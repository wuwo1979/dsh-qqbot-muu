/**
 * bot-restart.mjs —— /bot-restart 扩展命令（2026-10-28）
 *
 * 背景（主人被坑实录）：修复文档里一直写「发 /bot-restart 生效」，但宿主本体里
 * 根本没有这个命令 —— 发出去只会被当成普通聊天递给 AI，什么都不会发生。
 * 这个命令就是来还债的：把「改了东西之后怎么让它生效」一次说清楚，并把能热刷的当场热刷。
 *
 * 生效规则（真实情况，2026-10-28 核对）：
 *   · tools/lib、tools/*、出站扩展（outbound/*.mjs）  → /tools-reload 热刷即生效
 *   · inbound 钩子、commands（含本命令自身）          → tools-reload 大概率覆盖；不行就重启宿主
 *   · 浮窗宿主（settings-host / client）与宿主本体    → 只能重开 DSH Desktop（没有进程内重启 API）
 *   · 浮窗前端 JS                                     → 重启后 Ctrl+F5（看右上角版本戳确认）
 *
 * 热刷走的还是宿主自己的 tools_reload 能力：这里只是把「该发哪条命令」讲明白，
 * 不假装自己能重启 Electron（app.asar 里没有任何 restart/relaunch 暴露给扩展，实测确认）。
 */

export default {
  name: ['bot-restart', '重启bot', 'rebot'],
  description: '查看本次改动如何生效：哪些热刷就行、哪些要重开 DSH Desktop（不再假装能远程重启）',
  usage: '/bot-restart',

  async handler(ctx) {
    const lines = [
      '🛠 生效规则速查（2026-10-28 核对过宿主，没有进程内重启 API）：',
      '',
      '① 改了 tools/lib、tools/*、outbound/*（比如记忆分身、视频管线）',
      '   → 发 /tools-reload 热刷，立即生效',
      '',
      '② 改了浮窗宿主（settings-host / client）或宿主本体',
      '   → 只能重开 DSH Desktop（关掉再开），没有别的办法',
      '',
      '③ 浮窗界面看起来还是旧的',
      '   → 重启后在浮窗里 Ctrl+F5，右上角版本戳对上了就是新版（当前应为 v1028b+）',
      '',
      '（本命令只做指引，不能替你重启 —— 之前文档里写的 /bot-restart 是不存在的命令，已还债）',
    ];
    return { kind: 'text', content: lines.join('\n') };
  },
};
