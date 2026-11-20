# 更新日志

## 0.1.15 — 2026-11-20

三件事：装包不再卡原生构建、连发文字+图片合成一轮、要求「打开视频」时真的能打开；另外把发布流程改成「三个渠道必须是同一份产物」。

### 修复
- **安装时卡在 frida 原生构建 / prebuild-install 超时**：`frida-compile` 与 `frida-java-bridge` 只在作者本机打包小天才桥接时用过，运行期没有任何代码 import 它们（`dist/`、`client/`、`entry.js`、`install.mjs` 里 grep 全空，打包产物也不进包）。已从 `dependencies` 删除，安装时不再拉原生二进制，也不需要再在 `pnpm-workspace.yaml` 里写 `frida@17.27.0: false` 去跳过构建。
- **连发「文字 + 图片」被拆成两次回复**：以前延迟聚合只看文字停口时间，先发一句、再补一张图，会被当成两件事各回一次。现在窗口里只要出现图片/语音/视频/文件，就多等一会儿（新增 `behavior.debounce.mediaSilenceSec`，默认 8 秒），等对方把图发完再合成一轮处理，同一条任务不再被拆开（`dist/gateway/debounce.js` + `dist/config.js`）。
- **被要求「打开这个抖音/B站视频」时回「打不开」**：新增工具 `open_link`（在机器人所在电脑上用默认浏览器打开 http(s) 链接），人设里也允许她先打开再读内容讲给主人听。
- **发布出去的包和 GitHub 资产不是同一份**：`scripts/release-all.mjs` 以前复用旧的 `.tgz`，导致 npm 上是旧构建、GitHub 上是新构建。现在每次发布前强制删掉旧包重新 `npm pack`，并在 npm 发布后用 sha1 跟注册表里的 `dist.shasum` 比对，不一致就判定失败（`NPM_PENDING`）并提示升版本重发。三个渠道（GitHub Release / npm / 市场条目）必须来自同一个 tgz。

## 0.1.14 — 2026-11-20

这一版只修问题，不加花活：把「长上下文开不了新会话」「工具卡住整会话焊死」「装在只读目录就报路径错误」「发布流程会并发/乱发版本」四件事处理掉。

### 修复
- **上下文过长后开不了新会话**：以前一个会话的上下文越堆越多，最后模型直接报超长、新消息进不来，只能手动删档。现在两处兜底（`dist/transport/outbound.js` + `dist/session/session-manager.js`）：
  - 回合结束时如果报「上下文超长 / token 超限」，立刻换一份新会话档（旧档文件保留，可在侧边栏回看），下一条消息从干净上下文开始；
  - 回合数超过阈值（默认 60 回合，`QQBOT_SESSION_MAX_TURNS` 可调）也会主动换档，避免无限堆积。
  - 人设和长期记忆不在会话档里（每轮由 persona / recall 重新注入），换档不丢性格、不丢印象卡与记忆。
- **工具调用卡住把会话焊死**：加了回合看门狗（`QQBOT_TURN_TIMEOUT_MS`，默认 15 分钟）。卡住的回合会被取消并写一条明确的 warn（带会话 key 和已卡时长），下一条消息能正常进来，不再出现「消息来了但永远不回应、日志里还查不到原因」。
- **数据根不可写就整套报路径错误**：`dist/gateway/data-root.js` 新增落点兜底 —— `{cwd}/dshqqbot` 建不出来（只读目录/系统目录）时自动退到用户主目录下的 `.dsh-qqbot`，并只 warn 一次；用户也可以继续用 `dataRoot` 指定位置。
- **面试陪练的 keepalive 脚本写死 `F:\nodejs\node.exe`**：改成先找 PATH 里的 `node`，再找常见安装目录，找不到就写日志跳过 —— 别人机器上不会再因为这一行直接失败。

### 发版流程（用户要求：禁止并发、一次只发一个、每次都要有内容）
- `scripts/release-all.mjs` 增加发布闸门，任一不满足就停，绝不推：
  - 同一时间只允许一个发布进程（`tmp/release.lock` + pid 存活判断，30 分钟视为陈旧锁）；
  - 版本号必须比 npm 上的 `latest` 新，且 npm / git tag 里都不能已经存在；
  - `CHANGELOG.md` 必须有这一版的一节，避免「空版本」。
- 仍然是一条命令：`npm run ci`（只体检）、`npm run release`（CI → 隐私扫描 → 提交 → GitHub → npm → 市场条目）。

## 0.1.9

### 文档
- README 新增「默认谁都不会被回（空名单 = 全拒）」一节：写清出厂默认（`care` 模式 + 空名单 = 私聊/群聊一律不回复）、三个添加入口（桌宠面板按名字加 / 配置里填 OpenID / 临时改 `open`），以及自己的 OpenID 在哪看。
- 市场条目按上游规范迁到 `data/plugins/<owner>__<repo>.yml`，描述里明确写出访问默认值。

> 0.1.9 与 0.1.8 的代码完全一致，只补了访问控制的说明与市场提交结构；npm 同版本不可覆盖，所以用新版本号带上这批文档修正。

## 0.1.8

### 修复
- **彻底去掉写死的本机绝对路径**：`dist/`、`client/`、`dshqqbot/.qqbot-extensions/`、`scripts/` 里所有 `F:/qqbot/...`、`C:/Users/Administrator/...`、`D:/...` 改成运行期推导（环境变量 → 从模块自身位置往上找仓库根 → cwd），别人机器上不会再指向不存在的目录。
- `settings-host.js` 里 Chrome 调试实例的 `--user-data-dir=F:\qqbot	mp\chrome-dy` 原来会被 JS 解析成制表符 + 相对路径，已改成按仓库根拼接。
- `tts-core.mjs` 的 Python 兜底不再写死 `E:\Anaconda\python.exe`，改成 `QQBOT_PYTHON` → `python`。
- `embedder.mjs` 找插件目录不再写死某个用户目录，改成 `USERPROFILE` / `APPDATA` + `DSH_HOME` 推导。
- `start-interview.mjs` 不再写死 DSH 桌面端安装路径（仍可用 `DSH_DESKTOP_EXE` 覆盖）。

### 发版闸门
- 绝对路径检查现在真的会拦：系统目录（`C:/Windows`、`Program Files`）豁免，其余一律点名。
- 运维用的 `scripts/*.ps1` 不再打包进 npm 包。

## 0.1.7 — 2026-11-18

这一版主要是「别再让用户被同样的问题绊倒」：修掉已知 bug、把隐私数据从发布包里清干净、补上升级自检。

### 修复
- **小模型抢 CPU**（`dist/features/local-embed.js`）：ONNX 线程数固定为 1（`intraOpNumThreads` / `interOpNumThreads`）、`executionMode: 'sequential'`、推理串行排队；空闲 5 分钟自动 `dispose()` 卸载模型，下次用到再加载。修 bug 时不再和 file-history 插件抢资源。
- **小天才通道重复发消息**：frida 断开后补回逻辑会每 3 分钟重复注入同一段积压，导致对同一个人反复发「嗯。」。现在补回前先查链路（`linkFresh()`），并加补回水位 `.qqbot/xtc-catchup.json`，同一条只补一次。
- **`/bot-restart` 起不来**：旧实现重启时丢了 `ELECTRON_RUN_AS_NODE` / `DSH_HOME` 等环境变量、且杀完进程立刻 spawn 导致端口没释放。现在保留 env、等 2 秒、失败重试 3 次，并把日志写到 `logs/bot-restart.log`。

### 隐私与安全
- 发布包里不再包含任何真实账号与个人数据：`dshqqbot/.qqbot-extensions/data/**`、顶层 `*.json` 配置、`*.bak*`、`*.lnk`、`**/.state/**`、本地密钥提取脚本全部排除（`package.json` 的 `files`）。
- 代码里硬编码的 openid / wxid / 家人姓名全部移除：
  - `lib/private-guard.mjs` 改为按名单文件判断（`QQBOT_PRIVATE_PEERS` 或 `{数据根}/.qqbot/private-people.json`），发布包不带名单。
  - `scripts/private-archive-import.mjs` 的名单与仓库根改为读环境变量/本地文件。
  - 小天才插件去掉硬编码的兜底 id（改从会话台账推）；UI 与注释里的称呼改成「家长 / 家人 / 小朋友」。
- 私聊归档仍然只写独立库 `.qqbot/private/private-chat.db`，常规记忆（`memory.db`）读不到；要读必须由人当场同意。

### 升级自检（防安全模式）
- 启动时检测 profile 的 `package.json` 是否存在 `file:F:/...` 这类**绝对盘符**依赖（pnpm 会把它拼成相对路径 → 安装失败 → 进安全模式），命中就写日志 + 落标记 `.qqbot/profile-fix-needed.json`，并提示跑 `node scripts/dsh-profile-links.mjs` 修。
- 插件内部跨包相对 import 已改为按仓库根动态解析（`pickRepoRoot()`），从 `node_modules/.pnpm` 位置加载也不会 `ERR_MODULE_NOT_FOUND`。

### 数据
- 新增 `scripts/private-archive-import.mjs` / `wechat-full-pull.mjs` / `wechat-media-pull.mjs`：把家人的私聊（抖音/微信/QQ）按「平台:dm:会话ID」分 scope 归档，带时间戳与 `private` 标签，幂等可重跑。
- 媒体只索引不搬运（`media_file` 表），避免误删原文件。

### 发版守门（每版必跑）
- 新增 `scripts/release-check.mjs`：打包清单、包内 token/私钥/真实账号、入口语法、profile 依赖写法、默认人设五项一起查；`npm publish` 前会自动跑（`prepublishOnly`），不通过发不出去。
- 新增 `docs/RELEASE_CHECKLIST.md`：发布流程、隐私红线、老用户升级为什么不会再进安全模式。
- 可移植性：`live/persona.mjs` 与 `inbound/az-bili-note.mjs` 不再写死 `F:/qqbot/...`，改为从环境变量 / 数据根 / `import.meta.url` 推；没有 `character.json` 的机器也有内置默认人设（名字 / 种族 / 性格）。

## 0.1.6 — 2026-11-13
- 多通道（QQ / 微信 / 小天才）积压消息补回；端口自愈（桥接写 `.port`，插件读取）；任务管理支持「时间窗 OR 事件」。
