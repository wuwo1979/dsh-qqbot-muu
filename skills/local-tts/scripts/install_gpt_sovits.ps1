<#
.SYNOPSIS
  在 Windows 上落地 GPT-SoVITS（本地中文 TTS + 零样本音色克隆），并把 api_v2.py 起在 9880。

.DESCRIPTION
  默认目标路径 F:\qqbot\.models\gpt-sovits（不进 git 仓库）。
  只做三件事：拉代码 → 装 python 依赖 → 下权重；ffmpeg 与 6GB 显存调参单独提示。
  **支持 -WhatIf：只打印命令，不下载、不建目录、不改文件。**

.EXAMPLE
  pwsh -File scripts/install_gpt_sovits.ps1 -WhatIf          # 先看它要干什么
  pwsh -File scripts/install_gpt_sovits.ps1                  # 真跑
  pwsh -File scripts/install_gpt_sovits.ps1 -Cuda auto -SkipWeights
  pwsh -File scripts/install_gpt_sovits.ps1 -StartApi        # 装完顺便把 9880 起起来
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $Root = 'F:\qqbot\.models\gpt-sovits',
    [string] $Repo = 'https://github.com/RVC-Boss/GPT-SoVITS.git',
    [string] $Python = 'E:\Anaconda\python.exe',
    [ValidateSet('auto', 'cu118', 'cu124', 'cu128', 'cpu')]
    [string] $Cuda = 'auto',
    [string] $HfMirror = '',
    [switch] $SkipWeights,
    [switch] $SkipDeps,
    [switch] $StartApi,
    [int] $Port = 9880
)

$ErrorActionPreference = 'Stop'
# 日志与产物一律落在仓库 tmp/ 下（不污染 skills 结构）
$LogDir = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'tmp'
if (-not (Test-Path $LogDir)) { $LogDir = Join-Path $env:TEMP 'local-tts' }

function Say  ($m) { Write-Host "  $m" }
function Head ($m) { Write-Host "`n== $m ==" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }

function Invoke-Act {
    param([string] $What, [scriptblock] $Body)
    if ($PSCmdlet.ShouldProcess($What, '执行')) {
        & $Body
    } else {
        Say "(WhatIf) 跳过：$What"
    }
}

Head "0. 环境检查"
Say "目标目录 : $Root"
Say "python    : $Python"
Say "CUDA 方案 : $Cuda"
if (-not (Test-Path $Python)) { throw "python 不存在：$Python（用 -Python 指定）" }
$pyVer = (& $Python -c "import sys;print(sys.version.split()[0])")
Say "python 版本: $pyVer"
if ([version]($pyVer -replace '[^0-9.].*$','') -lt [version]'3.9') { throw "GPT-SoVITS 需要 python >= 3.9（推荐 3.10/3.11）" }

$gitOk = (Get-Command git -ErrorAction SilentlyContinue) -ne $null
Say "git       : $(if ($gitOk) { (git --version) } else { '缺失（后面会改用 zip 下载路线）' })"

$driveLetter = (Split-Path -Qualifier $Root).TrimEnd(':')
$freeGB = try { [math]::Round((New-Object System.IO.DriveInfo($driveLetter)).AvailableFreeSpace / 1GB, 1) } catch { $null }
if ($freeGB) {
    Say "磁盘剩余  : ${freeGB} GB（代码+权重约需 6~8 GB）"
    if ($freeGB -lt 8) { Warn "剩余空间偏小，权重下载可能失败" }
}

# ── 1. 代码 ─────────────────────────────────────────────────────────
Head "1. 拉 GPT-SoVITS 代码"
if (Test-Path (Join-Path $Root 'api_v2.py')) {
    Say "已存在 $Root\api_v2.py，跳过 clone"
} else {
    Invoke-Act "创建目录 $Root" { New-Item -ItemType Directory -Force -Path $Root | Out-Null }
    if ($gitOk) {
        Invoke-Act "git clone --depth 1 $Repo $Root" {
            git clone --depth 1 $Repo $Root
            if ($LASTEXITCODE -ne 0) { throw "git clone 失败（$LASTEXITCODE）：先确认网络/代理，或手动下载 zip 解压到 $Root" }
        }
    } else {
        Say "手动路线：下载 https://github.com/RVC-Boss/GPT-SoVITS/archive/refs/heads/main.zip"
        Say "          解压后把里面的 GPT-SoVITS-main\* 全部移动到 $Root"
    }
}

# ── 2. python 依赖 ──────────────────────────────────────────────────
Head "2. python 依赖"
$torchIndex = switch ($Cuda) {
    'cu118' { 'https://download.pytorch.org/whl/cu118' }
    'cu124' { 'https://download.pytorch.org/whl/cu124' }
    'cu128' { 'https://download.pytorch.org/whl/cu128' }
    'cpu'   { 'https://download.pytorch.org/whl/cpu' }
    default { $null }
}
if (-not $torchIndex) {
    # 本机已装 torch 2.7.1+cu118 —— 直接复用，别重装（重装容易把别的东西搞坏）
    $torchV = (& $Python -c "import torch;print(torch.__version__)" 2>$null)
    if ($torchV) {
        Say "检测到已装 torch $torchV；--Cuda auto 时不重装 torch"
        $torchIndex = $null
    } else {
        $torchIndex = 'https://download.pytorch.org/whl/cu118'
        Say "没检测到 torch，按 cu118 装（显式 -Cuda 可改）"
    }
}
if (-not $SkipDeps) {
    if ($torchIndex) {
        Invoke-Act "pip install torch torchaudio --index-url $torchIndex" {
            & $Python -m pip install --upgrade torch torchaudio --index-url $torchIndex
        }
    }
    Invoke-Act "pip install -r $Root\requirements.txt" {
        & $Python -m pip install -r (Join-Path $Root 'requirements.txt')
    }
    Invoke-Act "pip install huggingface_hub" {
        & $Python -m pip install --upgrade huggingface_hub
    }
} else { Say "-SkipDeps：跳过 pip" }

# ── 3. 权重 ────────────────────────────────────────────────────────
Head "3. 下载预训练权重（约 3~5 GB，一次性）"
if ($SkipWeights) {
    Say "-SkipWeights：跳过"
} else {
    $env:HF_ENDPOINT = if ($HfMirror) { $HfMirror } else { 'https://hf-mirror.com' }
    Say "HF_ENDPOINT=$($env:HF_ENDPOINT)（国内建议 hf-mirror.com；要走官方就传 -HfMirror https://huggingface.co）"
    Invoke-Act "下载 lj1995/GPT-SoVITS → $Root\pretrained_models" {
        & $Python -c "from huggingface_hub import snapshot_download as s; s('lj1995/GPT-SoVITS', local_dir=r'$Root\pretrained_models')"
    }
    Say "中文必须的 G2PW 模型：把 pretrained_models\G2PWModel 复制到 GPT_SoVITS\text\G2PWModel"
    Invoke-Act "放置 G2PWModel" {
        $src = Join-Path $Root 'pretrained_models\G2PWModel'
        $dst = Join-Path $Root 'GPT_SoVITS\text\G2PWModel'
        if (Test-Path $src) {
            New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
            if (-not (Test-Path $dst)) { Copy-Item -Recurse -Force $src $dst }
            Say "G2PWModel 就位"
        } else { Warn "没找到 $src；缺它中文会报错，手动从 HF 仓库下载 G2PWModel" }
    }
}

# ── 4. ffmpeg ──────────────────────────────────────────────────────
Head "4. ffmpeg（Windows 版 GPT-SoVITS 需要 ffmpeg.exe 在仓库根目录）"
$ffCandidates = @(
    'F:\qqbot\.venv-draw\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe',
    (Join-Path $Root 'ffmpeg.exe')
) + @((Get-Command ffmpeg -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }))
$ff = $ffCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($ff) {
    Say "找到 ffmpeg: $ff"
    if ((Resolve-Path $ff).Path -ne (Join-Path $Root 'ffmpeg.exe')) {
        Invoke-Act "复制 ffmpeg.exe → $Root" { Copy-Item -Force $ff (Join-Path $Root 'ffmpeg.exe') }
    }
    Say "注意：ffprobe.exe 需要单独的 build（imageio 那个只有 ffmpeg）；音色处理缺 ffprobe 时可忽略"
    Say "      要补齐：winget install --id Gyan.FFmpeg -e  （装完把 bin 下 ffmpeg/ffprobe 复制到 $Root）"
} else {
    Warn "没找到 ffmpeg；请 winget install --id Gyan.FFmpeg -e 后把 ffmpeg.exe/ffprobe.exe 复制到 $Root"
}

# ── 5. 6GB 显存推荐参数 ────────────────────────────────────────────
Head "5. 显存 6GB（RTX 3060 Laptop）推荐参数"
@(
    '用 v2Pro / v3 权重起步：v4(48k)、v5 更吃显存，6GB 上容易 OOM',
    'configs\tts_infer.yaml 里把 is_half 设为 true（fp16），device 保持 cuda',
    'sample_steps 降到 24（v3/v4 默认 32），质量掉得不多、速度快一截',
    'batch_size 保持 1，parallel_infer 保持 true，streaming_mode 保持 false',
    '起服务前设 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True（减少碎片 OOM）',
    '合成前关掉浏览器/画图模型；nvidia-smi 看到已用 >1.5GB 就先腾显存',
    'OOM 兜底：临时改 device: cpu（慢 10~20 倍，但一定能出音）'
) | ForEach-Object { Say "· $_" }

# ── 6. 起服务 ──────────────────────────────────────────────────────
Head "6. 起 api_v2.py（9880）"
$startCmd = "cd `"$Root`"; `$env:PYTORCH_CUDA_ALLOC_CONF='expandable_segments:True'; & '$Python' api_v2.py -a 127.0.0.1 -p $Port -c GPT_SoVITS/configs/tts_infer.yaml"
Say "手动启动："
Write-Host "  $startCmd" -ForegroundColor DarkGray
$apiLog = Join-Path $LogDir 'gpt-sovits-api.log'
Say "日志建议：  ... > `"$apiLog`" 2>&1"
if ($StartApi) {
    Invoke-Act "后台启动 api_v2.py（$Port）" {
        New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
        $env:PYTORCH_CUDA_ALLOC_CONF = 'expandable_segments:True'
        $p = Start-Process -FilePath $Python `
            -ArgumentList @('api_v2.py', '-a', '127.0.0.1', '-p', "$Port", '-c', 'GPT_SoVITS/configs/tts_infer.yaml') `
            -WorkingDirectory $Root -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $LogDir 'gpt-sovits.out.log') `
            -RedirectStandardError  (Join-Path $LogDir 'gpt-sovits.err.log')
        Say "api_v2.py pid=$($p.Id)  → http://127.0.0.1:$Port/tts"
        Say "首帧要等模型加载（约 30~90s），之后看 /tmp/gpt-sovits.err.log 有没有 OOM"
    }
}

Head "下一步（适配层 + 验收）"
@(
    "$Python `"$((Split-Path -Parent $PSScriptRoot))\adapter\server.py`" --gsv http://127.0.0.1:$Port --port 9881",
    "$Python `"$((Split-Path -Parent $PSScriptRoot))\scripts\verify.py`" --gsv http://127.0.0.1:$Port --require-gsv",
    '然后把 voice-config.json 的 provider 改成 "http"、endpoint 改成 http://127.0.0.1:9881/v1/audio/speech'
) | ForEach-Object { Say $_ }
Write-Host "`n完成（WhatIf 模式下什么都没做）" -ForegroundColor Green
