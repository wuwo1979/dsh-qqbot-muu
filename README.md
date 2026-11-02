<div align="center">

<img src="assets/icon.png" width="110" alt="小蓝">

# dsh-qqbot-muu

**一只跑在你自己机器上的 QQ 桌宠助手——独立完整插件，零第三方插件依赖。**

把 QQ 助手养成能长期养的「小蓝」：记得住人、分得清群、会说话配表情、
能自己写口播视频、有一套主人说了算的 B 站运营流程。
记忆、语气、出片、运营全部本地跑：**本地 SQLite + 本地小模型 + 你自己的云 Key**。

[![npm](https://img.shields.io/npm/v/dsh-qqbot-muu)](https://www.npmjs.com/package/dsh-qqbot-muu)
[![CI](https://github.com/wuwo1979/dsh-qqbot-muu/actions/workflows/ci.yml/badge.svg)](https://github.com/wuwo1979/dsh-qqbot-muu/actions/workflows/ci.yml)
[![LICENSE](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A522.5-blue)

`Node ≥ 22.5` · `MIT` · `DSH 桌面端插件` · `独立插件 dsh-qqbot-muu`

</div>

---

## 这是什么

一个**跑在你自己电脑上**的 QQ 助手插件。它不训练模型、不上传你的数据，
只把「记忆、说话、出片、运营」四件事拼成一条能跑的流水线。
它**不是**托管服务、不是 SaaS，也不需要你的账号密码——只有本机 Cookie 和本机数据库。

| | |
|---|---|
| 🧠 **记得住人** | 两层记忆 + 类海马体检索，A 群的坏情绪不带去 B 群 |
| 💬 **说人话** | 人格与世界书注入，语气被日常一点点养出来 |
| 🖼 **会用表情包** | 本地视觉模型打标，情绪到位自己发一张 |
| 🐋 **桌宠** | 四形态住在你桌面上：小蓝三套形象 + 原生大肥鱼，可开成公网链接给指定的人看 |
| 🎬 **会出片** | 文案→分镜→出图质检→配音→字幕→成片，主人说「通过」才发 |
| 📢 **会运营** | B 站扫码登录、发动态、AI 写评论草稿、数据留档 |
| 🔒 **数据主权** | 一切落在本机；导出/彻底删除都有接口，还有审计日志 |

## 功能一览

### 🧠 记忆与认知
个人层（印象卡、熟识度）跨群统一，群层按会话物理隔离；统一记忆库基于 `node:sqlite`（WAL + FTS5）。
检索是五路融合（向量 + 关键词 + 实体 + 图谱随机游走 + 回溯意图），能顺着「甲→乙→丙」捞到字面完全没命中的旧事；
三元组带时序失效——改口了旧事实也只是标记，可追溯；人格护栏给信念变化设步长上限，几句话撬不动对一个人的整体判断。

<details>
<summary>🧠 记忆系统全部能力（点开看细节）</summary>

| 能力 | 说明 |
| --- | --- |
| 类海马体检索 | 五路 RRF 融合 + 模式分离（MMR 去重）+ 模式补全（时间邻近扩散 + 归纳补全） |
| 时序失效 | 单值关系出新值时旧事实标 `superseded` 而非删除，可回答"现在"也可追溯"什么时候改的口" |
| 回放巩固 | 按显著度挑种子 → 余弦聚类 → 抽成归纳片段写回，原文可溯源 |
| 人格护栏 | 信念层步长上限 + 锚点限幅，`driftReport` 给 0~100 稳定度 |
| 历史记录导入 | QQ 导出的 `.txt`/JSON，**入库前脱敏**（手机号/身份证/邮箱/银行卡/QQ 号先打码再进库） |
| 人物归一 | QQ 号做主键、昵称只作别名；同昵称不同号不合并（宁可不认出，不串号） |
| 历史印象卡 | 切片→摘要→高维卡，本地模型跑，自动限流 |
| 旧识注入 | 只给当事人、只在关心级会话；块里只有统计结论，**绝不跨群转述原话** |
| 降级召回 | 向量模型离线时不拿余弦当门槛，无关提问返回空，不塞噪声 |
| 库自愈 | schema 带版本号每次校验；`mem-maintain.mjs` 体检/备份/补索引一条命令 |
| 数据主权 | `exportScope` 全量导出、`purgeScope` 彻底删除、`_audit.jsonl` 审计留痕 |

</details>

### 💬 说话与分发
人格与世界书是唯一事实源；本地小模型代答（单脑仲裁，不会"本地答一半云端答一半"）；
TTS 分段合成 + 句间呼吸 + ffmpeg 人声后处理，全篇语速平稳不"逐句朗诵"；
7 局纯本地小游戏零 token，另外 3 局会临时叫醒本地模型、收摊即还显存。

<details>
<summary>💬 语音 / 模型调度细节（点开看）</summary>

| 项 | 说明 |
| --- | --- |
| TTS 引擎 | edge（默认在线）/ GPT-SoVITS（聊天首选）/ Breeze / IndexTTS-2.5（视频配音）；本地适配层零第三方依赖 |
| 显存策略 | 聊天/向量化全 `keep_alive:0`，用完就走；闲置 60s 看门狗整体卸载；游戏用 pin 借住 12 分钟 |
| 表情包 | 本地视觉模型打标 + 情绪词表 + 三路检索 + 危险标签黑名单 + 频率限制；没有合适的不硬发 |
| 聊天记录来源 | 本地消息台账补齐最近记录；机器人离线期间的消息 QQ 接口拉不到，可用官方导出 `.txt` 导入 |
| 浮窗 UI | 浅/深色主题、记忆页卡片化、拖拽把手记住尺寸、特别关心一键加星 |

</details>

### 🐋 桌宠（四形态）
四个形态住在桌面上：**原版少女 / 女仆装立绘 / Q 版 de 娘** 三个自绘形象，加上 dsh-pet 原生的 **MuU 大肥鱼**（16 个动作全套：写代码、三球抛接、女仆舞……）。
浮窗一键切换、动作按钮直接让她挥手/开心/说话/被拎起；「⏻ 开关」整体显隐。
还能发布成**限制人数的公网链接**：访问码登录 + 单席位 + 可重置踢人 + 防爆破限速，
网页端同样能切形态、发整活动作、按住拎起——桌面桌宠同步做出动作；
本机不开任何入站端口（本机连接器主动外连云端代答），dsh token 全程不出你的电脑。

<details>
<summary>🐋 公网桌宠的安全设计（点开看）</summary>

- 访问码恒时比较；每 IP 10 分钟错 5 次拉黑 15 分钟
- 单席位互斥（默认 1 人），会话 HMAC 签名 cookie + 空闲 30 分钟自动退席
- 全局限速 120 请求/分钟/IP、请求体上限、路径双白名单、安全响应头全套
- 管理：`node pet-gate/agent.mjs status / reset-seat / new-key`（重置席位、换访问码）
- 详见 `pet-gate/README.md`

</details>

### 🎬 视频创作
文案 → 分镜（节拍编排）→ 出图质检（拉普拉斯/色彩度/dHash 打分，不过关自动重画）→
配音 → 字幕 → 拼片 → 草稿。文字动效逐帧渲染 11 种风格，画面与配音时长天然对齐；
支持 1080×1920 竖屏；**成片永远是草稿，主人说「通过」才投稿**。

### 📢 运营
B 站扫码登录（Cookie 只落本机）、分享卡片、发/删动态、AI 写评论草稿（最小输入集，不塞整篇分镜）、
发布台账可核对；所有平台写操作统一限速节奏（随机 45s~4min 间隔 + 每日上限 + 风控自动冷却）。
抖音只做登录态与成片准备——网页端签名硬算等于自报高危机器人，所以不做自动投稿，代码里写的是真话。

---

## 🚀 快速开始（初次下载看这里）

> **⏱ 只想要一条命令？** 装好 [DSH 桌面端](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)和 Node.js ≥ 22.5，然后 PowerShell 里执行：
>
> ```powershell
> dsh plugin add github:wuwo1979/dsh-qqbot-muu#main
> ```
>
> 重启 DSH 桌面端 → 浮窗出现「🧠 记忆 / 🐋 桌宠」页签 = 装好了，不用再看下面。
> 下面的分步教程是给想搞懂每一步的人准备的；卡住了直接跳 [新手常见问题](#-新手常见问题)。

### 0. 前置条件

- **Node.js ≥ 22.5**（用到内置 `node:sqlite`）
- **DSH 桌面端**（[下载地址](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)）
- **QQ 机器人凭据**：在 [QQ 开放平台](https://q.qq.com) 创建机器人拿到 `QQBOT_APPID` / `QQBOT_SECRET`（设置成环境变量或写进 bot 数据根的配置）
- 可选增强（缺了会自动降级，不会带病跑）：Python + Pillow（视频文字动效）、ffmpeg（音效与拼片）、Ollama（本地代答/打标/向量）

### 1. 安装插件（三选一）

```powershell
# 方式一 · GitHub 直装（推荐）
dsh plugin add github:wuwo1979/dsh-qqbot-muu#main

# 方式二 · GitHub 发布包（离线/内网）
npm i -g https://github.com/wuwo1979/dsh-qqbot-muu/archive/refs/heads/main.tar.gz
dsh-qqbot-muu-install --data-root "D:\你的bot数据目录"

# 方式三 · npm
npm i -g dsh-qqbot-muu
dsh-qqbot-muu-install --data-root "D:\你的bot数据目录"
```

### 2. 首次配置（装完自检会指出缺什么）

```powershell
# 把能力文件铺进 bot 数据根（配置里指向作者机器的绝对路径会自动改写到你的数据根）
node install.mjs --data-root "D:\你的bot数据目录"

# 可选：本地模型（表情打标 / 向量检索）
ollama pull qwen2.5vl:3b
ollama pull nomic-embed-text    # 缺了自动退回关键词检索
```

装完自检：本机没有出图环境就自动关掉出图并写明原因——**别人下载后不会因为路径指向别人的电脑而静默失败**。

### 3. 验证装好了

1. 重启 DSH 桌面端（服务端路由要重启才生效），浮窗里按 `Ctrl+F5`
2. 浮窗出现「🧠 记忆 / 🔗 账号管理 / 🐋 桌宠」等页签 = 插件已挂载
3. 群里 @ 她说句话，浮窗「聊天」页能看到消息 = 链路通了

### 🆘 新手常见问题

| 症状 | 处理 |
|---|---|
| 重启后浮窗没有新页签 | 浮窗里按 `Ctrl+F5` 强刷；再不行确认插件目录名是 `dsh-qqbot-muu` |
| `dsh` 命令找不到 | dsh CLI 由 DSH 桌面端提供；先装桌面端并重开终端，或用上面的方式二/三 |
| 提示 `node:sqlite` 不可用 | Node 版本低于 22.5，去 nodejs.org 升级 LTS |
| 安装时提示数据目录 | `--data-root` 是你给 bot 的空文件夹，填一个新建目录即可 |

### 4. 常用入口

| 想做什么 | 去哪里 |
| --- | --- |
| 调记忆 / 群分级 / 特别关心 | 浮窗「🧠 记忆」页 |
| 换语音引擎 / 查模型状态 | 浮窗「⚙ 设置」页 |
| 让她做动作 / 换桌宠形态 | 浮窗「🐋 桌宠」页（或右键桌宠） |
| B 站登录 / 发动态 / 回评论 | 浮窗「🔗 账号管理」→「B 站管理」 |
| 出第一条视频 | 群里让主人下指令，或看 [docs/publish-flow.md 的首跑记录](docs/publish-flow.md) |
| 体检记忆库 | `node qqbot-mod/scripts/mem-maintain.mjs --data-root <数据目录> --fix` |

<details>
<summary>⚙️ 配置速查（点开看）</summary>

| 文件 | 作用 |
| --- | --- |
| `dshqqbot/.qqbot-extensions/memory-config.json` | 记忆库数据根（install.mjs 自动改写标记位） |
| `dshqqbot/.qqbot-extensions/local-llm-config.json` | 本地模型与显存驻留策略 |
| `dshqqbot/.qqbot-extensions/draw-config.json` | 本地 SD 出图（不用可关） |
| `dshqqbot/.qqbot-extensions/bili-ops-config.json` | B 站运营（干净模板 `bili-ops-config.example.json` 随包发布） |
| `dshqqbot/.qqbot-extensions/voice-config.json` | 语音引擎选择 |

群分级：浮窗「记忆」页 →「群等级」即时生效；按**名字**加特别关心（QQ 机器人接口不给群号/QQ 号，按名字认人最稳）。

</details>

<details>
<summary>🛠️ 从源码跑 / 升级后补丁被冲掉（点开看）</summary>

```powershell
# 一把跑完全部自检（51 个套件）
node qqbot-mod/scripts/run-all-tests.mjs

# 插件自动升级生成新 generation 后，把定制装回（三路合并，只在真冲突时报警）
node qqbot-mod/patches/live-overlay/install.mjs --check
node qqbot-mod/patches/live-overlay/install.mjs --apply
```

本包已自带完整底盘（`dist/` + `client/`），正常情况下不需要补丁步骤；
overlay 体系保留作为备份与迁移工具。

</details>

## 🔒 访问控制（默认只认特别关心）

**装完默认只回应你的特别关心**：`c2cMode` / `groupMode` 默认 `care` ——
私聊只回应「特别关心的人」（`group-tiers.json` 的 `priorityPeople`），
群聊只响应「特别关心群」（`priority`）。名单和人格体系**同源**：
浮窗/命令里把谁设成特别关心，谁就能聊，改完即时生效（5s 内），不用碰配置。
（早期版本默认全开，v0.1.5 起改为安全默认。）

四档可选（配置 `access` 段）：

| 模式 | 行为 | 适合 |
|---|---|---|
| `care`（默认） | 只认特别关心的人/群 + 白名单 | 有固定圈子的私人实例 |
| `allowlist` | 只回白名单内的会话 | 名单自己维护时 |
| `open` | 任何人可用 | 完全公开的 bot |
| `disabled` | 完全关闭该通道 | 只要桌宠不要聊天 |

```yaml
access:
  c2cMode: care
  c2cAllow: ['额外放行的用户openid']   # 叠加在特别关心之上；"*" = 全部放行
  groupMode: care
  groupAllow: ['额外放行的群openid']
```

> 不知道 openid？试者在群里 @ 她一句，然后 `harness.log` 搜 `not in allowlist`，括号里就是；
> care/allowlist 名单为空时启动日志会打醒目提示（不会静默）。
> 拒绝时日志会打醒目提示（不会静默）。

## 🔒 隐私

**仓库与 npm 包里不包含**：真实 openid / 群号 / 聊天记录 / B 站与抖音 Cookie / API Key /
`memory.db` / 运营产物 / 表情包图库 / 模型缓存 / 日志。

三层防线：

1. **白名单式 `.gitignore`**：`*` 起手再 `!` 放行——默认全禁止，只有源码、补丁、脚本、脱敏截图能进仓库；`/secrets/`、`/docs/`（本地文档）、运行时数据、`pet-gate/secrets.json` 全部挡在门外
2. **`.npmignore` 同口径**：运行时状态、台账 `*.jsonl`、本机配置不进包；发布前 `node scripts/check-pack-privacy.mjs` 自动把关（Cookie/令牌/真名/非 ASCII 文件名），CI 每次推送再查一遍
3. **导入即脱敏**：历史聊天导入时，手机号/身份证/邮箱/银行卡在**入库前**打码，不是事后补救；`--dry-run` 可先看筛选结果

包内文件名一律纯 ASCII（Windows `npm pack` 对非 ASCII 文件名会乱码丢文件，实测踩过）。

<details>
<summary>🔑 密钥与敏感文件都放在哪（点开看）</summary>

| 内容 | 位置 | 入库？ |
| --- | --- | --- |
| WSL 密码、npm token、私人素材与存档 | `secrets/` | ❌ |
| B 站 / 抖音 Cookie | `{dataRoot}/*-cookie.json` | ❌ |
| DeepSeek Key | 环境变量或 `{dataRoot}/bili-ops-secret.json` | ❌ |
| B 站运营配置（含主人 openid） | `{dataRoot}`，仓库只有 example 模板 | ❌ |
| 桌宠公网网关密钥/席位 | `pet-gate/secrets.json` / `seats.json` | ❌ |
| 真实人格 / 世界书 | `qqbot-mod/persona/character.json`（仓库只有 example） | ❌ |
| 审计日志 | `{dataRoot}/.qqbot/memory/_audit.jsonl`（谁导出/删了什么） | 本地留痕 |

</details>

## 目录

```text
dshqqbot/.qqbot-extensions/   扩展本体（inbound / outbound / hooks / tools / lib）
dist/ client/                 插件底盘（自持，QQ 通道 / 浮窗 / 设置面板）
entry.js cordis.patch.yml     DSH 插件入口与 bundle 声明
qqbot-mod/persona/            人格与世界书 example（真实档案只在本地）
qqbot-mod/patches/            补丁与三路合并安装器（overlay）
qqbot-mod/scripts/            自检脚本（run-all-tests 一把跑 51 个套件）
skills/video-frame-render/    逐帧视频渲染（Pillow 画帧 + Remotion/ffmpeg）
skills/local-tts/             本地 TTS 适配层（GPT-SoVITS / Breeze / IndexTTS → OpenAI 形状）
skills/voice-sing/            唱歌换声（Demucs 拆轨 → RVC → 混音）
skills/office-deliver/        数据 → 报告/表格/PPT 三件套
pet-gate/                     桌宠公网网关（访问码 + 单席位 + 防爆破；密钥不入库）
scripts/check-pack-privacy.mjs  npm 包隐私自检（发布/CI 用）
assets/                       README 截图（脱敏）与图标
submission/                   插件市场提交条目
```

## 市场收录

- 已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（DSH 桌面端内置插件市场的数据源）
- 条目：`submission/wuwo1979__dsh-qqbot-muu.yml`（本地预检：`node scripts/check-submission.mjs`）
- **更新机制**：市场不会自动跟随本仓库发版。每发一个新 Release，需要向上游仓库提 PR，把条目里的 `tarball:` 指到新版本——已随 v0.1.4 完成

## 致谢与许可

- 底盘血统来自 `@zaofan/dsh-qqbot`（1.10.39），本包在其基础上深度改造并**已完全独立**（无运行时依赖），与原作者无隶属关系，感谢上游的开源工作
- MIT © wuwo1979
