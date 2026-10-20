#Requires -Version 5.1
<#
.SYNOPSIS
  Installs, upgrades or removes Kadai Server on a Windows PC (native, no Docker).

.DESCRIPTION
  Install (elevated PowerShell, from the unpacked on-prem bundle):
      powershell -ExecutionPolicy Bypass -File .\install.ps1
  It installs a private Node.js 22 runtime, PostgreSQL 16 (EDB installer, unattended), creates
  the kadai database and roles, registers the Windows service "Kadai Server" (WinSW, runs as
  LocalService), opens TCP 8080 for the local network only and puts a "Kadai" shortcut on the
  desktop. Counter PCs then open http://<this-pc>:8080.

  Upgrade:   .\install.ps1 -Upgrade -BundlePath .\kadai-server-1.4.0-win-x64.zip
  Rollback:  .\install.ps1 -Rollback          (previous version + its pre-upgrade backup)
  Remove:    .\install.ps1 -Uninstall         (keeps PostgreSQL, the database and the data folder)
  Offline:   pass -NodeZip, -PostgresInstaller and -WinSWExe with local copies of the downloads.

.EXAMPLE
  .\install.ps1 -Port 8080 -SetNetworkPrivate -BackupTask
#>
[CmdletBinding()]
param(
  [string]$BundlePath,
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'Kadai'),
  [string]$DataRoot = (Join-Path $env:ProgramData 'Kadai'),
  [ValidateRange(1, 65535)][int]$Port = 8080,
  [string]$PublicUrl,
  [ValidateRange(20, 99)][int]$NodeMajor = 22,
  [ValidatePattern('^16\.\d+-\d+$')][string]$PostgresVersion = '16.15-1',
  [string]$PostgresInstaller,
  [securestring]$PostgresSuperPassword,
  [string]$NodeZip,
  [string]$WinSWExe,
  [switch]$SkipFirewall,
  [switch]$SetNetworkPrivate,
  [switch]$NoShortcut,
  [switch]$BackupTask,
  [switch]$Upgrade,
  [switch]$Rollback,
  [switch]$Uninstall,
  [switch]$Yes
)

. (Join-Path $PSScriptRoot 'kadai-common.ps1')

$WinSWUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$WinSWSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'
$PgMajor = 16
$PgServiceName = "postgresql-x64-$PgMajor"
$PgBin = Join-Path $env:ProgramFiles "PostgreSQL\$PgMajor\bin"
$EnvFile = Join-Path $DataRoot 'kadai.env'
$AppDir = Join-Path $InstallDir 'app'
$ServiceDir = Join-Path $InstallDir 'service'
$ScriptsDir = Join-Path $InstallDir 'scripts'
$StateFile = Join-Path $DataRoot 'upgrade-state.json'
$FirewallRuleName = 'Kadai-HTTP-In'
$LocalServiceSid = '*S-1-5-19'
$KitRoot = Split-Path -Parent $PSScriptRoot

function Confirm-Action([string]$Question) {
  if ($Yes) { return }
  $a = Read-Host "$Question [y/N]"
  if ($a -notmatch '^(y|yes)$') { Stop-WithError 'aborted' }
}

function ConvertTo-PlainText([securestring]$Secure) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Get-Download([string]$Url, [string]$OutFile) {
  Write-Step "downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
}

function Assert-Sha256([string]$File, [string]$Expected) {
  $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) { Stop-WithError "checksum mismatch for $File (expected $Expected, got $actual)" }
}

function Get-ReleaseInfo {
  # release.env at the root of the on-prem bundle (written by the release workflow).
  return Read-EnvFile (Join-Path $KitRoot 'release.env')
}

# --- application bundle -------------------------------------------------------------------
function Resolve-Bundle {
  if ($BundlePath) {
    if (-not (Test-Path -LiteralPath $BundlePath)) { Stop-WithError "bundle not found: $BundlePath" }
    return (Resolve-Path -LiteralPath $BundlePath).Path
  }
  foreach ($dir in @($PSScriptRoot, $KitRoot)) {
    $found = Get-ChildItem -LiteralPath $dir -Filter 'kadai-server-*-win-x64.zip' -ErrorAction SilentlyContinue |
      Sort-Object Name | Select-Object -Last 1
    if ($found) { return $found.FullName }
  }
  $release = Get-ReleaseInfo
  if (-not ($release.ContainsKey('KADAI_RELEASE_URL') -and $release.ContainsKey('KADAI_VERSION'))) {
    Stop-WithError 'pass -BundlePath kadai-server-<version>-win-x64.zip'
  }
  $name = "kadai-server-$($release['KADAI_VERSION'])-win-x64.zip"
  $target = Join-Path $KitRoot $name
  Get-Download "$($release['KADAI_RELEASE_URL'])/$name" $target
  Get-Download "$($release['KADAI_RELEASE_URL'])/SHA256SUMS" (Join-Path $KitRoot 'SHA256SUMS')
  return $target
}

function Test-BundleChecksum([string]$Bundle) {
  $sums = Join-Path (Split-Path -Parent $Bundle) 'SHA256SUMS'
  if (-not (Test-Path -LiteralPath $sums)) { Write-Warn 'no SHA256SUMS next to the bundle: integrity not verified'; return }
  $name = Split-Path -Leaf $Bundle
  $line = Get-Content -LiteralPath $sums | Where-Object { $_ -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape($name))$" } | Select-Object -First 1
  if (-not $line) { Stop-WithError "$name is not listed in $sums" }
  Assert-Sha256 $Bundle ($line -split '\s+')[0]
  Write-Step 'bundle checksum OK'
}

# Extracts the bundle into <InstallDir>\app.new and returns that folder.
function Expand-Bundle([string]$Bundle) {
  # Short extraction path next to the install folder (deep node_modules paths, MAX_PATH).
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $tmp = Join-Path $InstallDir ('x' + (New-RandomHex 3))
  Expand-Zip $Bundle $tmp
  $root = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
  if (-not $root -or -not (Test-Path -LiteralPath (Join-Path $root.FullName 'dist\server.js'))) {
    Stop-WithError "$Bundle is not a Kadai server bundle"
  }
  $new = Join-Path $InstallDir 'app.new'
  if (Test-Path -LiteralPath $new) { Remove-Item -LiteralPath $new -Recurse -Force }
  Move-Item -LiteralPath $root.FullName -Destination $new
  Remove-Item -LiteralPath $tmp -Recurse -Force
  return $new
}

function Get-BundleVersion([string]$Dir) {
  $file = Join-Path $Dir 'release.json'
  if (Test-Path -LiteralPath $file) { return (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json) }
  return [pscustomobject]@{ version = 'unknown'; node_major = $NodeMajor }
}

# --- Node.js ------------------------------------------------------------------------------
function Install-NodeRuntime([int]$Major) {
  $dest = Join-Path $InstallDir 'node'
  $exe = Join-Path $dest 'node.exe'
  if (Test-Path -LiteralPath $exe) {
    $current = (& $exe --version) -replace '^v', ''
    if ([int]($current.Split('.')[0]) -eq $Major) { Write-Step "Node.js $current already installed"; return $exe }
  }
  $zip = $NodeZip
  if (-not $zip) {
    $base = "https://nodejs.org/dist/latest-v$Major.x"
    $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
    $m = [regex]::Match($sums, "([0-9a-f]{64})\s+(node-v$Major\.\d+\.\d+-win-x64\.zip)")
    if (-not $m.Success) { Stop-WithError "no Node.js $Major win-x64 build found at $base" }
    $zip = Join-Path $env:TEMP $m.Groups[2].Value
    Get-Download "$base/$($m.Groups[2].Value)" $zip
    Assert-Sha256 $zip $m.Groups[1].Value
  }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $tmp = Join-Path $InstallDir ('n' + (New-RandomHex 3))
  Expand-Zip $zip $tmp
  $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  Move-Item -LiteralPath $inner.FullName -Destination $dest
  Remove-Item -LiteralPath $tmp -Recurse -Force
  Write-Step "Node.js $(& $exe --version) installed in $dest"
  return $exe
}

# --- PostgreSQL ---------------------------------------------------------------------------
function Test-InstallerUrl([string]$Url) {
  try {
    $r = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 20
    return ($r.Headers['Content-Type'] -match 'msdos|dosexec|octet-stream')
  } catch { return $false }
}

# Newest 16.x installer published by EnterpriseDB, starting from -PostgresVersion.
function Resolve-PostgresInstallerUrl {
  $minor = [int]($PostgresVersion -replace '^16\.(\d+)-\d+$', '$1')
  $build = $PostgresVersion -replace '^16\.\d+-(\d+)$', '$1'
  $url = "https://get.enterprisedb.com/postgresql/postgresql-$PostgresVersion-windows-x64.exe"
  for ($next = $minor + 1; $next -le $minor + 10; $next++) {
    $candidate = "https://get.enterprisedb.com/postgresql/postgresql-16.$next-1-windows-x64.exe"
    if (Test-InstallerUrl $candidate) { $url = $candidate } else { break }
  }
  if ($build -ne '1') { Write-Step "using PostgreSQL installer build $build" }
  return $url
}

# Returns the superuser password (generated when we install PostgreSQL ourselves).
function Install-PostgreSQL {
  $secretsDir = Join-Path $DataRoot 'secrets'
  New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null
  Protect-SecretFile $secretsDir
  $pwFile = Join-Path $secretsDir 'postgres-superuser.txt'

  if (Get-Service -Name $PgServiceName -ErrorAction SilentlyContinue) {
    Write-Step "PostgreSQL $PgMajor is already installed ($PgServiceName)"
    if ($PostgresSuperPassword) { return (ConvertTo-PlainText $PostgresSuperPassword) }
    if (Test-Path -LiteralPath $pwFile) { return (Get-Content -LiteralPath $pwFile -Raw).Trim() }
    return (ConvertTo-PlainText (Read-Host -AsSecureString "Password of the PostgreSQL 'postgres' superuser"))
  }

  $installer = $PostgresInstaller
  if (-not $installer) {
    $url = Resolve-PostgresInstallerUrl
    $installer = Join-Path $env:TEMP (Split-Path -Leaf $url)
    Get-Download $url $installer
  }
  $sig = Get-AuthenticodeSignature -LiteralPath $installer
  if ($sig.Status -ne 'Valid') { Stop-WithError "the PostgreSQL installer signature is not valid ($($sig.Status))" }

  $superPw = New-RandomHex 24
  Write-Utf8File -Path $pwFile -Lines @($superPw)
  Protect-SecretFile $pwFile

  # Options in a temporary file (not on the command line), readable by administrators only.
  $optionFile = Join-Path $secretsDir 'pg-install-options.txt'
  Write-Utf8File -Path $optionFile -Lines @(
    'mode=unattended',
    'unattendedmodeui=none',
    "superpassword=$superPw",
    'serverport=5432',
    "servicename=$PgServiceName",
    'enable-components=server,commandlinetools',
    'disable-components=pgAdmin,stackbuilder'
  )
  Protect-SecretFile $optionFile
  Write-Step 'installing PostgreSQL 16 (this takes a few minutes)'
  try {
    $p = Start-Process -FilePath $installer -ArgumentList @('--optionfile', "`"$optionFile`"") -Wait -PassThru
    if ($p.ExitCode -ne 0) { Stop-WithError "the PostgreSQL installer failed with exit code $($p.ExitCode)" }
  } finally {
    Remove-Item -LiteralPath $optionFile -Force -ErrorAction SilentlyContinue
  }
  Set-Service -Name $PgServiceName -StartupType Automatic
  Start-Service -Name $PgServiceName
  return $superPw
}

function Initialize-Database([string]$SuperSecret, [string]$OwnerSecret, [string]$AppSecret) {
  $psql = Join-Path $PgBin 'psql.exe'
  $sql = @'
SELECT format('CREATE ROLE %I LOGIN CREATEDB PASSWORD %L', :'owner', :'owner_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner') \gexec
SELECT format('ALTER ROLE %I LOGIN CREATEDB PASSWORD %L', :'owner', :'owner_pw') \gexec
SELECT format('CREATE ROLE %I LOGIN NOCREATEDB NOCREATEROLE PASSWORD %L', :'app', :'app_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app') \gexec
SELECT format('ALTER ROLE %I LOGIN NOCREATEDB NOCREATEROLE PASSWORD %L', :'app', :'app_pw') \gexec
SELECT format('CREATE DATABASE %I OWNER %I ENCODING %L TEMPLATE template0', :'db', :'owner', 'UTF8')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'db', :'app') \gexec
SELECT format('GRANT ALL ON DATABASE %I TO %I', :'db', :'owner') \gexec
'@
  # Variables are set on stdin (\set), so the passwords never appear on a command line.
  $vars = @(
    "\set db '$KadaiDbName'", "\set owner '$KadaiDbOwner'", "\set app '$KadaiDbAppUser'",
    "\set owner_pw '$OwnerSecret'", "\set app_pw '$AppSecret'"
  ) -join "`n"
  $previous = $env:PGPASSWORD
  $env:PGPASSWORD = $SuperSecret
  try {
    ($vars + "`n" + $sql) | & $psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U postgres -d postgres | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'creating the database roles failed' }
    "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext;" |
      & $psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U postgres -d $KadaiDbName | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'creating the extensions failed' }
  } finally {
    $env:PGPASSWORD = $previous
  }
  Write-Step "database '$KadaiDbName' ready (owner $KadaiDbOwner, runtime role $KadaiDbAppUser)"
}

# --- service ------------------------------------------------------------------------------
function Install-KadaiService([string]$NodeExe) {
  New-Item -ItemType Directory -Force -Path $ServiceDir | Out-Null
  $svcExe = Join-Path $ServiceDir 'kadai-service.exe'
  if (Get-Service -Name $KadaiServiceName -ErrorAction SilentlyContinue) {
    Stop-Service -Name $KadaiServiceName -Force -ErrorAction SilentlyContinue
    & $svcExe uninstall | Out-Null
  }
  if ($WinSWExe) { Copy-Item -LiteralPath $WinSWExe -Destination $svcExe -Force } else { Get-Download $WinSWUrl $svcExe }
  Assert-Sha256 $svcExe $WinSWSha256

  $logDir = Join-Path $DataRoot 'logs'
  $xml = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'kadai-service.xml') -Raw -Encoding UTF8
  $values = @{
    '{{NODE_EXE}}' = $NodeExe; '{{ENV_FILE}}' = $EnvFile; '{{APP_DIR}}' = $AppDir; '{{PG_BIN}}' = $PgBin
    '{{PG_SERVICE}}' = $PgServiceName; '{{LOG_DIR}}' = $logDir; '{{PORT}}' = [string]$Port
  }
  foreach ($k in $values.Keys) { $xml = $xml.Replace($k, [Security.SecurityElement]::Escape($values[$k])) }
  [IO.File]::WriteAllText((Join-Path $ServiceDir 'kadai-service.xml'), $xml, (New-Object Text.UTF8Encoding($false)))

  & $svcExe install | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-WithError 'registering the Windows service failed' }
  # Least privilege: run as LocalService instead of LocalSystem.
  $svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='$KadaiServiceName'"
  $r = Invoke-CimMethod -InputObject $svc -MethodName Change -Arguments @{ StartName = 'NT AUTHORITY\LocalService'; StartPassword = '' }
  if ($r.ReturnValue -ne 0) { Stop-WithError "could not set the service account (code $($r.ReturnValue))" }
  Write-Step "Windows service 'Kadai Server' registered"
}

function Set-FolderPermission {
  foreach ($d in @((Join-Path $DataRoot 'data'), (Join-Path $DataRoot 'data\backups'), (Join-Path $DataRoot 'logs'))) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
  }
  Grant-Path (Join-Path $DataRoot 'data') $LocalServiceSid 'M'
  Grant-Path (Join-Path $DataRoot 'logs') $LocalServiceSid 'M'
  Protect-SecretFile $EnvFile $LocalServiceSid
}

function Set-Firewall {
  if ($SkipFirewall) { return }
  Get-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -Name $FirewallRuleName -DisplayName "Kadai Server (TCP $Port, local network)" `
    -Description 'Counter PCs on this LAN reach Kadai Server' -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Domain, Private -RemoteAddress LocalSubnet | Out-Null
  Write-Step "firewall: TCP $Port allowed from the local subnet (Private/Domain networks)"
  $public = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' })
  foreach ($p in $public) {
    if ($SetNetworkPrivate) {
      Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private
      Write-Step "network '$($p.Name)' set to Private"
    } else {
      Write-Warn "network '$($p.Name)' is Public: counter PCs cannot connect. Re-run with -SetNetworkPrivate or run: Set-NetConnectionProfile -InterfaceIndex $($p.InterfaceIndex) -NetworkCategory Private"
    }
  }
}

function New-DesktopShortcut {
  if ($NoShortcut) { return }
  $desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
  $icon = Join-Path $AppDir 'web\favicon.ico'
  Write-Utf8File -Path (Join-Path $desktop 'Kadai.url') -Lines @(
    '[InternetShortcut]', "URL=http://localhost:$Port/", "IconFile=$icon", 'IconIndex=0'
  )
  Write-Step 'desktop shortcut "Kadai" created'
}

function Register-BackupTask {
  if (-not $BackupTask) { return }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptsDir\backup.ps1`" -Kind scheduled"
  $trigger = New-ScheduledTaskTrigger -Daily -At '22:45'
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName 'Kadai Backup' -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'Daily Kadai database backup' -Force | Out-Null
  Write-Step "scheduled task 'Kadai Backup' (daily 22:45) registered"
}

function Copy-KadaiScript {
  New-Item -ItemType Directory -Force -Path $ScriptsDir | Out-Null
  foreach ($f in @('install.ps1', 'backup.ps1', 'restore.ps1', 'kadai-common.ps1', 'kadai-service.xml', 'README.md')) {
    $src = Join-Path $PSScriptRoot $f
    if ((Test-Path -LiteralPath $src) -and ((Resolve-Path $src).Path -ne (Join-Path $ScriptsDir $f))) {
      Copy-Item -LiteralPath $src -Destination $ScriptsDir -Force
    }
  }
}

function Show-Summary([string]$Url) {
  Write-Host ''
  Write-Host 'Kadai Server is running.' -ForegroundColor Green
  Write-Host "  This PC:       http://localhost:$Port  (desktop shortcut 'Kadai')"
  Write-Host "  Counter PCs:   $Url"
  Write-Host '  First visit shows the setup wizard: create the shop and the owner login.'
  Write-Host '  Then upload the license in Settings -> System.'
  Write-Host "  Configuration: $EnvFile  (keep a copy safe: needed for disaster recovery)"
  Write-Host "  Logs:          $(Join-Path $DataRoot 'logs')"
  Write-Host "  Backups:       $ScriptsDir\backup.ps1 / restore.ps1"
}

# =============================================================================
Assert-Administrator
if (-not [Environment]::Is64BitOperatingSystem) { Stop-WithError '64-bit Windows 10/11 or Server 2016+ is required' }

if ($Uninstall) {
  Confirm-Action 'Remove the Kadai service, firewall rule, shortcut and backup task? (data and database are kept)'
  if (Get-Service -Name $KadaiServiceName -ErrorAction SilentlyContinue) {
    Stop-Service -Name $KadaiServiceName -Force -ErrorAction SilentlyContinue
    & (Join-Path $ServiceDir 'kadai-service.exe') uninstall | Out-Null
  }
  Get-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Unregister-ScheduledTask -TaskName 'Kadai Backup' -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Kadai.url') -Force -ErrorAction SilentlyContinue
  Write-Step "removed. Data kept in $DataRoot; application files in $InstallDir; database '$KadaiDbName' in PostgreSQL."
  return
}

if ($Rollback) {
  if (-not (Test-Path -LiteralPath $StateFile)) { Stop-WithError "no previous upgrade recorded ($StateFile)" }
  $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
  $prev = Join-Path $InstallDir 'app.prev'
  if (-not (Test-Path -LiteralPath $prev)) { Stop-WithError "$prev is missing" }
  Confirm-Action "Roll back to version $($state.previous_version) and restore $($state.backup)? Data entered since the upgrade is lost."
  Stop-Service -Name $KadaiServiceName -Force
  $failed = Join-Path $InstallDir 'app.failed'
  if (Test-Path -LiteralPath $failed) { Remove-Item -LiteralPath $failed -Recurse -Force }
  Move-Item -LiteralPath $AppDir -Destination $failed
  Move-Item -LiteralPath $prev -Destination $AppDir
  Set-EnvValue $EnvFile 'KADAI_VERSION' ([string]$state.previous_version)
  if ($state.backup) {
    & (Join-Path $PSScriptRoot 'restore.ps1') -File $state.backup -Yes -NoSafetyBackup
  } else {
    Start-Service -Name $KadaiServiceName
  }
  Remove-Item -LiteralPath $StateFile -Force
  Write-Step "rolled back to $($state.previous_version)"
  return
}

if ($Upgrade) {
  $cfg = Get-KadaiConfig $DataRoot
  $bundle = Resolve-Bundle
  Test-BundleChecksum $bundle
  $new = Expand-Bundle $bundle
  $info = Get-BundleVersion $new
  $old = Get-BundleVersion $AppDir
  Confirm-Action "Upgrade Kadai $($old.version) -> $($info.version)?"
  $nodeExe = Install-NodeRuntime ([int]$info.node_major)
  Write-Step 'pre-upgrade backup'
  $dump = & (Join-Path $PSScriptRoot 'backup.ps1') -Kind pre_upgrade -NoPrune
  @{ previous_version = $old.version; backup = [string]$dump; at = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
  Stop-Service -Name $KadaiServiceName -Force
  $prev = Join-Path $InstallDir 'app.prev'
  if (Test-Path -LiteralPath $prev) { Remove-Item -LiteralPath $prev -Recurse -Force }
  Move-Item -LiteralPath $AppDir -Destination $prev
  Move-Item -LiteralPath $new -Destination $AppDir
  Set-EnvValue $EnvFile 'KADAI_VERSION' ([string]$info.version)
  Copy-KadaiScript
  Start-Service -Name $KadaiServiceName
  if (Wait-KadaiReady $cfg 900) { Write-Step "upgrade to $($info.version) complete"; return }
  Stop-WithError "the new version is not healthy: see $(Join-Path $DataRoot 'logs'), or run .\install.ps1 -Rollback"
}

# --- fresh install ------------------------------------------------------------------------
if (Test-Path -LiteralPath $EnvFile) { Stop-WithError "Kadai is already installed ($EnvFile): use -Upgrade" }
$bundle = Resolve-Bundle
Test-BundleChecksum $bundle
New-Item -ItemType Directory -Force -Path $DataRoot, $InstallDir | Out-Null

$new = Expand-Bundle $bundle
$info = Get-BundleVersion $new
if (Test-Path -LiteralPath $AppDir) { Remove-Item -LiteralPath $AppDir -Recurse -Force }
Move-Item -LiteralPath $new -Destination $AppDir
Write-Step "Kadai $($info.version) unpacked into $AppDir"

$nodeExe = Install-NodeRuntime ([int]$info.node_major)
$superPw = Install-PostgreSQL
$ownerPw = New-RandomHex 24
$appPw = New-RandomHex 24
Initialize-Database $superPw $ownerPw $appPw

if (-not $PublicUrl) { $PublicUrl = "http://$($env:COMPUTERNAME.ToLowerInvariant()):$Port" }
$keyId = 'k' + (Get-Date -Format 'yyyyMM')
$dataDir = Join-Path $DataRoot 'data'
Write-Utf8File -Path $EnvFile -Lines @(
  '# Kadai Server configuration (Windows). Generated by install.ps1 - keep a copy in a safe place.',
  'KADAI_MODE=onprem',
  'NODE_ENV=production',
  "KADAI_VERSION=$($info.version)",
  'HOST=0.0.0.0',
  "PORT=$Port",
  "PUBLIC_BASE_URL=$PublicUrl",
  'LOG_LEVEL=info',
  "DATABASE_URL=postgres://${KadaiDbAppUser}:$appPw@127.0.0.1:5432/$KadaiDbName",
  "DATABASE_SYSTEM_URL=postgres://${KadaiDbOwner}:$ownerPw@127.0.0.1:5432/$KadaiDbName",
  "DATABASE_APP_ROLE=$KadaiDbAppUser",
  'KADAI_MIGRATE_ON_BOOT=true',
  'KADAI_EMBEDDED_WORKER=true',
  'KADAI_SERVE_WEB=true',
  "KADAI_DATA_DIR=$dataDir",
  "KADAI_WEB_DIST=$(Join-Path $AppDir 'web')",
  "KADAI_MIGRATIONS_DIR=$(Join-Path $AppDir 'migrations')",
  "KADAI_PG_BIN=$PgBin",
  "JWT_SECRET=$(New-RandomBase64 48)",
  "KADAI_ENCRYPTION_KEYS=${keyId}:$(New-RandomBase64 32)",
  "METRICS_TOKEN=$(New-RandomHex 24)",
  'SMS_PROVIDER=log',
  'WHATSAPP_PROVIDER=log',
  'EMAIL_PROVIDER=log',
  'KADAI_BACKUP_RETENTION_DAYS=30',
  'KADAI_BACKUP_KEEP_MIN=7'
)
Set-FolderPermission
Copy-KadaiScript
Install-KadaiService $nodeExe
Start-Service -Name $KadaiServiceName
Set-Firewall
New-DesktopShortcut
Register-BackupTask
$cfg = Get-KadaiConfig $DataRoot
if (-not (Wait-KadaiReady $cfg 600)) { Stop-WithError "Kadai did not start: see $(Join-Path $DataRoot 'logs')" }
Show-Summary $PublicUrl
