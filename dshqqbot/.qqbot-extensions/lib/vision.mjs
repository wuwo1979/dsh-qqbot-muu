/**
 * vision.mjs — 让她真的看得见图。
 *
 * 背景（2026-11-02 主人报「图片识别不了」）：
 *   宿主会把她收到的图片塞进 ctx.message.attachments（每项 { contentType:'image/*', url }），
 *   但 url 只是"透传"给多模态模型用的 —— 我们跑的是纯文本模型，于是她看到的永远是字面量 `[图片]`。
 *   本模块补上这一环：把图交给**本机 ollama 的视觉模型**（qwen2.5vl:3b，已在本机 3.2GB），
 *   拿一句"图里有什么 + 图里的字"回来，再拼进这轮上下文。
 *
 * 设计取舍：
 *   - 只用本地模型：不花云 token、不外传图片（这机器上图片常常是隐私截图）。
 *   - 结果按 ref 的 sha1 缓存 30 天：同一张图（表情包、反复发的截图）不重复推理，10s→0ms。
 *   - 失败一律静默降级成 ''：看图是加分项，绝不能因为它挂掉整轮对话。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MODEL = 'qwen2.5vl:3b';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const PROMPT =
  '用中文回答。用两三句话说明这张图里有什么；图里有文字就原样抄出来（最多 200 字），不要翻译、不要评价、不要客套。';
// 2026-11-07：默认 4k 上下文装不下聊天截图（ollama 报 400「exceeds the available context size」），
// 以前吞成静默失败 → 她只说「收到一张图」。这里放大到 8k，仍超则再升到 16k 重试一次。
const CTX_TOKENS = 8192;
const CTX_TOKENS_MAX = 16384;

function cacheDir(dataRoot) {
  const d = join(String(dataRoot || '.'), '.qqbot', 'vision-cache');
  try { mkdirSync(d, { recursive: true }); } catch { /* 建不出来就用内存态（下面直接跳过缓存） */ }
  return d;
}

function cacheKey(ref, bytes) {
  const h = createHash('sha1');
  h.update('v3:'); // 提示词/模型换代时让旧缓存自然失效，避免继续用旧语言/旧质量的描述
  h.update(String(ref).slice(0, 200));
  h.update(':');
  h.update(String(bytes?.length || 0));
  return h.digest('hex').slice(0, 20);
}

function readCache(dataRoot, key, now = Date.now()) {
  try {
    const p = join(cacheDir(dataRoot), key + '.json');
    if (!existsSync(p)) return '';
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (!j || typeof j.text !== 'string') return '';
    if (now - Number(j.ts || 0) > CACHE_TTL_MS) return '';
    return j.text;
  } catch { return ''; }
}

function writeCache(dataRoot, key, text, extra = {}) {
  try {
    writeFileSync(join(cacheDir(dataRoot), key + '.json'),
      JSON.stringify({ ts: Date.now(), text, ...extra }), 'utf8');
  } catch { /* 缓存写不进去不影响出结果 */ }
}

/** 把 ref 变成字节：本机路径 / file: / http(s) / data: 四种 */
export async function readRef(ref, { timeoutMs = 20000 } = {}) {
  const s = String(ref || '').trim();
  if (!s) return { ok: false, error: '空 ref' };
  try {
    if (s.startsWith('data:')) {
      const i = s.indexOf(',');
      if (i < 0) return { ok: false, error: 'data URI 没有逗号' };
      const head = s.slice(0, i);
      const b64 = s.slice(i + 1);
      const buf = head.includes(';base64') ? Buffer.from(b64, 'base64') : Buffer.from(decodeURIComponent(b64), 'utf8');
      return { ok: true, bytes: buf };
    }
    if (/^https?:\/\//i.test(s)) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const r = await fetch(s, {
          signal: ac.signal,
          headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126' },
        });
        if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > MAX_BYTES) return { ok: false, error: `图太大 ${Math.round(buf.length / 1024)}KB` };
        return { ok: true, bytes: buf };
      } finally { clearTimeout(t); }
    }
    const p = s.startsWith('file://') ? decodeURIComponent(s.replace(/^file:\/\//i, '')) : s;
    if (!existsSync(p)) return { ok: false, error: '文件不存在: ' + p };
    const buf = readFileSync(p);
    if (buf.length > MAX_BYTES) return { ok: false, error: `图太大 ${Math.round(buf.length / 1024)}KB` };
    return { ok: true, bytes: buf };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * 看图 → 一句话描述。
 * @returns {Promise<{ok:boolean,text?:string,ms?:number,cached?:boolean,error?:string}>}
 */
export async function describeImage(dataRoot, ref, opts = {}) {
  const model = String(opts.model || DEFAULT_MODEL);
  const endpoint = String(opts.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const timeoutMs = Math.max(3000, Number(opts.timeoutMs) || 90000);
  const got = await readRef(ref, { timeoutMs: Math.min(timeoutMs, 20000) });
  if (!got.ok) return { ok: false, error: got.error };

  const key = cacheKey(ref, got.bytes);
  const hit = readCache(dataRoot, key);
  if (hit) return { ok: true, text: hit, cached: true, ms: 0 };

  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const send = (numCtx) => fetch(endpoint + '/api/generate', {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: PROMPT,
        images: [got.bytes.toString('base64')],
        stream: false,
        options: { num_predict: 220, temperature: 0.2, num_ctx: numCtx },
      }),
    });
    let r = await send(CTX_TOKENS);
    // 大截图（1080p 聊天记录）会超上下文：ollama 明确报 400 + context size，此时升一档重试。
    if (r.status === 400) {
      const err = await r.text();
      if (!/context size/i.test(err)) return { ok: false, error: `ollama HTTP 400 ${err.slice(0, 80)}` };
      r = await send(CTX_TOKENS_MAX);
      if (!r.ok) return { ok: false, error: `ollama HTTP ${r.status}（大图仍超上下文）` };
    } else if (!r.ok) {
      return { ok: false, error: 'ollama HTTP ' + r.status };
    }
    const j = await r.json();
    const text = String(j?.response || '').replace(/\s+/g, ' ').trim().slice(0, 260);
    if (!text) return { ok: false, error: '模型没说话' };
    writeCache(dataRoot, key, text, { model, bytes: got.bytes.length });
    return { ok: true, text, ms: Date.now() - t0 };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, error: aborted ? `超时 ${Math.round(timeoutMs / 1000)}s` : (e?.message || String(e)) };
  } finally { clearTimeout(timer); }
}

/**
 * 从消息里挑出图片，最多 n 张。
 * 2026-11-07：补上引用消息里的图（quote.attachments）与表情包（contentType=sticker/emoji），
 * 之前只读 message.attachments，引用图/表情包永远只有一句「收到一张图」。
 */
export function imageRefsOf(message, n = 2) {
  const lists = [
    message?.attachments,
    message?.quote?.attachments,
    message?.quoted?.attachments,
    message?.quote?.message?.attachments,
  ];
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      const ct = String(a?.contentType || a?.type || a?.content_type || '').toLowerCase();
      const url = String(a?.url || a?.file || a?.path || '').trim();
      if (!url) continue;
      // 普通图片：contentType 带 image 或扩展名像图；表情包：sticker/emoji 或 gif/webp
      const isImg = ct.includes('image') || ct.includes('sticker') || ct.includes('emoji')
        || /\.(png|jpe?g|gif|webp|bmp)$/i.test(url);
      if (!isImg) continue;
      if (out.includes(url)) continue;
      out.push(url);
      if (out.length >= n) return out;
    }
  }
  return out;
}
