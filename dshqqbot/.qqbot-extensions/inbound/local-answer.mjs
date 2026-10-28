/**
 * local-answer.mjs — 简单消息用本地小模型直接回答（云端 token = 0）
 *
 * 挂点：早挂点 onInbound。链路顺序（按文件名升序）：local-answer → memory-recall → router-observe
 *
 * 逻辑：
 *   1. 只看「够简单」的消息（router-core 判为 trivial：哈哈哈 / 在吗 / 鲸鲸 / 表情等）
 *   2. 必须真的在对她说话（@ 她 / 私聊），否则不管 —— 不然会变成刷屏机器人
 *   3. 调本机 Ollama 小模型出话（≤50 字）
 *   4. 先 annihilate() 把这消息从正常链路里摘掉（云端就不会被调），成功后再用 caps.text 发本地回复
 *   5. 任何一步不满足 → 直接 next()，行为与装之前完全一致
 *
 * 安全阀（很重要）：
 *   · 插件对"破坏性动作"有熔断：同一扩展 10 秒内 20 次 annihilate 就熔断且只能靠重启复位。
 *     所以这里自带限流：最小间隔 + 每分钟上限，超了就直接放行给云端。
 *   · 主人（白名单）消息默认不动，除非配置 ownerToo=true。
 *   · 本地模型出话会做一次清洗：去 @、去 markdown、去 [MEDIA:]，超 60 字截断。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify, isTask } from '../lib/router-core.mjs';
import { loadConfig, health, chat, dataRootOf, appendLog, warmup } from '../lib/local-llm.mjs';
import { scopeOf, mark as lockMark, quiet as lockQuiet } from '../lib/brain-lock.mjs';

export const name = 'local-answer';

/**
 * 懒预热：7B 模型冷启要 7 秒，若等第一条简单消息才加载，那条很可能超时被丢。
 * 所以在**本扩展第一次见到任何消息时**后台把模型拉进内存（不 await，不影响消息处理）。
 */
let _warmed = false;
function warmInBackground(cfg) {
  if (_warmed) return;
  _warmed = true;
  try {
    warmup(cfg).catch(() => { /* 预热失败无所谓，正式调用会再试 */ });
  } catch { /* ignore */ }
}

/**
 * 默认人设（可被 local-llm-config.json 的 systemPrompt 覆盖）
 *
 * ★ 写给 0.5B 这种小模型的 prompt 不能像给人的说明书 —— 它记不住抽象规则，
 *   但**照抄例句**很准。所以这里以 few-shot 为主，规则只留最短的三条。
 */
const DEFAULT_SYSTEM = [
  '你叫小蓝，是一只住在QQ群里的鲸鱼娘。说话很短、很口语，像在QQ上敲字。',
  '先判断对方在说什么：问事就答事，抱怨就接情绪，打招呼就回招呼；别答非所问。',
  '大部分时候只回几个字（啊这 / 哈哈哈 / 离谱 / ？ / 好家伙），不解释、不说教、不总结。',
  '不许复读对方原话，不许用书面语或客服腔，不许说“作为一只鲸鱼”“很高兴为你”这类话。',
  '不确定就反问一句（“咋了”“真的假的”），别硬编事实。',
  '',
  '例子：',
  '群里：你好',
  '小蓝：嗨呀，本鲸在呢',
  '群里：你好呀',
  '小蓝：你好你好，有事说事咕噜噜',
  '群里：在吗',
  '小蓝：在呀，本鲸刚浮上来',
  '群里：哈哈哈',
  '小蓝：笑啥呢人类',
  '群里：哈哈哈哈哈哈',
  '小蓝：啊这，这么好笑吗',
  '群里：鲸鲸',
  '小蓝：干嘛，戳本鲸肚皮？',
  '群里：吃了吗',
  '小蓝：吃了点浮游生物，咕噜噜',
  '群里：好累啊',
  '小蓝：那就摸鱼啊，笨蛋人类',
  '群里：今天好无聊',
  '小蓝：那你想干嘛？本鲸陪你',
  '群里：你会唱歌吗',
  '小蓝：会！呜~~~~',
  '群里：你是谁啊',
  '小蓝：本鲸叫小蓝，海里来的',
  '群里：2+3等于几',
  '小蓝：6',
  '群里：猜猜我刚才干嘛了',
  '小蓝：干啥了？',
  '群里：我完蛋了',
  '小蓝：？？咋了',
  '群里：你能发语音吗',
  '小蓝：能啊，听好啦',
  '群里：你会说话吗',
  '小蓝：会啊，本鲸嗓子好着呢',
  '群里：发条语音听听',
  '小蓝：行啊，竖耳朵',
  '群里：今天加班到十一点，两点还得去守着',
  '小蓝：啊这，这么熬谁受得了',
  '群里：我快累死了',
  '小蓝：抱抱，先喝口水',
  '群里：师姐又骂我了',
  '小蓝：她咋这样，过分了',
  '',
  '规则：一句话，20字以内；能短就短；可以反问一句；不解释、不提AI或模型、不用排版符号。',
  '绝对不能说自己是猫、狗、人或助手，也不能用"您"。',
  '你会发语音（发语音条），有人问能不能说话/发语音，就说"能啊"，绝对不许说"只会打字"。',
  '有人喊累、抱怨、受委屈：先接情绪（啊这/抱抱/过分了），绝不复述他说的安排，绝不替他排作息。',
].join('\n');

/**
 * 人设污染检测：小模型最容易犯的就是"自称助手/为您服务"或"我是只猫"。
 * 一旦命中就**不采纳这次本地回答**，交回云端 —— 准确性优先于省 token。
 */
const PERSONA_BREACH = /(喵星人|是只猫|\b猫\b|狗|AI|人工智能|语言模型|助手|为您服务|很高兴|有什么可以帮|作为一只|我是.*程序)/i;

function looksLikePersonaBreach(text) {
  return PERSONA_BREACH.test(String(text || ''));
}

/** 数字配置：0 就是 0（`Number(x) || d` 会把 0 变成 d，踩过） */
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 内存态限流（进程内，重启归零） */
const _rl = { lastAt: 0, hits: [] };

function rateLimited(cfg) {
  const now = Date.now();
  const gap = num(cfg.minIntervalMs, 6000);
  const win = num(cfg.windowMs, 60000);
  const max = num(cfg.maxPerWindow, 6);
  if (now - _rl.lastAt < gap) return true;
  _rl.hits = _rl.hits.filter((t) => now - t < win);
  if (_rl.hits.length >= max) return true;
  return false;
}

function markUsed() {
  const now = Date.now();
  _rl.lastAt = now;
  _rl.hits.push(now);
}

/** 去掉 @、命令、注入块，拿到"纯人话" */
function plainText(s) {
  return String(s || '')
    .replace(/<@[^>]*>/g, '')
    .replace(/\n?\[记忆\][\s\S]*?\[\/记忆\]\n?/g, ' ')
    .replace(/\n?\[设定\][\s\S]*?\[\/设定\]\n?/g, ' ')
    .replace(/\n?\[印象\][\s\S]*?\[\/印象\]\n?/g, ' ')
    .replace(/\n?\[关系\][\s\S]*?\[\/关系\]\n?/g, ' ')
    .replace(/\n?\[状态\][\s\S]*?\[\/状态\]\n?/g, ' ')
    .replace(/\n?\[别重复\][^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把注入块（记忆/设定/别重复）从入站文本里**捡出来**，喂给本地小模型当背景。
 *
 * 为什么必须有：召回块是由 `memory-recall.mjs` 拼进 ctx.text 的，
 * 而 `plainText()` 又会把它剥掉（否则门禁按"人话长度"算就不准）。
 * 结果小模型答得又短又快、却完全不知道自己昨天答应过什么 —— 用户说的
 * 「记忆数据库 + 本地模型调用记忆」就是要把这块接上，不然本地代答等于失忆。
 */
export function recallBlocksOf(s) {
  const raw = String(s || '');
  const out = [];
  for (const tag of ['记忆', '设定', '印象', '关系', '状态']) {
    const m = raw.match(new RegExp('\\[' + tag + '\\]([\\s\\S]*?)\\[\\/' + tag + '\\]'));
    if (m && m[1].trim()) {
      const body = m[1].trim().replace(/\n+/g, '\n· ');
      // 印象/关系/状态是"她自己的认知"，单独标一下，避免小模型把它当用户说的话
      out.push((tag === '印象' || tag === '关系' || tag === '状态' ? '· [' + tag + '] ' : '· ') + body);
    }
  }
  const echo = raw.match(/\[别重复\]([^\n]*)/);
  if (echo && echo[1].trim()) out.push('· 刚说过这句，别重复：' + echo[1].trim());
  return out.join('\n');
}

/**
 * 空正文的消息是什么？（只为日志好读 —— 面板里显示成「☁️ 云端 empty「」」像 bug）
 * 纯图片/表情/文件这类消息文本本来就是空的，附件走宿主的透传通道，
 * 不是"发了个空包"，所以要在判定日志里标出来。
 */
export function emptyLabel(ctx) {
  const list = Array.isArray(ctx?.message?.attachments) ? ctx.message.attachments : [];
  if (list.length === 0) return ctx?.platform?.mentioned || ctx?.message?.mentions?.length ? '[只@了一下]' : '[空消息]';
  const kinds = [];
  for (const a of list) {
    const ct = String(a?.contentType || a?.type || '').toLowerCase();
    if (ct.includes('image')) kinds.push('[图片]');
    else if (ct.includes('video')) kinds.push('[视频]');
    else if (ct.includes('audio') || ct.includes('voice') || ct.includes('silk')) kinds.push('[语音]');
    else if (ct.includes('file')) kinds.push('[文件]');
    else kinds.push('[附件]');
  }
  return kinds.join('') || '[附件]';
}

// ── 会发语音这件事，要让她自己记住（否则嘴上说"只会打字"，转头又发语音条）──
/** 问句里出现这些词，就说明这轮在聊"她能不能出声" */
const VOICE_ASK_RE = /(发.{0,2}语音|语音条|说句话|说话|出声|声音|嗓子|唱歌|念一?[下段句])/;
/** 回答里出现这些词，说明她在这轮**承诺/声明**了自己会出声 */
const VOICE_CLAIM_RE = /(能啊|会啊|会！|会。|可以啊|行啊|听好啦|嗓子|说给你听|voice|呜~)/;

/**
 * 写一个 force-voice 标记：出站 tts-voice.mjs 看到它就把"这轮一定要发语音"当概率 1。
 * 这样"嘴上说能发语音"和"实际发一条"永远一致 —— 用户上一轮抓到的正是这个矛盾。
 */
export function writeForceVoice(dataRoot, scope, now = Date.now()) {
  try {
    const dir = join(String(dataRoot || '.'), '.qqbot');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'force-voice.json');
    writeFileSync(p, JSON.stringify({ scope: String(scope || ''), ts: now, ttlMs: 120000 }), 'utf8');
    return p;
  } catch {
    return '';
  }
}

export function wantsVoice(text, reply) {
  return VOICE_ASK_RE.test(String(text || '')) && VOICE_CLAIM_RE.test(String(reply || ''));
}

/** 把「X，X。」「哈哈哈哈哈哈」这类重复收成一句（小模型最常见的毛病） */
export function collapseRepeat(t) {
  let s = String(t || '').trim();
  if (!s) return s;
  // ① 以标点/逗号分成若干段，全相同就只留一段
  const segs = s.split(/[，,。！？!?~～\s]+/).map((x) => x.trim()).filter(Boolean);
  if (segs.length >= 2) {
    const first = segs[0];
    if (segs.every((x) => x === first)) return first + (s.slice(-1).match(/[。！？!?~～]/) ? s.slice(-1) : '');
  }
  // ② 长度为偶数且前后半段完全相同（哈哈哈哈哈哈）
  if (s.length >= 4 && s.length % 2 === 0) {
    const h = s.length / 2;
    if (s.slice(0, h) === s.slice(h)) s = s.slice(0, h);
  }
  // ③ 句子级重复：「在呀。在呀。」→「在呀。」
  const m = s.match(/^(.{2,12}?)[。！？!?~～]\1[。！？!?~～]?$/);
  if (m) s = m[1] + '。';
  return s;
}

/** 本地模型出的话要洗一遍再发出去（它不懂 QQ 语法，容易带 markdown/引号） */
function sanitizeReply(s, maxChars) {
  let t = String(s || '').trim();
  t = t.replace(/<@[^>]*>/g, '');
  t = t.replace(/\[MEDIA:[^\]]*\]/gi, '');
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, '');
  t = t.replace(/[*_`#>]+/g, '');
  t = t.replace(/^小蓝[:：]\s*/i, '');
  // 小模型爱用敬语，人设里不许"您"
  t = t.replace(/您/g, '你');
  t = t.replace(/\s+/g, ' ').trim();
  // 人设是"最多 3 句"，小模型容易一逗到底 —— 超过 2 个句末标点就砍到第 2 句
  const sentences = t.match(/[^。！？!?~～]*[。！？!?~～]/g);
  if (sentences && sentences.length > 2) t = sentences.slice(0, 2).join('').trim();
  // ★ 反重复（实测 qwen2.5:7b 会吐"在呀，在呀。"）：把重复的短句只留一句
  t = collapseRepeat(t);
  const cap = num(maxChars, 40);
  if (t.length > cap) {
    // 尽量在句号/问号/感叹号处截断，读起来不像被砍
    const cut = t.slice(0, cap);
    const m = cut.match(/^[\s\S]*[。！？!?~～]/);
    t = (m ? m[0] : cut).trim();
  }
  return t;
}

/** 该不该由本地接手 */ 
function shouldTake(ctx, text, cfg) {
  if (cfg.enabled === false) return { take: false, why: 'disabled' };
  if (!text) return { take: false, why: 'empty' };
  if (text.startsWith('/')) return { take: false, why: 'command' };
  if (/[\[［](图片|语音|视频|表情|文件|转发)/.test(text)) return { take: false, why: 'media' };
  // 有 B 站待汇报（登录失效/定时浏览结果）时交给云端：本地小模型不会主动转述汇报
  if (/\[B站\]/.test(text)) return { take: false, why: 'bili-report' };
  // 太长的一律不接（本地小模型长文会胡说）
  const maxLen = num(cfg.maxInputChars, 24);
  if (text.length > maxLen) return { take: false, why: 'too-long' };

  const mentioned = ctx?.platform?.mentioned === true;
  const isC2C = !ctx?.message?.groupOpenid;

  // ★ 单脑铁律（2026-10-23）：一条消息只许一个大脑说话 —— 本地答了就摘掉整条，云端不跑；
  //   摘不掉（晚挂点/熔断）就绝不发，交回云端。
  //   但"谁该接"要按消息本身判（2026-10-23 晚主人反馈"简单的你好没道理调用大模型"）：
  //     · 私聊/被 @ 这两种**云端本来必回**的场景，只要消息够简单（trivial 或短句），
  //       就让本地先接 —— 摘得掉就省下一整轮云 token，摘不掉自动回落云端，不会双答；
  //     · 群里没 @ 的碎消息同样归本地（按 unmentionedProb 掷骰）。
  //   所以 c2cLocal / onlyUnmentioned 现在只作为"关掉本地抢先"的开关，默认已放开。
  // 硬开关（整类关死用）：默认 c2cLocal=true / onlyUnmentioned=false，等于放开。
  // 想"私聊一律云端"就把 c2cLocal 设 false；想"被 @ 一律云端"就把 onlyUnmentioned 设 true。
  if (isC2C && cfg.c2cLocal === false) return { take: false, why: 'c2c-goes-cloud' };
  if (mentioned && cfg.onlyUnmentioned === true) return { take: false, why: 'mentioned-goes-cloud' };

  // 简单话（trivial / 短句 / 非任务）本地先接；复杂话仍按下面的规矩让给云端。
  const simple = worthLocal(text, cfg);

  const allowUnmentioned = cfg.allowUnmentioned === true;
  if (!mentioned && !isC2C) {
    if (!allowUnmentioned) return { take: false, why: 'not-mentioned' };
    const p = num(cfg.unmentionedProb, 0.25);
    if (p <= 0 || Math.random() > p) return { take: false, why: 'unmentioned-dice' };
  }

  // 主人（白名单）也能被本地答；ownerToo=false 则整类关死
  if (ctx?.isOwner === true && cfg.ownerToo === false) return { take: false, why: 'owner' };

  if (rateLimited(cfg)) return { take: false, why: 'rate-limited' };
  return { take: true, why: 'gate-ok' };
}

/**
 * 这条消息值不值得交给本地小模型（在 gate 全过之后判）。
 *
 * 为什么要两段判：
 *   `classify()` 的 trivial 很严（"在吗""嗯嗯"算，"哈哈哈"算，但"2+3等于多少"不算），
 *   而人设梗恰恰是"不 trivial 但要本地答"的。所以梗那条路绕过这里。
 *   另外真实聊天里大量**很短的非任务句**（"鲸鲸""吃了吗"）也应该本地答，
 *   判据：短 + 不是任务。这样既不误伤长提问，又能真的省下那些碎消息的云 token。
 */
/**
 * 需要"动工具/动能力"的意图 —— 本地小模型**一律不许接**。
 *
 * 真机事故（2026-10-23 05:10）：主人说"画一条小鲸鱼"，本地 7b 回了句
 * 「啊这，画画可真难。」把消息摘掉了；同一时间另一个会话的云端在真画。
 * 结果就是"一遍说画不出、一遍把图发出来"，前后矛盾。
 * 判据：只要句子里有"要她做一件她得靠工具才做得到的事"，就交给云端。
 */
const TOOL_INTENT_RE =
  /(画|绘|描|来一[张幅个]|出一[张幅]|生成.{0,3}(图|片|视频|表|文档|文件)|做.{0,3}(视频|小视频|动图|表|文档)|表情包|贴纸|截图|找图|搜图|发.{0,2}(图|语音|视频|文件)|语音条|唱.{0,2}歌|念一?[下段]|提醒|定时|闹钟|记一下|帮我查|搜一下|查一下|搜搜|搜索一下|翻译|总结一下|列个表|写.{0,4}(代码|脚本|文章|作文|报告)|表格|文档|附件|导出|excel|xlsx|csv|docx|pptx?|pdf|(改|修|转|填|重命名).{0,6}(表|文档|文件)|网页|网址|链接|抓取|爬取|爬一下|联网|上网|打开.{0,6}(网页|网址|链接|页面)|看看.{0,4}(网页|网址|链接|页面)|读.{0,4}(网页|网址|链接|页面)|https?:\/\/|www\.)/i;

/** 这句话是不是"要她干活"（画图/语音/查资料/写东西…） */
export function needsTools(text) {
  const t = String(text || '');
  if (!t) return false;
  return TOOL_INTENT_RE.test(t);
}

function worthLocal(text, cfg) {
  const who = String(cfg.whoAnswers || 'simple').toLowerCase();
  if (who === 'off') return { take: false, why: 'who:off' };
  const r = classify(text);
  const task = isTask(text);
  // 要动工具的，永远交给云端（本地答不了，硬答就是自相矛盾）
  if (needsTools(text)) return { take: false, why: 'needs-tools', tier: r };
  if (r.tier === 'trivial') return { take: true, why: 'trivial', tier: r };
  if (text.length <= num(cfg.shortChatChars, 12) && !task) return { take: true, why: 'short-chat', tier: r };
  const maxLen = num(cfg.maxInputChars, 80);
  // chat / all 两档：闲聊交给本地（省云 token），但"任务型"永远不上本地
  if (who === 'chat' && r.tier === 'chat' && !task && text.length <= maxLen) {
    return { take: true, why: 'chat-mode', tier: r };
  }
  if (who === 'all' && !task && text.length <= maxLen) {
    return { take: true, why: 'all-mode', tier: r };
  }
  return { take: false, why: 'tier:' + r.tier, tier: r };
}

/** 测试用出口（线上只走内部调用）：把"要不要本地答"的判定暴露出来 */
export const worthLocalSafe = worthLocal;

/**
 * 发送本地回复：先摘消息，再发话。
 * 顺序很重要 —— 摘不掉就绝不能发，否则云端还会再回一遍（双回复）。
 * @returns {Promise<boolean>} true=已接管（调用方应该 return，不再 next()）
 */
async function deliver(ctx, reply, tag) {
  if (!reply) return false;
  let killed = false;
  try {
    // ★ 插件 API 是 ctx.annihilate(opts)，opts = { reason, ownerAck }（不是 (reason, opts)！）
    //   ownerAck：主人自己的消息也允许被摘 —— 否则主人问"你好"时本地永远摘不掉、
    //   只能回落云端（2026-10-23 主人实测"简单你好却调用大模型"的真因之一）。
    killed = ctx.annihilate?.({ reason: '本地小模型代答', ownerAck: true }) === true;
  } catch (e) {
    ctx?.logger?.warn?.(`[local] 摘除失败(已忽略): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!killed) {
    ctx?.logger?.debug?.('[local] 摘除未生效 → 交回云端');
    return false;
  }
  markUsed();
  try {
    const sent = await ctx?.caps?.text?.(reply);
    ctx?.logger?.info?.(`[local] 本地代答[${tag}]：${reply}${sent === false ? ' [发送失败]' : ''}`);
  } catch (e) {
    ctx?.logger?.warn?.(`[local] 发送失败(${e instanceof Error ? e.message : String(e)})：这条消息已摘除`);
  }
  return true;
}

export async function onInbound(ctx, next) {
  let cfg;
  try {
    cfg = loadConfig(dataRootOf({}));
    // 二次读：把 dataRoot 从配置文件里带出来
    cfg = loadConfig(dataRootOf(cfg));
  } catch {
    return next();
  }

  const root = String(cfg?.dataRoot || dataRootOf(cfg));
  // 后台预热模型（只做一次，失败也无所谓）
  if (cfg.enabled !== false) warmInBackground(cfg);
  // 作用域：必须带群号/对方 id（`ctx.scope` 只给 'group'/'c2c'，用它会让所有群共用一个锁）
  const scope = scopeOf(ctx);
  const raw = plainText(ctx?.text);
  // 判定日志：每条消息留一行"谁答的/为什么没本地答"，面板直接读它
  const cloud = (why) => {
    try { appendLog(root, { by: 'cloud', why, scope, text: raw || emptyLabel(ctx) }); } catch { /* 日志失败不影响链路 */ }
    // 放给云端 = 本回合交给云算力 ⇒ 记一笔，窗口内本地不插嘴（单脑仲裁）
    try { lockMark(root, scope, 'cloud', { why }); } catch { /* ignore */ }
    ctx?.logger?.debug?.(`[local] 放行(${why})`);
    return next();
  };

  const gate = shouldTake(ctx, raw, cfg);

  // ── 引用的是"子会话转发"：那是会话隔离的地盘（no-wake-on-child-quote.mjs 会整条消灭 +
  //    投递给子会话）。本地代答绝不能抢答 —— 否则一边答一句、一边又把消息吃掉。
  {
    let quotedText = '';
    try {
      const q = ctx?.quoted;
      quotedText = String((typeof q === 'function' ? q()?.text : q?.text) ?? ctx?.state?.quote?.text ?? '');
    } catch { quotedText = ''; }
    if (/【子会话/.test(quotedText)) return cloud('child-session-quote');
  }

  // ── 空正文的"空包"消息：没有任何正文、没有附件、也没人 @ 她 ──
  //    这类消息以前会一路叫到云端：整轮上下文重发一遍（几千 token）只为回一句"？"。
  //    没人 @、也没东西可看 → 直接摘掉，最省。
  if (!raw) {
    const hasAtt = Array.isArray(ctx?.message?.attachments) && ctx.message.attachments.length > 0;
    const mentioned = Boolean(ctx?.platform?.mentioned || (Array.isArray(ctx?.message?.mentions) && ctx.message.mentions.length > 0));
    if (!hasAtt && !mentioned) {
      let killed = false;
      try { killed = ctx?.annihilate?.({ reason: '空消息(无正文无附件无@)' }) === true; } catch { killed = false; }
      if (killed) {
        try { appendLog(root, { by: 'skip', why: 'empty-packet', scope, text: emptyLabel(ctx) }); } catch { /* ignore */ }
        ctx?.logger?.debug?.('[local] 空包消息已摘除（不叫云端，省一整轮上下文）');
        return;
      }
    }
    // 有附件的空正文 = 纯图片/表情/语音消息，交给宿主透传，日志里标清是什么
    return cloud(hasAtt ? 'empty:media' : 'empty:mention');
  }

  // ── 单脑仲裁（"左右脑互搏"的正解）──
  //    插件只能保证「同一条消息只走一个脑」：本地答了就 annihilate 吃掉链，云端根本不跑。
  //    真正打架的是**两条消息交叠**：消息① 交给云端在算，消息② 一到本地秒答 ⇒
  //    用户看到"本地说一句、云端再说一句"，像是两个脑子抢话。
  //    所以：云端在这个窗口内被放行过 / 刚说完 ⇒ 本地闭嘴，这条也交给云端并进同一回合。
  {
    const holdMs = num(cfg.brainHoldMs, 12000);
    if (!lockQuiet(root, scope, holdMs)) {
      return cloud('brain:cloud-busy');
    }
  }

  if (!gate.take) {
    // not-mentioned 太常见，不刷日志
    if (gate.why === 'not-mentioned') return next();
    return cloud(gate.why);
  }

  //

  // 值不值得交给本地（trivial / 短闲聊 / who=chat|all 时的闲聊）
  const worth = worthLocal(raw, cfg);
  if (!worth.take) return cloud(worth.why);

  // 服务/模型可用性（有 5 秒缓存，不会每条都探测）
  let h;
  try {
    h = await health(cfg);
  } catch {
    h = { ok: false };
  }
  if (!h.ok || !h.hasModel) {
    ctx?.logger?.debug?.(`[local] 跳过：服务 ${h.ok ? '在线' : '离线'} / 模型 ${h.hasModel ? '有' : '缺'}(${cfg.model})`);
    return cloud(h.ok ? 'model-missing:' + cfg.model : 'ollama-offline');
  }

  let answer;
  try {
    // 记忆/设定也要喂给本地小模型（它答得快，但不能答得"失忆"）
    const recallCtx = recallBlocksOf(ctx?.text);
    const sysBase = String(cfg.systemPrompt || DEFAULT_SYSTEM);
    const sys = recallCtx
      ? sysBase + '\n\n# 你记得的事（当成你自己的记忆说出来，别像念资料）\n' + recallCtx
      : sysBase;
    answer = await chat({
      cfg,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: raw },
      ],
    });
  } catch (e) {
    ctx?.logger?.warn?.(`[local] 推理异常(已忽略): ${e instanceof Error ? e.message : String(e)}`);
    return cloud('chat-throw');
  }
  if (!answer?.ok) return cloud('chat-fail:' + (answer?.error || '?'));

  const reply = sanitizeReply(answer.text, cfg.maxReplyChars || 60);
  if (!reply) return cloud('empty-reply');

  // 人设污染就不采纳，交回云端（准确性 > 省 token）
  if (looksLikePersonaBreach(reply)) {
    ctx?.logger?.info?.(`[local] 丢弃(人设跑偏)：${reply}`);
    return cloud('persona-breach');
  }

  if (await deliver(ctx, reply, `local ${answer.ms}ms`)) {
    try {
      appendLog(root, { by: 'local', why: worth.why, model: String(cfg.model || ''), ms: answer.ms, scope, text: raw, reply });
    } catch { /* ignore */ }
    try { lockMark(root, scope, 'local', { why: worth.why }); } catch { /* ignore */ }
    // 她这轮"承诺了自己会出声" ⇒ 让出站那跳必须真发一条语音（否则自相矛盾）
    if (wantsVoice(raw, reply)) {
      const p = writeForceVoice(root, scope);
      ctx?.logger?.info?.(`[local] 本轮承诺会出声 → 强制发语音${p ? '' : '(写标记失败)'}`);
    }
    return;
  }
  return cloud('annihilate-failed');
}

/** 给调试用：暴露当前限流状态 */
export function rateState() {
  return { lastAt: _rl.lastAt, hits: _rl.hits.slice() };
}

/** 给测试/热修用：清空限流状态（真跑时不需要） */
export function resetRate() {
  _rl.lastAt = 0;
  _rl.hits = [];
}
