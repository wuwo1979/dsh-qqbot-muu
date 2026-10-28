---
name: local-tts
description: 本地中文语音生成（GPT-SoVITS 零样本音色克隆）落地包：OpenAI 形状适配层 + 假后端 stub + 5 组验收 + 安装脚本 + 回退 edge 的开关。用于把 QQ 机器人插件里走网页 edge-tts 的语音条换成跑在本机 6GB 显卡上的本地 TTS。
---

# local-tts —— 本机中文 TTS 落地包

给 `F:\qqbot\dshqqbot\.qqbot-extensions` 那套插件用的**本地语音后端**。
插件侧本来就走「OpenAI `/v1/audio/speech` 形状」的 HTTP 分支（`lib/tts-core.mjs:277-322`），
本包就是那个 endpoint 的真身：**GPT-SoVITS 的 `api_v2.py`（参数式 `/tts`）→ 适配层 → 真 mp3**。

## 什么时候用这个 skill

| 场景 | 用什么 |
|---|---|
| 想把机器人语音从 edge-tts（微软网页接口）换成本地模型 | 本 skill 全套走一遍 |
| 想用某个人的音色说话（5 秒样本零样本克隆） | GPT-SoVITS 路线（§1），`adapter/profiles.json` 加一条音色 |
| 只是想验证"插件 → HTTP → 音频"这条链路是否通 | `adapter/stub.py` + `scripts/verify.py`，**不需要显卡、不需要模型** |
| 本机没显卡 / 只要"能出声"的兜底 | 看 `tmp/tts-research.md` 的 Kokoro / MeloTTS 分支，再配本适配层 |
| 语音突然没了、怀疑本地服务挂了 | `GET /health` + `scripts/verify.py`，失败就回退 edge（§4） |

## 目录

```
skills/local-tts/
├─ SKILL.md                  ← 本文件
├─ adapter/
│  ├─ server.py              ← OpenAI 形状适配层（标准库实现，零依赖）
│  ├─ stub.py                ← 冒充 api_v2.py 的假后端（真 440Hz 正弦 wav）
│  └─ profiles.json          ← voice 名 → 参考音频/参考文本
└─ scripts/
   ├─ install_gpt_sovits.ps1 ← 拉代码/装依赖/下权重（支持 -WhatIf）
   └─ verify.py              ← 5 组验收，失败退出码 1
```

## 1. 起服务（真模型）

### 推荐方式：管家模式（2026-10-25 起，按需启停不占显存）

适配层（9881）内置**管家**：GSV/Breeze 平时一个都不跑（0 显存），插件来请求才现场拉起，
空闲 10 分钟自动关闭还显存（打游戏不抢卡）；启动前查 `nvidia-smi`，空闲显存不够
（GSV 要 ≥3.4GB / Breeze 要 ≥4.8GB）就回 503 说明原因，不会硬挤到 OOM。

```powershell
# 起（推荐用 detach 脚本：WMI 脱离会话，不受父进程退出影响）
powershell -NoProfile -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\detach-adapter.ps1          # 默认空闲10分钟
powershell -NoProfile -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\detach-adapter.ps1 30       # 空闲30分钟
# 或普通终端里手动：
& 'E:\Anaconda\python.exe' F:\qqbot\skills\local-tts\adapter\server.py --port 9881 --manage --idle-minutes 10

# 停（适配层+后端全停）
powershell -NoProfile -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\start-services.ps1 -Stop
```

- 插件侧不用改：voice-config.json 永远指 9881。第一条语音会冷启动（GSV 实测 ≈30s，
  客户端超时已放宽到 240s+），之后秒级；空闲被回收后再次冷启动。
- `/health` 里 `supervisor` 字段可看：显存余量、各后端运行中/空闲多久。
- 调参：`--idle-minutes`（回收阈值，0=不自动关）、`--need-gsv-mb / --need-breeze-mb`（显存门槛）、
  `--no-manage`（退回老行为：后端自己管自己）。
- 2026-10-25 实测：冷启动 28s→出 mp3；空闲 0.5 分钟档 54s 自动回收、显存 4.95GB 还回；
  门槛不够时 503 带友好提示且不 spawn。

### IndexTTS-2.5 情感档（2026-10-26 装完，全链路已通）

`backend: "index"` → `indextts_server.py`（:9890，POST /tts JSON → wav，bf16 约 5.9GB 显存）。
音色：`xiaolan_emo`（同小蓝参考音色）、`xiaolan_emo_soft`（happy 0.5 + calm 0.5，视频口播档）。
情感：`emo_vector` 八维 [happy,angry,sad,afraid,disgusted,melancholic,surprised,calm]；
多音字可用 `<音标>` 格式控制；语速 `duration`（0.5-2.0，越小越快）。
管家照管它：显存门槛 4600MB（6GB 卡基本只有不跑游戏才起得来）、冷启动等 420s。

**2026-10-26 实测（RTX 3060 Laptop 6GB，bf16，Low-VRAM 自动开启）：**
- 模型加载 48s；加载后常驻显存 5.9GB（几乎吃满 6GB 卡，跑它时别的 GPU 活都别想干）
- **合成速度 RTF ≈ 22-30（5.7s 音频 129s / 3.8s 音频 88s）——比 GSV 慢 ~25 倍**，
  首句还含 CUDA warmup。质量/情感确实好，但 QQ 即时语音等不起
- **分工结论：聊天语音走 GSV（1.5s 出 4s 音频），视频配音/读评论这类离线活才用 IndexTTS**
  （30s 解说稿约 10 分钟合成，可接受；出片时反正不用抢实时性）
- BigVGAN 自带 CUDA kernel 没编（本机无 MSVC cl.exe，日志有 `CalledProcessError(1, ['where', 'cl'])`），
  自动回退 torch 实现，只慢不坏；想提速装 VS Build Tools 后重跑可试

部署状态（全部就绪）：`index-tts-code/`=代码+venv（py3.11.13 + torch 2.8.0+cu128）；
`index-tts/`=权重 + `hf_cache/` 辅助资源（w2v-bert-2.0 2.3GB / bigvgan 449MB /
semantic_codec 177MB / campplus 28MB，hf-mirror.com 直链 curl 下载）。
安装坑备忘：uv 对 download.pytorch.org 的连接会僵死（缓存零增长假跑）——
torch/torchaudio 用 curl 直下 wheel 到 `wheels/` 后在 pyproject `[tool.uv.sources]` 指 path；
`requires-python` 收紧到 `>=3.11,<3.12`（本地 wheel 只有 cp311）；
服务启动要 `set MODELSCOPE_CACHE=F:\qqbot\.models\modelscope`（C 盘用户目录写不进）；
curl 测本机端口必须 `--noproxy "*"`（走代理会被拒 10061）。
自测：`curl -N --noproxy "*" 127.0.0.1:9890/health` 看 model_loaded:true。

### 手动常驻方式（老办法，适合"今天就想批量抽语音"）

```powershell
# ① 装（先看清楚它会干什么，再真跑）
powershell -NoProfile -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\install_gpt_sovits.ps1 -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\install_gpt_sovits.ps1

# ② 起 GPT-SoVITS（9880，参数式 /tts）
cd F:\qqbot\.models\gpt-sovits
$env:PYTORCH_CUDA_ALLOC_CONF='expandable_segments:True'
& 'E:\Anaconda\python.exe' api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml

# ③ 起适配层（9881，OpenAI 形状 + 负责 wav→mp3）
& 'E:\Anaconda\python.exe' F:\qqbot\skills\local-tts\adapter\server.py --gsv http://127.0.0.1:9880 --port 9881

# ④ 验收（上游不在时会 SKIP，加 --require-gsv 变成硬失败）
& 'E:\Anaconda\python.exe' F:\qqbot\skills\local-tts\scripts\verify.py --require-gsv
```

只想验证链路（无显卡/无模型）：

### Breeze TTS 2 量化变体（2026-10-25 补充下载）

主模型 `F:/qqbot/.models/breeze-tts2/breeze-tts-2-q8_0.gguf`（3.4GB）之外，
`F:/qqbot/.models/breeze-tts2/variants/` 里还有两份（来自 ModelScope `tardigrade4ai/Breeze-TTS-2.cpp`）：

| 文件 | 大小 | 用途（2026-10-25 同句实测：7.2s 音频） |
|---|---|---|
| `breeze-tts-2-q4_k.gguf` | 2.5GB | 省显存档：显存吃紧（比如 GSV 和 Breeze 同卡）时用它换 |
| `breeze-tts-2-q8_0-dd4.gguf` | 3.2GB | **提速档：50s vs 现役 q8_0 的 83s（快 40%）**，量化的是深度解码器（Breeze 慢的瓶颈正是它 15 步串行） |

换模型 = 重启 breeze-server 时换第一参数：`breeze-server.exe <gguf路径> --port 7860 --voices-dir F:/qqbot/voices`。
⚠️ breeze-server 会同时绑 `port` 和 `port+1` 两个口（7860+7861），再起第二个实例要用间隔 ≥3 的端口（比如 7864），否则双绑互相 reset 连接。
注意：-dd 变体连续生成超过 ~45 秒会逐渐发闷（官方说明），语音条这种短句场景无影响。

```powershell
& 'E:\Anaconda\python.exe' F:\qqbot\skills\local-tts\adapter\stub.py --port 9880 --seconds 1.2
& 'E:\Anaconda\python.exe' F:\qqbot\skills\local-tts\adapter\server.py --port 9881
& 'E:\Anaconda\python.exe' F:\qqbot\skills\local-tts\scripts\verify.py
```

> ⚠️ 普通终端里 `Start-Process` 起的服务随父 shell 存活没问题；但在 WorkBuddy/沙箱类宿主里
> 子进程会被 job 对象连带回收——那种环境请用上面的 `detach-adapter.ps1`（WMI 脱离）。

## 2. 接口

### 2.1 `model` 口径（2026-10-26 起统一，2.2.0+）

**浮窗/voice-config.json 里的 `model` 现在真的决定后端**（以前适配层根本不读它，
只按 voice 名猜——"切了模型没感觉"就是这个原因）。

| `model` 值（含别名） | 后端 | 端口 | 显存 | 速度 | 用途 |
|---|---|---|---|---|---|
| `edge`（`edge-tts`/`edgetts`/`microsoft-edge`/`online`） | **不在本地**，插件自己走 edge 分支 | — | 0 | 每句 0.3s | 没显卡 / 后端全挂时的兜底 |
| `gsv`（`gpt-sovits`/`gpt_sovits`/`gptsovits`/`sovits`） | GPT-SoVITS `api_v2.py` | 9880 | ≥3.4GB | 快：4s 音频 ≈1.5s | **聊天语音首选** |
| `breeze`（`breeze-tts2`/`breeze-tts-2`/`breeze_tts2`） | `breeze-server.exe`(gguf) | 7860 | ≥4.8GB | 慢：7s 音频 50~83s | 预设说话人（voice_name） |
| `index`（`indextts`/`index-tts`/`indextts2`/`index-tts-2.5`） | `indextts_server.py` | 9890 | 门槛 4.6GB，常驻 ≈5.9GB | 很慢：RTF 22~30 | 离线配音、要情感向量 |

解析规则（`Adapter.resolve()` + `normalize_model()`，全在 `adapter/server.py`）：

1. 请求体 `model` **非空 → 以它为准**，不再看 voice 猜后端。
2. `model` 为空/不传 → 按 `profiles.json` 里该 voice 的 `backend`。
3. voice 不属于目标后端、但它的参考音能复用（三个本地后端都吃参考音克隆）→ 保留音色，
   响应头 `X-Voice-Source: voice-reuse:index->gsv`；不能复用（如 `breeze_design` 只有
   instruction）→ 换该后端的 `engines.<backend>.default_voice`，标 `engine-default:...`。
4. `model=edge` → **400 `model_not_local`**（不是本地后端，edge 是插件侧的事），
   体里带 `available` 列表；未知值同样 400。

每次合成都在响应头回显实参，方便排查"到底切没切"：
`X-Model` / `X-Backend` / `X-Voice` / `X-Voice-Source` / `X-Speed` / `X-Pitch` / `X-Temperature` / `X-Encoder`。

```powershell
# 切到 GSV 的"软糯+升2个半音"派生音色（--noproxy 必须带，本机走代理会 10061）
curl.exe --noproxy "*" -s -D - -o F:\qqbot\tmp\a.mp3 `
  -X POST http://127.0.0.1:9881/v1/audio/speech `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"gsv\",\"input\":\"今天也要开心呀\",\"voice\":\"xiaolan_cute5\",\"response_format\":\"mp3\"}"
# → X-Backend: gsv / X-Voice: xiaolan_cute5 / X-Pitch: 2.0 / X-Speed: 1.0
```

### 2.2 请求级参数与 `custom` 派生音色

`profiles.json` 里每个 voice 可带 `speed` / `pitch`（半音）/ `temperature`；
另有一个 `custom` 段，用 `base` 指一个已有音色再覆盖几项，等于**不复制参考音就派生新音色**：

```jsonc
"custom": {
  "xiaolan_cute5": { "base": "xiaolan_cute", "pitch": 2 },      // 更软更亮
  "xiaolan_slow":  { "base": "xiaolan",      "speed": 0.88 }    // 放慢
}
```

- 请求里的 `speed` 是**乘数**（0.5~2.0），最终 = profile 的 speed × 请求 speed。
- `speed` 映射：GSV 直接传上游 `speed_factor`（`GsvBackend.supports_speed=True`）、
  IndexTTS 用 `duration=1/speed`、Breeze 不支持 → 用 ffmpeg `atempo` 后处理补。
- `pitch`（请求字段 `pitch_semitones`，或 profile 的 `pitch`）用 ffmpeg
  `asetrate=44100*2^(n/12)` + `atempo` 补时长，**三个后端都生效**。
- 响应体（`/admin/status` 的 `last`）会回显实际用的 `backend` / `voice` / `speed` /
  `pitch` / `temperature` / `elapsed_ms`。

### 2.3 热加载

`profiles.json` 的 **mtime 变了，下一次请求自动重读**（`ProfilesStore`，不用重启进程）：
`GET /admin/status` 的 `profiles.reloads` 会 +1。想立刻强制重载：

```powershell
curl.exe --noproxy "*" -s -X POST http://127.0.0.1:9881/admin/reload
```

### 2.4 运维接口（**只允许 127.0.0.1**，别的机器来 403）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 版本/编码器/各后端探活/pid/profiles 版本/管家状态 |
| GET | `/voices` | 音色名 + 默认音色 + 后端 + engines |
| GET | `/admin/status` | pid、uptime、pid 文件路径、profiles 版本与 reloads、每个 voice 的 backend/speed/pitch、各后端 `reachable`、管家显存、最近一次合成实参 `last` |
| POST | `/admin/reload` | 强读 profiles.json |
| POST | `/admin/stop`（别名 `/shutdown`） | 优雅退出：先回 JSON，0.4s 后 `shutdown()`，`finally` 里回收**自己拉起的**后端并删 pid 文件 |

启动即写 `F:\qqbot\dshqqbot\.qqbot\tts\adapter.pid`（内容为**纯 pid 文本**，插件
`lib/tts-core.mjs` 读的就是它；旁边还有同名 `.json` 记录 port/version/启动时间），
退出时只删自己那份。`--no-pid-file` 可关掉（测试用），环境变量 `TTS_PID_FILE` 可改路径。

### 2.5 起停脚本

```powershell
# 起（WMI 脱离会话，不受父 shell 退出影响；参数=空闲回收分钟数）
powershell -NoProfile -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\detach-adapter.ps1 10
# 或普通终端手动
& 'E:\Anaconda\python.exe' F:\qqbot\skills\local-tts\adapter\server.py --port 9881 --manage

# 停（2026-10-26 新增）：读 adapter.pid → 优雅 /admin/stop → 超时才 taskkill /T /F
powershell -NoProfile -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\stop-services.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\stop-services.ps1 -KillBackends   # 连 9880/7860/9890 一起停
powershell -NoProfile -ExecutionPolicy Bypass -File F:\qqbot\skills\local-tts\scripts\stop-services.ps1 -WhatIf         # 只看会干什么
```

`stop-services.ps1` 参数：`-Root`、`-PidFile`、`-Port`(9881)、`-TimeoutSec`(12)、
`-KillBackends`、`-WhatIf`。会自检端口是否真释放，最后打印结论。

### 2.6 主接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, encoder, upstream_ok, voices, ffmpeg, bitrate_kbps}` |
| GET | `/voices` | 可用音色名 |
| POST | `/v1/audio/speech` | body `{model,input,voice,response_format,speed,pitch_semitones}` → `audio/mpeg` |

- `voice` 命中 `profiles.json` 里的键就用它；命中不了（比如 `zh-CN-XiaoxiaoNeural`）会宽松匹配，
  再不行落到 `default`。**音色不在名字上，在参考音频上。**
- `response_format: "mp3"`（默认）→ 转 mp3；`"wav"` → 直通上游 wav（调试用）。
- 上游失败时**原样透传**上游的状态码与 JSON 体，并带 `X-Error-Source: upstream`，
  插件看到的就是 `tts-http 400/502`。
- mp3 编码顺序：`lameenc`（进程内）→ `ffmpeg`（**文件模式**，不碰管道，避免沙箱 EPERM）。
  本机 ffmpeg 用的是 `F:\qqbot\.venv-draw\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe`。

### 2.7 常见报错对照

| 现象 | 原因 / 处理 |
|---|---|
| 400 `model_not_local` | `model` 写了 `edge` 或拼错；看体里 `available`。本地只有 gsv/breeze/index |
| 503 `tts_backend_unavailable` | 显存不够（或后端起不来）。消息里有"需要 X MB，当前 Y MB"；先卸 ollama / 关游戏再试 |
| 502 + `X-Upstream-Status` | 后端自己报错：看 `F:\qqbot\tmp\tts-<backend>.log` 与 `.err` |
| 客户端 `RemoteDisconnected` / 连接被重置 | 老坑：响应头写了非 latin-1 字符会让 `send_header` 抛异常并断连。2.2.0 起 `Handler._hdr()` 会对非 latin-1 值做 percent-encode，`X-Voice-Source` 也改成纯 ASCII |
| 改了 `profiles.json` 没生效 | 2.2.0 起按 mtime 热加载；还不行就 `POST /admin/reload`（看 `/admin/status` 的 `reloads` 有没有涨） |
| 服务关不掉 / 端口还占着 | 用 `stop-services.ps1`。日志里出现 `supervisor: WARN gsv 还占着 :9880（taskkill 返回 ...）` 表示 taskkill 被拒（权限/沙箱），需管理员窗口手动 `taskkill /PID <pid> /T /F` |
| `--manage` 退出却杀掉了自己没起的后端 | 2.2.0 起 `--no-manage` 模式只回收**本进程 spawn 的**（`Supervisor._kill(only_own=True)`），不按端口误伤 |

## 3. 切到本地 TTS（只改 4 个键，两行事）

`F:\qqbot\dshqqbot\.qqbot-extensions\voice-config.json`：

```jsonc
{
  "provider": "http",                                   // 原 "edge"
  "endpoint": "http://127.0.0.1:9881/v1/audio/speech",  // 原 9880 /v1/audio/speech
  "model": "gsv",                                       // 真正决定后端：edge/gsv/breeze/index（见 §2.1）
  "voice": "xiaolan",                                   // 必须是 profiles.json 里的键
  "maxChars": 40,                                       // 建议 70 → 40，本地合成更跟手
  "timeoutMs": 20000                                    // 保持
}
```

不用改任何代码：`tts-core.mjs` 的 http 分支原样接收 `audio/mpeg` 字节并落盘 `.mp3`。
（这也是为什么适配层**必须**吐 mp3 —— 插件 `:318` 不看内容只写文件，wav 冒充 mp3 就是
那条"语音 0MB/放不出来"的经典事故。）

## 4. 失败怎么回退

```jsonc
{ "provider": "edge", "voice": "zh-CN-XiaoxiaoNeural" }   // 一行回退，立刻恢复现状
```

判断顺序：`GET /health` 400/连不上 → 适配层没起；`upstream_ok:false` → GPT-SoVITS 没起；
`/v1/audio/speech` 返回 4xx/5xx 且 `X-Error-Source: upstream` → 模型侧问题（看
`F:\qqbot\tmp\gpt-sovits.err.log` 有没有 OOM）。任何情况下插件都只是"这条不发声"，不会崩。

## 5. 自测基线（本机实测，stub 后端）

| 项 | 实测 |
|---|---|
| `verify.py` 退出码 | `0`（5/5 PASS） |
| 上游 wav | 57644 B / 1.20 s |
| 适配层 mp3 | 7724 B / 1.25 s / ≈49 kbps / 头 `49 44 33` = ID3 |
| 端到端耗时 | 116 ms（含 wav→mp3 转码） |
| 负向（stub `--fail`） | 退出码 `1`，上游 400 JSON 原样透传 |

## 6. 省 token 的规矩

1. **别把 verify 全量输出贴进上下文**，只取这三行：`[3]` 的字节数、`[4]` 的时长/码率、`exit=`。
2. 起服务一律 `> log 2>&1` 重定向到 `F:\qqbot\tmp\`，**让工具读日志文件**而不是流式回显；
   长跑服务绝不用前台管道。
3. 调音色/参数时先 `stub.py` 验链路（0.2 秒一次），确认链路没问题再上真模型（每次 30~90 秒加载）。
4. `verify.py --json` 只输出一行摘要，适合当 CI/回归钩子；细节写进 `verify.json` 文件按需再看。
5. 报错只贴**状态码 + 上游 JSON 的 `Exception` 字段**，别贴整页 traceback。

## 7. 已知限制

- 显存 6 GB：v2Pro / v3 起步，`is_half: true`、`sample_steps: 24`；v4(48k)/v5 容易 OOM。
- 参考音频必须是**干声**（无 BGM、无混响），5~10 秒；`prompt_text` 要与音频逐字一致。
- Windows 版 GPT-SoVITS 需要 `ffmpeg.exe` 在仓库根；`ffprobe.exe` 需另一个 build（`winget install Gyan.FFmpeg`）。
- 本机是 **Windows PowerShell 5.1**（`pwsh` 不在 PATH），且默认执行策略 Restricted：
  跑 `.ps1` 要 `powershell -NoProfile -ExecutionPolicy Bypass -File ...`；
  `.ps1` 必须存成 **UTF-8 带 BOM**，否则中文会被按 GBK 解析成乱码并报语法错。
- 适配层是同步转发，单进程线程池；并发量大时给 `api_v2.py` 加 `--workers` 或换成 CosyVoice 的 async 服务。
