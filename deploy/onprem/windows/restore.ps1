#Requires -Version 5.1
<#
.SYNOPSIS
  Restores a Kadai database backup on a Windows (native) installation.

.DESCRIPTION
  1. verifies the archive (.sha256 file when present, pg_restore --list)
  2. asks for confirmation (type the database name; -Yes for automation)
  3. takes a safety backup of the current database (unless -NoSafetyBackup)
  4. stops the Kadai service and restores into a NEW scratch database in one transaction
  5. swaps names atomically: kadai -> kadai_pre_restore_<time>, scratch -> kadai
  6. starts Kadai (pending migrations run on boot) and waits until it is ready
  The previous database is kept for rollback; drop it after checking the data.

.EXAMPLE
  .\restore.ps1 -File C:\ProgramData\Kadai\data\backups\kadai-kadai-20261020-224500-scheduled.dump
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$File,
  [switch]$Yes,
  [switch]$NoSafetyBackup,
  [switch]$NoStart,
  [string]$DataRoot = (Join-Path $env:ProgramData 'Kadai')
)

. (Join-Path $PSScriptRoot 'kadai-common.ps1')
Assert-Administrator

$cfg = Get-KadaiConfig $DataRoot
if (-not (Test-Path -LiteralPath $File)) { Stop-WithError "cannot read $File" }
$File = (Resolve-Path -LiteralPath $File).Path
$db = $KadaiDbName

# 1. verify
$shaFile = "$File.sha256"
if (Test-Path -LiteralPath $shaFile) {
  $expected = ((Get-Content -LiteralPath $shaFile -TotalCount 1) -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { Stop-WithError "checksum mismatch for $File" }
  Write-Step 'checksum OK'
} else {
  Write-Warn 'no .sha256 file next to the backup: integrity not verified by checksum'
}
$toc = Invoke-PgTool -Cfg $cfg -Tool 'pg_restore' -Arguments @('--list', $File) -NoDatabaseArgument
$toc | Where-Object { $_ -match '^;\s+(Archive created at|dbname|Dumped from database version)' } | ForEach-Object { Write-Host $_ }

# 2. confirm
if (-not $Yes) {
  Write-Host ''
  Write-Host "This REPLACES all data in database '$db' with the backup above. Kadai is stopped meanwhile." -ForegroundColor Yellow
  $answer = Read-Host "Type the database name ($db) to continue"
  if ($answer -ne $db) { Stop-WithError 'aborted' }
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$scratch = "${db}_restore_$stamp"
$old = "${db}_pre_restore_$stamp"

# 3. safety backup
if (-not $NoSafetyBackup) {
  Write-Step 'taking a safety backup of the current database'
  & (Join-Path $PSScriptRoot 'backup.ps1') -Kind manual -Label 'pre-restore' -NoPrune -DataRoot $DataRoot | Out-Null
}

# 4. restore into a scratch database
$stopped = $false
$swapped = $false
try {
  Write-Step 'stopping Kadai'
  Stop-Service -Name $KadaiServiceName -Force
  $stopped = $true

  Write-Step "creating scratch database $scratch"
  Invoke-PgTool -Cfg $cfg -Tool 'psql' -Database 'postgres' -Arguments @('-X', '-q', '-v', 'ON_ERROR_STOP=1') `
    -InputText "CREATE DATABASE `"$scratch`" TEMPLATE template0 ENCODING 'UTF8';" | Out-Null
  Invoke-PgTool -Cfg $cfg -Tool 'psql' -Database $scratch -Arguments @('-X', '-q', '-v', 'ON_ERROR_STOP=1') `
    -InputText 'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext;' | Out-Null

  Write-Step 'restoring (single transaction; this can take a few minutes)'
  Invoke-PgTool -Cfg $cfg -Tool 'pg_restore' -Database $scratch `
    -Arguments @('--no-owner', '--single-transaction', '--exit-on-error', $File) | Out-Null
  Invoke-PgTool -Cfg $cfg -Tool 'psql' -Database $scratch -Arguments @('-X', '-q', '-v', 'ON_ERROR_STOP=1') `
    -InputText "REVOKE ALL ON DATABASE `"$scratch`" FROM PUBLIC; GRANT CONNECT, TEMPORARY ON DATABASE `"$scratch`" TO `"$KadaiDbAppUser`";" | Out-Null

  # 5. swap
  Write-Step "swapping databases ($db -> $old, $scratch -> $db)"
  $swap = @"
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = '$db' AND pid <> pg_backend_pid() AND usename = current_user;
BEGIN;
ALTER DATABASE "$db" RENAME TO "$old";
ALTER DATABASE "$scratch" RENAME TO "$db";
COMMIT;
"@
  Invoke-PgTool -Cfg $cfg -Tool 'psql' -Database 'postgres' -Arguments @('-X', '-q', '-v', 'ON_ERROR_STOP=1') -InputText $swap | Out-Null
  $swapped = $true
} catch {
  Write-Warn "restore failed; the current database was not changed ($($_.Exception.Message))"
  if (-not $swapped) {
    try {
      Invoke-PgTool -Cfg $cfg -Tool 'psql' -Database 'postgres' -Arguments @('-X', '-q') `
        -InputText "DROP DATABASE IF EXISTS `"$scratch`";" | Out-Null
    } catch { Write-Warn "could not drop $scratch" }
  }
  if ($stopped) { Start-Service -Name $KadaiServiceName -ErrorAction SilentlyContinue }
  throw
}

# 6. start
if ($NoStart) {
  Write-Step 'Kadai left stopped (-NoStart)'
} else {
  Write-Step 'starting Kadai (pending migrations are applied on boot)'
  Start-Service -Name $KadaiServiceName
  if (-not (Wait-KadaiReady $cfg 600)) { Stop-WithError "Kadai did not become ready; the previous database is kept as $old" }
}
Write-Host ''
Write-Host "Restore complete. The previous database is kept as '$old' for rollback." -ForegroundColor Green
Write-Host "After checking the data, free its space with:"
Write-Host "  & '$(Join-Path (Get-PgBin $cfg) 'dropdb.exe')' -h 127.0.0.1 -U $KadaiDbOwner `"$old`""
