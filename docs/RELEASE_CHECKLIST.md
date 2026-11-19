# 发版与更新检查清单（v0.1.9 起一条命令）

> 目的：每次发版，**本地先跑完跟 CI 完全一样的那套检查**，全绿再推；推、打 tag、发 Release、发 npm、同步市场条目都在同一条命令里完成。
> 不需要你手动跑 CI、不需要点 GitHub Actions、也不需要每次去选 git 账号。

## 0. 记这一条就够了

```bash
npm run ci        # 只体检：语法 / 市场条目 / 包隐私 / 发版闸门（strict），全绿才继续
npm run release   # 一条龙：体检 → 提交 → 推 main → tag/Release → npm → 市场条目
```

- `npm run ci` 就是 `.github/workflows/ci.yml` 的四步 + 发版闸门，**本地跑不过就不会推**，不会再出现「推上去等 GitHub 报红」。
- `npm run release` 用 REST API 推提交（`github.com:443` 被墙也能用），令牌优先取 `GH_TOKEN` 环境变量，其次读已存的 git 凭据（`credential.https://github.com.helper = manager` 已固定，不会再弹「选择凭据助手」）。
- 幂等：版本已发过就跳过 npm；tag/Release 已存在就跳过；市场条目只在新版本号时才更新。
- 想先看它要做什么：`node scripts/release-all.mjs --dry-run`。

## 0.1 出问题时的分工

| 现象 | 处理 |
|---|---|
| `npm run ci` 红 | 按它点名的那一项修，别推 |
| 令牌读不到 | `set GH_TOKEN=ghp_…` 再跑（脚本不会再弹窗） |
| npm 提示版本已存在 | 说明这次只改了文档/脚本：要么升版本号，要么不发（同版本 npm 不允许覆盖） |

> 目的：每次发新版本前，机器先替你查一遍——**别人装得上、升级不会进安全模式、你的本地隐私不跟着包走**。
> 一条命令：`npm run release:check:strict`（`npm publish` 会自动先跑它，不通过直接发不出去）。

---

## 1. 一键闸门做了什么

`scripts/release-check.mjs`（`--strict` 为发布模式）会检查四类东西：

| 类别 | 检查内容 | 不通过会怎样 |
|---|---|---|
| 打包内容 | `npm pack --dry-run` 的清单里不能有 `data/`、`.state/`、`*.bak*`、`*.lnk`、`*.db`、`.ndjson`、`tmp/`、`logs/`、`secrets/`、cookie / token / 私聊库 / 微信密钥脚本 | 直接 fail |
| 包内文本 | 扫描所有文本文件：`sk-` / `ghp_` / `AWS Key` / 私钥 / `_authToken` / 长 Bearer；再从本机 `.qqbot/private-people.json` 读真实账号与姓名，命中即 fail | 直接 fail |
| 兼容性 | 必需文件齐全；入口语法 `node --check`；本机 profile 是否出现 `file:F:/...` 绝对盘符依赖（会让 DSH 进安全模式） | fail / 警告 |
| 新用户可用性 | `live/persona.mjs` 必须自带默认名字、种族、性格兜底——没有 `character.json` 的机器也要有个有情绪、有世界观的小蓝 | 直接 fail |

额外**警告项**（不拦发布，但每次都会列出来）：代码里写死的本机绝对路径（目前 65 个文件，正在逐步改成从 `import.meta.url` 推）。

## 2. 发布流程

```bash
# 0) 改完代码、写好 CHANGELOG、把 package.json 版本 +1
node scripts/release-check.mjs --strict     # 或者 npm run release:check:strict
node scripts/sync-plugin-copies.mjs         # 只在本机自用需要（把 dist/ 等同步进 .pnpm 副本）

# 1) 打包（可选，闸门里已经 dry-run 过一遍）
npm pack

# 2) 发布（会自动再过一次 strict 闸门）
npm login                                   # 或把 token 放进 secrets/npm-token.txt
node scripts/publish-npm.mjs                # 或 npm publish --access public
```

发布后核对：

```bash
npm view dsh-qqbot-muu version              # 应该等于新版本号
npm view dsh-qqbot-muu dist.tarball         # 拿到 tarball 地址
```

## 3. 老用户升级为什么不会再进安全模式

2026-11-13 那次事故的根因是 **profile 的 `package.json` 里写了 `file:F:/qqbot` 这种绝对盘符**：
pnpm 会把它当相对路径拼成 `<profile>\F:\qqbot`，scandir 失败 → 整次 install 失败 → 市场基线立不起来 → 安全模式。
现在有三道保险：

1. **依赖写法**：用 `scripts/dsh-profile-links.mjs` 把依赖改成 `file:./local-plugins/<包名>`（相对路径 + junction）。
2. **启动自检**：`dist/gateway/bootstrap.js` 启动时检测绝对盘符依赖，命中就写日志 + 落标记 `.qqbot/profile-fix-needed.json`，并在日志里给出修复命令。
3. **发布闸门**：`release-check.mjs --strict` 在本机 profile 还有绝对盘符依赖时直接 fail，不让你带着这个雷发版。

另一个坑（跨包相对 import）：插件被 pnpm 复制到 `.pnpm/<包名>/node_modules/<包名>` 后，`import '../qqbot-mod/x.mjs'` 会 `ERR_MODULE_NOT_FOUND`。现在三个插件都用 `pickRepoRoot()`（环境变量 → 入口文件上一级 → 工作目录）解析仓库根，装在哪都能找到。

## 4. 隐私红线（发布包里永远不该有的东西）

- 运行时数据：`dshqqbot/.qqbot/`（记忆库、私聊库、cookie、名单）、`dshqqbot/.qqbot-extensions/data/`、`.state/`；
- 凭据：`secrets/`、`*token*`、`*cookie*`、`.env`、`wx4-key*.ps1`；
- 本机身份：真实 openid / wxid / watchId / 姓名（发布包只保留「家长 / 家人 / 小朋友」这类称呼）；
- 私聊归档：`private-chat.db`、`*.ndjson` 导出、媒体索引。

私聊相关的代码能力保留（别人也能用），只是**名单从本地文件读**：
`QQBOT_PRIVATE_PEERS` 环境变量，或 `{数据根}/.qqbot/private-people.json`。发布包里既没有名单也没有数据。

## 5. 新用户装完是什么样（情感与世界观的兜底）

- 人设：`live/persona.mjs` 内置 `小蓝 / 深海鲸鱼娘 / 迷糊、心软、爱玩`，没有 `character.json` 也能跑；
- 语气与边界：`client/qqbot-settings.js` 的默认群提示词 + `dist/config.js` 的默认配置；
- 记忆与发言：`memory-config.json` 缺失时代码里有 `DEFAULTS`，不需要手写配置；
- 配置样例：`bili-ops-config.example.json` 这类 `*.example.json` 会进包，真实配置不会。

## 6. 已知未清的技术债

- 65 个文件里还有 `F:/qqbot/...` 这种兜底常量（多数是「配置缺失时的最后兜底」，运行期一般不会命中）。改法是统一换成 `pickRepoRoot()`；改完 `release-check` 的警告会消失。
- 微信 4.0 本地库是 SQLCipher 加密，正文导出仍缺密钥；媒体文件（`msg/attach`）可直接归档。
