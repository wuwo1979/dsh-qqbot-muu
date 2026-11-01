# pet-gate — 桌宠公网网关（限制人数 + 可重置 + 防攻击）

把「网页实时桌宠」发布成公网链接的安全网关，双层结构：

```
浏览器（群友，手机/电脑）
   │  HTTPS（发布平台提供）
   ▼
server.mjs（云端沙箱，本次发布的就是它）
   │  · 登录门：访问码（恒时比较，错 5 次/10分钟拉黑 15 分钟）
   │  · 席位：同时只允许 secrets.json seats 个人（默认 1），席位满拒绝新登录
   │  · 会话：HttpOnly+HMAC 签名 cookie，空闲 30 分钟自动退席，最长 12 小时
   │  · 全局限速 120 req/min/IP；请求体 ≤64KB；路径白名单；安全响应头
   │  · 静态素材 /media/**（media/ 目录随包分发，免中继）
   │  · /api/qqbot-settings/pet-* → 任务队列（长轮询中继）
   ▼
agent.mjs（本机运行：node pet-gate/agent.mjs）
   │  主动外连云端（本机不开任何入站端口），取任务 → 代答本机 harness
   │  dsh token 全程不出本机；本地再验一次路径白名单
   ▼
harness pet-panel（/api/qqbot-settings/pet-anim|pet-media|pet-status）
```

## 文件

| 文件 | 说明 | 入库？ |
|---|---|---|
| server.mjs | 云端网关（发布用） | ✅ |
| gate-page.mjs | 登录页 + 桌宠页 | ✅ |
| agent.mjs | 本机连接器 + 管理 CLI | ✅ |
| package.json | `npm start` → node server.mjs | ✅ |
| secrets.json | accessKey/adminKey/agentKey（首次启动自动生成） | ❌ gitignore |
| seats.json | 席位状态（重启不丢） | ❌ gitignore |
| media/ | 桌宠 webm 素材（从 harness 拷贝） | ❌ gitignore |

## 日常操作（在 F:/qqbot 下）

```bash
node pet-gate/agent.mjs              # 启动本机连接器（建议开机自启/常驻）
node pet-gate/agent.mjs status       # 看席位占用（谁在在线、闲了多久）
node pet-gate/agent.mjs reset-seat   # 重置席位：踢掉当前在线的人（可重进）
node pet-gate/agent.mjs new-key      # 换访问码：旧码立即作废，新码打印出来
```

## 更新素材

小蓝重渲染后同步一次：

```bash
cp "$APPDATA/dsh-desktop/harness/dsh-pet/pet/xiaolan-animation/"*.webm pet-gate/media/xiaolan/
# 然后重新发布（分享链接不变）
```

## 安全边界

- 访问码只给指定的人；泄露就 `new-key` 换码，`reset-seat` 踢人。
- 云端沙箱里只有页面/素材/任务队列，没有任何凭据可换 fare（dsh token 在本机内存）。
- 中继路径双重白名单（云端+本机各验一次），其余一律 404。
- adminKey 只在本机 CLI 里使用，走 HTTPS 传输但不落任何日志/页面。
