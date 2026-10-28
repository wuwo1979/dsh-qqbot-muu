# 动画原语（写进 `scene.anim` 数组即可，不写代码）

所有动画都是 `t` 的纯函数：给定本屏内秒数，状态唯一确定。
动画条目 = `{ "target": 目标块名, "kind": 原语, "at": 起始秒, "dur": 时长秒, ...参数 }`

```json
{ "template": "title", "dur": 2.4, "text": { "title": "逐帧渲染" },
  "anim": [
    { "target": "title", "kind": "slide_in", "dir": "up", "dist": "6%", "at": 0.1, "dur": 0.5, "ease": "easeOutCubic" },
    { "target": "bar",   "kind": "wipe_in",  "at": 0.55, "dur": 0.35 }
  ] }
```

## target 有哪些

| target | 对应的块 |
|---|---|
| `title` | title/bullet 的标题，quote 的 `quote` 正文（quote 版式正文就叫 `quote`） |
| `sub` | title 版式的副标题 |
| `lines` | **聚合**：所有 `line0/line1/...`（bullet 的列表行） |
| `line0`、`line1` … | bullet 的单行（想单独给某行加动画时用） |
| `quote` / `by` | quote 版式正文 / 出处 |
| `num` / `unit` / `caption` | bignum 的数字 / 单位 / 说明 |
| `text` | caption 版式的正文 |
| `bar` / `rule` / `qbar` / `nbar` | 强调条（title / bullet / quote / bignum） |
| `dot0`、`dot1` … | bullet 每行的圆点 |
| `all` 或 `*` | 展开成该屏所有块（慎用，容易一起动） |

## 原语表

| kind | 参数（缺省） | 效果 | 常用场景 |
|---|---|---|---|
| `fade_in` | — | 透明度 0→1 | 最稳的入场 |
| `fade_out` | — | 透明度 1→0 | 屏尾淡出 |
| `slide_in` | `dir`=`up`/`down`/`left`/`right`（`up`）、`dist`（`"8%"` 或像素数） | 从指定方向滑入 + 轻微淡入 | 标题、列表行 |
| `scale_in` | `from`（`0.92`） | 缩放 from→1 + 淡入 | 大数字、金句 |
| `typewriter` | `cps`（每秒字数）或 `dur` | 按字数逐个显示 | 引述、口播文案 |
| `wipe_in` | — | 从左向右擦出（宽度裁切） | 强调条、下划线 |
| `count_up` | `from`（0）、`to`（目标值）；可选 `value_fmt`（`"{:.0f}"`） | 数字从 from 滚到 to，中间值顶替目标块的**第一行** | bignum 的数字（`{ "template":"bignum", "text":{"num":"23"}, "anim":[{"target":"num","kind":"count_up","from":0,"to":23,"at":0.2,"dur":1.0}] }`） |
| `pulse` | `amp`（0.03）、`hz`（1.2） | 轻微呼吸缩放 | 强调、按钮感 |
| `shake` | `amp`（6）、`hz`（1.2）、`decay`（4） | 衰减抖动 | 警告、突出 |
| `stagger_fade` | `stagger`（0.25）、`dur`（0.4） | 每行依次淡入 | bullet 列表首选 |
| `underline_grow` | — | 同 wipe_in（语义别名） | 下划线 |

### 缓动 `ease`

`linear` / `easeOutQuad` / `easeOutCubic`（默认）/ `easeInOutCubic` / `easeOutExpo` / `easeOutBack`（带回弹）/ `easeInOutSine`。

- 入场统一用 `easeOutCubic`，别用 `linear`——匀速看起来像 PPT。
- 想要"弹一下"用 `easeOutBack`，但只给大标题/数字用，文字小的时候回弹会糊。

### 时间怎么写才不别扭

- `at` 是**本屏内**秒数（每屏从 0 开始），不是整条片子的绝对时间。字幕的 `from/to` 才是绝对时间。
- 入场动画 0.35~0.6 秒；`stagger` 0.15~0.3 秒/行；整组入场最好在 1.2 秒内结束。
- 屏尾不要补 `fade_out`：切屏本身就是硬切，加了反而拖沓。除非要跟下一屏做连续感。

## 不写 anim 时的默认

除 `caption` 外，默认是：

```json
[ { "target": "title", "kind": "fade_in", "at": 0.05, "dur": 0.45 },
  { "target": "lines", "kind": "stagger_fade", "at": 0.15, "stagger": 0.22 } ]
```

即"标题先淡入、列表逐行冒出"。**大多数片子这样就已经够用，不要为了炫技加一堆动画。**

## 现成组合（照抄）

列表屏，逐行上浮：

```json
"anim": [ { "target": "title", "kind": "slide_in", "dir": "up", "dist": "4%", "at": 0.05, "dur": 0.4 },
          { "target": "lines", "kind": "stagger_fade", "at": 0.25, "stagger": 0.2 } ]
```

金句屏，打字机 + 出处淡入：

```json
"anim": [ { "target": "quote", "kind": "typewriter", "cps": 14, "at": 0.2, "dur": 1.2 },
          { "target": "qbar",  "kind": "wipe_in", "at": 0.1, "dur": 0.4 },
          { "target": "by",    "kind": "fade_in", "at": 1.4, "dur": 0.4 } ]
```

数字屏，缩放弹入：

```json
"anim": [ { "target": "num",  "kind": "scale_in", "from": 0.86, "at": 0.1, "dur": 0.5, "ease": "easeOutBack" },
          { "target": "nbar", "kind": "wipe_in", "at": 0.5, "dur": 0.3 },
          { "target": "unit", "kind": "fade_in", "at": 0.6, "dur": 0.4 } ]
```

## 引擎里怎么实现的（想改代码时看）

- `primitives.py`：`State` 有 `alpha/dx/dy/scale/reveal/chars/value/pulse/visible` 八个通道；
  `apply_kind(state, anim, t, preset)` 就地改通道；`states_for(target, anims, t, preset, line_count, text_len)` 返回**长度 = 行数**的状态列表（`stagger_fade` 就靠它逐行延迟）。
- `timeline.py`：`draw_text_block` 把每个文字块画到独立小 RGBA 图层再 `alpha_composite`；
  `chars` 用跨行字符预算裁字数，`reveal` 用裁列，`scale` 重新算字号（不是拉伸位图，所以放大不糊）。
- 要不要加新原语：只改 `primitives.py` 的 `apply_kind` 与 `KIND_NAMES`，再在这里补一行文档。
