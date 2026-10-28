# 浮窗「B 站管理」面板补丁（参考块）

2026-10-24 加的面板代码，已打进当前活插件：

- `settings-host.js`：`GET/POST /api/qqbot-settings/bili`（任务列表 / 审核 / 驳回 / 手动投稿）
- `client/qqbot-settings.js`：`🎬 B 站管理（<我的B站号名>）` 卡片 + 刷新 + 通过/驳回按钮

插件升级会生成新代际并覆盖 `dist`/`settings-host.js`/`client`，所以把两段代码抽出来放这里，升级后按下面步骤重打。

## 重打步骤（务必先备份）

1. `settings-host.js`
   - 在 `  route(ctx, 'GET', '/api/qqbot-settings/memory', …` 这一行**之前**插入
     `settings-host.block.js` 的全部内容。
2. `client/qqbot-settings.js`
   - 在 `  function applyModelDir(dir) {` 这一行**之前**插入
     `client-functions.block.js` 的全部内容。
   - 在 `body += extCardHtml()` 之后加一行：
     `body += biliCardHtml()`
   - 在 `bindToolErrCard()` 之后加一行：
     `bindBiliCard()`
3. 语法检查：
   ```powershell
   node --check <插件目录>\settings-host.js
   node --check <插件目录>\client\qqbot-settings.js
   ```
4. 重启 DSH 桌面端（路由注册）→ 浏览器 Ctrl+R（客户端卡片）。

## 依赖

- `{数据根}/.qqbot-extensions/lib/bili-ops.mjs`（`listJobs/readRecords/approveJob/publishJob/updateJob/appendRecord/loadOpsConfig`）
- `{数据根}/.qqbot-extensions/tools/bili_ops.mjs`（主人校验与投稿门禁；面板只是审核入口，不绕过 `requireApproval`）

## 注意

- 面板的「通过」= 自动投稿（`publish.mode=web`），仍受 `requireApproval`、每日额度、主人身份（`ownerOpenids` / `groupAdmin.owners`）约束。
- 若 B 站登录失效，面板只显示任务，不会自动发评论/投稿。
