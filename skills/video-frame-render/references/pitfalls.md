# 踩过的坑（都是本机实测复现过的，不是听说）

每条坑都写了：现象 → 根因 → 本 skill 里的对策。改引擎前先读完。

## 1. 0 字节 / 断号帧会让 ffmpeg **静默截断**，还返回成功

**现象**：渲了 45 帧，成片只有 0.33 秒（`Duration: 00:00:00.33`），ffmpeg 退出码 **0**，stderr 一个字都没有。

**复现**（两种都能触发）：

- 把 `n00010.png` 截成 0 字节 → 编码 rc=0，成片 10 帧 / 0.33 秒。
- 直接删掉 `n00010.png`（帧号断裂）→ 表现完全一样：rc=0、10 帧。

干净目录对照：`-f null -` 数到 `frame=45`、`time=00:00:01.50`。

**根因**：`image2` 解复用器遇到读不了的帧就停下，不报错；`-y` 又不会覆盖成失败。
宿主进程被强杀（OOM、Ctrl+C、沙箱回收）最容易留下 0 字节 PNG。

**对策（已进代码）**：

1. 编码前 `common.bad_frames()` 逐文件体检，`< 128 字节`（`MIN_FRAME_BYTES`）判坏帧。
2. `render.check_and_repair()` 把坏帧所在的**整屏重渲**（单帧重渲容易又踩同一个内存峰值），仍坏则退出码 **6**。
3. 编码后 `common.count_video_frames()` 用 `-f null -` 数出真实帧数与帧目录数量比对，不等则退出码 **9**。
4. 负向对照脚本 `tmp/_vt/neg_control.py`：故意截 0 字节 → 期望 6，已实测通过。

> 这条是最值钱的一条：没有它，你会发出一条"6.6 秒文案配 0.3 秒画面"的片子，而且所有命令都返回成功。

## 2. 色彩标签：只给编码器参数不够，滤镜链还要 `setparams`

**现象**：加了 `-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`，`ffmpeg -i` 回读仍是：

```
yuv420p(tv, bt709/unknown/unknown)
```

**根因**：那些是**编码器/容器**级标签，帧本身的色彩元信息没写。

**对策**：滤镜链里再打一遍，两者都要：

```
-vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv \
-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv
```

回读应变成 `yuv420p(tv, bt709, progressive)` —— 三个标签都在。`verify.py` 会检查这一项，不合格退出码 9。

（播放器对 `unknown/unknown` 的默认猜测不一致，QQ/手机端容易出现偏色，所以别省这一步。）

## 3. 本机没有 ffprobe —— 数帧用 `-f null -`

`imageio_ffmpeg` 只发 ffmpeg 不发 ffprobe，`where ffprobe` 也找不到。所以：

- 流信息（分辨率/fps/时长/色彩标签/音轨）：解析 `ffmpeg -i file` 的 **stderr**（`common.media_info()`）。
- 帧数：`ffmpeg -v error -i file -f null -` 抓 `frame= N`（`common.count_video_frames()`），可靠且不需要 ffprobe。
- 有 ffprobe 就用 `-count_frames -show_entries stream=nb_read_frames`，`common.find_ffprobe()` 会自动优先。

## 4. PowerShell 里 `python -c @'...'@` 会把引号吃掉

内联多行 Python 传参时，`fr=r"F:\..."` 到解释器变成 `fr=rF:\...`，直接 `SyntaxError`。
**对策：一切多行脚本都用 write 工具落 `.py` 文件再执行**，别用 `-c` 内联。本 skill 的所有脚本都是文件形式，也是这个原因。

## 5. 受限沙箱里 Chromium 根本起不来（所以没有浏览器路线）

实测两条都失败：

- Playwright 启 chromium：`PermissionError: [WinError 5] 拒绝访问`，栈在 `E:\Anaconda\Lib\asyncio\windows_utils.py:63 _winapi.CreateFile`（沙箱禁止命名管道）。
- 直接跑 `chrome-headless-shell.exe --headless --screenshot --virtual-time-budget=1000`：
  `FATAL:mojo\public\cpp\platform\platform_channel.cc:112] Check failed: 拒绝访问。 (0x5)`，退出码 1，耗时 6.6 秒。

**含义**：本机不可能走"HTML + 无头浏览器逐帧截图"的路线（Remotion / puppeteer / playwright 全部不可用，且 npm 装不了）。
Pillow 直出 PNG 是本机唯一稳定路线。同理，`multiprocessing.Pool` 也会因为命名管道被拒而挂，
所以并行渲染用**独立子进程**（`render.py --jobs N` 内部走 `subprocess.Popen`，按帧区间切分，无共享状态）。

## 6. ffmpeg 发现顺序：ms-playwright 那个**没有 libx264**

**现象**：编码报

```
Unrecognized option 'preset'.
Error splitting the argument list: Option not found
```

退出码 8（shell 里会看到 `rc=2880417800` 这种负数）。

**根因**：`C:\Users\...\ms-playwright\ffmpeg-1013\ffmpeg-win64.exe` 是 Playwright 的裁剪版，
只够录 WebM 屏，**不含 libx264**；而系统 python（Anaconda）里又没有 `imageio_ffmpeg`
（它只装在项目 venv 里）。

**对策**：`common.find_ffmpeg()` 按 `VFR_FFMPEG` → `imageio_ffmpeg`（当前解释器）→ 仓库内 `.venv*/.../imageio_ffmpeg/binaries/*.exe` → `PATH` → ms-playwright 的顺序找，
并且**每个候选都探一次 `-encoders` 有没有 libx264**，第一个能编 H.264 的胜出（结果缓存）。
一个都找不到 libx264 时，`render.py` 会提示改用 `--format webp`。

本机实际胜出的是：
`F:\qqbot\.venv-draw\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe`（FFmpeg 7.1，带 libx264/aac）。

## 7. 音轨 `-i` 必须放在图像输入后面、输出选项前面

**现象**：

```
Error parsing options for input file F:\...\tone.wav.
Error opening input files: Invalid argument
```

**根因**：把 `-i audio.wav` 写在了 `-c:v libx264 ...` 这些输出选项之后，ffmpeg 会把前面的选项当作**下一个输入**的选项。

**正确顺序**：

```
ffmpeg -y -framerate 30 -i n%05d.png -i audio.wav \
  -vf setparams=... -c:v libx264 ... -c:a aac -b:a 192k -shortest out.mp4
```

**附**：音轨比画面短时不能用 `-shortest` 硬切（会把画面截短），要先 `-af apad` 补静音；`encode.py` 会先量音轨时长再决定。

## 8. Windows 控制台中文日志乱码

Python 默认按 cp936 写 stdout，而 pwsh 按 UTF-8 读 → 日志全成 `������`。
`common.py` 在 import 时统一 `sys.stdout.reconfigure(encoding="utf-8")`。
自己写新脚本时也要走 `import common`，否则中文日志会花。

## 9. 背景"辉光"两次翻车（视觉坑）

1. 第一版：小画布画椭圆 → `GaussianBlur` → `Image.blend(img, glow, 0.16)`。
   问题：`blend` 是把整张图往"黑底+一个亮椭圆"上拉，**整幅背景被压暗 16%**，且小图放大后边缘出现可见矩形色带。
2. 第二版：`Image.radial_gradient` 缩放贴上。问题：radial 在自身四边并不为 0，
   贴图边界留下一条**硬边竖带**（`y=900` 那行扫到 x=447 处有 45→57 的突变）。
3. 现在：256 小画布上按解析式算 `(1-d/R)²` 衰减、`R` 留够边距，保证遮罩在画布边缘严格为 0，
   再 `Image.composite` 上色。扫行验证已无跳变。

**教训**：所有"贴图/贴遮罩"的合成，都要检查**贴图边界处是否连续**；用 `Image.blend` 做局部亮斑是错的，
要么 `composite`（带 alpha 遮罩），要么直接加色。

## 10. 磁盘与帧体积

- 中间帧 PNG 实测 **≈ 51 KB/帧**（1080x1920 深色背景 + 中文字）。30 秒 = 900 帧 ≈ 46 MB。
- 重负载帧（大渐变 + 大半径模糊 + 描边中文）单帧可到 **246 KB / 218 ms**（Pillow 的 `GaussianBlur(80)` 很贵）。
- 所以：`render.py --dry-run` 一定先看 `est_png` 与 `disk_free`；中间帧默认渲完即删，绝不写仓库根目录。

## 11. 帧数齐 ≠ 帧可用（自检必须有负向对照）

只检查"帧数对不对"是不够的，因为 **0.3 秒的片子和 6.6 秒的片子都可能是 198 个文件**（坏帧场景下不是，但反过来说：
帧数对也可能是全黑）。所以 `verify.py` 除了数帧，还：

- 查色彩标签；
- 抽 N 帧算 `mean` 与唯一色数：`mean < 2.0` 或唯一色 `< 400` 判黑屏/纯色（实测正常帧 mean≈28~35、唯一色 700~3600）。

**任何自检都要配一个"故意做错"的负向对照**，否则你不知道自检本身是不是失效了。
本仓库的负向对照：`tmp/_vt/neg_control.py`（0 字节帧 → 期望 6）、`tmp/_vt/t_bad.py`（断号帧 → 观察静默截断）。
