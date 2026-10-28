# start-services.ps1 —— 一键拉起本地 TTS（Breeze TTS 2 + 适配层），并自检健康
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\start-services.ps1
#   powershell -ExecutionPolicy Bypass -File ... -Backend breeze|gsv|both|adapter -Stop
#
# 说明：
#   · 只起进程、写日志到 tmp\tts-*.log；不改插件配置（voice-config.json 自己填一次就行）
#   · **推荐 -Backend adapter**：只起轻量适配层（零显存），GSV/Breeze 由它按需拉起、
#     空闲 10 分钟自动关闭还显存、显存不够（在跑游戏）时拒绝启动并回说明。
#     下面 breeze/gsv/both 是手动常驻模式，适合"今天就想批量抽语音"的场景。
#   · 关掉本窗口服务会继续跑（Start-Process 独立进程），要停就 -Stop
[CmdletBinding()]
param(
  [ValidateSet('adapter', 'breeze', 'gsv', 'both')][string]$Backend = 'adapter',
  [int]$AdapterPort = 9881,
  [int]$BreezePort = 7860,
  [int]$GsvPort = 9880,
  [string]$Model = 'F:\qqbot\.models\breeze-tts2\breeze-tts-2-q8_0.gguf',
  [string]$Root = 'F:\qqbot',
  [double]$IdleMinutes = 10,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'

# 环境里同时存在 HTTPS_PROXY / https_proxy（大小写两条）时 Start-Process 会炸
# （"字典中的关键字: HTTPS_PROXY"）。先归一成一条大写。
foreach ($n in @('HTTPS_PROXY', 'HTTP_PROXY')) {
  $l = $n.ToLowerInvariant()
  $up = [Environment]::GetEnvironmentVariable($n, 'Process')
  $lo = [Environment]::GetEnvironmentVariable($l, 'Process')
  if ($null -ne $up -or $null -ne $lo) {
    $v = if ($up) { $up } else { $lo }
    [Environment]::SetEnvironmentVariable($n, $null, 'Process')
    [Environment]::SetEnvironmentVariable($l, $null, 'Process')
    [Environment]::SetEnvironmentVariable($n, $v, 'Process')
  }
}

$logDir = Join-Path $Root 'tmp'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
# GPT-SoVITS 的 venv（torch 2.7.1+cu118 走 anaconda-base.pth 复用，另有全部推理依赖）。
# 适配层是纯标准库，用同一个解释器起最省事；ffmpeg 由 server.py 自己找（venv-draw 的 imageio_ffmpeg）。
$pyGsv = Join-Path $Root '.models\gpt-sovits\.venv\Scripts\python.exe'
if (-not (Test-Path $pyGsv)) { $pyGsv = 'python' }
$py = $pyGsv
$adapter = Join-Path $Root 'skills\local-tts\adapter\server.py'
$breezeDir = Join-Path $Root '.models\breeze-tts2'
$breezeExe = Get-ChildItem $breezeDir -Recurse -Filter 'breeze-server.exe' -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty FullName

function Wait-Health([string]$url, [int]$seconds = 40) {
  # 注意：不要求 200。GPT-SoVITS 的 GET /tts 缺参数会回 400/500，但**能回 HTTP 就说明端口通了**。
  for ($i = 0; $i -lt $seconds; $i++) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
    } catch {
      $resp = $_.Exception.Response
      if ($resp -and [int]$resp.StatusCode -ge 400 -and [int]$resp.StatusCode -lt 500) { return $true }
      $tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port ([int]([uri]$url).Port) -InformationLevel Quiet -WarningAction SilentlyContinue
      if ($tcp) { return $true }
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

if ($Stop) {
  Get-Process -Name 'breeze-server', 'breeze-cli' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  # CIM 在某些沙箱里会被拒（PermissionDenied），退回按可执行文件路径匹配
  try {
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -like '*local-tts*adapter*server.py*' -or $_.CommandLine -like '*api_v2.py*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {
    Get-Process python* -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -like '*gpt-sovits*' -or $_.Path -like '*.venv-draw*' } |
      Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Write-Host '已停止本地 TTS 进程' -ForegroundColor Yellow
  return
}

Write-Host "== 启动本地 TTS（$Backend）==" -ForegroundColor Cyan

if ($Backend -eq 'adapter') {
  # 管家模式：只起适配层，GSV/Breeze 由它按需拉起/回收
  $adapterArgs = @($adapter, '--port', "$AdapterPort", '--manage', '--idle-minutes', "$IdleMinutes",
    '--breeze', "http://127.0.0.1:$BreezePort", '--gsv', "http://127.0.0.1:$GsvPort")
  Start-Process -FilePath $py -ArgumentList $adapterArgs -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'tts-adapter.log') -RedirectStandardError (Join-Path $logDir 'tts-adapter.err')
  if (Wait-Health "http://127.0.0.1:$AdapterPort/health" 40) {
    Write-Host "  ✔ 管家就绪 http://127.0.0.1:$AdapterPort（后端未起，首次语音会冷启动几十秒）" -ForegroundColor Green
  } else {
    Write-Warning "  ✘ 适配层没起来，看 tmp\tts-adapter.err"
  }
  return
}

if ($Backend -in @('breeze', 'both')) {
  if (-not $breezeExe) { Write-Warning "没找到 breeze-server.exe（$breezeDir）" }
  elseif (-not (Test-Path $Model)) { Write-Warning "没找到模型 $Model" }
  else {
    Start-Process -FilePath $breezeExe -ArgumentList @($Model, '--host', '127.0.0.1', '--port', "$BreezePort") `
      -WorkingDirectory (Split-Path $breezeExe) -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logDir 'tts-breeze.log') -RedirectStandardError (Join-Path $logDir 'tts-breeze.err')
    # 探活用 GET /health（实测 /v1/model 是 404；/health 返回 status/sample_rate/ws_port）
    if (Wait-Health "http://127.0.0.1:$BreezePort/health" 180) { Write-Host "  ✔ Breeze 就绪 :$BreezePort" -ForegroundColor Green }
    else { Write-Warning "  ✘ Breeze 没起来，看 tmp\tts-breeze.err" }
  }
}

if ($Backend -in @('gsv', 'both')) {
  $gsvDir = Join-Path $Root '.models\gpt-sovits\GPT-SoVITS-main'
  $api = Join-Path $gsvDir 'api_v2.py'
  if (-not (Test-Path $api)) { Write-Warning "没找到 GPT-SoVITS（$api）" }
  else {
    Start-Process -FilePath $py -ArgumentList @($api, '-a', '127.0.0.1', '-p', "$GsvPort") `
      -WorkingDirectory $gsvDir -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logDir 'tts-gsv.log') -RedirectStandardError (Join-Path $logDir 'tts-gsv.err')
    if (Wait-Health "http://127.0.0.1:$GsvPort/tts" 90) { Write-Host "  ✔ GPT-SoVITS 就绪 :$GsvPort" -ForegroundColor Green }
    else { Write-Host "  · GPT-SoVITS 首次加载较慢，看 tmp\tts-gsv.log" -ForegroundColor Yellow }
  }
}

$adapterArgs = @($adapter, '--port', "$AdapterPort", '--breeze', "http://127.0.0.1:$BreezePort")
if ($Backend -ne 'breeze') { $adapterArgs += @('--gsv', "http://127.0.0.1:$GsvPort") }
Start-Process -FilePath $py -ArgumentList $adapterArgs -WorkingDirectory $Root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'tts-adapter.log') -RedirectStandardError (Join-Path $logDir 'tts-adapter.err')
if (Wait-Health "http://127.0.0.1:$AdapterPort/health" 40) {
  Write-Host "  ✔ 适配层就绪 http://127.0.0.1:$AdapterPort/v1/audio/speech" -ForegroundColor Green
} else {
  Write-Warning "  ✘ 适配层没起来，看 tmp\tts-adapter.err"
}

Write-Host @"

插件侧只需要在 dshqqbot\.qqbot-extensions\voice-config.json 里填一次：
  "provider": "http",
  "endpoint": "http://127.0.0.1:$AdapterPort/v1/audio/speech",
  "voice": "xiaolan"    ← GPT-SoVITS（当前默认）；要 Breeze 就写 "breeze"

自检：node tmp\probe-tts-plugin2.mjs   （把 dataRoot 指到工作区 tmp 才能写文件）
停止：powershell -ExecutionPolicy Bypass -File $($MyInvocation.MyCommand.Path) -Stop
"@ -ForegroundColor DarkGray
