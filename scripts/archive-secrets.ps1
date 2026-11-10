# 归档 secrets 内的大体积备份（需在普通/管理员 PowerShell 中运行，不要放沙箱里跑）
# 用法：
#   powershell -ExecutionPolicy Bypass -File F:\qqbot\scripts\archive-secrets.ps1 -WhatIf   # 只检查
#   powershell -ExecutionPolicy Bypass -File F:\qqbot\scripts\archive-secrets.ps1           # 真归档并删除原散文件
param([switch]$WhatIf)
$ErrorActionPreference = 'Stop'
$root = 'F:\qqbot\secrets'
$stamp = Get-Date -Format 'yyyyMMdd'
$targets = @(
  @{ dir = 'qq_history';                archive = "qq_history-$stamp.tar.gz" },
  @{ dir = 'git-backup-20261028-1723'; archive = "git-backup-20261028-1723-$stamp.tar.gz" }
)

foreach ($t in $targets) {
  $src = Join-Path $root $t.dir
  if (-not (Test-Path -LiteralPath $src)) { Write-Host "skip (missing): $src"; continue }
  $dst = Join-Path $root $t.archive
  if (Test-Path -LiteralPath $dst) { Write-Host "skip (archive exists): $dst"; continue }
  $sizeGB = ((Get-ChildItem -LiteralPath $src -Recurse -File -Force | Measure-Object Length -Sum).Sum) / 1GB
  Write-Host ("archive {0} ({1:N2} GB) -> {2}" -f $src, $sizeGB, $dst)
  if ($WhatIf) { continue }

  & tar -czf $dst -C $root $t.dir
  if ($LASTEXITCODE -ne 0) { throw "tar failed for $src (exit $LASTEXITCODE)" }

  # 校验：完整读一遍归档并列出条目，条目数必须大于 0
  $entries = (& tar -tzf $dst) | Measure-Object
  if ($entries.Count -lt 1) { throw "archive verification failed (empty listing): $dst" }
  Write-Host ("verified: {0} entries, {1:N1} MB" -f $entries.Count, ((Get-Item -LiteralPath $dst).Length / 1MB))

  Remove-Item -LiteralPath $src -Recurse -Force
  Write-Host "removed original: $src"
}
Write-Host 'done. restore: tar -xzf <archive>.tar.gz -C F:\qqbot\secrets'
