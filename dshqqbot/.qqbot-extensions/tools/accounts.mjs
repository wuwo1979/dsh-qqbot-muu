/**
 * tools/accounts.mjs —— 账号管理（B 站 + 抖音 一个入口）
 *
 * 定位（重要，别改错）：
 *   · B 站：能自动的照旧自动（扫码登录 / 投稿 / 评论），但一律过 pacing 闸门（随机间隔 + 日配额 + 风控冷却）。
 *   · 抖音：登录给「官方页面二维码 + 说明 + 粘 Cookie」，投稿给「一键打开创作者中心上传页」。
 *     抖音网页端接口要 a_bogus/X-Bogus 签名与设备指纹，硬算等于把自己标成高危机器人，所以不做自动投稿。
 *
 * 主人 2026-10-27 的诉求：B 站被判定高危后先不管，改经营抖音；浮窗「B 站管理」→「账号管理」。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DATA_ROOT_FALLBACK = 'F:/qqbot/dshqqbot';

function dataRoot() {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  try {
    const cfg = JSON.parse(readFileSync(join(DATA_ROOT_FALLBACK, 'memory-config.json'), 'utf8'));
    return cfg.dataRoot || DATA_ROOT_FALLBACK;
  } catch {
    return DATA_ROOT_FALLBACK;
  }
}

function libUrl(rel) {
  const root = dataRoot().replace(/\\/g, '/');
  return pathToFileURL(join(root, '.qqbot-extensions', 'lib', rel)).href;
}

async function platforms() {
  return import(libUrl('platforms/index.mjs'));
}

function fmtOne(p) {
  const st = p.loggedIn === true ? '✅ 已登录' : p.loggedIn === null ? '◐ 状态未知' : '○ 未登录';
  const who = p.nickname ? `（${p.nickname}${p.uid ? ' / ' + p.uid : ''}）` : '';
  const pace = p.paced && p.paced.counts
    ? Object.keys(p.paced.counts).filter((k) => !/At$/.test(k)).map((k) => `${k} ${p.paced.counts[k]}/${(p.paced.caps || {})[k] || 0}`).join(' · ')
    : '';
  return `${p.label || p.platform}：${st}${who}${p.hint ? '｜' + p.hint : ''}${pace ? '\n  今日：' + pace : ''}`;
}

async function run(args = {}) {
  const root = dataRoot();
  const action = String(args.action || 'status');
  try {
    const P = await platforms();
    if (action === 'status') {
      const o = await P.overview(root);
      const lines = (o.platforms || []).map(fmtOne);
      return { ok: true, msg: lines.join('\n') || '没有平台', platforms: o.platforms };
    }
    if (action === 'douyin' || action === 'douyin-login') {
      const d = await P.detail(root, 'douyin');
      const lg = d.login || {};
      return {
        ok: true,
        status: d.status,
        url: lg.url,
        creatorUrl: lg.creatorUrl,
        uploadUrl: lg.uploadUrl,
        msg: [
          `扫码打开官方登录页：${lg.url}`,
          ...(lg.howto || []).map((s, i) => `${i + 1}. ${s}`),
          '',
          `说明：${lg.why || ''}`,
        ].join('\n'),
      };
    }
    if (action === 'douyin-cookie') {
      const raw = String(args.cookie || args.text || '').trim();
      if (!raw) return { ok: false, msg: '要用 douyin-cookie 就把 Cookie 整行放进 cookie 参数' };
      const mod = await import(libUrl('platforms/douyin.mjs'));
      const r = mod.saveCookie(root, raw, String(args.note || ''));
      return { ok: !!r.ok, msg: r.ok ? `已保存抖音 Cookie（${r.bytes} 字节${r.hasSid ? '，含会话' : '，但没看到 sessionid，可能不全'}）` : `保存失败：${r.error}` };
    }
    if (action === 'douyin-upload') {
      const mod = await import(libUrl('platforms/douyin.mjs'));
      const path = String(args.path || args.file || '').trim();
      const info = await mod.loginInfo();
      const st = await mod.status(root);
      return {
        ok: true,
        status: st,
        url: info.uploadUrl,
        msg: [
          '抖音不支持自动投稿（要 a_bogus 签名，硬闯会被判高危），这一步走网页：',
          `1. 打开创作者中心上传页：${info.uploadUrl}`,
          path ? `2. 上传这个文件：${path}` : '2. 上传你刚做好的成片（路径我下面给了）',
          '3. 标题/简介/封面按面板里那份 meta 填，发布时勾「定时」或立刻发都行',
        ].join('\n'),
      };
    }
    if (action === 'douyin-like') {
      const mod = await import(libUrl('platforms/douyin.mjs'));
      const raw = String(args.link || args.url || args.awemeId || '').trim();
      if (!raw) return { ok: false, msg: 'douyin-like 需要抖音视频链接（分享短链或 https://www.douyin.com/video/7xxx 都行）' };
      const pv = await mod.parseVideoLink(raw);
      if (!pv || !pv.ok) return { ok: false, msg: '认不出这个链接：' + String((pv && pv.error) || raw).slice(0, 80) };
      const off = ['off', '0', '取消', 'unlike'].includes(String(args.like || '').toLowerCase());
      const r = await mod.diggVideo(root, { awemeId: pv.awemeId, like: !off });
      if (!r.ok) return { ok: false, msg: r.error || '点赞失败', detail: r };
      return { ok: true, msg: `${r.msg}（${pv.awemeId}）`, detail: r };
    }
    if (action === 'douyin-follows') {
      const mod = await import(libUrl('platforms/douyin.mjs'));
      const r = await mod.followingList(root, { count: Number(args.limit || 20) || 20 });
      if (!r.ok) return { ok: false, msg: r.error || '拉关注列表失败', detail: r };
      const lines = r.users.map((u, i) => `${i + 1}. ${u.nickname || '（没名字）'}${u.uniqueId ? `（抖音号 ${u.uniqueId}）` : ''}`);
      return {
        ok: true,
        total: r.total,
        users: r.users,
        msg: r.users.length ? `关注/互关 ${r.users.length} 人：\n${lines.join('\n')}` : (r.note || '平台没给关注列表'),
      };
    }
    if (action === 'bili') {
      const d = await P.detail(root, 'bili');
      return { ok: true, status: d.status, qr: d.qr, msg: fmtOne(d.status) + (d.status?.loggedIn ? '' : '\n要重新登录：扫码后点「我已确认」') };
    }
    return { ok: false, msg: `未知 action：${action}（可用 status / douyin / douyin-cookie / douyin-upload / bili）` };
  } catch (e) {
    return { ok: false, msg: `账号工具出错：${String((e && e.message) || e)}` };
  }
}

export const name = 'accounts';
export const expose = 'all';
export const description =
  '账号管理：B 站 + 抖音 一个入口。status 看两边登录态与今日配额；douyin 给官方登录页与扫码说明；' +
  'douyin-cookie 存 Cookie；douyin-upload 给创作者中心上传页；douyin-like 给抖音视频点赞/取消；' +
  'douyin-follows 看关注/互关的人；bili 看 B 站状态/二维码。' +
  '所有写操作都过 pacing（随机 45s~4min、日配额、风控冷却），不做批量刷的行为。';
export const inputSchema = {
  action: { type: 'string', required: true, description: 'status | douyin | douyin-cookie | douyin-upload | douyin-like | douyin-follows | bili' },
  link: { type: 'string', description: 'douyin-like 必填：抖音视频链接（v.douyin.com 短链 / douyin.com/video/<id> / 纯数字 id）' },
  awemeId: { type: 'string', description: 'douyin-like 可选：直接给视频 ID（给了就不用 link）' },
  like: { type: 'string', description: 'douyin-like 可选：on（默认）或 off（取消赞）' },
  cookie: { type: 'string', description: 'douyin-cookie 必填：浏览器里 Cookie 那一整行' },
  note: { type: 'string', description: 'douyin-cookie 可选：备注' },
  path: { type: 'string', description: 'douyin-upload 可选：要上传的成片路径（只用于提示）' },
};
export { run };
