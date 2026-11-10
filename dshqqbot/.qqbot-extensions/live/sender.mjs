/**
 * live/sender.mjs — B 站直播间弹幕发送（Cookie + csrf，严格限流）
 *
 * 平台侧没有官方「机器人发言」接口（开放平台的消息发送能力需要额外权限与报备），
 * 因此这里走登录态弹幕接口，并且只在策略判定通过后调用。发送失败不重试轰炸。
 */
import { UA, cookieHeader } from '../lib/bili-api.mjs';

const ERR = {
  '-101': '登录态失效，需要重新扫码登录 B 站',
  '-111': 'csrf 校验失败（Cookie 里的 bili_jct 缺失或过期）',
  '10030': '发送频率过快，被平台限流',
  '10031': '发送频率过快，被平台限流',
  '1003212': '弹幕内容过长',
  '1003': '超出平台发送限制',
  '10024': '账号等级不足或未实名，暂时不能发言',
  '10026': '该直播间禁止发送弹幕',
  '10036': '弹幕内容触发平台风控',
};

export function canSend(cookies) {
  return Boolean(cookies && cookies.SESSDATA && cookies.bili_jct);
}

export async function sendBiliDanmaku({ cookies, roomId, text, timeoutMs = 12000 }) {
  if (!canSend(cookies)) {
    return { ok: false, error: '没有可发言的登录态（缺 SESSDATA 或 bili_jct）', needLogin: true };
  }
  const csrf = String(cookies.bili_jct);
  const body = new URLSearchParams({
    bubble: '0',
    msg: String(text || '').slice(0, 30),
    color: '16777215',
    mode: '1',
    fontsize: '25',
    rnd: String(Math.floor(Date.now() / 1000)),
    roomid: String(roomId),
    csrf,
    csrf_token: csrf,
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.live.bilibili.com/msg/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(cookies),
        referer: `https://live.bilibili.com/${roomId}`,
        origin: 'https://live.bilibili.com',
        'user-agent': UA,
      },
      body,
      signal: ctl.signal,
    });
    const j = await res.json().catch(() => null);
    const code = Number(j?.code ?? -1);
    if (code === 0 && j?.data?.mode_info === undefined) {
      return { ok: true, code: 0, msg: '已发送' };
    }
    if (code === 0) return { ok: true, code: 0, msg: '已发送' };
    return { ok: false, code, error: ERR[String(code)] || String(j?.message || j?.msg || '发送失败').slice(0, 80) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}
