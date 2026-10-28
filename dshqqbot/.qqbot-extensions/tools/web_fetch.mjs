/**
 * web_fetch.mjs — 工具 `web_fetch`：真的把网页抓下来，转成可读正文
 *
 * 为什么单独做：bing_search 只给标题+摘要，用户发来一个链接说"看看这个"时，
 * 模型没法只靠摘要回答；本地小模型又没有工具能力，容易变成"我去看看"然后什么都没做。
 * 这个工具让云端大脑有一条真实可执行的抓取链路。
 *
 * 安全：
 *   · 只允许 http/https；
 *   · 拒绝 localhost / 内网 / 链路本地地址（防止被诱导扫本机端口）；
 *   · 手动跟随重定向，每一跳都重新校验；
 *   · 超时 15 秒，正文截断到 maxChars（默认 4000）。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const DEFAULT_CHARS = 4000;
const MAX_CHARS = 12000;

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  middot: '·', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z#0-9]+);/g, (m, name) => (name in ENTITY_MAP ? ENTITY_MAP[name] : m));
}

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || h === '0.0.0.0' || h === '::1') return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^(fc|fd|fe80)/i.test(h) && h.includes(':')) return true;
  // 纯数字/十六进制主机名（127.1、0x7f000001 这类绕过写法）
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return true;
  return false;
}

function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { ok: false, error: '不是合法 URL' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: '只支持 http/https 链接' };
  if (isPrivateHost(u.hostname)) return { ok: false, error: '拒绝访问本机/内网地址' };
  return { ok: true, url: u.toString() };
}

function charsetOf(contentType, buf) {
  const head = Buffer.from(buf).subarray(0, 2048).toString('latin1');
  const m =
    /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType || '')) ||
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  let cs = (m && m[1] || 'utf-8').toLowerCase();
  if (cs === 'gb2312' || cs === 'gbk') cs = 'gb18030';
  return cs;
}

function decodeBody(buf, contentType) {
  const cs = charsetOf(contentType, buf);
  try { return new TextDecoder(cs, { fatal: false }).decode(buf); }
  catch { try { return new TextDecoder('utf-8', { fatal: false }).decode(buf); } catch { return Buffer.from(buf).toString('utf8'); } }
}

function htmlToText(html) {
  let s = String(html || '');
  const title = decodeEntities((s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  s = s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|canvas|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n· ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: s };
}

async function fetchOnce(target) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(target, {
      redirect: 'manual',
      signal: ctl.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFollow(rawUrl) {
  let current = rawUrl;
  const chain = [];
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const c = checkUrl(current);
    if (!c.ok) return { ok: false, error: c.error, url: current, chain };
    const res = await fetchOnce(c.url);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, error: '重定向缺少 Location', url: current, chain };
      current = new URL(loc, c.url).toString();
      chain.push(current);
      continue;
    }
    const ab = await res.arrayBuffer();
    return { ok: true, res, url: c.url, buf: Buffer.from(ab), chain };
  }
  return { ok: false, error: '重定向次数过多', url: current, chain };
}

export async function run(args) {
  const a = args || {};
  const checked = checkUrl(a.url);
  if (!checked.ok) return { ok: false, msg: `抓取失败：${checked.error}` };

  let r;
  try {
    r = await fetchFollow(checked.url);
  } catch (e) {
    const why = e && e.name === 'AbortError' ? '超时（15 秒）' : (e instanceof Error ? e.message : String(e));
    return { ok: false, msg: `抓取失败：${why}` };
  }
  if (!r.ok) return { ok: false, msg: `抓取失败：${r.error}` };
  if (r.res.status < 200 || r.res.status >= 400) {
    return { ok: false, msg: `抓取失败：HTTP ${r.res.status}` };
  }

  const ct = String(r.res.headers.get('content-type') || '');
  const maxChars = Math.max(200, Math.min(MAX_CHARS, Number(a.maxChars) || DEFAULT_CHARS));
  let title = '';
  let text = '';
  if (/json/i.test(ct)) {
    text = r.buf.toString('utf8');
  } else if (/html|xml/i.test(ct) || /^\s*</.test(r.buf.subarray(0, 64).toString('latin1'))) {
    const h = htmlToText(decodeBody(r.buf, ct));
    title = h.title;
    text = h.text;
  } else {
    text = decodeBody(r.buf, ct);
  }

  if (!text.trim()) return { ok: false, msg: `抓取失败：页面没有可读正文（HTTP ${r.res.status}，${ct || '未知类型'}）` };
  const clipped = text.length > maxChars ? text.slice(0, maxChars) + '\n…（正文过长，已截断）' : text;

  const head = [
    '已抓取网页' + (title ? '：' + title : ''),
    'URL：' + checked.url + (r.chain.length ? `（经 ${r.chain.length} 次跳转）` : ''),
    `正文 ${text.length} 字${text.length > maxChars ? `，以下为前 ${maxChars} 字` : ''}：`,
    '',
  ].join('\n');
  return { ok: true, msg: head + clipped };
}

export default {
  name: 'web_fetch',
  expose: 'all',
  description:
    '抓取一个网页并返回可读正文（标题 + 正文，默认 4000 字）。用户发来链接、要求"看看这个网页/读一下这个网址/抓一下这个链接"时用它，不要凭空猜网页内容。只支持 http/https 公网地址。',
  inputSchema: {
    url: { type: 'string', required: true, description: '要抓取的 http/https 网址' },
    maxChars: { type: 'integer', description: `最多返回多少字，默认 ${DEFAULT_CHARS}，上限 ${MAX_CHARS}` },
  },
  run,
};
