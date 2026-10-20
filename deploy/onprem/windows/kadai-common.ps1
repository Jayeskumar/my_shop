# Shared helpers for the Kadai Windows scripts (install.ps1, backup.ps1, restore.ps1).
# Dot-sourced; compatible with Windows PowerShell 5.1 and PowerShell 7.

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with a progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# Text piped to psql.exe is UTF-8 (Windows PowerShell 5.1 defaults to ASCII).
$OutputEncoding = New-Object Text.UTF8Encoding($false)

$script:KadaiServiceName = 'kadai'
$script:KadaiDbName = 'kadai'
$script:KadaiDbOwner = 'kadai_owner'
$script:KadaiDbAppUser = 'kadai_app'
$script:DefaultDataRoot = Join-Path $env:ProgramData 'Kadai'

function Write-Step([string]$Message) { Write-Host "[kadai] $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "[kadai] WARNING: $Message" -ForegroundColor Yellow }
function Stop-WithError([string]$Message) { throw "[kadai] ERROR: $Message" }

function Assert-Administrator {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-WithError 'run this script from an elevated PowerShell (Run as administrator)'
  }
}

function New-RandomBytes([int]$Count) {
  $bytes = New-Object byte[] $Count
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return , $bytes
}
function New-RandomHex([int]$Count) { return (-join ((New-RandomBytes $Count) | ForEach-Object { $_.ToString('x2') })) }
function New-RandomBase64([int]$Count) { return [Convert]::ToBase64String((New-RandomBytes $Count)) }

# Reads a dotenv file into a hashtable (KEY=value, # comments, optional surrounding quotes).
function Read-EnvFile([string]$Path) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $key = $Matches[1]
      $value = $Matches[2].TrimEnd()
      if ($value -match '^"(.*)"$' -or $value -match "^'(.*)'$") { $value = $Matches[1] }
      $map[$key] = $value
    }
  }
  return $map
}

# Replaces or appends KEY=value in a dotenv file (UTF-8 without BOM, keeps the ACL).
function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
  $lines = @()
  if (Test-Path -LiteralPath $Path) { $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8) }
  $found = $false
  $out = foreach ($line in $lines) {
    if (-not $found -and $line -match "^\s*$([regex]::Escape($Key))=") { $found = $true; "$Key=$Value" } else { $line }
  }
  if (-not $found) { $out = @($out) + "$Key=$Value" }
  Write-Utf8File -Path $Path -Lines $out
}

function Write-Utf8File([string]$Path, [string[]]$Lines) {
  $text = ($Lines -join "`r`n") + "`r`n"
  [IO.File]::WriteAllText($Path, $text, (New-Object Text.UTF8Encoding($false)))
}

function Get-KadaiConfig([string]$DataRoot = $script:DefaultDataRoot) {
  $envFile = Join-Path $DataRoot 'kadai.env'
  if (-not (Test-Path -LiteralPath $envFile)) { Stop-WithError "Kadai is not installed ($envFile not found)" }
  $cfg = Read-EnvFile $envFile
  $cfg['__ENV_FILE'] = $envFile
  $cfg['__DATA_ROOT'] = $DataRoot
  return $cfg
}

# postgres://user:password@host:port/db → libpq connection pieces (password via PGPASSWORD).
function ConvertFrom-PostgresUrl([string]$Url) {
  $u = [Uri]$Url
  $user, $password = $u.UserInfo.Split(':', 2)
  if ($null -eq $password) { $password = '' }
  $port = 5432
  if ($u.Port -gt 0) { $port = $u.Port }
  return [pscustomobject]@{
    Host     = $u.Host
    Port     = $port
    User     = [Uri]::UnescapeDataString($user)
    Password = [Uri]::UnescapeDataString($password)
    Database = $u.AbsolutePath.TrimStart('/')
  }
}

function Get-PgBin([hashtable]$Cfg) {
  $candidates = @()
  if ($Cfg.ContainsKey('KADAI_PG_BIN')) { $candidates += $Cfg['KADAI_PG_BIN'] }
  $candidates += (Join-Path $env:ProgramFiles 'PostgreSQL\16\bin')
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath (Join-Path $c 'pg_dump.exe'))) { return $c } }
  Stop-WithError 'PostgreSQL client tools (pg_dump.exe) not found; set KADAI_PG_BIN in kadai.env'
}

# Runs a PostgreSQL tool as the owner role; throws on a non-zero exit code.
# -Database overrides the database of DATABASE_SYSTEM_URL; -InputText is sent on stdin.
function Invoke-PgTool {
  param(
    [Parameter(Mandatory)][hashtable]$Cfg,
    [Parameter(Mandatory)][string]$Tool,
    [string[]]$Arguments = @(),
    [string]$Database,
    [string]$InputText,
    [switch]$NoDatabaseArgument
  )
  $conn = ConvertFrom-PostgresUrl $Cfg['DATABASE_SYSTEM_URL']
  $exe = Join-Path (Get-PgBin $Cfg) "$Tool.exe"
  $db = $conn.Database
  if ($Database) { $db = $Database }
  $all = @('-h', $conn.Host, '-p', [string]$conn.Port, '-U', $conn.User)
  if (-not $NoDatabaseArgument) { $all += @('-d', $db) }
  $all += $Arguments
  $previous = $env:PGPASSWORD
  $env:PGPASSWORD = $conn.Password
  $env:PGCLIENTENCODING = 'UTF8'
  try {
    if ($PSBoundParameters.ContainsKey('InputText')) { $output = $InputText | & $exe @all } else { $output = & $exe @all }
    if ($LASTEXITCODE -ne 0) { Stop-WithError "$Tool exited with code $LASTEXITCODE" }
    return $output
  } finally {
    $env:PGPASSWORD = $previous
  }
}

function Wait-KadaiReady([hashtable]$Cfg, [int]$TimeoutSeconds = 600) {
  $port = 8080
  if ($Cfg.ContainsKey('PORT')) { $port = [int]$Cfg['PORT'] }
  $url = "http://127.0.0.1:$port/health/ready"
  Write-Step "waiting for $url (up to $TimeoutSeconds s)"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10
      if ($r.StatusCode -eq 200) { Write-Step 'Kadai is ready'; return $true }
    } catch { Start-Sleep -Seconds 5 }
  }
  Write-Warn "Kadai did not become ready in $TimeoutSeconds s (see the logs folder)"
  return $false
}

# Grants an account rights on a folder or file (inheritance for folders).
function Grant-Path([string]$Path, [string]$Identity, [string]$Rights) {
  $isDir = Test-Path -LiteralPath $Path -PathType Container
  $grant = "${Identity}:($Rights)"
  if ($isDir) { $grant = "${Identity}:(OI)(CI)($Rights)" }
  & icacls.exe $Path /grant $grant /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-WithError "icacls failed on $Path" }
}

# Only SYSTEM and Administrators (+ optional reader) may access a secrets file or folder.
# Well-known SIDs keep this working on non-English Windows (*S-1-5-18 SYSTEM, *S-1-5-32-544
# Administrators, *S-1-5-19 LocalService).
function Protect-SecretFile([string]$Path, [string]$Reader) {
  $inherit = ''
  if (Test-Path -LiteralPath $Path -PathType Container) { $inherit = '(OI)(CI)' }
  & icacls.exe $Path /inheritance:r /grant:r "*S-1-5-18:${inherit}(F)" "*S-1-5-32-544:${inherit}(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-WithError "icacls failed on $Path" }
  if ($Reader) {
    & icacls.exe $Path /grant "${Reader}:${inherit}(R)" | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError "icacls failed on $Path" }
  }
}

# Extracts a zip much faster than Expand-Archive (Windows PowerShell 5.1).
function Expand-Zip([string]$Zip, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
  [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination)
}
