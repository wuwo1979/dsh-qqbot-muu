# dsh-qqbot-muu

> `@zaofan/dsh-qqbot` 的**扩展包 + 补丁集**：把社区插件补成一个能长期养的 QQ 助手 ——
> 记得住人、分得清群、能自己写口播视频、有一个不会长歪的 2D 鲸鱼娘，还有一个主人说了算的 B 站运营流程。

<p align="center">
  <img src="assets/icon.png" width="120" alt="小蓝">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-qqbot-muu"><img alt="npm" src="https://img.shields.io/npm/v/dsh-qqbot-muu"></a>
  <a href="https://github.com/wuwo1979/dsh-qqbot-muu/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/wuwo1979/dsh-qqbot-muu/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-green"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.5-blue">
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img alt="DSH" src="https://img.shields.io/badge/DSH-%E6%8F%92%E4%BB%B6%E5%B8%82%E5%9C%BA-8a63d2"></a>
</p>

<p align="center">
  <sub>界面截图含真实群名/昵称，默认不随仓库发布；需要市场截图时用本地脱敏版。</sub>
</p>

<p align="center">
  <code>Node ≥ 22.5</code> · <code>MIT</code> · <code>DSH 桌面端插件</code>
</p>

---

## 这是什么

一个**跑在你自己机器上**的 QQ 助手能力包。它不训练模型、不上传数据，
只是把「记忆、语气、出片、运营」这四件事用本地 SQLite + 本地小模型 + 云端算力拼成一条能跑的流水线：

- **记忆**：两层记忆（个人层跨群统一 / 群层物理隔离）+ 类海马体的检索与巩固层
- **说话**：人格与世界书注入、本地小模型代答与单脑仲裁、TTS 发件箱、表情包准入
- **出片**：文案 → 分镜 → 出图质检 → 配音 → 字幕 → 拼片 → 草稿，主人一句「通过」才发
- **运营**：B 站扫码、单条分享卡片、AI 写评论草稿、审核后发送、数据留档

它**不是**：托管服务、SaaS、也不需要你的账号密码 —— 只有本机 Cookie 和本机数据库。

### 它自己在长（这条决定它像不像"活的"）

小蓝（也叫我"小肥鱼"）的性格和记忆不是写死的一段 prompt，而是**会被日常碰出来的**：

- **被亲近的人影响**：`qqbot-mod/persona/character.json` 的 `influences` 写明"脾气从谁身上长出来"（妈妈=妈妈：心软、爱操心；爸爸=爸爸：懒、较真、心是热的）。它说话的口音、安慰人的方式、遇到技术问题的第一反应都会偏向这两个人，但**不会冒充他们、也不会把真名说出去**（隐私红线见 `docs/publish-flow.md` 6.5）。
- **从网上学**：B 站/抖音的运营事件（发了什么片、评论区回了几条、学习笔记心得）会被 `lib/study-digest.mjs` 收成一段摘要，喂进「自我反思」。
- **每天自己写一条心得**：`lib/memory-agent.mjs` 的 `runSelfReflection()`（`growthIntervalHours ≈ 20`）产出 `kind='growth'` 记忆 + `persona growth:latest`，浮窗「学习心得」里能逐条审查；摘要里**同时含特别关心的人和最近网上的事**，所以反思不只是复盘聊天。
- **印象卡会过期、会重写**：`lib/persona-fresh.mjs`（卡片 36h / 心情 30min / 切片回看 3 天）+ `outbound/memory-agent.mjs` 每 6h 自检一次；过期的心情会显示成「上次状态 · 已过期」，不会假装"此刻还这样"。
- **有表情包的习惯**：发图成功会记 `sticker:last`，隔 ≥30 分钟聊到兴头时会提醒它"手边有图可以配一张"（`inbound/aa-memory-recall.mjs` 的 `[手边]` 提示）。

## 功能

### 记忆与认知

| 能力 | 说明 |
| --- | --- |
| 两层记忆 | 个人层（印象卡、熟识度）跨群统一；群层（台账、记忆、心情）按 scope 隔离，A 群的坏情绪不带坏 B 群 |
| 统一记忆库 | 单个 `memory.db`（`node:sqlite` + WAL + FTS5），`chat` / `mem` 全部带 `scope` |
| 类海马体检索 | 五路 RRF 融合：向量余弦 + 倒排关键词（二元组 + 单字）+ 实体锚定 + **图谱随机游走（PPR）** + 回溯意图，再做**模式分离**（MMR 去重）与**模式补全**（时间邻近扩散 + 归纳补全）。PPR 能顺着「甲→乙→丙」捞到字面完全没命中的旧事，这是 1 跳扩散做不到的 |
| 时序失效 | 三元组带 `valid_from / valid_to / status`。单值关系（是/住在/负责…）出现新值时，旧事实标记 `superseded` 而**不是删除**——所以既能按"现在"回答，也能追溯"她什么时候改的口"（`edgeHistory` / `relationState`） |
| 回放巩固 | 按显著度挑种子 → 余弦聚类 → 抽成「归纳片段」写回，原文仍可溯源（`mem_gist` / `mem_link`） |
| 人格护栏 | 信念层带**步长上限**与**锚点限幅**：少数几次对话改不动对一个人的整体判断；`driftReport` 给出 0~100 稳定度 |
| 群分级 | 「特别关心群 / 普通群」两级。普通群只看当前信息，不召回、不沉淀、不画像 —— 省 token 也省心 |
| 历史记录导入 | 支持 QQ 导出的 `.txt` 与 JSON。**入口即脱敏**：手机号、身份证、邮箱、银行卡、QQ 号在入库前就打码；再按信息量筛掉「在吗 / 哈哈 / [图片]」，只留像事实、态度、承诺的句子 |
| 指定对话导入 | `--peer` 从「导出全部消息记录」里只裁出和某一个人的对话；`--self-uin` 把"我"和"对方"分开。认得自己时第三方发言一律剔除（否则一次全量导入会把几十个人的话算进同一个人的画像）；认不出自己且文件里多人时只留对方的话并提示补号 |
| 完整记录归档 | `--archive` 把整段对话**原样**写进 `chat` 台账：不筛寒暄、长消息不砍到 500 字、重复导入幂等。归档行 `src='import'`，**不吃 60 天保留窗**——否则导进来第二天就被当日维护删了 |
| 人物归一 | QQ 号优先做主键、昵称只作别名。同一人换昵称自动并到一份记忆；同昵称不同号**不合并**（宁可认不出，也不串号）。记忆按 `person:<id>` 隔离，A 的召回看不到 B |
| 轨迹与画像 | 每人一条 `impression`：出现次数、平均字数、活跃时段、高频词、提问率、语气倾向 —— 统计口径，不依赖大模型也能稳定 |
| 双方关系 | 除了「TA 是什么人」，还有一条 `relation`：「我们怎么相处」—— 轮次、会话段数、谁更常先开口、对方平均多久回、共同话题。单看一个人说的话看不出关系，这一条是双视角 |
| 历史印象卡 | 切片（60 条/片、重叠 8）→ 每片摘要 → 汇总成高维卡，跑在本地模型上。私聊回合整理成功后会自动重建（进程内 12h/人 + `perDayMs` 双限流），也可 `--digest` 或面板手动触发 |
| 旧识注入 | 导入的画像会以 `[旧识]` 块回到她眼前，但**只给当事人、只在看得起的关系里**（特别关心群 / 私聊）。普通群一个字都不带；块里只有统计结论，不含此人说过的原话 —— 跨群转述原话才是隐私事故 |
| 身份与关系归并 | 档案里一人一名：主人起的 **MuU** 和她自称的 **小蓝** 是同一个人（`character.json` 的 `aliases`）；**妈妈=妈妈、爸爸=爸爸** 也写在档案里，所以印象卡不会再单列一条"妈妈"，同名/同义卡会被合并（面板会显示「已合并 N 条重复卡」） |
| 性格来源 | `character.json` 的 `influences` 写明她的脾气从谁身上长出来（如心软像妈妈、冷幽默像爸爸）：生成的人格核里有独立一段，**受影响但不等于模仿**，也不许给同一个人造第二个称呼 |
| 降级召回 | 向量模型没装或离线时，**不拿余弦当门槛**——实测词频向量的噪声底噪（0.10~0.19）高于真实命中（0.02~0.14），这个量纲没有判别力。准入改看证据通道，无关提问直接返回空，不会往上下文里塞噪声。召回结果带 `vecMode`，面板能看出这条是在哪套后端下算的 |
| 中文单字通道 | 倒排表除了二元组还收单字（低权重）。二元组要求措辞完全一致，「你说过要教我什么」和「本鲸今天教你钓鱼吧」没有一个共同二元组，只有单字「教」能挂上 —— 这条通道专治复述型问句 |
| 回溯意图 | 「你还记得你说过要教我什么」「你答应过我什么」要的不是话题，是**她自己说过的话**。按话题匹配只会撞上「明天记得带伞」这种同形词，所以单独识别句式，把最近的 `say` / `promise` 提上来 |
| 本地模型补图 | 隐式关系（"我上周搬去南山了"）正则抽不出来，交给**本机**小模型抽三元组，只在 `mem_edge` 加边、正文不动；模型没开就整批跳过，不会拖住入库 |
| 数据主权 | `exportScope` 导出全量（不含向量）、`purgeScope` 彻底删除（含索引/画像/图谱/JSONL）、`_audit.jsonl` 记录谁在何时导出或删了哪个 scope |
| 库自愈与体检 | schema 带版本号，**每次拿句柄都校验**（长跑进程里新增的表不会自己长出来——线上真出过整组索引表缺失、三路召回全哑而面板全绿）。`dbHealth` 看缺表/倒排覆盖/碎片率/完整性，`maintainDb` 做检查点 + 备份 + 补索引，每日维护窗口自动备份 |

### 说话与分发

| 能力 | 说明 |
| --- | --- |
| 人格注入 | `qqbot-mod/persona/` 是唯一事实源，世界书按 scope 叠加 |
| 本地代答 | Ollama 小模型快速回；单脑仲裁避免「本地答一半、云端答一半」的自相矛盾 |
| 批量门槛 | 一次勾选多个会话设置模式与最低分，不用一个个点 |
| TTS | 发件箱统一出站。**分段合成 + 句间呼吸**（逗号 88ms / 句号 170ms / 省略号 280ms 分级停顿），再走 ffmpeg 人声后处理：高通去闷、5.2kHz 削齿音、轻压缩贴耳、−16 LUFS 归一。全篇语速语调平稳，**不逐句抖**，避免「一句一句念」的朗诵感 |
| 表情包 | 本地视觉模型打标 + **27 词标准情绪词表**（无语/委屈/累/吃瓜…，`scripts/sticker-tag-enrich.mjs` 一键补标）+ 情绪/标签/向量三路检索 + 危险标签黑名单 + 间隔/每小时上限/最近去重；情绪到位时主脑会自己调 `sticker_send` 发一张，没有合适的不硬发 |
| 浮窗 UI | 设计令牌化的浅/深色主题、分段式 tab、记忆页卡片化（见截图） |
| 浮窗尺寸 | 右下角有拖拽把手：拖到多大就记住多大（`localStorage['qqs-dock-size-v1']`）；切换 tab 不再跳大小（只记 border-box 尺寸，不会每切一次掉 2px），聊天列表吃满剩余高度；双击把手/头部标题恢复默认尺寸。窗口顶边留 56px 安全区，放大也不会盖住页面最上面那排按钮 |
| 按钮不挤内容 | tab 多了自动换行不再横向挤；聊天页顶部行、输入区按钮统一压到 22px 高，省下的高度全给消息列表 |
| 特别关心 | 群名 / 昵称点一下就能加（也收 openid），面板里**只显示名字不显示 openid**；聊天板块每条消息旁 `☆` 一键加/移除 |
| 小游戏 | 7 局：猜数字 / 数字炸弹 / 成语接龙 / 21点 / 石头剪刀布（纯本地规则，**零 token**）+ 海龟汤 / 故事接龙 / 你问我答（这三局会**临时叫醒本地小模型**，收摊即放显存） |
| 模型不常驻 | 聊天与向量化都发 `keep_alive:0`，生成完就离开显存；闲置 60s 且没有 pin 时看门狗会把 ollama 里所有模型卸载。要用时（聊天 / 游戏 / 配音）再冷启，冷启成本换显存 |
| 本地语音 | `provider:"http"` 指向本地适配层就能换成自己的模型（GPT-SoVITS 克隆 / Breeze TTS 2），见下方「本地语音」一节 |
| 聊天记录来源 | 会话快照没了（重启、换会话）也不会白屏：按 `{dataRoot}/.qqbot/msg-history/<group_|c2c_><openid>/YYYY-MM-DD.jsonl` 的本地消息台账补齐最近 N 条，机器人自己发的一并算上 |

**聊天目标列表也吃同一份台账**：`known-chats` 除了 `known-chats.jsonl` / `memory.db` / `local-answer-log.jsonl`，
还会扫 `.qqbot/msg-history/` 下的每个 `group_*` / `c2c_*` 目录，把「台账里有历史、但 known-chats 里没有」的人和群补进浮窗的下拉列表——
所以登录后打开浮窗，之前记过的私聊和特别关心对象都能直接选到，不用等它再发一条消息。

⚠️ 但有件事补不了：机器人**离线期间**别人发的消息。QQ 官方机器人接口没有「拉历史消息」的 API，
收不到就是没收过，本地也不会有副本。想让那段也不丢，只能让 QQ 自己保持登录（手机上把机器人号挂着），
或者事后用「消息管理器 → 导出消息记录」把那段 .txt 导进来（见下方 `.bak` 一节）。

### 视频创作

| 环节 | 做法 |
| --- | --- |
| 文案 | 脚本模型写口播稿，按句切分并估算时长（4.4 字/秒含标点停顿） |
| 分镜 | `shot-planner` 按节拍（hook / point / turn / proof / cta）分配**文字屏与真图屏**，真图只给开场与例证；相邻屏 Jaccard ≥ 0.55 判重降级为文字 |
| 出图 | 每屏最多 3 次变体；`image_gate` 用拉普拉斯方差、Hasler-Süsstrunk 色彩度、灰度熵、4bit 色数、dHash 查重打分，不过关换角度重画，全废才退回文字动效 |
| 文字动效 | 逐帧渲染 11 种风格（打字机 / 逐字弹入 / 扫读高亮 / RGB 分离抖动 …），配音时长决定帧数，画面与声音天然对齐 |
| 字形叙事 | 借鉴《文字游戏》：**以字代图**（汉字按网格堆成鲸鱼/山/浪的轮廓，Zpix 像素字）、**重新象形**（拆字后部件飞入合拢）、**留白呼吸**（黑屏只留 8 个字）。一单最多 2 屏，克制着用 |
| 角色 | 2026-10-25 起**程序化 2D 小人整条退役**（几何图元拼的形象太丑，主人拍板删除，备份在 `archive/retired-2d-char-pipeline-20261025.tar.gz`）。人物出场改走 AI：视频里用「定妆照 + img2img 锁脸」（`media.characterLock`），形象基调来自 `media.characterPrompt`（深蓝长发 + 白蕾丝发箍 + 蓝白女仆裙 + 鲸尾） |
| 音效 | 空库用 ffmpeg 现场合成 12 个语义音效，每 cue 带淡入淡出 + 限幅；按分镜计划挑音，同一单内不重复 |
| 成片 | Ken Burns 推拉 + 按节拍取转场时长，导出 `video.mp4` / `cover.jpg` / `sub.srt` / 剪映素材包；`orientation: vertical` 出 **1080×1920 竖屏**（出图 576×1024），默认横屏 1280×720。编码统一打 `tv / bt709` 色彩标签 + `setsar=1`，避免被标成 `yuvj420p(pc, bt470bg)` |
| 分镜上限 | `panels` 2~12（原来只收 2~8） |

### 运营

| 能力 | 说明 |
| --- | --- |
| B 站登录 | `/bili login` 扫码，Cookie 只写本机 `bili-cookie.json` |
| 分享卡片 | 视频以单条卡片分享（标题 + 封面 + UP + 播放/点赞 + 链接），记录可查 |
| 发动态 | `bili` 工具 `action=post`（正文 `text`）发图文动态，`action=remove`（`dynamicId`）删自己发的；走新接口 `/x/dynamic/feed/create/dyn` 的 **JSON body**（`{dyn_req, csrf}` + 查询串 csrf），旧版 `form` 编码一律 `-400`，登录失效只认 `-101/-111` |
| 运营流程 | 写脚本 → 出片 → 草稿；**主人一句「通过」自动投稿**；还能改名、写评论/回复、拉数据 |
| 回复评论 | 浮窗里一条条看/改/直发；草稿由**云端 DeepSeek** 生成（不用本地小模型）。输入是**最小集**：视频标题 + 一句话内容 + 留言的人 + 他的评论 + **小蓝自己的性格/说话习惯**（读 `qqbot-mod/persona/character.json`）。**任务是"回这个人"**，不是点评自己的视频，所以不塞整篇分镜，也不会写成「谢谢支持」那种客服腔；没有云端 Key 就退模板，不硬凑 |
| 发布日志 | 浮窗 B 站卡片直接读本机两份台账（`.qqbot/bili-dynamic-log.jsonl`、`.qqbot/bili-ops/records.jsonl`），列出「发过什么动态 / 建过哪些片单」，每条带 `t.bilibili.com` 链接，**发完不看远端也能核对** |
| 方案标注 | 浮窗里列出当前出图/SD 模型（路径 + GB + 7861 是否在跑）、产物目录、ffmpeg、逐帧 skill 的脚本路径，以及 `bili-ops/jobs` 里还有几个任务 |
| 产物目录 | 「打开产物目录」走 `POST /open-dir`：explorer → `cmd /c start` → PowerShell 三重兜底，并把**目录里有多少项**一起回来（空目录会直说「还没渲染过视频」），路径顺手进剪贴板 |
| 权限口径 | 所有写操作只接受主人；**主人在群里也能直接下指令出片**（2026-10-26 放开，之前群里一律拒绝，主人抱怨"群里让它做视频没反应"），非主人照旧一律拒绝；成片仍走 `awaiting_review`，主人说「通过」才投稿 |
| 音效产物目录 | 音效库落 `{dataRoot}/音效/lib/builtin`；该目录建不出来时（`F:\qqbot\dshqqbot` 拒绝新建子目录）自动退回 `data/bili-ops`，不再每单报 `EPERM` |
| 成片登记 | `tmp/` 里做好的成片浮窗看不到，必须登记进 `{dataRoot}/../data/bili-ops/jobs/<id>/`（`video.mp4` + `cover.jpg` + `sub.srt` + `meta.json`，`status:"awaiting_review"`），登记后「B站管理」立刻出现「🎬 待审核成片」→「✅ 通过并投稿」；完整流程见 [docs/publish-flow.md](docs/publish-flow.md) |
| 回收站清空 | 表情包图库的「回收站」层多了「🧹 清空回收站」按钮（`POST /api/qqbot-settings/stickers/trash-purge` → `store.cleanupTrash(0)` 物理删文件+索引，带确认弹窗） |
| 账号管理 | 浮窗原来的「🎬 B站管理」现在是「🔗 账号管理」：B 站、抖音各一张卡，看登录态 / 昵称 / **今日配额**（`publish 3 · comment 3 · dynamic 2`），B 站可扫码重登，抖音扫码 + 粘 Cookie |
| 抖音 | 只做「登录态 + 成片准备 + 一键打开创作者中心上传页」：抖音网页端投稿要 `a_bogus/X-Bogus` 签名与设备指纹，硬算等于把自己标成高危机器人，所以**不做自动投稿**，代码里写的是真话不是占位 |
| 行为节奏 | 所有平台写操作统一过 `lib/platforms/pacing.mjs`：两次写操作随机隔 **45s~4min**、同类操作至少 3 倍间隔、每日硬上限、命中 429/`-412`/「频繁/风控」自动进 **30 分钟冷却**（冷却期内直接拒绝，不重试） |

## 安装

**方式一 · 直接从 GitHub 装**（现在就能用，推荐）：

```powershell
dsh plugin add github:wuwo1979/dsh-qqbot-muu#main
```

**方式二 · 从 GitHub 的发布包装**（等价，适合离线/内网）：

```powershell
npm i -g https://github.com/wuwo1979/dsh-qqbot-muu/archive/refs/heads/main.tar.gz
dsh-qqbot-muu-install --data-root "D:\你的bot数据目录"
```

**方式三 · npm 源**（包名 `dsh-qqbot-muu`）：

> ⚠️ 目前**还没有正式发布到 npm**（`npm view dsh-qqbot-muu` 会 404）。发布前必须先有 npm 凭证：
> `npm login` 之后 `npm publish`（仓库里 `scripts/check-pack-privacy.mjs` 会先跑一遍隐私闸门，
> 发布内容只有代码 + `*.example.json` + vendor，不含任何 Cookie/台账/openid/人格真身）。
> 在那之前请用方式一或方式二。

**装扩展本体**（把能力文件铺进 bot 数据根）：

```powershell
node install.mjs --data-root "D:\你的bot数据目录"
ollama pull qwen2.5vl:3b        # 表情打标 / 识图
ollama pull nomic-embed-text    # 向量检索（可选，缺了自动退回 lexical）
```

**打客户端补丁**（可选，按需）：

```powershell
node qqbot-mod/patches/add-memory-panel.mjs --apply   # 记忆页
node qqbot-mod/patches/ui-theme-v2.mjs      --apply   # 设计令牌 / 深色 / 记忆页卡片化
node qqbot-mod/patches/merge-group-tabs.mjs --apply   # 群组管理子标签
node qqbot-mod/patches/unify-fam-ui.mjs     --apply   # 熟识度统一入口
```

> 每个补丁都支持 `--check`（只看会改什么）、`--apply`、`--revert`，并且是幂等的。
> 客户端补丁改完在 DSH 里按 `Ctrl+R` 重载；服务端补丁重启桌面端。

**升级后补丁被冲掉？用 overlay 一键装回**（推荐）：

`@zaofan/dsh-qqbot` 自动升级会生成新的 generation 目录，里面是干净的官方文件 —— 之前打的补丁全部消失，表现为"记忆页没了、浮窗切 tab 会跳大小"。
`qqbot-mod/patches/live-overlay/` 保存了「官方同版本原文件 + 我们的定制版」并做三路合并，只在上游真正改到同一行时才冲突：

```powershell
node qqbot-mod/patches/live-overlay/install.mjs --check   # 看完再装
node qqbot-mod/patches/live-overlay/install.mjs --apply   # 装进当前 live generation
node qqbot-mod/patches/live-overlay/capture.mjs           # 定制有更新后，把 live 回写成新的 ours/
```

装完 / 升级完都要**重启宿主**（`/bot-restart` 或重启 DSH 桌面端），再在页面上 `Ctrl+F5`；只刷新页面的话，服务端路由还是旧的。

依赖：

- Node.js ≥ 22.5（用到内置 `node:sqlite`）
- DSH 桌面端，已安装 `@zaofan/dsh-qqbot`
- Python + Pillow（只有文字动效 / 角色动效 / 出图质检需要；缺了会自动降级并如实记一条 warning）
- ffmpeg（音效合成与拼片；找不到会静默降级为静音）

## 配置速查

<details>
<summary><b>装完要改的四个文件</b></summary>

- `dshqqbot/.qqbot-extensions/memory-config.json` → `dataRoot` 改成你的 bot 数据根（`install.mjs` 会自动替换标记位）
- `dshqqbot/.qqbot-extensions/local-llm-config.json` → 同上
- `dshqqbot/.qqbot-extensions/draw-config.json` → 只有用本地 SD 绘图才需要改
- `dshqqbot/.qqbot-extensions/bili-ops-config.json` → B 站运营（`publish.mode` / 额度 / 定时）
</details>

<details>
<summary><b>群分级怎么配</b></summary>

浮窗「🧠 记忆」页 →「🏷 群等级」→ 设为关心 / 降为普通，即时生效。
同页「⭐ 特别关心」按**名字**加人/加群，界面上不会出现 openid：

- 输入框填**群名**（如 `相亲相爱一家人`）或**昵称**（如 `爸爸`）就能加，也接受直接粘 openid；
- 下面「见过的群 / 说过话的人」候选点一下就是加/取消；
- **聊天板块每条消息旁也有 ☆**，点一下就把这个人设为/取消特别关心 —— 不用再回来找名单；
- 名单 chips 只显示名字，× 移除。

> 为什么不按群号 / QQ 号加？QQ 官方机器人接口只下发 `group_openid` / 用户 `openid`，**不给群号和 QQ 号**，本地也没有 号→openid 的映射表，所以按名字认人是最稳的一层。群名来自 `.qqbot/groups.json`，昵称来自消息台账（`msg-history`）。

名单里的**人**在普通群也会按关心级对待（完整召回 + 沉淀），写进 `priorityPeople`。也可以直接改 `data/group-tiers.json`：

```json
{ "defaultTier": "normal", "priority": ["群openid"], "priorityPeople": ["用户openid"], "normal": [], "profileInNormal": false, "digestNormal": false }
```

| 项 | 特别关心群 / 私聊 | 普通群（默认） |
| --- | --- | --- |
| 个人印象卡 | 完整卡 + 熟识度 | 只给一行「名字 · 等级」 |
| 长期记忆召回 | 开 | 关 |
| 长期记忆沉淀 | 开 | 关 |
| 历史印象汇总 | 参与 | 不参与 |
| 记忆分身读写 | 事实 + 个人卡 | 只记心情/关系，读最近 5 条 |
</details>

<details>
<summary><b>视频链路可调参数</b></summary>

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `video.style` | `auto` | `auto` / `text`（文字动效 + 小蓝）/ `image`（真图分镜） |
| `video.planner` | `true` | 分镜编排；`false` 退回「一屏一图 + 固定淡入」 |
| `video.maxImageShots` | `2` | 一单最多几张真图（云端质量不可控，只花在开场和例证） |
| `video.imageAttempts` | `3` | 每屏最多重画几次 |
| `video.imageGate` | `true` | 出图质检开关（关掉 = 画完直接用） |
| `video.imageGoodEnough` | `0.84` | 质检达标分，越高越挑 |
| `video.character` | `true` | 文字屏是否带小蓝 |
| `video.characterSize` | `300` | 小蓝落版尺寸（px） |
| `video.shotMinSec` / `shotMaxSec` | `2.4` / `5.2` | 单屏时长上下限 |
</details>

<details>
<summary><b>B 站运营与工具调用</b></summary>

| action | 用途 |
| --- | --- |
| `plan topic=...` | 写脚本 → 出图 → 配音 → 字幕 → 拼片 → 封面 → 草稿（`awaiting_review`） |
| `approve jobId=...` | 审核通过 → 自动投稿（失败退回成片包并给原因） |
| `reject` / `publish mode=manual` / `comment` / `engage` / `rename` / `list` / `records` | 见浮窗与工具说明 |

- `publish.requireApproval` 默认 `true`，`limits.dailyVideos` 默认 `1`，定时任务只产草稿、绝不自动发布。
- DeepSeek Key 不入库：优先读环境变量 `DEEPSEEK_API_KEY`，其次 `{dataRoot}/bili-ops-secret.json`（已忽略）。请求体只带选题/风格/分镜数/时长，不含聊天记录、记忆库、Cookie。
- 产物在 `{dataRoot}/.qqbot/bili-ops/jobs/<jobId>/`。
- 扩展工具用宿主**扁平 value-schema**：每个字段直接写 `{ type, description, enum?, required? }`，包成 JSON-Schema 的 `{ type:'object', properties }` 会被宿主拒绝，工具随即"消失"。
</details>

## 隐私

仓库内**不包含**任何真实 openid / 群号 / 聊天记录、B 站 Cookie、DeepSeek Key、
`memory.db`、运营产物、表情包图库与索引、模型缓存与日志。

`.gitignore` 是**白名单式**的（`*` 起手再 `!` 放行），只有源码、补丁、脚本、文档与截图能进仓库；
`install.mjs` 也只复制代码与默认配置，不复制 `data/`、`.state/`、`*.bak`。

**npm 包同口径**：`dshqqbot/.qqbot-extensions/.npmignore` 把运行时状态、台账、本机配置挡在包外，
含真实 openid 的 `bili-ops-config.json` 不进包（干净模板 `bili-ops-config.example.json` 随包发布，
`install.mjs` 在目标没有配置时自动铺出）；发布前跑 `node scripts/check-pack-privacy.mjs` 自动把关，
CI（`.github/workflows/ci.yml`）每次推送都会再查一遍。

**包内文件名必须是纯 ASCII**（2026-10-28 实测踩到）：Windows 上 `npm pack` 会按系统 ANSI 码页
重新编码非 ASCII 文件名，产出的 tarball 里名字变成乱码、甚至整份文件丢失
（`commands/子会话.mjs` 就这样在包里出现过 0 字节缺失）。所以仓库里一律用英文文件名，
命令的中文名写在文件内的 `name: [...]` 里（`/唤醒` `/会话列表` `/子会话` 都还能用）。
`scripts/check-pack-privacy.mjs` 现在会额外拦一道「非 ASCII 文件名」。

导入历史聊天记录时，**脱敏发生在入库之前**（不是事后补救）：手机号保留前 3 后 4、身份证前 6 后 4、
邮箱只留首字符、银行卡只留后 4 位、裸数字串按 QQ 号打码（年份与小额金额不受影响）。
可以先用 `--dry-run` 看筛出来哪些句子，确认后再写库。

```bash
# 只看报告，不写库
node qqbot-mod/scripts/qq-import.mjs --file 聊天记录.txt --dry-run

# 只导入和某个人的对话（QQ 号最准，不会和同昵称的人串号）
node qqbot-mod/scripts/qq-import.mjs --file 全部消息.txt --peer 123456789 --self-uin 987654321 --dry-run

# 完整归档：整段对话原样进聊天台账，再用本地模型重建这个人的历史印象卡
node qqbot-mod/scripts/qq-import.mjs --file 全部消息.txt --peer 123456789 --self-uin 987654321 --archive --digest
```

| 参数 | 作用 |
|---|---|
| `--peer QQ号\|昵称` | 从「导出全部消息记录」里只捞出这一段对话。纯数字只认 QQ 号（防重名串号），昵称按规范化匹配 |
| `--self-uin` / `--self-name` | 认出"我"。不给的话只能靠发言人数量猜：文件里非 peer 只有 1 个发言人 → 当作一对一；多个 → 只留对方的话并提示补号 |
| `--archive` | 把**完整对话原样**写进 `chat` 台账：不筛寒暄、不砍长消息（默认 2000 字，实时采集是 500）。记忆分身、历史印象、"那晚到底聊了什么"都靠这份 |
| `--scope` | 显式指定归档到哪个会话。默认按 QQ 号落在 `c2c:qq:<号>`，和运行时 openid scope 分开，不半截合并 |
| `--digest` | 归档后调本地模型重建这个人的高维印象卡（切片→汇总） |
| `--min-score` | 只影响**进记忆库**的筛选门槛，不影响归档 |

导入会同时产出三种东西，粒度不同、互不替代：

1. `chat` 台账 —— 原话，可重放、可事后换模型重建记忆；
2. `person:<id>` 记忆 —— 筛掉寒暄后的句子 + 一条 `impression`（TA 是什么人）；
3. `person:<id>` 里的 `relation` —— 一条"我们怎么相处"：轮次、谁先开口、回得多快、共同话题。
   只靠"TA 说了什么"看不出关系，这一条是双方视角。

> 归档进台账的 `src='import'` 行**不吃 60 天保留窗**。否则导进来的旧记录下次日维护就被当过期数据删掉。

```bash
node qqbot-mod/scripts/graph-enrich.mjs --scope person:qq12345 --dry-run  # 看还有多少条待补图
node qqbot-mod/scripts/graph-enrich.mjs --scope person:qq12345 --limit 50 # 本地模型补三元组
```

补图只往图谱加边、不改正文，**全在本机跑**（`local-llm` 的 Ollama / OpenAI 兼容端点），
聊天记录不出机器。模型没开时脚本会立刻退出并说明原因，不会空转。
彻底删除一个 scope 的全部记忆用 `purgeScope`（代码接口，含索引与画像），
导出用 `exportScope`，两者都会在 `{dataRoot}/.qqbot/memory/_audit.jsonl` 留痕。

### 为什么导不进 `.bak`？—— 密钥根本拿不到

QQ NT 的聊天库是 `nt_msg.db`（外加若干同族库），**SQLCipher 加密**。密钥不是写死在文件里的常量：
它在 QQ 登录时由服务端下发，只存在 QQ 进程内存里，而且随版本/账号变化。要"拿到密钥"等于去 dump 运行中的
QQ 进程内存再逆出派生逻辑 —— 这既不稳定（一升级就废），也不该由本插件做。所以本插件**不解密 `.bak`
/ `nt_msg.db`，也没有任何"密钥获取"功能**：这不是没做完，是这个方向本身不通。

能走通的只有官方导出这条路：

1. PC 版 QQ → 左下角 **≡ / 设置** → **消息管理器**（老版本在「工具 → 消息管理器」）；
2. 左侧选中群或好友，等它把历史同步下来（首次打开会转一会儿）；
3. 右上角 **导出消息记录** → 选 **`.txt`**（推荐，纯文本最稳）或 `.mht`；
4. 浮窗 → **记忆** → 「📥 导入历史」，把导出文件的**绝对路径**填进去（带空格要加引号）。

> 找不到"导出消息记录"？多半是这个会话还没落到本地库 —— 在消息管理器里点开它、往下翻到底，
> 再试；仍没有就是精简版/渠道版 QQ，换官方 PC 版 NT 再导。手机端可以先「聊天记录迁移」到电脑。

`--file` 除了 `.txt` / `.mht`，也吃任意 `.json`；面板里的 `--peer` 输入框用来只捞某一段对话。

### 本地语音（GPT-SoVITS / Breeze TTS 2 / IndexTTS-2.5）

默认走 edge-tts（在线、零本机占用、音色稳定，但音色是"播音腔"）。想换成自己训练的模型或
本地推理，改用 `provider:"http"`——插件只认 OpenAI 形状的 `POST /v1/audio/speech`，
`skills/local-tts/adapter/server.py` 就是那层适配（**纯标准库，零第三方依赖**），把
GPT-SoVITS 的参数式 `/tts`、Breeze 的多部分上传、IndexTTS 的 `/tts` 全部翻译成同一个接口，
并保证吐出**真 mp3**。

**先看这张表再选**（浮窗「设置」页的引擎表就是它的实时版：端口亮不亮、模型多大、现在选的是哪套）：

| 引擎 | 端口 | 本机模型占用 | 速度 | 适合 |
| --- | --- | --- | --- | --- |
| `edge`（默认） | 无（云端） | 0 GB | 秒级 | 日常聊天，缺点是播音腔 |
| `gsv` GPT-SoVITS | 9880/9881 | 1.75 GB | 接近实时 | **聊天即时语音首选**，5 秒参考音克隆 |
| `breeze` Breeze TTS 2 q8 | 7860/9881 | 9.15 GB | ≈0.10× 实时（820ms/帧） | 生成一段展示音频，不适合对话 |
| `index` IndexTTS-2.5 | 9890/9881 | 14.6 GB | RTF≈22–30（3.8s 音频要 88s） | **离线视频配音 / 读评论**，情感最自然；6GB 卡常驻 5.9GB |

分工建议：聊天走 `gsv`，视频配音走 `index`（`narrate_footage.py --voice xiaolan_emo` 已直通）。

```bash
# 1) 起服务（显存 6GB 只能二选一，默认 breeze）
powershell -ExecutionPolicy Bypass -File skills\local-tts\scripts\start-services.ps1 -Backend breeze
powershell -ExecutionPolicy Bypass -File skills\local-tts\scripts\start-services.ps1 -Backend gsv
#    停止：同一个脚本加 -Stop

# 2) 换引擎有两条路
#    a. 浮窗「设置」页 → 引擎表 → 点「用这个方案」（走 POST /api/qqbot-settings/tts-engines，直接改 voice-config.json）
#    b. 手改 dshqqbot\.qqbot-extensions\voice-config.json（改一次就行）
#       "provider": "http",
#       "endpoint": "http://127.0.0.1:9881/v1/audio/speech",
#       "model":    "gsv",              ← gsv / breeze / index
#       "voice":    "xiaolan"           ← gsv: xiaolan|gentle；breeze: breeze|breeze_design；index: xiaolan_emo|xiaolan_emo_soft
```

几个必须知道的点：

- **Breeze 也吃 OpenAI JSON**：`POST /v1/audio/speech` + `response_format:"mp3"` 会直接回
  64kbps / 24kHz 的真 mp3（裸 24k s16le PCM 只出现在 multipart 路径）。它缺的是**克隆音色注册**——
  想用自己的参考音得先 `POST /v1/voices`（ref_audio + ref_text + name），之后用 `voice:"<name>"`。
  适配层把这两步都做了，所以插件侧还是填一个 `endpoint` 就够。
- **Breeze 慢**：q8_0 在 3060 上约 **0.10× 实时**（≈820ms/帧，瓶颈是 depth decoder 的 15 次串行小 matmul），
  适合"生成一段展示音频"，不适合聊天随口回。日常对话用 GPT-SoVITS 或先留 edge。
- 探活口径：Breeze 是 `GET /health`（`/v1/model` 是 404），GPT-SoVITS 是 `/tts`；
  适配层的 `/health` 会分别探这些上游，`reachable:false` 只代表上游没起，不代表适配层坏了。
- 合成失败会往 `.qqbot/tts/failures.log` 记一行（含 bytes / exit code / 原因），
  0 字节不再"悄悄删掉"。
- `voiceProfiles` 里的 `size` 写的是**在线合成、本地无模型**——别把它当成"模型 0MB"。
- **9881 不用手动起**：插件每次合成前先探端口，没开就自己 detached 拉起
  `adapter/server.py --manage`（空闲 3 分钟回收显存）。群里再也不会出现「tts-http: fetch failed」。
- **显存被聊天模型占着怎么办**：6GB 卡上 `qwen2.5:7b` 常驻能吃掉 4.2GB，GSV 要 3.4GB 就起不来。
  插件遇到「显存不够」会先让 Ollama 把模型吐出来（`keep_alive:0`，下次聊天它自己会重载，几秒），
  再重试一次；要是还腾不出来（浏览器 + QQ + 桌面端能占掉 3GB 多），就**临时回退 edge 在线语音**把这句话说出来，
  并在 `failures.log` 记 `local-vram-short → 已回退在线语音`。人在群里听到的是声音，不是报错。
- **工具/语音报错不进群**：失败的原文只写 `.qqbot/tool-errors.jsonl`，群里由她自己用一句人话圆过去。
  想恢复"把报错直接发到群里"的旧行为，设环境变量 `QQBOT_TOOL_ERRORS_ON_QQ=1`。

### 本地模型什么时候在显存里？

默认策略是**平时不在**：聊天回复、向量化（`nomic-embed-text` 那个 274MB）都带 `keep_alive:0`，
生成完就离开显存；看门狗每 20s 看一眼，没 pin 且闲置超过 60s 就把 Ollama 里的模型整体卸载。
需要用的时候再冷启（`qwen2.5:7b` 约 5~6s，`qwen2.5:1.5b` 约 2s）。

要「借住」一段时间的场景用 pin：

| 场景 | 谁 pin | 有效期 | 到点后 |
| --- | --- | --- | --- |
| 小游戏（海龟汤 / 故事接龙 / 你问我答） | `game-lib` 开局 `pin('game')`，每步续期 | 12 分钟 | 收摊或超时 → `unpin` + 立刻卸载 |
| 视频配音 / 长文本读评论 | 由脚本自己 pin | 调用方决定 | 同上 |

配置在 `dshqqbot/.qqbot-extensions/local-llm-config.json`：

```jsonc
{
  "model": "qwen2.5:7b",
  "gameModel": "",          // 给游戏单独指定模型；留空=跟 model 同一个
  "keepAlive": "0",         // 单次请求的 keep_alive，0 = 用完就走
  "residency": {
    "enabled": true,
    "idleUnloadSec": 60,    // 没 pin 又闲置多久就整体卸载
    "pinnedKeepAlive": "10m", // 有 pin 期间单次请求的 keep_alive
    "looseKeepAlive": "0",
    "watchMs": 20000        // 看门狗间隔
  }
}
```

想让游戏又快又不太笨：`"gameModel": "qwen2.5:1.5b"`（986MB，冷启 2s，出题偶尔跑偏但有本地题库兜底）；
想让它更会聊：留空走 `qwen2.5:7b`。显存只有 6GB 时别同时让别的程序占着。

### 库体检与维护

记忆库有几种"不报错、只悄悄变差"的坏法：索引表没建上（关键词/实体/图谱三路召回全哑，
只剩向量）、WAL 没检查点（备份可能是残的）、prune 删了行但文件不缩小、一直没备份。
一个脚本全查一遍：

```bash
node qqbot-mod/scripts/mem-maintain.mjs --data-root <数据目录>              # 只体检，只读
node qqbot-mod/scripts/mem-maintain.mjs --data-root <数据目录> --fix        # 检查点 + 备份 + 补索引
node qqbot-mod/scripts/mem-maintain.mjs --data-root <数据目录> --fix --vacuum --keep 5
```

体检会明确回答「倒排覆盖 487/489」「缺表: mem_edge」「碎片率 34%」这类问题，
而不是给一个"正常"。日常备份不用手动：`chatlog.dailyBackup` 会在每日维护窗口
把库 `VACUUM INTO` 到 `.qqbot/backups/`，保留 `backupKeep` 份。

## 目录

```text
dshqqbot/.qqbot-extensions/   扩展本体（inbound / outbound / hooks / tools / lib）
qqbot-mod/patches/            客户端与服务端补丁（--check / --apply / --revert）
qqbot-mod/patches/live-overlay/  官方原文件 + 定制版 + 三路合并安装器（扛插件自动升级）
qqbot-mod/scripts/            自检脚本（`node qqbot-mod/scripts/run-all-tests.mjs` 一把跑完 51 个套件，失败详情落 tmp/test-failures/）
scripts/check-pack-privacy.mjs  npm 包隐私自检（发布/CI 用）
scripts/check-submission.mjs   插件市场提交预检
qqbot-mod/persona/            人格与世界书（唯一事实源）
assets/char/pose/             鲸鱼娘五姿态（720×980 透明 PNG + sprite.json，video.character 直接用）
assets/char/src/              出图原图（带底色，供重抠/换姿态）
assets/char/whale/            同配色纯鲸鱼本体（贴纸/小图标用）
skills/video-frame-render/    逐帧拼视频的 skill（Pillow 画帧 + ffmpeg 编码，省 token）
skills/local-tts/             本地 TTS 适配层（OpenAI 形状 /v1/audio/speech → GPT-SoVITS / Breeze / IndexTTS）
skills/voice-sing/            唱歌换声（Demucs 拆轨 → RVC 换声 → 混音；带 sources.json 出处台账）
skills/office-deliver/        数据 → 报告/表格/PPT 三件套，带版式验收（纯 Pillow 出图 + Office COM 渲染回读）
docs/publish-flow.md          第一条视频从选题到投稿的完整流程（首跑记录，含踩过的坑与验收口径）
assets/                       README 截图与图标
submission/                   插件市场提交条目
install.mjs                   把扩展装进任意 bot 数据根
```

## 市场收录

- 条目：`submission/wuwo1979__dsh-qqbot-muu.yml`（`category: usage`）
- 截图：`screenshots.json`（仓库根，相对路径，最多 8 张）
- 本地预检：`node scripts/check-submission.mjs` —— 校验 YAML 字段、`dsh.bundle` 声明、图标与截图规则，提交前先跑一遍就不会再被 CI 打回来

## 致谢与许可

- 基础插件：`@zaofan/dsh-qqbot`（客户端 `client/qqbot-settings.js`、`dist/features/*`），本包把它**锁在 1.10.39** 并当成运行时依赖
- 本项目在其之上补扩展与补丁，与插件作者无隶属关系

### 它现在是独立插件，不是那个插件的"影子"

- 自己的 id：`dsh-qqbot-muu`（`cordis.patch.yml` → `dsh.bundle.patch`），装法与上游互不干扰
- 依赖：`package.json` 里锁 `"@zaofan/dsh-qqbot": "1.10.39"` —— **先装本体**，再装本包；身份门控/QQ 通道仍由本体提供，本包只做扩展、面板、补丁、流水线
- 不完全兼容是刻意的：上游一升级（新的 `profiles/.generations/live/...`）本包的补丁就会被冲掉，所以有 `qqbot-mod/patches/live-overlay/`（三路合并装回）——**升级后跑一次 `node qqbot-mod/patches/live-overlay/install.mjs --apply`**
- MIT
