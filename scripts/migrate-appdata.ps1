# migrate-appdata.ps1 — move DSH harness data from C: (AppData) to F:\qqbot and leave junctions behind.
#
# Why: DSH keeps sessions / attachments / settings under %APPDATA%\dsh-desktop\harness.
#      They grow forever and C: is small. A junction keeps the old path working while
#      the bytes live on F:.
#
# Usage (run PowerShell as the same user, DSH Desktop CLOSED):
#   powershell -ExecutionPolicy Bypass -File F:\qqbot\scripts\migrate-appdata.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File F:\qqbot\scripts\migrate-appdata.ps1
#
# Notes:
#   * Requires DSH Desktop to be fully closed (it holds open write handles).
#   * Uses robocopy /MOVE, then creates a directory junction at the old path.
#   * Safe to re-run: already-junctioned items are skipped.
#   * Rollback: delete the junction, move the folder back (see docs/项目整理与迁移.md).

param(
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$AppRoot = Join-Path $env:APPDATA 'dsh-desktop\harness'
$DstRoot = 'F:\qqbot\data\harness'
$Items = @('sessions', 'attachments', 'qqbot-settings')

function Get-DirSizeMB($path) {
  if (-not (Test-Path -LiteralPath $path)) { return 0 }
  $sum = (Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
  if (-not $sum) { return 0 }
  return [math]::Round($sum / 1MB, 1)
}

function Test-IsJunction($path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  $item = Get-Item -LiteralPath $path -Force
  return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

if (-not (Test-Path -LiteralPath $AppRoot)) {
  throw "Harness root not found: $AppRoot"
}

$procs = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0 -and -not $Force) {
  throw "DSH Desktop is running ($($procs.Count) process(es)). Close it completely, then re-run. (Use -Force only if you know the dirs are not being written.)"
}

Write-Host "Harness root : $AppRoot"
Write-Host "Destination  : $DstRoot"
Write-Host "Dry run      : $($DryRun.IsPresent)"
Write-Host ''

New-Item -ItemType Directory -Force -Path $DstRoot | Out-Null

foreach ($name in $Items) {
  $src = Join-Path $AppRoot $name
  $dst = Join-Path $DstRoot $name

  Write-Host "== $name =="
  if (-not (Test-Path -LiteralPath $src)) {
    Write-Host "  skip: source does not exist"
    continue
  }
  if (Test-IsJunction $src) {
    $target = (Get-Item -LiteralPath $src -Force).Target
    Write-Host "  skip: already a junction -> $target"
    continue
  }

  $size = Get-DirSizeMB $src
  Write-Host ("  source: {0} ({1} MB)" -f $src, $size)
  Write-Host ("  target: {0}" -f $dst)
  if ($DryRun) {
    Write-Host "  dry-run: would robocopy /MOVE then junction"
    continue
  }

  if (Test-Path -LiteralPath $dst) {
    # Destination exists: merge? Refuse to guess.
    $dstSize = Get-DirSizeMB $dst
    throw "Destination already exists ($dst, $dstSize MB). Move it away or remove it first."
  }

  # robocopy exit codes: 0-7 are success-ish, >=8 is failure.
  $rc = Start-Process -FilePath 'robocopy.exe' -ArgumentList @(
    "`"$src`"", "`"$dst`"", '/E', '/MOVE', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'
  ) -Wait -PassThru -NoNewWindow
  if ($rc.ExitCode -ge 8) {
    throw "robocopy failed for $name (exit $($rc.ExitCode))"
  }

  # robocopy /MOVE usually removes the source; make sure.
  if (Test-Path -LiteralPath $src) {
    $left = @(Get-ChildItem -LiteralPath $src -Force -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) {
      Remove-Item -LiteralPath $src -Force
    } else {
      throw "Source still has files after move: $src. Nothing was deleted; inspect before retrying."
    }
  }

  New-Item -ItemType Junction -Path $src -Target $dst | Out-Null
  $check = (Get-Item -LiteralPath $src -Force).Target
  Write-Host ("  done: junction -> {0} ({1} MB freed on C:)" -f $check, $size)
}

Write-Host ''
Write-Host 'Done. Start DSH Desktop and confirm settings/sessions still load.'
Write-Host 'If the bot does not connect, check the bot-host lock: F:\qqbot\dshqqbot\.qqbot\bot-host.lock'
