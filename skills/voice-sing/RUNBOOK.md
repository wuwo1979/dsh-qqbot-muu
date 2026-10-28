# voice-sing 运行手册（RVC 唱歌/换声）

把一段歌拆成「人声 + 伴奏」，把人声换成目标音色，再混回一条 mp3。
全流程本机离线跑，不训练、不联网（除了首次装依赖/下模型）。

> 试听产物（链路验证，见文末「本次实测」）：
> - `F:\qqbot\tmp\sing-demo-luomi.mp3`（软糯）
> - `F:\qqbot\tmp\sing-demo-asa.mp3`（飒爽）

---

## 0. 目录约定

| 东西 | 路径 |
| --- | --- |
| 专用 venv（torch 2.1.1+cu118） | `F:\qqbot\.models\voice-sing-venv` |
| RVC 推理三件套（hubert/rmvpe/pretrained） | `F:\qqbot\.models\rvc-assets` |
| 音色模型（.pth + .index） | `F:\qqbot\.models\rvc-voices\<音色名>\` |
| 本手册的脚本 | `F:\qqbot\skills\voice-sing\scripts\` |
| ffmpeg（无 ffprobe） | `F:\qqbot\.venv-draw\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe` |

`rvc-assets` 里各文件的用途：

- `hubert_base.pt` — 内容特征提取（RVC 必需，**推理必需**）
- `rmvpe.pt` — 音高（f0）提取，`-me rmvpe` 用（**推理必需**）
- `pretrained_v2\f0G40k.pth` / `D40k.pth` — **训练用底模，推理完全不需要**，下它只是为了将来想训练时不缺件

> 结论一句话：只装 `hubert_base.pt` + `rmvpe.pt` + 一个音色 `.pth` 就能出声；
> 光有 `pretrained_v2` 是**出不了任何音色**的（它是通用声码器/主干权重，不含目标音色的音色信息），
> 所以「找不到公开音色模型」时不能拿 pretrained_v2 冒充成品。

---

## 1. 显存（6GB RTX 3060 Laptop 必读）

- demucs `htdemucs` 拆轨峰值约 3.5~4.5GB；RVC 推理（rmvpe + hubert + 合成器）约 2~2.5GB。
- **ollama 常驻聊天模型会抢走 2~4GB**，跑之前先卸：

```powershell
ollama ps                 # 看谁在占卡
ollama stop <模型名>      # 或 ollama stop --all
nvidia-smi --query-gpu=memory.free --format=csv   # 确认空闲 > 4.5GB
```

- 还是 OOM 就降 demucs 段长：`--segment 7`（默认已给 7）→ 更小更快但可能切出爆音；RVC 侧加 `-de cuda:0` 之外没有更省的开关，实在不行 `-de cpu:0`（慢 10 倍以上，但能跑完）。
- 本机实测：占用 5.3GB 空闲时，`--segment 7` 拆 10 秒的歌 + 换声 1.5 分钟能跑完。

---

## 2. 一次性安装（已经装好，重装照这个来）

```powershell
$py = 'F:\qqbot\.venv-draw\Scripts\python.exe'
& $py -m venv F:\qqbot\.models\voice-sing-venv
$venv = 'F:\qqbot\.models\voice-sing-venv\Scripts\python.exe'

# 1) torch/torchaudio（cu118）：本机 curl/IWR 的 TLS 是坏的，只能 python urllib 下 wheel
& $py F:\qqbot\skills\voice-sing\scripts\dl.py `
    'https://download-r2.pytorch.org/whl/cu118/torch-2.1.1%2Bcu118-cp311-cp311-win_amd64.whl' `
    'F:\qqbot\tmp\wheels\torch-2.1.1+cu118-cp311-cp311-win_amd64.whl'
& $py F:\qqbot\skills\voice-sing\scripts\dl.py `
    'https://download-r2.pytorch.org/whl/cu118/torchaudio-2.1.1%2Bcu118-cp311-cp311-win_amd64.whl' `
    'F:\qqbot\tmp\wheels\torchaudio-2.1.1+cu118-cp311-cp311-win_amd64.whl'
& $venv -m pip install --no-cache-dir --no-deps F:\qqbot\tmp\wheels\torch-2.1.1+cu118-cp311-cp311-win_amd64.whl
& $venv -m pip install --no-cache-dir --no-deps F:\qqbot\tmp\wheels\torchaudio-2.1.1+cu118-cp311-cp311-win_amd64.whl
& $venv -m pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple `
    filelock typing-extensions sympy networkx jinja2 fsspec

# 2) 推理依赖（demucs 拆轨 + rvc-python 换声）
& $venv -m pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple demucs rvc-python
# 也可直接：& $py scripts\install_rvc_deps.py torch deps verify
```

```powershell
# 3) 打 fairseq → transformers HuBERT 的补丁（装完 rvc-python 后必须跑一次，幂等）
& $venv F:\qqbot\skills\voice-sing\scripts\hubert_hf.py        # 把 hubert_base.pt 转成 HF 格式，落到 rvc-assets\hubert-hf
& $venv F:\qqbot\skills\voice-sing\scripts\patch_rvc_hubert.py # 改 utils.load_hubert + 往 site-packages 写 fairseq 桩包

# 4) demucs 权重（默认会下到 C:\Users\...\.cache\torch，沙箱不可写 → PermissionError）
& $py F:\qqbot\skills\voice-sing\scripts\dl.py `
    'https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th' `
    'F:\qqbot\tmp\torch-home\hub\checkpoints\955717e8-8726e21a.th'
```

版本钉子（踩过坑，别让 pip 自己升）：

| 包 | 版本 | 为什么 |
| --- | --- | --- |
| torch / torchaudio | 2.1.1+cu118 | 6GB 卡的 cu118 轮子，torch 2.6+ 的 `weights_only` 会拒绝老 .pth |
| numpy | 1.23.5 | demucs/rvc 顺手装的新 numpy 2.x 会让 torch 2.1.1 直接 import 失败 |
| scipy / numba / llvmlite / librosa | 1.11.4 / 0.58.1 / 0.41.1 / 0.10.2 | 与 numpy 1.23 配套 |
| faiss-cpu | 1.8.0 | 1.7.3 无 cp311 轮子；1.15.x 要求 numpy>=1.25 |
| transformers | 4.44.2 | 5.x 要求 torch>=2.6 |

`rvc-assets` / 音色模型用 `scripts\fetch_rvc_assets.py` 下（走 hf-mirror，带断点续传）。
注意 `rvc_python\base_model\rmvpe.onnx` 要留一个 **0 字节占位文件**，否则 `download_rvc_models()` 会去连 huggingface.co。
本机**不要**用 `curl` / `Invoke-WebRequest`：schannel 报
`SEC_E_NO_CREDENTIALS (0x8009030E)`；`pip` 直连 pytorch.org 还会假活卡住，所以 torch 单独走 `dl.py`。

---

## 3. 一句话跑完整条链路

```powershell
# 这三个环境变量是必须的（demo_pipeline.py 已自动带上，手动跑要自己设）
$env:OMP_NUM_THREADS  = '1'                          # 见 §5：不设会让 faiss 段死等十几分钟
$env:HF_HOME          = 'F:\qqbot\tmp\hf-cache'       # 否则 transformers 想写 E:\huggingface_cache
$env:TORCH_HOME       = 'F:\qqbot\tmp\torch-home'     # demucs 权重目录（默认在 C:\ 下，沙箱不可写）
$venv = 'F:\qqbot\.models\voice-sing-venv\Scripts\python.exe'
& $venv F:\qqbot\skills\voice-sing\scripts\demo_pipeline.py `
  --song F:\qqbot\tmp\sing-demo2\song.wav `
  --voice luomi=F:\qqbot\.models\rvc-voices\sucrose-luomi\sucrose_e100_s5400.pth`|F:\qqbot\.models\rvc-voices\sucrose-luomi\added_IVF902_Flat_nprobe_1_sucrose_v2.index `
  --voice asa=F:\qqbot\.models\rvc-voices\raiden-asa\ei_raiden_e110_s5060.pth `
  --pitch luomi=0 --pitch asa=-2 `
  --out-prefix F:\qqbot\tmp\sing-demo
```

实测耗时（10 秒素材、两个音色）：demucs 约 20s + 每个音色换声约 11s + 混音 <1s，**总计 48s**。

脚本内部三步（也可以拆开手动跑）：

```powershell
# 1. 拆人声/伴奏
& $venv -m demucs -n htdemucs --two-stems vocals --segment 7 `
    -o F:\qqbot\tmp\sing-demo-work F:\qqbot\tmp\sing-demo2\song.wav
#    -> F:\qqbot\tmp\sing-demo-work\htdemucs\song\{vocals,no_vocals}.wav

# 2. RVC 换声（-ip 是可选的 .index，能提相似度）
& $venv -m rvc_python cli `
    -i F:\qqbot\tmp\sing-demo-work\htdemucs\song\vocals.wav `
    -o F:\qqbot\tmp\sing-demo-work\conv-luomi.wav `
    -mp F:\qqbot\.models\rvc-voices\sucrose-luomi\sucrose_e100_s5400.pth `
    -ip F:\qqbot\.models\rvc-voices\sucrose-luomi\added_IVF902_Flat_nprobe_1_sucrose_v2.index `
    -de cuda:0 -me rmvpe -pi 0 -ir 0.6 -fr 3 -rmr 0.25 -pr 0.5

# 3. 混音出 mp3（-14 LUFS，带响度归一）
& $py F:\qqbot\skills\voice-sing\scripts\mix.py `
    --vocal F:\qqbot\tmp\sing-demo-work\conv-luomi.wav `
    --instrumental F:\qqbot\tmp\sing-demo-work\htdemucs\song\no_vocals.wav `
    --out F:\qqbot\tmp\sing-demo-luomi.mp3
```

参数速查（`rvc_python cli`）：

| 参数 | 含义 | 常用值 |
| --- | --- | --- |
| `-pi/--pitch` | 整体升降调（半音，整数） | 男转女 +12，女转女 -2~+2 |
| `-me/--method` | f0 提取 | `rmvpe`（默认最好）/ `harvest` / `pm` |
| `-ir/--index_rate` | 检索比重，越高越像但可能闷 | 0.5~0.75 |
| `-pr/--protect` | 保护清辅音/气声 | 0.33~0.5 |
| `-rmr/--rms_mix_rate` | 响度包络混合 | 0.25 |
| `-de/--device` | `cuda:0` / `cpu:0` | cuda:0 |

---

## 4. 音色模型（本地可用的两个）

| 名字 | 文件 | 来源 | 许可 |
| --- | --- | --- | --- |
| 软糯 luomi（原神·砂糖 sucrose） | `sucrose-luomi\sucrose_e100_s5400.pth` + `added_IVF902_Flat_nprobe_1_sucrose_v2.index` | `https://hf-mirror.com/1358Adrian/so-vits-svc-rvc-models`（`RVC_v2_Public_Models/`），上游 `https://huggingface.co/1358Adrian/so-vits-svc-rvc-models` | 仓库标注 **openrail**；底层是 miHoYo 游戏角色音色，**仅限本机个人试听，不可再分发/商用** |
| 飒爽 asa（原神·雷电将军 raiden） | `raiden-asa\ei_raiden_e110_s5060.pth`（无 .index） | 同上 | 同上 |

- 两个都是 v2 模型（48k），`-pi` 按需调：砂糖档高一点更甜（+1~+3），雷电将军压低更飒（-2~0）。
- 没有 `.index` 也能跑，只是相似度略降（`-ir` 会被忽略）。

---

## 5. 常见报错

| 现象 | 原因/处理 |
| --- | --- |
| `CUDA out of memory` | ollama 在占卡，先 `ollama stop`；或 demucs 加 `--segment 7`（更小） |
| `No module named fairseq` | `rvc_python` 依赖 fairseq 载 hubert；本机**没有 MSVC / Windows SDK**，fairseq 0.12.2 编不出来 → 走 `hubert_hf.py` + `patch_rvc_hubert.py` 的 HF HuBERT 兜底（已装好；重装 venv 后要重跑这两个脚本） |
| **换声时 GPU 30% 空转、5 秒音频跑十几分钟没结果** | faiss `.index` 与 torch 在 Windows 上 OpenMP 死锁。设 `OMP_NUM_THREADS=1`（`demo_pipeline.py` 已内置）→ 同样任务 11 秒 |
| demucs 报 `PermissionError: ...\.cache\torch\hub\checkpoints\*.partial` | 沙箱不许写 `C:\Users\...`。设 `TORCH_HOME=F:\qqbot\tmp\torch-home`，并按 §2 用 `dl.py` 预下权重 |
| `AttributeError: 'tuple' object has no attribute 'dtype'`（infer.py:145） | 这是**假报错**：`vc_single` 内部异常时返回 `(info, (None,None))`。真正原因在日志更上面几行 |
| `curl: (35) schannel ... SEC_E_NO_CREDENTIALS` | 本机 curl/IWR 的 TLS 坏了，下载一律用 `python scripts\dl.py <url> <dst>` |
| pip 卡在 `Downloading ... MB` 不动 | 大文件走 `dl.py` 下好 wheel 再 `pip install <wheel>`；`pip` 直连 pytorch.org 会假活 |
| `weights_only` / `UnpicklingError` 加载 .pth | torch 2.6+ 默认 `weights_only=True`；本机固定 torch 2.1.1 不会遇到 |
| demucs 报 `lameenc`/`ffmpeg` 缺 | demucs 只负责拆 wav，mp3 编码统一用上表的 ffmpeg 绝对路径 |
| 输出人声像"闷罐" | `-ir` 调低到 0.5、`-pr` 升到 0.5、确认输入是 16k mono |

---

## 6. 本次实测（2026-10-26）

- 环境：Windows / RTX 3060 Laptop 6GB / torch 2.1.1+cu118 / demucs 4.1.0 / rvc-python 0.1.5
- 试听素材：**没有**现成的可拆歌曲，用 GSV（本地 TTS，音色 `xiaolan_cute`）念 8 句「啦/啊」→ 拼成
  `F:\qqbot\tmp\sing-demo2\vocal.wav` → `make_demo_song.py` 按 16 音符变调排出旋律 + numpy 合成
  C-Am-F-G 伴奏 → `song.wav`（9.92s）。**这是链路验证，不是真唱的成品歌。**
- 流程：`demo_pipeline.py` = demucs 拆 → RVC 两个音色 → ffmpeg 混音。
- 产出（**都有声音，已验证 RMS/峰值/频谱重心**）：
  - `F:\qqbot\tmp\sing-demo-luomi.mp3` 9.93s / 233KB / RMS 0.12 / 频谱重心 1702Hz（软糯档偏亮）
  - `F:\qqbot\tmp\sing-demo-asa.mp3` 9.93s / 233KB / RMS 0.12 / 频谱重心 1315Hz（飒爽档压低 -2 半音后更沉）
  - 两条整体相关度 0.747（同一旋律、不同音色/音高），说明换声确实生效而不是复制原轨。
- 中间件在 `F:\qqbot\tmp\sing-demo-work\`：`htdemucs\song\{vocals,no_vocals}.wav`、`conv-luomi.wav`、`conv-asa.wav`、`pipeline.log`。
- 装完的体积：`voice-sing-venv` 6.22GB（33644 文件）、`rvc-assets` 919.5MB（6 文件，含 hubert-hf 导出版）、两个音色 211.4MB、demucs 权重 80.2MB。
