#!/usr/bin/env node
/**
 * sticker-vision-cli.mjs — 本地视觉打标 CLI（零 token）
 *
 * 给插件 dist/features/sticker-tagger.js 的 visionCli 调用：
 *   sticker.visionCli: node "F:\qqbot\qqbot-mod\scripts\sticker-vision-cli.mjs" "{img}"
 *
 * 读一张本地图片 → 调本机 Ollama 的视觉模型 → 按插件约定的 JSON 输出：
 *   {"result":{"summary":"【标签】…\n【描述】…"}}
 * 模型不可用/超时 → 退出码 1（插件会跳过，把图留在"待整理"）。
 *
 * 用法：node sticker-vision-cli.mjs <图片路径>
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const img = process.argv[2];
if (!img) {
  console.error('用法: node sticker-vision-cli.mjs <图片路径>');
  process.exit(2);
}

const MODEL = process.env.STICKER_VISION_MODEL || 'qwen2.5vl:3b';
// OLLAMA_HOST 常被服务端设成 0.0.0.0（监听地址），客户端要换回本机回环；缺协议/端口时补齐
function normalizeHost(raw) {
  let h = String(raw || '').trim().replace(/\/+$/, '');
  if (!h) return 'http://127.0.0.1:11434';
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  h = h.replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/i, '$1127.0.0.1');
  if (!/:\d+$/.test(h)) h += ':11434';
  return h;
}
const HOST = normalizeHost(process.env.OLLAMA_HOST);
const PROMPT = '请用简体中文回答，只输出两行，不要输出其他内容：第一行以【标签】开头，给出 3-6 个逗号分隔的中文短标签（从内容/情绪/用途三个维度）；第二行以【描述】开头，给一句中文详细描述（画面内容+情绪+适合在什么群聊场合用这张图）。';

let buf;
try {
  buf = readFileSync(img);
} catch (e) {
  console.error('读图失败:', e.message);
  process.exit(1);
}
if (buf.length > 8 * 1024 * 1024) {
  console.error('图片超过 8MB，跳过');
  process.exit(1);
}

const t0 = Date.now();
const imgB64 = buf.toString('base64');

function looksDegenerate(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (!/[\u4e00-\u9fa5]/.test(t)) return true;          // 没有一个汉字 → 基本是乱码
  const head = t.slice(0, 40);
  const chars = {};
  for (const ch of head) chars[ch] = (chars[ch] || 0) + 1;
  return Math.max(...Object.values(chars)) / head.length > 0.6;
}

async function ask(prompt, attempt) {
  const body = {
    model: MODEL,
    stream: false,
    keep_alive: '10m',
    messages: [{ role: 'user', content: prompt, images: [imgB64] }],
    options: {
      temperature: [0.3, 0.6, 0.8][attempt] || 0.8,
      seed: attempt === 0 ? 7 : attempt * 131 + 7,
      num_predict: attempt >= 2 ? 96 : 160,
      repeat_penalty: 1.1,
      repeat_last_n: 128,
    },
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 85_000);
  try {
    const res = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return { error: `Ollama 返回 ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    return { text: String(data?.message?.content || '').trim() };
  } catch (e) {
    return { error: e.message };
  }
}

async function askBest(prompt) {
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await ask(prompt, attempt);
    if (r.error) { lastErr = r.error; continue; }
    if (!looksDegenerate(r.text)) return { text: r.text };
    lastErr = '模型输出退化（重复字符）';
  }
  return { error: lastErr };
}

// 有些表情包会让模型卡在「两行格式」里反复输出乱码：退化成自由描述，再从描述里抽标签
function tagsFromDesc(desc) {
  const STOP = new Set(['一个', '这张', '图片', '画面', '展示', '显示', '适合', '用于', '可以', '这个', '那个', '其中', '以及', '然后', '非常', '比较', '人物', '角色', '卡通']);
  const segs = String(desc || '').split(/[，。、；：,.;:\s（）()“”"']+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const s of segs) {
    if (s.length < 2 || s.length > 10) continue;
    if (STOP.has(s)) continue;
    if (!/[\u4e00-\u9fa5]/.test(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= 5) break;
  }
  return out;
}

let summary = '';
let lastErr = '';
const strict = await askBest(PROMPT);
if (strict.text) summary = strict.text;
else {
  lastErr = strict.error || '';
  const loose = await askBest('请用一句简体中文描述这张图里的内容、人物情绪和适合使用的场合。不要分点。');
  if (loose.text) {
    const desc = loose.text.replace(/^【[^】]*】/, '').trim();
    const tags = tagsFromDesc(desc);
    summary = '【标签】' + (tags.join(',') || '表情包,图片') + '\n【描述】' + desc;
  }
}
if (!summary) {
  console.error(`打标失败(${basename(img)}): ${lastErr || '模型没有返回内容'}；是不是没有 ollama pull ${MODEL}？`);
  process.exit(1);
}
// JSON 模式 → 转成插件约定的【标签】/【描述】两行
try {
  const j = JSON.parse(summary);
  const tags = Array.isArray(j.tags) ? j.tags.map((x) => String(x).trim()).filter(Boolean) : [];
  const desc = String(j.desc || j.description || '').trim();
  if (tags.length || desc) summary = '【标签】' + tags.join(',') + '\n【描述】' + desc;
} catch { /* 不是 JSON 就按原文用 */ }
if (!/^【标签】/.test(summary)) {
  console.error('模型输出不合格式：' + summary.slice(0, 120));
  process.exit(1);
}

process.stderr.write(`[sticker-vision] ${basename(img)} ${Date.now() - t0}ms\n`);
process.stdout.write(JSON.stringify({ result: { summary } }));
