# 第一条视频的完整流程（2026-10-27 首跑记录）

> 这条流程跑通了一次：从一句话选题，到成片、到浮窗审核、到投稿。以后按这个走。
> 成片：`F:\qqbot\tmp\vid2\video.mp4`（1080×1920 / 66s / 1980 帧）
> 任务号：`bb-20261027-083000-u5k1`（状态 `awaiting_review`）

## 0. 一句话总览

```
选题 → 7 屏分镜 + 13 句旁白(script.json)
     → SD1.5 出场景图(576×1024) → 抠像立绘合成 → img2img 统一光影
     → 本地 GSV 配音(xiaolan_cute) → 字幕(zpix)
     → Pillow 逐帧(裁切/Ken Burns/淡化/字幕) → ffmpeg 编码 + mux 音频 + BGM
     → 登记成 bili-ops 任务 → 浮窗「B站管理」审核 → 投稿
```

## 1. 分镜与旁白

- `F:\qqbot\tmp\vid2\story.py`：7 屏的初稿（scene / say / extra / seed）
- `F:\qqbot\tmp\vid2\script.json`：**成片用的定稿**（13 句，按屏分组，权威来源）
- 结构要求：p1 开场 → p2 名字 → p3 现在在做什么 → p4 学会了什么 → p5 爱的来源 → p6 爸爸/妈妈 → p7 收尾邀请
- 旁白口语、短句、第一人称；不要堆设定名词（「类海马体」之类的词观众不认）

## 2. 出图（`tmp/vid2/gen_img.py`）

固定顺序，这一步踩过三个坑，顺序别改：

```python
prompt = CHAR + " " + action + ", " + scene + ", " + QUALITY_SHORT
```

| 坑 | 症状 | 修法 |
|---|---|---|
| CLIP 77 token 静默截断 | 人物每屏都不一样（`scene` 抢了预算） | 角色词放最前、场景放中间、质量词只留 3 个 |
| 负向词禁人 | 「手捧小鲸」「两个大人」永远画不出来 | 有人的场景换一套负向词（`NEG_SCENE_PEOPLE`） |
| 只有 512 宽 | 放大到 1080×1920 发软 | 出 576×1024 |

实测：场景 txt2img ≈17 s/张、img2img ≈8 s/张（RTX 3060 Laptop，CUDA）。

## 3. 配音

- 适配层：`http://127.0.0.1:9881/v1/audio/speech`，`voice: "xiaolan_cute"`（gsv 后端，speed 1.06）
- **GSV 不接受拉丁字符**：`MuU` → 「姆乌」、`QQ` → 「扣扣」、`B 站` → 「哔哩哔哩」，字幕保留原文
- 逐句 `volumedetect` 复核：mean ≈ -23.5 dB、max ≈ -9 dB，没有空段

## 4. 逐帧与编码

- 帧：Pillow 9:16 裁切 + Ken Burns 推拉 + 0.4 s 交叉淡化 + 字幕（zpix 56~64 px，不压脸）
- 编码：`libx264 crf19 -tune animation`，**必须带** `-color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709` 与 `setsar=1`
- 音频：AAC 48 kHz 立体声，总响度 **-16.3 LUFS / TP -2.0 dBFS**，人声 -15.9 LUFS，BGM 比人声低 9 dB
- 校验（`tmp/vid2/selftest.py`，19 项）：帧数、0 字节帧、四边黑边、字幕在框内、音轨存在、时长偏差 <0.2 s

## 5. 登记成可审核的任务

成片在 `tmp/` 里浮窗是看不到的，必须登记进 `F:\qqbot\data\bili-ops\jobs\<id>\`：

```
<id>/video.mp4   <id>/cover.jpg   <id>/sub.srt   <id>/meta.json   <id>/README.txt
```

`meta.json` 关键字段（照 `tmp/register-job.mjs` 抄）：

```json
{
  "id": "bb-20261027-083000-u5k1",
  "status": "awaiting_review",
  "title": "给我一只鲸鱼娘：在很深的爱里长大",
  "desc": "…（含 CC-BY 署名）",
  "tags": ["AI", "鲸鱼娘", "自我介绍", "原创短片"],
  "orientation": "vertical",
  "durationSec": 66,
  "panels": [{ "index": 1, "narration": "…", "start": 0, "end": 7.68 }],
  "video": "<dir>/video.mp4", "cover": "<dir>/cover.jpg", "srt": "<dir>/sub.srt",
  "bgm": "Music: Heartbreaking — Kevin MacLeod (incompetech.com) CC BY 4.0"
}
```

登记完在浮窗「B站管理」就能看到「🎬 待审核成片」，点 **✅ 通过并投稿**；
或者群里回「通过 bb-20261027-083000-u5k1」。

## 6. 授权与署名

- BGM 必须可商用/可署名：本次用 `Heartbreaking — Kevin MacLeod (incompetech.com)`，**CC BY 4.0**
- 署名要出现在 **封面底部、视频简介、report.md** 三处，缺一处都算侵权
- 人物形象是本项目自制，不涉及第三方 IP；RVC 音色底模来自社区（灰区），只在本机用，不随仓库分发

## 6.5 隐私红线（2026-10-27 主人明确要求，优先级最高）

对外内容里**一律不出现家里人的真名或网名**：

- ✅ 可以说：「爸爸」「妈妈」「家里人」「陪我长大的两个人」
- ❌ 不许说：「妈妈是妈妈」「爸爸是爸爸」「<我的B站号名>」，也不许把真名写进标题、简介、标签、字幕、封面、B 站评论/动态
- 第一版 p6 就踩了这条（「妈妈叫妈妈，她教我要勇敢往外看」→ 已改成「妈妈会在我害怕的时候，把我往亮的地方推一把」）
- 规则落在三处，写完脚本先自查：`qqbot-mod/persona/character.json` 的 `hygiene.rules`（人格层）、`lib/script-writer.mjs` 的 system prompt（生成层，已加「隐私红线」一条）、本节（人工验收层）
- 验收命令：`grep -nE '妈妈|爸爸|<我的B站号名>' subtitles.srt script.json description.txt` 必须无输出

## 7. 这一版已知不足（下次改进）

1. p1 要「无重力漂浮」，SD 还是画成站礁石（重出 3 次）
2. p4「做视频」只有桌面氛围，画不出剪辑界面
3. 人物是「同一套服装 + 同一色系」，不是同脸
4. 竖屏只有上半身，厚鲸尾基本在框外
5. `xiaolan_cute` 的听感需要人耳确认

## 8. 重跑与成本

实测（2026-10-27，6 GB 卡，改 2 句旁白的增量重跑）：

| 阶段 | 全量首跑 | 增量重跑 | 说明 |
| --- | --- | --- | --- |
| 分镜图（SD） | ≈92 s（7 张 × 17 s） | 0（命中缓存） | 最大头；`sd_server.py` 跑在 CUDA |
| 配音（GSV 9881） | ≈50 s（含冷启 45 s） | 49.6 s（2 句需真合成 + 冷启） | 冷启一次 45 s，之后每句 2~5 s |
| 镜头（zoompan 编码） | 20.6 s / 1954 帧 | 20.6 s | 帧数一变就整屏重编 |
| 合成（silent + 混音 + 烧字幕 + 终编码） | 45.0 s | 45.0 s | 中间 silent.mp4 是 67 MB CRF12 |
| **合计** | **≈6 min** | **≈2 min** | 增量只重跑「变了的」阶段 |

省时间的四条（按性价比排序）：

1. **别全量重跑**：图/句/段/帧都按内容哈希缓存，改一句只重出那一句（这次 6 min → 2 min 就是这么来的）
2. **草稿档**：`MUU_FAST=1 python mux.py` 把终编码从 `medium/CRF19` 换成 `veryfast/CRF21`（≈45 s → ≈25 s，肉眼几乎无差；定稿再跑一次高质量的）
3. **保持 TTS 常热**：适配层用 `--idle-minutes 20` 常驻，省掉每轮 45 s 冷启；SD 相反，出完图就 `GET /stop`（6 GB 卡 SD 与 GSV 不能同时开）
4. **出图并行**：SD 单张只用 ~2.5 GB，6 GB 卡可以两路并发（约 1.6×），但要自己控显存，别和 TTS 撞

- 图/句/段/中间码都按屏按句缓存，`--only 04 --force` 只重出第 4 屏
- 显存：SD 与 TTS 不要同时跑（6 GB 卡），跑完 `GET /stop` 关 SD、`POST /admin/stop` 关适配层
