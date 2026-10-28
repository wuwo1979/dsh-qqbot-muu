---
name: voice-sing
description: 给「小蓝」做本地唱歌/换声：Demucs 拆人声 → RVC 换声（或纯变调）→ 混回 -14 LUFS 的 mp3。一条命令跑完，也可分步调参。当有人要「让机器人唱歌」「把这首歌换成她的声音」「翻唱」「干声换声」时用。
---

# voice-sing — 小蓝唱歌流水线

> **2026-10-26 更新**：真 RVC 换声已经装好并跑通，两个现成女声音色在
> `F:\qqbot\.models\rvc-voices\`，一键链路是 `scripts\demo_pipeline.py`，
> 解释器必须用 **`F:\qqbot\.models\voice-sing-venv\Scripts\python.exe`**（torch 2.1.1+cu118）。
> 完整安装/踩坑说明见同目录 **RUNBOOK.md**，本文件只讲怎么用。

三段式：**拆轨（Demucs）→ 换声（RVC，缺权重时降级变调）→ 混音（loudnorm -14 LUFS）**。

## 硬规则：每首歌都必须交代「原曲出处」

交付任何 cover 时，**必须在同一条消息里给出原视频 / 原曲链接**，并把它写进产物目录的 `sources.json`。
没有出处就不许交付 —— 主人要靠链接自己去对一遍"到底换没换声"。

`sources.json` 格式（放 `--out-prefix` 同目录，多个 cover 用数组）：

```json
{
  "cover": "cover-雾里.mp3",
  "song": "雾里",
  "artist": "姚六一",
  "source": {"platform": "bilibili", "bvid": "BV13v411V7Da", "url": "https://www.bilibili.com/video/BV13v411V7Da",
             "title": "姚六一《雾里》MV", "owner": "乐悦传媒", "duration_s": 253},
  "voice": "sucrose-luomi", "rvc_input_sr": 16000, "pitch_shift": 0,
  "made_at": "2026-10-27T08:00:00+08:00"
}
```

取歌用 `scripts\fetch_song.py`（B 站搜索 → 取 DASH 最高码率音轨 → 立刻落 `sources.json`）；
若主人直接给了本地 mp3，也要在 `sources.json` 里写 `source.type="local"` 与文件名。

## 0. 最快路径（已验证）

```powershell
$env:OMP_NUM_THREADS='1'; $env:HF_HOME='F:\qqbot\tmp\hf-cache'; $env:TORCH_HOME='F:\qqbot\tmp\torch-home'
$venv = 'F:\qqbot\.models\voice-sing-venv\Scripts\python.exe'
& $venv F:\qqbot\skills\voice-sing\scripts\demo_pipeline.py `
  --song F:\qqbot\tmp\sing-demo2\song.wav `
  --voice luomi=F:\qqbot\.models\rvc-voices\sucrose-luomi\sucrose_e100_s5400.pth`|F:\qqbot\.models\rvc-voices\sucrose-luomi\added_IVF902_Flat_nprobe_1_sucrose_v2.index `
  --voice asa=F:\qqbot\.models\rvc-voices\raiden-asa\ei_raiden_e110_s5060.pth `
  --pitch luomi=0 --pitch asa=-2 --out-prefix F:\qqbot\tmp\sing-demo
```

`OMP_NUM_THREADS=1` 不是可选项：不设时 faiss 索引 + torch 会在 Windows 上 OpenMP 死锁，
5 秒音频能卡十几分钟（`demo_pipeline.py` 已内部兜底）。

## 1. 分步 / 降级链路

```powershell
cd F:\qqbot\skills\voice-sing
& $venv scripts\check_env.py                       # 先看缺什么
& $venv scripts\split.py   --input song.mp3 --outdir work
& $venv scripts\convert.py --input work\vocals.wav --output work\conv.wav --mode rvc `
    --model F:\qqbot\.models\rvc-voices\sucrose-luomi\sucrose_e100_s5400.pth --pitch 0
& $venv scripts\mix.py     --vocal work\conv.wav --inst work\instrumental.wav --out cover.mp3 --target -14
```

（`pipeline.py` 也可以，`--vocal X --song X` = 同一首歌；它内部调上面三个脚本。）

每一步都打印 `[step] 完成 0.42s out=... bytes=... note=...`，加 `--json report.json` 落盘当证据。

## 依赖分三档（check_env 会告诉你在哪一档）

| 档位 | 需要什么 | 能干什么 | 本机状态（2026-10-26） |
|---|---|---|---|
| 0 零依赖 | 只要 ffmpeg（本机已有 7.1） | 中置消音拆轨 + 变调 + 混音 | ✅ 能跑（仅降级用） |
| 1 Demucs | `pip install demucs`（80MB 权重） | 真拆轨，音质从"凑合"到"能用" | ✅ 已装（htdemucs 权重在 `F:\qqbot\tmp\torch-home\hub\checkpoints\955717e8-8726e21a.th`） |
| 2 RVC | rvc-python + hubert/rmvpe/pth | 真换声，这才是"小蓝唱" | ✅ 已装并跑通（venv `F:\qqbot\.models\voice-sing-venv`） |

没装也**不会崩**：`--split-mode auto` 自动退到 center-cancel，`--convert-mode auto` 自动退到变调。

## 模型放哪（实际路径）

```
F:\qqbot\.models\rvc-assets\              # 推理三件套 + HF 版 hubert
  ├── hubert_base.pt         189,507,909B
  ├── rmvpe.pt               181,184,272B
  ├── pretrained_v2\         f0G40k.pth / D40k.pth（**只训练要，推理不用**）
  └── hubert-hf\             hubert_hf.py 导出的 transformers 格式（fairseq 缺失时的兜底）
F:\qqbot\.models\rvc-voices\              # 现成音色
  ├── sucrose-luomi\  sucrose_e100_s5400.pth + added_IVF902...index   （软糯）
  └── raiden-asa\     ei_raiden_e110_s5060.pth                        （飒爽，无 index）
```

`convert.py --model` 指到任意 `.pth` 就行，同目录下同名 `.index` 会被自动带上。

## 下载命令（本机 curl/IWR 的 TLS 是坏的，别用它们）

```powershell
$py = 'F:\qqbot\.venv-draw\Scripts\python.exe'
# RVC 三件套 + 音色（走 hf-mirror，带断点续传）
& $py F:\qqbot\skills\voice-sing\scripts\fetch_rvc_assets.py
# demucs 权重（不预下会试图写 C:\Users\...\.cache 而 PermissionError）
& $py F:\qqbot\skills\voice-sing\scripts\dl.py `
  'https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th' `
  'F:\qqbot\tmp\torch-home\hub\checkpoints\955717e8-8726e21a.th'
# fairseq 补丁（重装 venv 后必须重跑，幂等）
& $venv F:\qqbot\skills\voice-sing\scripts\hubert_hf.py
& $venv F:\qqbot\skills\voice-sing\scripts\patch_rvc_hubert.py
```

拉完用 `check_env.py` 核对字节数，不符就是下坏了/下成了 html。

## 6GB 卡怎么活（RTX 3060 Laptop 实测 3.6GB 空闲）

- Demucs 默认要 ~7GB，**必须给 `--segment`**：6GB 卡用 **7**（`htdemucs` 系列上限 7.8，脚本硬夹）。
- 脚本已自动设 `PYTORCH_NO_CUDA_MEMORY_CACHING=1`，能省一大块显存。
- 还不够就 `--device cpu`：Demucs CPU ≈ 音频时长的 1.5 倍（3 分钟歌约 4.5 分钟）。
- `-n htdemucs_ft` 质量略好但**慢 4 倍**，3060 上不划算，默认就用 `htdemucs`。
- 跑唱歌时把 Ollama / 其他占卡进程清掉，否则 GSV 和 Demucs 会抢显存。

## 坑（都是我踩过的，按疼的程度排）

1. **torch ≥ 2.6 的 `weights_only=True` 会让 RVC 的 .pth 加载失败**，报 `Weights only load failed` / `UnpicklingError`。所以唱歌单独用 `F:\qqbot\.models\voice-sing-venv`（torch 2.1.1+cu118），**别动主环境/GSV 的 torch**。另外本机没 MSVC/SDK，fairseq 编不出来，靠 `hubert_hf.py` + `patch_rvc_hubert.py` 走 HF HuBERT（重装 venv 后要重跑）。
2. **不设 `OMP_NUM_THREADS=1` 会死等**：faiss `.index` + torch 在 Windows 上 OpenMP 死锁，实测 5 秒音频跑 20 分钟无输出、GPU 空转 30%。设了就 11 秒。
3. **demucs 权重路径**：默认写 `C:\Users\...\.cache\torch\hub\checkpoints`，沙箱下 `PermissionError`。设 `TORCH_HOME=F:\qqbot\tmp\torch-home` 并用 `dl.py` 预下。
2. **loudnorm 不给 `print_format` 就完全静默**——不报错、不写任何响度数字。脚本已固定 `print_format=summary`。
3. **loudnorm 内部上采样到 192kHz**，后面不 `aresample=44100` 会输出 192k 的文件（体积爆炸、部分播放器不认）。
4. **人声是 mono、伴奏是 stereo 时 amix 会退化成 mono**。两路都先 `aformat=channel_layouts=stereo`，输出 `-ac 2`。
5. **变调必须先统一采样率再 `asetrate`**。ref_zh.wav 是 32kHz，直接按 44.1k 套公式会变成 +10 半音、时长也短一截。
6. **中置消音出来的伴奏是反相立体声，任何 mono 下混都会静音**（QQ 语音条 = mono = 一片死寂）。脚本用 `pan=mono|c0=0.5*c0-0.5*c1` 出单声道再复制成立体声，牺牲宽度换"哪里都能听见"。
7. **RVC 的 `--pitch` 是按半音的整数**，`+12` = 升高一个八度。女声参考要"更幼"通常是 **+3 ~ +6**。
8. 混音输出体积：3 分钟 192kbps mp3 ≈ **4.1MB**，QQ 语音条上限约 5MB/60s，**长歌要走文件不是语音条**。

## 实测性能（本机，8 秒与 3 分钟假数据）

| 环节 | 8s 曲 | 180s 曲 |
|---|---|---|
| split（center-cancel） | 0.12s | 0.39s |
| convert（pitch 变调） | 0.14s | 0.33s |
| mix（含 loudnorm 单遍） | 0.27s | **3.78s** ← 瓶颈 |
| 合计 | 0.6s | 5.8s（RTF 0.032，约 31× 实时） |

响度实测 **-14.2 LUFS / true peak -2.1 dBFS**（目标 -14，TP 上限 -1.5）。
装 Demucs 后 split 会慢到 3 分钟歌约 20~40 秒（GPU），换声 RVC 约 1~3 分钟。

## 授权提醒

Demucs = MIT（可自由用）。RVC 代码 MIT，但权重包附带「仅供研究使用，传播导出声音者自负全责」声明。

本机两个现成音色（砂糖 sucrose / 雷电将军 raiden）来自 HF `1358Adrian/so-vits-svc-rvc-models`
（标注 **openrail**），底层是 **miHoYo 游戏角色音色**——**只在本机自己听/群内玩，不要再分发，别商用**。
