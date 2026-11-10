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

## 一键入口：`scripts/sing.py`（2026-11-09 新增）

从"一个歌名"到"能发出去的一条语音/一个文件"，只跑这一条：

```bash
F:/qqbot/.models/voice-sing-venv/Scripts/python.exe skills/voice-sing/scripts/sing.py \
  --song "茶花开了" --style child --out F:/qqbot/tmp/sing/chahua-full
```

- `--style child` = 童真（luomi 音色 + **+3 半音**，带 faiss index）；`normal` = 原调。
  +2 偏大人、+4 会发尖飘，**+3 是甜而不飘那个位置**（2026-11-09 四调定的）。
- `--max-seconds 45` 只做前 45 秒（语音条用）；不给就整首。
- `--local <音频>` 跳过在线取歌。
- 产物固定：`<out>/cover.mp3` + `<out>/meta.json`（含原曲 B 站链接、音色、音高、时长、体积）。
- stdout 最后一行是 JSON，上游直接 `JSON.parse` 最后一行即可。
- `--skip-demucs` 复用 `<out>/work/htdemucs/` 里已经拆好的轨（只换音色时用）。

**实测（271s 的歌，6GB 卡）**：demucs 12s + RVC 约 50s + 混音 ≈ **73 秒整首出片**，6.3MB / 270.4s。

### 踩坑（继续往下加）

9. **本机执行环境不允许创建管道**：`subprocess.run(..., capture_output=True)` / `Popen` 默认 pipe
   会直接 `PermissionError: [WinError 5] 拒绝访问`（`_winapi.CreatePipe`）。所有子进程必须
   `stdout=文件句柄 / DEVNULL, stderr=STDOUT`，日志写文件再读回来。`sing.py`、`demo_pipeline.py`
   和 `tools/sing.mjs`（spawn 用 `stdio: ['ignore', fd, fd]`）都已经按这个改过。
10. **B 站搜索接口缺 `buvid3` 指纹会直接 412**（`HTTPError 412 Precondition Failed`）。
    `fetch_song.py` 现在先 GET 一次 `https://www.bilibili.com/` 把 `buvid3/b_nut/buvid4` 捞进 cookie。
11. **搜"歌名"最容易命中的是 40 分钟循环歌单**。`fetch_song.py` 加了 `--min-sec 60 --max-sec 420`
    按时长过滤（默认值），`sing.py` 不传就用默认。
12. **控制台是 GBK，日志里的 emoji 会把脚本带崩**：`demo_pipeline` 的输出含 `🌿` 之类，
    `sing.py` 里 `print(out)` 直接 `UnicodeEncodeError: 'gbk' codec can't encode character '\U0001f33f'`
    ——注意**封面其实已经生成好了**，是最后打日志才崩。已加
    `sys.stdout.reconfigure(encoding="utf-8", errors="replace")`（stderr 同）。改完记得
    `python -c "import ast; ast.parse(open(...).read())"` 验一下语法，别手滑把换行吃掉。
13. **平板 `/api/messages/voice` 的转码器是坏的**——喂 mp3/wav/amr（16k/24k/8k、8~96kbps
    全试过）一律返回 `{"success":true}`，但微信里放出来是**纯噪音**，24k 那次直接显示
    「语音未能转换」。**必须自己编 silk**：`ffmpeg -f s16le -ar 24000 -ac 1 → pcm` →
    `scripts/mksilk.mjs`（`node_modules/silk-wasm`，`encode(pcm, 24000)`，**没有码率参数**）
    → `.silk` → `send-direct.mjs --voice x.silk`。这条实测能正常播放。
14. **沙感的三个来源，按影响排**：① silk 码率固定（约 24kbps）——带伴奏必糊，伴奏抢比特；
    ② RVC `-ir` 太高（index 拉满颗粒明显）、`-fr` 太低（3 = 不平滑）；③ 换声残留的高频嘶声
    在 10k 以上，silk 本来就存不下。**当前定参**：`-ir 0.5 -fr 7 -rmr 0.25 -pr 0.33`，
    混音 `highpass=75,afftdn=nr=8:nf=-42,deesser=i=0.45:m=0.7,equalizer=f=7500:g=-3,lowpass=12000`。
    **语音条默认发清唱**（`work/conv-<voice>.wav` 干声），要伴奏就用 `--full` 发文件。

## 发出去：微信 / QQ 各一条路（2026-11-09 打通）

**微信（不用等 WCX v346）**：桥接把 v345 判成只读、`/wx/send*` 全 503，但**平板 3001 的
`POST /api/messages/voice` 是好的**。一键全链：

```bash
node skills/voice-sing/scripts/sing-deliver.mjs --song "茶花开了" --conv <wxid|xxx@chatroom>
node skills/voice-sing/scripts/sing-deliver.mjs --song "茶花开了" --conv <...> --full   # 整首按文件发
```

- 默认只唱 **45 秒**当语音条（微信语音条撑不住整首），`--full` 才整首走 `--file`。
- 产物落 `F:\qqbot\media\sing\<歌名>-<style>\cover.mp3`（本地留档）+ `sent.json`（发送台账）。
- 语音条走的是**自编 silk**：`cover.mp3`→pcm→`mksilk.mjs`→`cover-wx.silk`→`send-direct.mjs --voice`。
  `source: "vocal-dry"` 表示发的是清唱干声（默认），`"mix"` 是混音版。
- 平板其它发送路由：`/api/messages/{text,image,file,voice,emoji,video}`；`/audio`、`/silk`、
  `/sticker` 是 404（不存在）。

**QQ**：`dshqqbot/.qqbot-extensions/tools/sing.mjs`（工具名 `sing`，默认 45 秒语音条，`full: true` 走文件）。


## 授权提醒

Demucs = MIT（可自由用）。RVC 代码 MIT，但权重包附带「仅供研究使用，传播导出声音者自负全责」声明。

本机两个现成音色（砂糖 sucrose / 雷电将军 raiden）来自 HF `1358Adrian/so-vits-svc-rvc-models`
（标注 **openrail**），底层是 **miHoYo 游戏角色音色**——**只在本机自己听/群内玩，不要再分发，别商用**。
