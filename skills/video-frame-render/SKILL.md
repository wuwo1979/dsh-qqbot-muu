---
name: video-frame-render
description: 把分镜/文案 JSON 逐帧渲染成 mp4（中文竖屏 1080x1920 / 横屏 1920x1080），只靠 Python + Pillow + ffmpeg，不用浏览器、不用录屏。给 QQ 机器人插件做短视频时用：调用者只写一份十几行的 JSON，不写渲染代码，token 花在文案上而不是动画代码上。
---

# video-frame-render —— 分镜 JSON ➜ 逐帧渲染 ➜ mp4

一句话：**你只写 JSON，别写动画代码。** 版式、动画、字体、编码参数都已经固定在这个 skill 里。

## 三条出片路子（2026-10-25 起本 skill 覆盖三条，浮窗「视频路子」选择默认值）

| 路子 | 引擎 | 适合 | 入口 |
|---|---|---|---|
| A · 前端截图拼帧（默认） | render.py：分镜模板 → PNG 帧 → x264 | 知识点卡片、数据播报、图文短片 | `render.py --storyboard sb.json --out out.mp4 --yes` |
| B · 文字排列组合 | render_text.py：纯 PIL 文字动画（打字机/弹字/滑入/波浪），不碰浏览器 | 金句、歌词、公告、快问快答 | `render_text.py --script sb.json --out out.mp4` |
| C · 算力画画 | render_art.py：numpy 粒子流场/叠浪/星轨，程序化生成 | 氛围片头、情绪片段、直播间背景 | `render_art.py --spec sb.json --out out.mp4` |

- 默认路子读 `dshqqbot/.qqbot-extensions/bili-ops-config.json` 的 `video.route`（frames/text/art），浮窗可改；
  配置缺失或拿不到时用 A。
- B/C 的 JSON 同样**只写文件、正文只报路径**；C 有 `seed`，同 seed 同画面（可复现）。
- C 的分辨率 >720p 会自动降采样渲染再放大（速度优先）；要锐利就显式给 `"size":[720,1280]`。
- B/C 输出与 A 同一套编码规矩（bt709/tv、帧数核对），`verify.py --video` 同样适用。

## 什么时候用 / 不用

| 场景 | 用它？ |
|---|---|
| QQ 群里发一条 10~40 秒的竖屏短视频（文案卡、知识点、数据播报、口播配图） | ✅ |
| 横屏教程片段、B 站静帧动画、把一段文案做成带字幕的短片 | ✅ |
| 需要真人视频、实拍素材剪辑、复杂 3D、逐字动效剪辑 | ❌ 这是另一类工具 |
| 需要"每帧都是新 AI 生成画面" | ❌ 这是视频生成模型，不是本 skill |
| 只要一张封面图 | ❌ 直接画图，别渲染视频 |

## 省 token 的硬规矩（违反就白干）

1. **不许输出渲染代码。** 不允许写 PIL/ffmpeg/HTML/Canvas 代码来"辅助"，一律走 `scripts/render.py`。
2. **不许把 storyboard JSON 全文贴回对话。** 用 `write` 工具直接写文件，正文只报路径。
3. **不超过 12 个 scene。** 一条片子 4~8 屏最好；文案长就拆成两条视频。
4. **先 `--dry-run` 再 `--yes`。** dry-run 会告诉你帧数/耗时/PNG 体积，避免渲完才发现要 900 帧。
5. **不要一张张看帧。** 要验收用 `--stills 0,90,300` 抽 3 张，或 `verify.py` 自动查。
6. **改了文案只重跑，不要改引擎。** 想换观感：改 `theme` 的四个颜色 / 换 `preset` / 换 `template`。

## 最小可用调用（照抄这 8 行）

```powershell
# 1) 写分镜（用 write 工具写到 tmp/sb.json，内容就是下面这十几行）
# 2) 试算
python skills\video-frame-render\scripts\render.py --storyboard tmp\sb.json --dry-run
# 3) 出片
python skills\video-frame-render\scripts\render.py --storyboard tmp\sb.json --out tmp\out.mp4 --yes
# 4) 自检
python skills\video-frame-render\scripts\verify.py --video tmp\out.mp4 --fps 30
```

最小 storyboard（3 屏 / 6.6 秒，竖屏）：

```json
{
  "preset": "vertical",
  "fps": 30,
  "subtitles": [{ "from": 0.0, "to": 2.0, "text": "一句底部字幕" }],
  "scenes": [
    { "template": "title",  "dur": 2.0, "text": { "title": "大标题", "sub": "副标题" } },
    { "template": "bullet", "dur": 2.6, "text": { "title": "三个要点", "lines": ["第一条", "第二条", "第三条"] } },
    { "template": "bignum", "dur": 2.0, "text": { "num": "23", "unit": "毫秒/帧", "caption": "单帧渲染耗时" } }
  ]
}
```

字段全表、5 个模板各自要哪些键 → `references/storyboard-schema.md`
动画原语（位移/缩放/淡入淡出/打字机/数字滚动…）→ `references/primitives.md`
踩过的坑（0 字节帧静默截断、色彩标签、编码顺序…）→ `references/pitfalls.md`

## CLI

### render.py（主入口）

| 参数 | 说明 |
|---|---|
| `--storyboard PATH` | 必填，分镜 JSON |
| `--out PATH` | 输出文件；mp4/webp/gif 由 `--format` 或后缀决定 |
| `--preset vertical\|horizontal` | 画幅预设，缺省读 JSON 的 `preset`（默认 vertical） |
| `--fps N` | 覆盖 JSON 的 fps；只允许 12/15/24/25/30/50/60 |
| `--audio PATH` | 音轨（wav/m4a/mp3）；音轨短于画面会自动补静音 |
| `--format mp4\|webp\|gif` | 没有 ffmpeg 时用 webp/gif 降级（动图，不是视频） |
| `--stills 0,90,300` | 只渲指定帧到 PNG，用来肉眼抽检 |
| `--frames-only` | 只出帧不编码（配合 `--out-dir`） |
| `--dry-run` | 只打印代价（帧数/耗时/PNG 体积/磁盘），不落盘 |
| `--yes` | 确认执行；**不加就只打印代价表并退出 3**（防手滑渲 900 帧） |
| `--jobs N` | 按帧区间开 N 个独立子进程并行（不用 multiprocessing.Pool） |
| `--crf N` / `--x264preset P` | 质量/速度，默认 20 / medium |
| `--keep-frames` | 保留中间帧（默认渲完就删，绝不污染仓库） |
| `--max-frames/--max-width` | webp/gif 降级模式的上限，默认 150 帧 / 540px |

### encode.py（独立可用）

```powershell
python scripts\encode.py --frames tmp\frames --out out.mp4 --fps 30 --audio bgm.m4a --expect 198
```

### verify.py（独立可用）

```powershell
python scripts\verify.py --video out.mp4 --expect-frames 198 --fps 30 --sample 6
```

检查：容器可解、分辨率、fps、时长≈帧数/fps、**色彩标签=bt709 tv**、实际帧数、抽帧查黑屏/纯色。

### check_env.py（新机器先跑）

```powershell
python scripts\check_env.py
```

报告 python/Pillow/ffmpeg 来源与 libx264/字体/磁盘，并给出"能不能出 mp4"的结论。

### record_screen.py（游戏/屏幕录制，2026-10-25 新增）

```powershell
python scripts\record_screen.py --out F:/qqbot/tmp/gameplay.mp4 --seconds 60
python scripts\record_screen.py --out clip.mp4 --window "无边框窗口化的游戏标题" --fps 30
```

ffmpeg gdigrab 轻量录制，不用 OBS。**游戏必须窗口化/无边框**（独占全屏抓不到）。
提前停：往 `<out>.stop` 写任意内容。沙箱/服务会话里没有交互桌面会产出 48 字节空片——
由 DSH 宿主（用户会话）调用时正常，首次真用先录 3 秒验一下。

### narrate_footage.py（录屏 + TTS 解说 → 成片，2026-10-25 新增）

```powershell
python scripts\narrate_footage.py --footage gameplay.mp4 --narration narration.txt --voice xiaolan
```

解说稿空行分段，一段一屏；每段调本地 TTS 管家（9881）配音，素材按段对齐（短则定格、
长则截断），顺序拼接后烧 SRT 字幕出片。全本地零云端。实测：12s 素材 2 段解说 → 13s 成片。
产物直接交 B 站投稿（`bili_ops` approve 流程）。

## 退出码（机器人侧据此分支）

| 码 | 含义 | 该怎么办 |
|---|---|---|
| 0 | 成功 | 发片 |
| 2 | 用法/JSON 不合法 | 修 JSON，别重试 |
| 3 | 需要 `--yes` 确认（或只剩降级能力） | 看代价表后加 `--yes` |
| 4 | 环境缺失（无 Pillow/字体） | 按提示装，或改 webp 降级 |
| 6 | 帧完整性失败（0 字节/缺帧，重渲后仍坏） | 查磁盘空间，重跑 |
| 8 | ffmpeg 编码失败 | 看 stderr；多半是 ffmpeg 没有 libx264 |
| 9 | 自检不合格（帧数不符/色彩标签错/黑屏） | 别发，先看 `verify.py` 输出 |

## 实测数字（本机 Windows + Anaconda py3.11.5 + ffmpeg 7.1）

- 1080x1920 / 30fps / 198 帧 / 6.6 秒：渲染 14.8 s（**74.8 ms/帧**，单进程）、编码 1.5 s、成片 **458 KB**。
- 同上加 `--jobs 2`：渲染 8.4 s（**42.6 ms/帧**）——并行是按帧区间开子进程，无共享状态。
- 加 6.6 秒 aac 音轨：成片 578 KB，编码 1.65 s。
- 无 ffmpeg 降级：198 帧动画 WebP（540x960）12.0 s / 262 KB。
- 中间帧约 51 KB/帧：60 秒（1800 帧）≈ 90 MB 临时空间、约 2 分钟渲染；`--dry-run` 会先报帧数与 PNG 体积。

## 目录

```
skills/video-frame-render/
├─ SKILL.md                     ← 本文件
├─ presets/vertical.json        ← 1080x1920 中文竖屏
├─ presets/horizontal.json      ← 1920x1080 横屏
├─ examples/selftest.json       ← 3 屏样例（自测用）
├─ references/storyboard-schema.md
├─ references/primitives.md
├─ references/pitfalls.md
└─ scripts/
   ├─ render.py    ← 主入口：storyboard ➜ 帧 ➜ mp4/webp/gif
   ├─ encode.py    ← 帧体检 + ffmpeg 编码 + 数帧核对（可独立跑）
   ├─ verify.py    ← 成片自检（可独立跑）
   ├─ check_env.py ← 环境探测
   ├─ timeline.py  ← 绘制引擎（背景/文字块/字幕/时间轴）
   ├─ templates.py ← 5 种版式，坐标不外露
   ├─ primitives.py← 动画原语（纯函数，只看 t）
   └─ common.py    ← ffmpeg 发现、媒体信息、帧常量、退出码
```

## 一句话原理

`render_at(scene, t)` 是**只依赖 t 的纯函数**：不读系统时钟、不用 requestAnimationFrame、不依赖上一帧。
所以可以跳帧、可以并开多个进程、可以断点续渲，同参数重渲逐像素一致——这也是为什么它比
"无头浏览器录屏"更快更稳（本机沙箱里 Chromium 根本起不来，见 `references/pitfalls.md`）。
