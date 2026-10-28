# storyboard JSON 字段表

一份 storyboard 就是一个 JSON 对象：`{preset?, fps?, theme?, subtitles?, scenes[]}`。
`scenes` 里每一屏只写 **版式 + 时长 + 文案**，坐标/字号/动画都不用你管。

```json
{
  "preset": "vertical",
  "fps": 30,
  "theme": { "bg": "#0B1020", "fg": "#FFFFFF", "accent": "#4EA1FF", "muted": "#A9B6CC" },
  "subtitles": [ { "from": 0.0, "to": 2.4, "text": "底部字幕" } ],
  "scenes": [ { "template": "title", "dur": 2.4, "text": { "title": "标题" } } ]
}
```

## 顶层字段

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `preset` | `"vertical"` \| `"horizontal"` | `vertical` | 竖屏 1080x1920 / 横屏 1920x1080 |
| `fps` | int | 30 | 只能 12/15/24/25/30/50/60；QQ 群发 24~30 足够 |
| `theme` | object | 取 preset | 只覆盖你写的那几个键：`bg` 背景 / `fg` 主文字 / `accent` 强调色 / `muted` 次要文字，都是 `#RRGGBB` |
| `subtitles` | array | 无 | 全局底部字幕，见下 |
| `scenes` | array | 必填 | 1~12 屏（建议 4~8），超过 12 直接报用法错 |

## scene 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `template` | string | 否（默认 `title`） | `title` / `bullet` / `quote` / `bignum` / `caption` |
| `dur` | float | 是 | 本屏秒数，> 0。30fps 下 2.0 秒 = 60 帧 |
| `text` | object | 是 | 文案，键取决于 template（见下表） |
| `anim` | array | 否 | 覆盖默认入场动画，见 `primitives.md`；不写就用默认（标题淡入 + 列表逐行淡入） |

### 五种版式各自要的 `text` 键

| template | 用途 | `text` 键 |
|---|---|---|
| `title` | 封面/大标题 | `title`（大字，居中）、`sub`（可选，副标题） |
| `bullet` | 要点列表 | `title`（可选，小标题）、`lines`（字符串数组，每行一条，建议 ≤5 条） |
| `quote` | 引用/金句 | `quote`（正文，竖排块左对齐）、`by`（可选，出处，渲染成 "— 出处"） |
| `bignum` | 数字冲击 | `num`（大数字）、`unit`（可选，单位）、`caption`（可选，说明） |
| `caption` | 纯文字屏 | `text`（或 `title`），居中多行 |

示例（每种一行，可以直接复制进 `scenes`）：

```json
{ "template": "title",   "dur": 2.0, "text": { "title": "逐帧渲染", "sub": "为什么比录屏省 token" } }
{ "template": "bullet",  "dur": 2.6, "text": { "title": "三个关键点", "lines": ["模板固定", "动画是时间的纯函数", "一行 JSON 换一条片子"] } }
{ "template": "quote",   "dur": 2.4, "text": { "quote": "帧数齐不等于帧可用。", "by": "实测记录" } }
{ "template": "bignum",  "dur": 2.0, "text": { "num": "23", "unit": "毫秒/帧", "caption": "1080x1920 单帧渲染耗时" } }
{ "template": "caption", "dur": 2.0, "text": { "text": "一段居中说明文字，会自动折行。" } }
```

## subtitles

| 字段 | 说明 |
|---|---|
| `from` / `to` | 秒，绝对时间轴（从整条片子开头算），也接受 `t0` / `t1` |
| `text` | 字幕内容；底部圆角半透明底条，自动折行，最多 2 行 |

- 自动 0.15 秒淡入淡出，不用自己写动画。
- 字幕与画面内容互不影响：`bignum` 屏也能盖字幕。
- 中文字幕一行建议 ≤ 18 字；超了会被折到第二行，第三行起被裁掉。

## 时长怎么配

- 一屏 1.8~3.0 秒最稳。低于 1.2 秒看着像抽搐，高于 4 秒观众走神。
- 字数与时长：`dur ≈ 字数 / 8`（中文口播语速），最低 1.8 秒。
- 单条片子总长建议 8~35 秒。60 秒 = 1800 帧 = 约 2 分钟渲染 + 1.5 GB 临时 PNG。
- `dur` 帧数换算：`frames = round(dur * fps)`，误差自动补到最后一屏，总帧数恒等于 `round(总时长 * fps)`。

## 常见 JSON 错误（render.py 会在退出码 2 报出来）

| 错误 | 提示原文（节选） |
|---|---|
| 缺 `scenes` | `storyboard 必须是 {scenes: [...]} 结构` |
| `scenes` 为空 | `scenes 不能为空` |
| 屏数过多 | `scenes=13 太多（建议 ≤8，>12 请拆成多条片子）` |
| 缺 `dur` | `scenes[0] 缺 dur（秒）` |
| `dur` ≤ 0 | `scenes[0].dur 必须 > 0` |
| 版式名错 | `scenes[0].template='xxx' 不合法，只能是 ('title', 'bullet', 'quote', 'bignum', 'caption')` |
| 缺 `text` | `scenes[0] 缺 text` |
| fps 不支持 | `fps=29.97 不支持（12/15/24/25/30/50/60）` |

## presets/*.json 里有什么（想改样式才看）

版式坐标全在 preset 里，改 preset 就是改整条片子的观感，**不用碰代码**：

| 键 | 竖屏值 | 横屏值 | 作用 |
|---|---|---|---|
| `w` / `h` | 1080 / 1920 | 1920 / 1080 | 画幅 |
| `safe.x` | 72 | 120 | 左右安全边距 |
| `safe.top` / `bottom` | 220 / 340 | 110 / 130 | 上下安全边距 |
| `title_px` | 96 | 84 | title 版式标题字号 |
| `body_px` | 56 | 46 | bullet 列表字号 |
| `num_px` | 260 | 210 | bignum 数字字号 |
| `title_y` | 840 | 470（且 `vcenter: true`） | 标题中心 y |
| `subtitle_y` | 1540 | 900 | 字幕条中心 y |
| `font_bold` / `font_regular` | `C:/Windows/Fonts/msyhbd.ttc` / `msyh.ttc` | 同 | 中文字体（微软雅黑；换机器要换成有的字体） |
