import { spawn } from 'node:child_process'

/**
 * tools/open_link.mjs —— 在「她所在的那台电脑」上打开一个链接
 *
 * 用在：主人说「打开这个视频 / 帮我把这个抖音打开 / 看看这个 B 站链接」时。
 * 只打开浏览器/默认程序，不下载、不登录、不改任何账号状态。
 */

export const name = 'open_link'

export const description =
  '在运行她的这台电脑上用默认浏览器打开一个 http(s) 链接（抖音、B 站、其他网页都行）。当主人说「打开这个视频/把链接打开/我电脑上打开看看」时调用；打开后可以再读一次内容讲给他听。'

export const inputSchema = {
  url: { type: 'string', required: true, description: '要打开的 http(s) 链接' },
  why: { type: 'string', description: '可选：为什么打开（会记进日志，方便排查）' },
}

function isSafeUrl(u) {
  try {
    const x = new URL(String(u || '').trim())
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return false
    if (!x.hostname || !/\./.test(x.hostname)) return false
    return true
  } catch {
    return false
  }
}

export async function run(args = {}) {
  const url = String(args.url || '').trim()
  if (!isSafeUrl(url)) return { ok: false, error: '这不是一个有效的 http(s) 链接' }

  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const argv = isWin ? ['/c', 'start', '', url] : [url]

  try {
    const child = spawn(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => { /* 打开失败由下面统一报 */ })
    child.unref()
    return {
      ok: true,
      url,
      why: String(args.why || ''),
      msg: `已在这台电脑上用默认浏览器打开：${url}`,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export default { name, description, inputSchema, run, expose: 'all' }
