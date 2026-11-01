/**
 * share_now — 手动让小蓝现在分享一条（不用等自动间隔）
 *
 * 主人 2026-10-31：「主动分享……我希望能是手动触发式 + 可选时间间隔」。
 *
 * 链路：本工具只写一个请求文件（{dataRoot}/.qqbot-extensions/data/share-request.json），
 * hooks/proactive-share.mjs 每 30s 读一次、读到就排一条 now+30s 的私聊任务 ——
 * 到点插件伪造入站消息，她用自己的口吻说出来（不是机械转发）。最长 30 秒后开口。
 *
 * 动作：
 *   · status  —— 今天发了几条、上次什么时候、自动间隔/静默时段是什么
 *   · list    —— 今天可分享的素材（去重后，带 key）+ 能发给谁
 *   · trigger —— 请求立即分享（默认）；可指定素材 key、自定义一句话、指定对象
 *
 * 纪律：只读本地文件，零模型调用、零网络请求。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectShareMaterial } from '../hooks/proactive-share.mjs';

const CONFIG_NAME = 'share-config.json';
const STATE_NAME = 'share-state.json';
const REQUEST_NAME = 'share-request.json';

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const isOpenid = (s) => /^[A-Za-z0-9_-]{16,}$/.test(String(s || ''));

function readJson(p, dflt) {
  try { return JSON.parse(String(readFileSync(p, 'utf8')).replace(/^\uFEFF/, '')) || dflt; } catch { return dflt; }
}

const short = (s, n = 60) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const chatId = (x) => String((x && (x.openid != null ? x.openid : (x.gid != null ? x.gid : x.id))) ?? '');

/** 分享对象：配置显式 targets 优先，否则 group-tiers 的 priorityPeople */
function targetsOf(root, cfg, qq) {
  const names = new Map();
  for (const x of (qq && Array.isArray(qq.c2c) ? qq.c2c : [])) names.set(chatId(x), String(x.name || ''));
  const pick = (id, name) => ({ id, name: name || names.get(id) || '' });
  const explicit = Array.isArray(cfg.targets) ? cfg.targets : [];
  if (explicit.length) {
    return explicit
      .map((t) => (typeof t === 'string' ? { id: t, name: '' } : { id: String((t && (t.id || t.openid)) || ''), name: String((t && t.name) || '') }))
      .map((t) => pick(t.id.replace(/^(c2c:|qq:)/, '').trim(), t.name))
      .filter((t) => t.id && isOpenid(t.id));
  }
  const tiers = readJson(join(String(root), '.qqbot-extensions', 'data', 'group-tiers.json'), {}) || {};
  return (Array.isArray(tiers.priorityPeople) ? tiers.priorityPeople : [])
    .map((x) => pick(String(x).replace(/^(c2c:|qq:)/, '').trim(), ''))
    .filter((t) => t.id && isOpenid(t.id));
}

const when = (ts) => (Number(ts) ? new Date(Number(ts)).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '（还没有）');

export default {
  name: 'share_now',
  expose: 'all',
  description: '手动触发小蓝主动分享（给爸爸妈妈）：可先列出今天能分享的素材，再挑一条立刻发；也能看今天已发几条、自动间隔设置。零模型调用，最长 30 秒后开口',
  inputSchema: {
    action: { type: 'string', enum: ['status', 'list', 'trigger'], description: 'status=看今天发了没；list=看今天可分享的素材与对象；trigger=立刻分享（默认）' },
    key: { type: 'string', description: 'trigger 用：list 里某条素材的 key（不填就用最新未分享的一条）' },
    text: { type: 'string', description: 'trigger 用：自定义这次要说的事（一句话；给了就不从素材池取）' },
    target: { type: 'string', description: 'trigger 用：发给谁的 openid 或昵称（不填就轮流给最久没收到的人）' },
  },
  run: async (args, env) => {
    const root = String((env && env.caps && env.caps.dataRoot) || (env && env.dataRoot) || '').trim();
    if (!root) return { ok: false, msg: '拿不到 dataRoot，没法操作分享状态' };

    const cfgFile = join(root, '.qqbot-extensions', CONFIG_NAME);
    const stateFile = join(root, '.qqbot-extensions', 'data', STATE_NAME);
    const cfg = readJson(cfgFile, {}) || {};
    const st = readJson(stateFile, {}) || {};
    const now = Date.now();
    const day = localDay(new Date(now));
    const qq = env && env.qq;

    // ── status ────────────────────────────────────────────────
    if (args.action === 'status') {
      const sent = Number(st.dayCount && st.dayCount[day]) || 0;
      const quiet = cfg.quietHours && cfg.quietHours.start !== cfg.quietHours.end
        ? `${cfg.quietHours.start}:00 – ${cfg.quietHours.end}:00 不自动发`
        : '没设静默时段';
      const lines = [
        `主动分享：${cfg.enabled === false ? '已关闭' : '开启'} · 模式 ${cfg.mode || 'interval'}`,
        `今天已发 ${sent} 条（上限 ${cfg.dailyMax || 2} / 每人 ${cfg.perTargetMax || 1}）`,
        `上次分享：${when(st.lastAt)}`,
      ];
      if (String(cfg.mode || 'interval') === 'interval') {
        const iv = Number(cfg.intervalMinutes);
        const next = Number(st.lastAt) && Number.isFinite(iv) && iv > 0 ? when(Number(st.lastAt) + iv * 60_000) : '（随时可以）';
        lines.push(`间隔 ${iv ? iv + ' 分钟' : '未设（自动已暂停）'}，下一次不早于：${next}`);
      } else {
        lines.push('手动模式：只在你调用 share_now 时才发');
      }
      lines.push(quiet);
      const pending = readJson(join(root, '.qqbot-extensions', 'data', REQUEST_NAME), null);
      if (pending && Number(pending.at) && now - Number(pending.at) < 10 * 60_000) {
        lines.push('有一条手动分享正在队列里（30 秒内会说）');
      }
      return { ok: true, msg: lines.join('\n') };
    }

    // ── list ──────────────────────────────────────────────────
    const material = collectShareMaterial(root, now);
    const usedToday = new Set((Array.isArray(st.used) ? st.used : []).filter((u) => u && u.day === day).map((u) => String(u.key)));
    const targets = targetsOf(root, cfg, qq);

    if (args.action === 'list') {
      const out = [`今天可分享的素材（${material.length} 条，${usedToday.size} 条已用过）：`];
      if (!material.length) out.push('  （今天还没有逛到 / 想明白 / 做完的事，可以给 text 自定义一句话）');
      material.slice(0, 10).forEach((m, i) => {
        out.push(`  ${i + 1}. [${m.key}] ${usedToday.has(m.key) ? '（已用）' : ''}${short(m.line, 70)}`);
      });
      out.push('能发给谁：');
      if (!targets.length) out.push('  （还没配对象：share-config.targets 或 group-tiers.priorityPeople 都空着）');
      for (const t of targets) out.push(`  · ${t.name || '(没名字)'} · ${t.id}`);
      out.push('用法：share_now {action:"trigger", key:"...", target:"<openid>"}');
      return { ok: true, msg: out.join('\n') };
    }

    // ── trigger（默认）─────────────────────────────────────────
    let target = '';
    let targetName = '';
    const raw = String(args.target || '').trim();
    if (raw) {
      if (isOpenid(raw)) {
        target = raw;
        targetName = (targets.find((t) => t.id === raw) || {}).name || '';
      } else {
        const pool = (qq && Array.isArray(qq.c2c) ? qq.c2c : []).filter((x) => String(x.name || '').includes(raw));
        if (pool.length !== 1) {
          return {
            ok: false,
            msg: pool.length
              ? `「${raw}」命中 ${pool.length} 个对象，人家不猜着发 —— 请用 openid：\n` + pool.slice(0, 6).map((x) => `  · ${x.name || '(没名字)'} · ${chatId(x)}`).join('\n')
              : `找不到「${raw}」—— 先 action:"list" 看看能发给谁（昵称解析需要 env.qq 在线）`,
          };
        }
        target = chatId(pool[0]);
        targetName = String(pool[0].name || '');
      }
    }

    const text = String(args.text || '').replace(/\s+/g, ' ').trim().slice(0, 110);
    let key = String(args.key || '').trim();
    if (!text && key) {
      const hit = material.find((m) => m.key === key);
      if (!hit) return { ok: false, msg: `素材池里没有 key=${key}（先 action:"list" 看今天的 key）` };
    }
    const line = text || (key ? (material.find((m) => m.key === key) || {}).line : (material[0] && material[0].line)) || '';
    if (!line) return { ok: false, msg: '今天没有可分享的素材，也没给 text —— 自定义一句再触发' };

    const dir = join(root, '.qqbot-extensions', 'data');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, REQUEST_NAME), JSON.stringify({
        id: 'r' + now,
        at: now,
        target,
        targetName,
        text: text || '',
        key: text ? '' : (key || (material[0] && material[0].key) || ''),
      }, null, 2) + '\n', 'utf8');
    } catch (e) {
      return { ok: false, msg: '写请求文件失败：' + (e instanceof Error ? e.message : String(e)) };
    }

    const who = targetName || target || '（最久没收到的人）';
    return {
      ok: true,
      msg: `已排上：30 秒内她会主动私聊 ${who} ——「${short(line, 50)}」\n（她用自己的口吻说，不是机械转发；对方没接话就不会追问）`,
    };
  },
};
