# stop-services.ps1 —— 把本地 TTS 真正关掉（适配层 + 它拉起来的 GSV/Breeze/IndexTTS）
#
# 为什么需要这个脚本：
#   「python 服务关不掉」的老毛病是**孤儿后端**——适配层是 python，后端 api_v2.py / indextts_server.py
#   也是 python，端口一被占住就再也起不来；而父 shell 退出后 Start-Process 起的进程会被
#   Windows 收编到别处，找人全靠猜。现在适配层启动时把 pid 写进
#   <数据根>\.qqbot\tts\adapter.pid，本脚本就按它认人：
#
#   1) 读 pid 文件 → 先 POST /admin/stop（适配层自己退出，且在 finally 里回收它拉起的后端）
#   2) 等它真的没了（默认 12 秒）
#   3) 还在就直接 Stop-Process（再不行 taskkill /T /F，连子进程树一起）
#   4) 最后按 pid 文件旁边的 adapter.json 里的端口二次确认 9881 已释放
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\stop-services.ps1
#   ... -KillBackends            连 9880/7860/9890 上的后端一起停（推荐，彻底还显存）
#   ... -Port 9881 -TimeoutSec 20
#   ... -WhatIf                  只看会杀谁，不动手
#
# 注意：PowerShell 执行策略默认禁止跑未签名脚本，必须带 -ExecutionPolicy Bypass -File。
[CmdletBinding()]
param(
  [string]$Root = 'F:\qqbot',
  [string]$PidFile = '',
  [int]$Port = 9881,
  [int]$TimeoutSec = 12,
  [switch]$KillBackends,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Continue'

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }

# pid 文件默认位置和插件（lib/tts-core.mjs）完全一致：<数据根>/.qqbot/tts/adapter.pid
if (-not $PidFile) { $PidFile = Join-Path $Root 'dshqqbot\.qqbot\tts\adapter.pid' }
$metaFile = [System.IO.Path]::ChangeExtension($PidFile, '.json')

Say "== 停止本地 TTS ==" Cyan
Say "  pid 文件: $PidFile"

# ── 1. 找出适配层 pid ───────────────────────────────────────────────
# pid 文件内容是纯数字（消费者 tts-core.mjs 也是这么读的），别往里塞 JSON。
$pidFromFile = 0
$meta = $null
if (Test-Path $PidFile) {
  $raw = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue)
  if ($raw -and $raw.Trim() -match '^\d+$') { $pidFromFile = [int]$raw.Trim() }
}
if (Test-Path $metaFile) {
  try { $meta = Get-Content $metaFile -Raw | ConvertFrom-Json } catch { $meta = $null }
}
if ($meta -and $meta.port) { $Port = [int]$meta.port }

$adapterProc = $null
if ($pidFromFile -gt 0) {
  $adapterProc = Get-Process -Id $pidFromFile -ErrorAction SilentlyContinue
  if ($adapterProc) { Say "  pid $pidFromFile 活着：$($adapterProc.ProcessName)" } else { Say "  pid $pidFromFile 已不在（残留 pid 文件）" DarkYellow }
}

# pid 文件可能过期/缺失：再按端口和命令行兜一层（CIM 可能被沙箱拒，失败就跳过）
$byCmdLine = @()
try {
  $byCmdLine = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like '*local-tts*adapter*server.py*') })
} catch {
  Say "  · CIM 不可用，只按 pid 文件认人" DarkGray
}
foreach ($p in $byCmdLine) {
  if (-not $adapterProc -or $adapterProc.Id -ne $p.ProcessId) {
    Say "  额外发现适配层进程 $($p.ProcessId)（命令行匹配）" DarkYellow
    if (-not $adapterProc) { $adapterProc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue }
  }
}

$adapterPid = if ($adapterProc) { $adapterProc.Id } else { 0 }

# ── 2. 先讲礼貌：POST /admin/stop ───────────────────────────────────
$stoppedGracefully = $false
if ($adapterPid -gt 0) {
  if ($WhatIf) {
    Say "  [WhatIf] 会 POST http://127.0.0.1:$Port/admin/stop 然后停 pid $adapterPid" Yellow
  } else {
    try {
      # 这段不用 Invoke-WebRequest 也能发，但沙箱里 IWR 是允许的（只是 TLS 会挂，本地明文没事）
      $body = '{}'
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/admin/stop" -Method POST -Body $body `
        -ContentType 'application/json' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
      Say "  POST /admin/stop -> $($r.StatusCode)" Green
    } catch {
      Say "  POST /admin/stop 失败（$($_.Exception.Message.Split([Environment]::NewLine)[0])），直接杀进程" DarkYellow
    }
    # 等它自己退：适配层 finally 里会回收它拉起的后端，给它时间
    for ($i = 0; $i -lt $TimeoutSec * 2; $i++) {
      if (-not (Get-Process -Id $adapterPid -ErrorAction SilentlyContinue)) { $stoppedGracefully = $true; break }
      Start-Sleep -Milliseconds 500
    }
    if ($stoppedGracefully) { Say "  ✔ 适配层已优雅退出（pid $adapterPid，约 $([math]::Round($i/2,1))s）" Green }
    else { Say "  ✘ 等了 $TimeoutSec 秒还没退，强制结束" DarkYellow }
  }
}

# ── 3. 还赖着就动手 ─────────────────────────────────────────────────
if (-not $WhatIf) {
  if (-not $stoppedGracefully) {
    foreach ($p in @($byCmdLine)) {
      if ($p) { Say "  taskkill /T /F $($p.ProcessId)"; & taskkill /PID $($p.ProcessId) /T /F 2>&1 | Out-Null }
    }
    if ($adapterPid -gt 0 -and (Get-Process -Id $adapterPid -ErrorAction SilentlyContinue)) {
      Say "  Stop-Process -Force $adapterPid"
      Stop-Process -Id $adapterPid -Force -ErrorAction SilentlyContinue
    }
    # 命令行里没匹配到、pid 也过期的情况：谁在听 9881 就杀谁
    $holders = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($h in $holders) {
      if ($h -and $h -ne 0) { Say "  端口 $Port 被 pid $h 占着 -> 结束" DarkYellow; & taskkill /PID $h /T /F 2>&1 | Out-Null }
    }
  }
  # pid 文件清掉（下次起来会重写）
  if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
  if (Test-Path $metaFile) { Remove-Item $metaFile -Force -ErrorAction SilentlyContinue }
}

# ── 4. 可选：连后端一起停（显存立刻还回来）────────────────────────────
if ($KillBackends) {
  Say "== 顺手停后端（9880 GSV / 7860 Breeze / 9890 IndexTTS）==" Cyan
  $backends = @(
    @{ Name = 'gsv'; Port = 9880; Match = '*gpt-sovits*api_v2.py*' },
    @{ Name = 'breeze'; Port = 7860; Match = '*breeze-server*' },
    @{ Name = 'index'; Port = 9890; Match = '*indextts_server.py*' }
  )
  foreach ($b in $backends) {
    $hit = @()
    try {
      $hit = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -and $_.CommandLine -like $b.Match })
    } catch { }
    $hit += @(Get-Process -Name 'breeze-server' -ErrorAction SilentlyContinue | Where-Object { $b.Name -eq 'breeze' })
    $pids = @($hit | ForEach-Object { $_.Id } | Where-Object { $_ } | Select-Object -Unique)
    # 端口占用法兜底
    $portPids = @(Get-NetTCPConnection -LocalPort $b.Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($pp in $portPids) { if ($pp -and $pids -notcontains $pp) { $pids += $pp } }

    if ($pids.Count -eq 0) { Say ("  · {0} :{1} 没有进程" -f $b.Name, $b.Port) DarkGray; continue }
    foreach ($pp in $pids) {
      if ($WhatIf) { Say ("  [WhatIf] 会停 {0} pid {1}" -f $b.Name, $pp) Yellow }
      else { & taskkill /PID $pp /T /F 2>&1 | Out-Null; Say ("  ✔ {0} pid {1} 已停" -f $b.Name, $pp) Green }
    }
  }
}

# ── 5. 收尾自检 ────────────────────────────────────────────────────
if (-not $WhatIf) {
  $still = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if ($still.Count -gt 0) { Say "✘ 端口 $Port 仍被占用（pid $(($still | Select-Object -ExpandProperty OwningProcess) -join ','))" Red; exit 1 }
  Say "✔ 端口 $Port 已释放，本地 TTS 已停止" Green
  if (-not $KillBackends) { Say "  （后端 9880/7860/9890 没动；要一起停加 -KillBackends）" DarkGray }
}
