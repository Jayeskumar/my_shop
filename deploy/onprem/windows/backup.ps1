#Requires -Version 5.1
<#
.SYNOPSIS
  Backs up the Kadai database on a Windows (native) installation.

.DESCRIPTION
  Writes kadai-kadai-<yyyyMMdd-HHmmss>-<kind>[-label].dump (pg_dump custom format) and a
  .sha256 file into <data>\backups (or -Dest), verifies the archive with pg_restore --list,
  optionally copies it to KADAI_BACKUP_COPY_TO (USB disk / network share), records it in the
  application's backup list and prunes old backups. Outputs the backup file path.

.EXAMPLE
  .\backup.ps1
  .\backup.ps1 -Kind manual -Label before-gst-change -Dest E:\KadaiBackups
#>
[CmdletBinding()]
param(
  [ValidateSet('scheduled', 'manual', 'pre_upgrade')][string]$Kind = 'manual',
  [string]$Dest,
  [ValidatePattern('^[A-Za-z0-9_-]{0,40}$')][string]$Label = '',
  [int]$RetentionDays = -1,
  [int]$KeepMin = -1,
  [switch]$NoPrune,
  [string]$DataRoot = (Join-Path $env:ProgramData 'Kadai')
)

. (Join-Path $PSScriptRoot 'kadai-common.ps1')
Assert-Administrator

$cfg = Get-KadaiConfig $DataRoot
if ($RetentionDays -lt 0) { $RetentionDays = 30; if ($cfg.ContainsKey('KADAI_BACKUP_RETENTION_DAYS')) { $RetentionDays = [int]$cfg['KADAI_BACKUP_RETENTION_DAYS'] } }
if ($KeepMin -lt 0) { $KeepMin = 7; if ($cfg.ContainsKey('KADAI_BACKUP_KEEP_MIN')) { $KeepMin = [int]$cfg['KADAI_BACKUP_KEEP_MIN'] } }
if (-not $Dest) {
  if ($cfg.ContainsKey('KADAI_BACKUP_DIR') -and $cfg['KADAI_BACKUP_DIR']) { $Dest = $cfg['KADAI_BACKUP_DIR'] }
  else { $Dest = Join-Path $cfg['KADAI_DATA_DIR'] 'backups' }
}
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# One backup at a time: an exclusive lock file.
$lockPath = Join-Path $Dest '.backup.lock'
try {
  $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  Stop-WithError "another backup is already running ($lockPath)"
}

try {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $started = (Get-Date).ToString('o')
  $suffix = ''
  if ($Label) { $suffix = "-$Label" }
  $name = "kadai-$KadaiDbName-$stamp-$Kind$suffix.dump"
  $final = Join-Path $Dest $name
  $partial = Join-Path $Dest ".$name.partial"

  Write-Step "backing up database '$KadaiDbName' -> $final"
  try {
    Invoke-PgTool -Cfg $cfg -Tool 'pg_dump' -Arguments @('-Fc', '-Z', '6', '-f', $partial) | Out-Null
    if ((Get-Item -LiteralPath $partial).Length -eq 0) { Stop-WithError 'pg_dump produced an empty file' }
    Invoke-PgTool -Cfg $cfg -Tool 'pg_restore' -Arguments @('--list', $partial) -NoDatabaseArgument | Out-Null
  } catch {
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
    throw
  }
  $sha = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
  $size = (Get-Item -LiteralPath $partial).Length
  Move-Item -LiteralPath $partial -Destination $final -Force
  Write-Utf8File -Path "$final.sha256" -Lines @("$sha  $name")
  Write-Step ("backup written: {0:N1} MB, sha256 {1}" -f ($size / 1MB), $sha)

  if ($cfg.ContainsKey('KADAI_BACKUP_COPY_TO') -and $cfg['KADAI_BACKUP_COPY_TO']) {
    $copyTo = $cfg['KADAI_BACKUP_COPY_TO']
    try {
      New-Item -ItemType Directory -Force -Path $copyTo | Out-Null
      Copy-Item -LiteralPath $final, "$final.sha256" -Destination $copyTo -Force
      $copySha = (Get-FileHash -LiteralPath (Join-Path $copyTo $name) -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($copySha -eq $sha) { Write-Step "copied to $copyTo" } else { Write-Warn "copy in $copyTo does not match its checksum" }
    } catch {
      Write-Warn "could not copy the backup to $copyTo ($($_.Exception.Message))"
    }
  }

  # Application backup list (Settings -> System). Best effort. Inside psql's single-quoted
  # \set values a backslash escapes the next character, so Windows paths are doubled.
  $record = @"
\set kind '$Kind'
\set location '$($final.Replace('\', '\\').Replace("'", "''"))'
\set size $size
\set sha '$sha'
\set started '$started'
SELECT format(
  'INSERT INTO backups (kind, status, location, size_bytes, checksum_sha256, started_at, finished_at)
   VALUES (%L, %L, %L, %s, %L, %L::timestamptz, now())',
  :'kind', 'completed', :'location', :'size', :'sha', :'started')
WHERE to_regclass('public.backups') IS NOT NULL \gexec
"@
  try { Invoke-PgTool -Cfg $cfg -Tool 'psql' -Arguments @('-X', '-q', '-v', 'ON_ERROR_STOP=1') -InputText $record | Out-Null }
  catch { Write-Warn 'could not record the backup in the backups table' }

  if (-not $NoPrune -and $RetentionDays -gt 0) {
    $cutoff = (Get-Date).AddDays(-$RetentionDays)
    $all = @(Get-ChildItem -LiteralPath $Dest -Filter 'kadai-*.dump' -File | Sort-Object LastWriteTime -Descending)
    for ($i = $KeepMin; $i -lt $all.Count; $i++) {
      if ($all[$i].LastWriteTime -lt $cutoff) {
        Remove-Item -LiteralPath $all[$i].FullName, "$($all[$i].FullName).sha256" -Force -ErrorAction SilentlyContinue
        Write-Step "pruned $($all[$i].Name)"
      }
    }
  }
  Write-Output $final
} finally {
  $lock.Dispose()
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
