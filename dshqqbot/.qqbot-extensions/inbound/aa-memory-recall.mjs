/**
 * memory-recall.mjs — 入站时按需召回长期记忆（Neuro 式「检索而非重放」）
 *
 * 挂点：早挂点 onInbound —— 链上唯一能 `ctx.rewrite()` 改到"进上下文那版文本"的位置。
 *
 * 它做两件事：
 *   ① 召回：拿当前这句话去记忆库做向量近邻，命中就追加一个 [记忆] 块（≤300 字）
 *   ② 沉淀：把这条消息（去掉 [记忆] 块的原文本）记成一条 event 记忆，带 embedding 去重
 *
 * 为什么这样省钱：
 *   现在每轮带的是「最近 10 条原文」（常 1000~2000 字），超出就永久丢；
 *   改成「4 条语义相关的提炼」≈160 字，且旧信息能随时被召回。
 *
 * 安全契约：
 *   · 全程 try/catch，任何异常都只记日志并照常 next() —— 绝不让记忆功能影响聊天；
 *   · 拿不到模型就退化成字符 n-gram（memory-core 内部处理），再不行就整块跳过。
 */

// 存储后端在门面里选：优先 SQLite（memory-db），不可用自动回退 JSONL（memory-core）。
import {
  loadConfig, recall, remember, drainInbox, digestScope, shouldDigest, formatRecallBlock, stats,
  ingestChatHistory, personProfile,
} from '../lib/memory.mjs';
// 世界书：设定按关键词命中才注入，不进常驻 prompt
import { loreFor } from '../lib/lore-core.mjs';
// 印象卡 + 心情 + 关系温度：让"对熟人更熟、今天状态不同"能被主模型看见
// 2026-10-23：印象卡与熟识度在底层统一成 persona.fam:<senderId>，注入只留一个 [印象] 块
import { familiarityBlockFor, moodBlockFor, getPersonaValue } from '../lib/profile-core.mjs';
// 记忆轨迹：给浮窗「记忆」页显示召回/整理是否真的跑了
import { trace as traceMemory } from '../lib/memory-trace.mjs';
// 反重复：把她刚说过的几句附在后面（AI 味最大来源就是重复）
import { formatEchoBlock } from '../lib/self-echo.mjs';
// 学来的说话习惯（从群聊/导入记录里提炼，只学表达方式）
import { currentStyle } from '../lib/imitate.mjs';
// 记忆"过一遍小模型"：把 2 条以上的召回压成一句她自己的回忆（省 token + 去念资料感）
import { rewriteRecall } from '../lib/memory-llm.mjs';
// 群等级：特别关心群/私聊走完整档；普通群只看信息本身，但保留一个极短认人块（避免不认人）
import { tierOf, policyFor, isPriorityPerson } from '../lib/group-tiers.mjs';
import { compactBlockFor } from '../lib/profile-core.mjs';
import { bedrockBlock } from '../lib/bedrock.mjs';
import { beliefs } from '../lib/memory-hippo.mjs';
// 表情包提醒：用会话状态记"上次发图/上次提醒"的时间（2026-10-27）
import { getChatState, setChatState } from '../lib/chatlog-db.mjs';
// [mmtr 2026-10-27]：会遗忘的记忆层——防自增强（刚用过的降权+只记日志）与承诺账本（[约定]块）
import { promiseBlockFor, applyRecallGuard } from '../lib/memory-mmtr.mjs';

// 性格倾向 → 一句话（主人 2026-10-26 要求让 belief 层真正被模型看到）。
// trait 值是小步长缓变量，文本天然轮间稳定，不会破坏 prompt 缓存；
// 只在完整档（特别关心/私聊）注入，普通群一个字不多花。
const TRAIT_LABELS = {
  warmth: ['待人热情', '偏冷淡'],
  trust: ['值得信任', '需留个心眼'],
  humor: ['爱开玩笑', '正经话少'],
  reliability: ['说到做到', '常放鸽子'],
  boundary: ['有分寸', '爱越界'],
  energy: ['活跃话多', '安静寡言'],
};
function traitBlockFor(dataRoot, senderId) {
  const sid = String(senderId || '').trim();
  if (!sid || !/^[\w-]+$/.test(sid)) return '';
  let rows = [];
  try { rows = beliefs(dataRoot, 'person:qq:' + sid) || []; } catch { return ''; }
  const hits = rows
    .filter((b) => b && Math.abs(b.value) >= 0.3 && (b.n || 0) >= 3)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 2)
    .map((b) => {
      const pair = TRAIT_LABELS[b.key];
      if (!pair) return '';
      return b.value > 0 ? pair[0] : pair[1];
    })
    .filter(Boolean);
  if (!hits.length) return '';
  return `\n[性格观察]和他相处下来，感觉他${hits.join('、')}[/性格观察]`;
}

export const name = 'aa-memory-recall';

/** 插件数据根（优先级：环境变量 > memory-config.json 的 dataRoot > 默认 {cwd}/dshqqbot） */
function dataRootOf(cfg) {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  return (cfg && cfg.dataRoot) || 'F:/qqbot/dshqqbot';
}

/** 会话作用域：群按群 openid，私聊按用户 openid */
function scopeOf(ctx) {
  const m = ctx?.message || {};
  if (m.groupOpenid) return 'group:' + m.groupOpenid;
  if (m.senderId) return 'c2c:' + m.senderId;
  return '';
}

/** 归一化：去 @、去空白、去标点，只留汉字/字母/数字 —— 用于自匹配判重 */
function normText(s) {
  return String(s || '')
    .replace(/<@[^>]*>/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    .toLowerCase();
}

/** 去掉我们上一轮可能注入过的块（[记忆] / [设定] / [印象] / [关系] / [状态]），避免注入被自己的注入污染 */
function stripMemoryBlock(text) {
  return String(text || '')
    .replace(/\n?\[记忆\][\s\S]*?\[\/记忆\]\n?/g, '\n')
    .replace(/\n?\[信条\][\s\S]*?\[\/信条\]\n?/g, '\n')
    .replace(/\n?\[设定\][\s\S]*?\[\/设定\]\n?/g, '\n')
    .replace(/\n?\[印象\][\s\S]*?\[\/印象\]\n?/g, '\n')
    .replace(/\n?\[旧识\][\s\S]*?\[\/旧识\]\n?/g, '\n')
    .replace(/\n?\[性格观察\][\s\S]*?\[\/性格观察\]\n?/g, '\n')
    .replace(/\n?\[成长\][\s\S]*?\[\/成长\]\n?/g, '\n')
    .replace(/\n?\[关系\][\s\S]*?\[\/关系\]\n?/g, '\n')
    .replace(/\n?\[状态\][\s\S]*?\[\/状态\]\n?/g, '\n')
    .replace(/\n?\[B站\][\s\S]*?\[\/B站\]\n?/g, '\n')
    .replace(/\n?\[学\][\s\S]*?\[\/学\]\n?/g, '\n')
    .replace(/\n?\[别重复\][^\n]*/g, '\n')
    .trim();
}

// 聊天台账补录的节流（每 15s 最多一次；读的是插件已落盘的 msg-history，增量很小）
let _lastChatIngest = 0;
function maybeIngestChat(dataRoot, cfg, logger) {
  try {
    const now = Date.now();
    const every = Math.max(3000, Number(cfg?.chatlog?.ingestThrottleMs) || 15000);
    if (now - _lastChatIngest < every) return;
    _lastChatIngest = now;
    const r = ingestChatHistory(dataRoot, cfg?.chatlog || {});
    if (r && r.ok && r.imported > 0) logger?.debug?.(`[chatlog] 补录 ${r.imported} 条`);
  } catch { /* 台账是旁路，失败不影响聊天 */ }
}

/** 纯表情/纯标点/复读/命令 之类不值得记 */
function worthRemembering(text, cfg) {
  const t = String(text || '').trim();
  if (t.length < (cfg.minTextLen || 6)) return false;
  // ★ 2026-10-22 修：实测抓到了 "/bot-restart" —— 斜杠命令不是聊天内容，
  //   进记忆库只会污染召回（问"上次说啥"时可能召回一条命令）。
  if (t.startsWith('/')) return false;
  // 空正文占位（P0-2 引入的）也不该记
  if (/^（只 @ 了你一下/.test(t)) return false;
  // 不含任何文字/数字 = 纯标点或纯表情符号
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) return false;
  if (/^\[(图片|语音|视频|表情|文件)[^\]]*\]$/.test(t)) return false;
  if (/^[哈嗯哦啊额唔咦哦嘿呀吧嘛]+$/.test(t)) return false;
  return true;
}

export async function onInbound(ctx, next) {
  let cfg;
  try {
    cfg = loadConfig(dataRootOf({}));
    cfg = loadConfig(dataRootOf(cfg));
  } catch {
    return next(); // 配置都读不了 → 直接放行
  }

  if (cfg.enabled === false) return next();

  const scope = scopeOf(ctx);
  if (!scope) return next();

  const dataRoot = dataRootOf(cfg);
  const original = stripMemoryBlock(ctx.text);
  if (!original) return next();

  // ── ⓪a 顺手把聊天台账补进 SQLite（幂等、增量；给记忆分身和运维查）──
  maybeIngestChat(dataRoot, cfg, ctx?.logger);

  // ── ⓪ 先把"她自己记下的"（memory 工具写的收件箱）并入本群 ──
  //    工具拿不到当前 scope，所以写公共收件箱；这里在拿到 scope 之后归位。
  //    放在召回之前，这样她刚记的东西下一条消息就能被召回。
  try {
    const merged = await drainInbox(dataRoot, scope, cfg);
    if (merged > 0) ctx?.logger?.debug?.(`[memory] 收件箱并入 ${merged} 条 → ${scope}`);
  } catch (e) {
    ctx?.logger?.debug?.(`[memory] 收件箱并入失败(已忽略): ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── ① 先召回（必须早于沉淀：否则会把"当前这句话"当成历史记忆注回去，白烧 token）──
  //   群等级策略：普通群（水群）不召回长期记忆——只看信息本身；特别关心群/私聊才召回。
  const tier = tierOf(dataRoot, scope, cfg.groupTiers);
  // 特别关心的人（2026-10-25 主人要求）：普通群里遇到名单里的 QQ，也按 priority 档走
  //   —— 完整印象卡 + 长期记忆召回/沉淀；名单在浮窗「记忆」→「特别关心（手动添加）」里维护。
  let tierEff = tier;
  try {
    if (tier === 'normal' && isPriorityPerson(dataRoot, ctx?.message?.senderId, cfg.groupTiers)) tierEff = 'priority';
  } catch { /* 名单读不到就按原档 */ }
  const policy = policyFor(tierEff, cfg.groupTiers);
  let memBlock = '';
  const recallT0 = Date.now();
  let recallRaw = 0;
  let recallKept = 0;
  let recallRewritten = false;
  let recallErr = '';
  if (policy.recall) {
  try {
    const hits = await recall(dataRoot, scope, original, cfg);
    recallRaw = Array.isArray(hits) ? hits.length : 0;
    // ★ 自匹配过滤：库里存着"这句话本身"时（上一轮沉淀的），cos 常是 0.93~0.97，
    //   低于 0.98 的老阈值会漏过去，于是每轮把用户刚说的话再注回去一次 —— 纯浪费 token。
    //   这里按**文本**判重，比按余弦稳：只要召回条目的正文等于/包含当前这句就丢掉。
    const qNorm = normText(original);
    const seenHit = new Set();
    const kept = (Array.isArray(hits) ? hits : []).filter((h) => {
      const t = normText(h && h.text);
      if (!t) return false;
      if (t === qNorm) return false;
      // 当前这句被完整包含在记忆里（比如记忆是"甲：乙"的长句）也算自匹配
      if (t.length > qNorm.length && t.includes(qNorm) && qNorm.length >= 8) return false;
      // 库里历史重复（去重上线前写进去的）也不要重复占额度
      if (seenHit.has(t)) return false;
      seenHit.add(t);
      return true;
    });
    // [mmtr 2026-10-27] 防自增强：刚被用过的记忆本轮降权 + 记使用日志（重要性不受检索影响）
    try { applyRecallGuard(dataRoot, scope, kept); } catch { /* 护栏失败不影响召回 */ }
    memBlock = formatRecallBlock(kept, cfg);
    recallKept = kept.length;
    if (memBlock) {
      ctx?.logger?.debug?.(`[memory] 召回 ${kept.length} 条 (${kept.map((h) => h.cos.toFixed(2)).join(',')})`);
    }
    // ── ①a2 本地小模型"过一遍"（用户 2026-10-23 提的方案）──
    //   · 2 条以上才值得过一次模型（1 条时原文更准）；
    //   · 成功 → 压成一句第一人称回忆（4 条 160 字 → 1 句 ~30 字），还顺便丢掉噪声；
    //   · 失败/超时/模型离线 → 保留原来的编号列表（永不因此丢记忆、更不卡回复）。
    if (memBlock && kept.length >= 2) {
      try {
        const lr = await rewriteRecall(kept, original, cfg, { dataRoot });
        if (lr && lr.ok && lr.text) {
          memBlock = '\n[记忆]' + lr.text + '[/记忆]';
          recallRewritten = true;
          ctx?.logger?.info?.(`[memory] 本地模型改写 ${kept.length} 条 → ${lr.text.length} 字(${lr.ms}ms): ${lr.text}`);
        } else {
          ctx?.logger?.debug?.(`[memory] 保留编号列表(${(lr && lr.reason) || '?'}${lr && lr.ms ? ' ' + lr.ms + 'ms' : ''})`);
        }
      } catch (e) {
        ctx?.logger?.debug?.(`[memory] 改写异常(已忽略): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    recallErr = e instanceof Error ? e.message : String(e);
    ctx?.logger?.debug?.(`[memory] 召回失败(已忽略): ${recallErr}`);
  }
  }
  // 轨迹只记摘要（不存全文），给浮窗看"这条消息到底有没有查库、查到几条"
  try {
    traceMemory(dataRoot, {
      kind: 'recall', scope, query: original.replace(/<@[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 50),
      raw: recallRaw, hits: recallKept, rewritten: recallRewritten,
      ok: !recallErr, error: recallErr, ms: Date.now() - recallT0,
    });
  } catch { /* ignore */ }

  // ── ①b 世界书：命中关键词才带 1~2 条设定（Neuro 式，设定不进常驻 prompt）──
  let loreBlock = '';
  try {
    const l = loreFor(dataRoot, original, cfg.lore || {});
    loreBlock = l.block;
    if (loreBlock) ctx?.logger?.debug?.(`[lore] 注入 ${l.hits.map((h) => h.id).join(',')}`);
  } catch (e) {
    ctx?.logger?.debug?.(`[lore] 注入失败(已忽略): ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── ①c 反重复：把她刚说过的几句附在后面（AI 味最大来源就是重复同一个句式/口头禅）──
  let echoBlock = '';
  try {
    const ec = formatEchoBlock(dataRoot, scope, cfg.echo || {});
    echoBlock = ec.block;
    if (echoBlock) ctx?.logger?.debug?.(`[echo] 反重复 ${ec.lines.length} 句`);
  } catch (e) {
    ctx?.logger?.debug?.(`[echo] 反重复生成失败(已忽略): ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── ①d 印象 + 熟识度（个人层：跨群统一；稳定模式，保云端缓存）──
  //   特别关心群/私聊：完整卡；普通群：只给「名字 · 等级」极简认人块（不认识的人一个字都不多花）。
  let profileBlock = '';
  try {
    const who = {
      senderId: String(ctx?.message?.senderId || ''),
      senderName: String(ctx?.message?.senderName || ''),
    };
    const profileCfg = { ...(cfg.profile || {}), ...(cfg.bond || {}) };
    if (policy.profile === 'full') {
      profileBlock = familiarityBlockFor(dataRoot, scope, who, profileCfg);
      // [性格观察]（2026-10-26）：belief 层的性格倾向终于被模型看到（此前只存不消费）
      try {
        const tb = traitBlockFor(dataRoot, who.senderId);
        if (tb) profileBlock += tb;
      } catch { /* 性格观察失败不影响印象块 */ }
      // [成长]（2026-10-26）：她的自我心得（growth:latest，自我反思每天一变的慢变量）——
      // 让"完善自我"这条信条真的有出口：她能看到自己上一次的反思。
      try {
        const gv = getPersonaValue(dataRoot, '__global__', 'growth:latest');
        if (gv && gv.value) profileBlock += '\n[成长]' + String(gv.value).replace(/\s+/g, ' ').trim().slice(0, 90) + '[/成长]';
      } catch { /* 成长块失败不影响印象块 */ }
      if (profileBlock) ctx?.logger?.debug?.(`[profile] 已注入完整印象+熟识度 (tier=${tier})`);
    } else if (policy.profile === 'compact') {
      profileBlock = compactBlockFor(dataRoot, scope, who, profileCfg);
      if (profileBlock) ctx?.logger?.debug?.(`[profile] 已注入精简认人块 (tier=${tier})`);
    }
  } catch (e) {
    ctx?.logger?.debug?.(`[profile] 印象块失败(已忽略): ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── ①e 状态：本轮/近 30 分钟的当下心情（≤30 字，过期自动不带）──
  let moodBlock = '';
  try {
    moodBlock = moodBlockFor(dataRoot, scope, cfg.mood || {});
    if (moodBlock) ctx?.logger?.debug?.('[mood] 已注入状态');
  } catch (e) {
    ctx?.logger?.debug?.(`[mood] 状态失败(已忽略): ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── ①d2 旧识：这个人的历史聊天记录导入后留下的画像 ──
  //   数据隔离：只读 senderId 自己那一个 scope（person:qq:<号>），不跨人聚合。
  //   可见性：只有拿到了"完整印象"权限的场景（特别关心群/私聊）才带；
  //   普通群连"认识这个人"都不展开，更不能把他在别处说过的话搬过来。
  let pastBlock = '';
  if (policy.profile === 'full' && cfg.pastProfile !== false) {
    try {
      const sid = String(ctx?.message?.senderId || '').trim();
      const p = sid ? personProfile(dataRoot, sid) : null;
      if (p && p.ok && p.impression) {
        // 画像本身已经是一句统计结论（≤120 字），这里只做截断，不改写语义
        const line = p.impression.replace(/\s+/g, ' ').slice(0, 120);
        pastBlock = `\n[旧识]${line}[/旧识]`;
        ctx?.logger?.debug?.(`[past] 已注入旧识画像 (${p.say} 条)`);
      }
    } catch (e) {
      ctx?.logger?.debug?.(`[past] 旧识画像失败(已忽略): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── ①d3 学来的说话习惯：她观察群里怎么说话，只学表达方式（≤90 字）──
  let styleBlock = '';
  if (cfg.imitate?.inject !== false) {
    try {
      const st = currentStyle(dataRoot);
      if (st) styleBlock = `\n[学]${String(st).slice(0, 90)}[/学]`;
    } catch { /* 学不到就算了 */ }
  }

  // ── ①d4 手痒提醒：她几乎从不发表情包（2026-10-27 主人点名）──
  //   不是命令，只是"手边有图"的轻推：距上次发图 ≥ 30 分钟才出现，且最多每 30 分钟一次，
  //   免得每轮都催（催多了反而机械）。
  let stickerBlock = '';
  try {
    if (cfg.stickerNudge !== false && policy.capture) {
      const st = getChatState(dataRoot, 'sticker:last') || {};
      const lastTs = Number(st.ts) || 0;
      const gap = Date.now() - lastTs;
      const nudge = getChatState(dataRoot, 'sticker:nudge') || {};
      if (gap > 30 * 60 * 1000 && Date.now() - (Number(nudge.ts) || 0) > 30 * 60 * 1000) {
        stickerBlock = '\n[手边]库里有很多表情包，这轮如果聊到兴头（笑、被夸、吐槽、接梗），可以顺手配一张：先 sticker_auto 或 sticker_send 搜一下，九成贴切才发；正事/难过/吵架不发。[/手边]';
        setChatState(dataRoot, 'sticker:nudge', { ts: Date.now() });
      }
    }
  } catch { /* 提醒失败不影响对话 */ }

  // ── ①d5 [约定]（2026-10-27 mmtr）：到期的承诺/约定自己浮上来——
  //   事实锁定原文、越接近截止越清晰、超宽限自动 broken 并付关系代价。
  let promiseB = '';
  try { promiseB = promiseBlockFor(dataRoot, scope); } catch { /* 约定块失败不影响对话 */ }

  // 所有块合并成一次 rewrite（改两次会让中间态被别的扩展看见）
  // [信条]（2026-10-26）：底层刻写常驻块，全静态、跨群不变（prompt 缓存友好）；
  // 放最前——它是主人手笔，LLM 只读不可改，优先级高于一切注入。
  const bedrock = bedrockBlock(dataRoot);
  const extra = bedrock + memBlock + loreBlock + profileBlock + pastBlock + moodBlock + promiseB + echoBlock + styleBlock + stickerBlock;
  if (extra && typeof ctx.rewrite === 'function') {
    ctx.rewrite({ text: String(ctx.text || '') + extra });
  }

  // ── ② 再沉淀（用"原文本"，不含刚注入的记忆块）──
  //   普通群不沉淀长期记忆：水群只看信息本身，不把闲聊塞进向量库（省本地算力）
  if (policy.capture && cfg.capture !== false && worthRemembering(original, cfg)) {
    try {
      await remember(dataRoot, scope, {
        text: original.slice(0, 200),
        kind: 'event',
        subj: String(ctx?.message?.senderName || ctx?.message?.senderId || ''),
      }, cfg);
    } catch (e) {
      ctx?.logger?.debug?.(`[memory] 沉淀失败(已忽略): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── ③ 中层记忆：攒够 digestEvery 条就压一次"前情摘要"（零 token，抽取式）──
  //    只做增量判断（shouldDigest 很便宜），真正压缩才扫库；绝不删原记忆。
  if (policy.digest) {
    try {
      if (shouldDigest(dataRoot, scope, cfg)) {
        const d = digestScope(dataRoot, scope, cfg);
        if (d.ok) ctx?.logger?.info?.(`[memory] 中层摘要已生成: 覆盖 ${d.covered} 条 → ${d.text.slice(0, 40)}…`);
      }
    } catch (e) {
      ctx?.logger?.debug?.(`[memory] 摘要失败(已忽略): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return next();
}

/** 调试用：让她能通过日志看到记忆库状态 */
export function dumpStats(ctx) {
  try {
    const cfg = loadConfig(dataRootOf({}));
    return stats(dataRootOf(cfg), scopeOf(ctx) || 'unknown', cfg);
  } catch { return null; }
}
