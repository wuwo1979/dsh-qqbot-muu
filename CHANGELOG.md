# 更新日志

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
