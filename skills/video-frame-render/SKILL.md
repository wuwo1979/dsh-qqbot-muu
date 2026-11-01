---
name: video-frame-render
description: 把分镜/文案 JSON 逐帧渲染成 mp4（中文竖屏 1080x1920 / 横屏 1920x1080），只靠 Python + Pillow + ffmpeg，不用浏览器、不用录屏。给 QQ 机器人插件做短视频时用：调用者只写一份十几行的 JSON，不写渲染代码，token 花在文案上而不是动画代码上。
---

# video-frame-render —— 分镜 JSON ➜ 逐帧渲染 ➜ mp4

一句话：**你只写 JSON，别写动画代码。** 版式、动画、字体、编码参数都已经固定在这个 skill 里。

## 四条出片路子（2026-10-31 起本 skill 覆盖四条，浮窗「视频路子」选择默认值）

| 路子 | 引擎 | 适合 | 入口 |
|---|---|---|---|
| A · 前端截图拼帧（默认） | render.py：分镜模板 → PNG 帧 → x264 | 知识点卡片、数据播报、图文短片 | `render.py --storyboard sb.json --out out.mp4 --yes` |
| B · 文字排列组合 | render_text.py：纯 PIL 文字动画（打字机/弹字/滑入/波浪），不碰浏览器 | 金句、歌词、公告、快问快答 | `render_text.py --script sb.json --out out.mp4` |
| C · 算力画画 | render_art.py：numpy 粒子流场/叠浪/星轨，程序化生成 | 氛围片头、情绪片段、直播间背景 | `render_art.py --spec sb.json --out out.mp4` |
| D · Remotion 立绘动画 | render_remotion.mjs：DSH 自带 Remotion runtime，立绘整图程序化动作 | 桌宠透明 webm、立绘短视频 mp4 | `node scripts/render_remotion.mjs --spec spec.json`（**cwd 必须在 F:\qqbot**） |

- 默认路子读 `dshqqbot/.qqbot-extensions/bili-ops-config.json` 的 `video.route`（frames/text/art），浮窗可改；
  配置缺失或拿不到时用 A。
- B/C 的 JSON 同样**只写文件、正文只报路径**；C 有 `seed`，同 seed 同画面（可复现）。
- C 的分辨率 >720p 会自动降采样渲染再放大（速度优先）；要锐利就显式给 `"size":[720,1280]`。
- B/C 输出与 A 同一套编码规矩（bt709/tv、帧数核对），`verify.py --video` 同样适用。

## 路子 D · Remotion 立绘动画（2026-10-31 新增，桌宠透明 webm 用）

用 DSH 自带的 Remotion runtime（`%APPDATA%\dsh-desktop\harness\data\dsh-remotion\runtime`，
4.0.532，无需安装任何包）把 v1 立绘做成**整图程序化动作**——不重绘不拆图层，画风 100% 保真。

```powershell
# 必须在 F:\qqbot 下跑（Remotion 浏览器缓存按 cwd/package.json 定位，落别处会撞 dsh-remotion 只读 ACL）
node skills\video-frame-render\scripts\render_remotion.mjs --spec tmp\pet.json
```

spec 字段：`image`（立绘绝对路径，RGBA 透明底 png 最佳）、`motion`、`out`（.webm=透明 /
.mp4=不透明）、`seconds`、`fps`(30)、`width/height`(720/980)、`shadow`(true，脚下接地阴影)、
`bg`（mp4 底色；webm 桌宠保持空）。`motion` 预置 7 个（`remotion/PetAnim.jsx` MOTIONS）：
循环类 `idle-breathe`(3s)/`idle-float`(4s)/`sway`(2.5s)/`talk-nod`(1.5s)，一次性 spring 类
`happy-bounce`/`point-forward`/`lift-up`。循环动作 seconds 取周期整数倍可无缝循环（非整数倍
尾帧自动取模对齐）。

实测坑（已内建处理，动模板前先读）：
- 立绘必须拷进 bundle 的 `public/` 用 `staticFile('/input.png')` 加载——http 页面直接引 file://
  会被 Chromium 拦死（delayRender 永不 resolve）；且不能用裸 `/input.png`，404。
- **透明 webm 必须显式 `pixelFormat:'yuva420p' + imageFormat:'png'`**——这版 renderMedia 的
  `transparent:true` 不会自动切 pix_fmt，缺了就出无 alpha 的假透明（用 webm 里 BlockAdditions
  元素数量验 alpha：桌宠金标准素材 60~150 处，0~2 处即假透明）。
- 浏览器用本机 Chrome/Edge（`browserExecutable`），官方 chrome-headless-shell 下载源国内卡死。
- 模板工程 `remotion/` 通过 node_modules junction 指到 runtime（脚本自动建），Remotion root
  依 entryPoint 向上最近 package.json 解析，故 `remotion/package.json` 不能删。
- 速度参考：720×980@30 90 帧 ≈ 18~20s（含 bundle）；样片在 `tmp/pet-anim-test/`。

`--check` 做环境自检（runtime/junction/cwd 五项）。退出码：0 成功；2 用法/环境问题；其他=渲染失败。

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
├─ remotion/                    ← 路子 D 模板工程（node_modules 为自动建的 junction，勿手改）
│  ├─ index.jsx / PetAnim.jsx   ← Remotion 入口 + 7 动作库
│  ├─ package.json              ← Remotion root 锚点，不能删
│  └─ public/                   ← 渲染时自动拷入立绘
└─ scripts/
   ├─ render.py    ← 主入口：storyboard ➜ 帧 ➜ mp4/webp/gif
   ├─ render_remotion.mjs ← 路子 D：立绘 spec ➜ 透明 webm / mp4
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

## 2026-10-28 配音与草稿更新（bili_ops 管线）

- **配音引擎按任务可选**：`bili_ops action=plan` 新增 `dubbing` 参数（`gsv`=快/`breeze`=自然约10×实时/`index`=情感最足约20-30×实时）。宿主面板「🎙 配音」下拉和文稿草稿转任务都走它；不传就跟随 voice-config 全局。浮窗工单模板已同步。
- **渲染前自动预热**：dubbing 是 breeze/index 时，renderJob 开头先用一句短文本把引擎拉起来（index 冷加载 7~12 分钟），失败只记 warning 不挡单——首段配音不再撞冷加载超时。
- **文稿草稿箱**：`bili_ops action=draft`（op=save/list/get/del/submit）。灵感随手存（draftText 自由文本）、反复改（同 draftId 覆盖）、改好 `op=submit` 一键转视频任务（文本若是 `{title,desc,panels:[…]}` 脚本 JSON 就直传分镜，否则当选题自动扩写；默认 dubbing=breeze）。面板「账号管理」页有草稿箱 UI。数据落 `{storage.root}/script-drafts.jsonl`。
- **评论拉取定向**：comment-watch 的 biliCheck/biliList 支持 `sort`（latest/hot）+ `maxAgeHours` 时间窗 + `withSub`（楼中楼被动回复）——回复新评论利于抢前排，面板「视频雷达→评论巡检」和「账号管理→高赞评论」都加了筛选下拉。

## 2026-10-29 两阶段渲染 + 文案质量闸（主人实锤 w11g 单）

- **两阶段渲染（bili-ops renderJob 重构）**：阶段 1 全部出图 → 阶段 1.5 停 SD（draw-core stopServer）+ 适配层 `/admin/stop-backend` 停非目标 TTS 后端还显存 → 阶段 1.6 预热（梯队 **index→breeze→gsv**，出片偏好；适配层通用梯队 gsv 抢跑是滑档主因）→ 阶段 2 统一配音/文字帧/时间轴。背景：SD 出图占满 6GB 卡（free=354MB 实锤），index 15GB 权重靠共享显存分页 900s 载不完 → 预热超时滑 GSV，且 breeze-server 常驻 4.8GB 帮凶。
- **适配层 v2.3.2**：新增 POST `/admin/stop-backend`（body `{name}`，local-only），停单个后端不关适配层。
- **文案质量闸（renderJob）**：脚本总旁白 < 240 字（≈55s）自动 writeScript 重写（原稿当参考、briefing 注入，panels 提到 ≥12），失败放行原稿记 warning。根因：agent 硬凑「每屏≤26字」写出 7 屏 77 字 25 秒电报体。
- **script-writer 规格升级**：全片总字数 ≥ sec×4.3，每屏必须有实际信息（数字/例子/进展），禁空话；panels clamp 上限 8→14；prompt 加好/坏示例。
- **工单模板 v3**：文案质量红线段（信息覆盖 + 空话禁令 + 好旁白示范 + 屏数放开 9~14）+ 成片 ≥60s + 拒收重写机制说明。

## 2026-10-29 深夜：逻辑自审查出 2 个实锤 bug + 画质升级

- **Bug A 稀疏数组（实锤）**：出图段 `detail.panels[i] = {imageScore/pose}` 写在 push 之前 → 稀疏残骸排在 panels[0]（w11g meta.panels[0]={"pose":"talk.png"}、README "undefined. [?s] undefined"、字幕错位）。修：imageScore/pose 改暂存数组 imgScores/poseByShot，push 时带上。
- **Bug B 预热误判（高危）**：预热走 synthesize 会被两层降级骗过——适配层梯队（index 起不来 gsv 出声返 200）和 tts-core 的 edge-fallback（显存不够回在线语音）都返回 ok → 预热误判「index 热了」→ 整单配音走冷引擎再超时。修：全链路 `strict_engine`——tts-core body 加 strict_engine 且 strict 时禁 edge-fallback；适配层 v2.3.3 strict 时 chain=[native] 不接力；预热传 strict:true，全梯队失败明确落 gsv。
- **画质升级**：sceneMode 默认 procedural→ai（程序化渐变底是「空旷 PPT 感」主因，SD 离线时才兜底程序化）；出图分辨率竖屏 576×1024→640×1136、横屏 768×432→832×480（SD1.5 6GB 稳）。
- 隐私复扫：npm 包 539 文件 + 仓库 417 文件全过（files 白名单排除 tmp/ 备份）。
