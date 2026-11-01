/**
 * restart-info.mjs —— /restart-info 扩展命令（2026-10-29 改名让位）
 *
 * ⚠️ 历史：本命令原名 /bot-restart（2026-10-28 建，当时宿主里没有这个命令）。
 *   2026-10-29 发现官方 1.10.39 的 dist/commands/exit.js **已内置同名 /bot-restart**
 *   （真正自重启宿主），两个同名注册把 SDK slash-command 直接炸出
 *   `duplicate name "bot-restart"` → 网关启动失败 → 机器人整天离线。
 *   于是本文件改名让位：**真重启用官方 /bot-restart**；本命令只留「怎么让改动生效」的速查。
 */

export default {
  name: ['restart-info', '生效规则'],
  description: '查看本次改动如何生效：哪些 /tools-reload 热刷就行、哪些要重开 DSH Desktop（真重启用官方 /bot-restart）',
  usage: '/restart-info',

  async handler(ctx) {
    const lines = [
      '🛠 生效规则速查（2026-10-28 核对过宿主）：',
      '',
      '① 改了 tools/lib、tools/*、outbound/*（比如记忆分身、视频管线）',
      '   → 发 /tools-reload 热刷，立即生效',
      '',
      '② 改了浮窗宿主（settings-host / client）或宿主本体',
      '   → 只能重开 DSH Desktop（关掉再开）',
      '',
      '③ 要重启机器人/宿主本体',
      '   → 用官方 /bot-restart（1.10.39 内置，会真重启宿主）',
      '',
      '④ 浮窗界面看起来还是旧的',
      '   → 重启后在浮窗里 Ctrl+F5，右上角版本戳对上了就是新版',
    ];
    return { kind: 'text', content: lines.join('\n') };
  },
};
