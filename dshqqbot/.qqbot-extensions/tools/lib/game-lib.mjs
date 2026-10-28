/**
 * game-lib.mjs — 聊天小游戏引擎 + 会话存档（2026-10-25）
 *
 * 设计目标（主人定的三条）：
 *   ① **上下文零负担** —— 游戏状态全部落盘（每群一份），AI 每步只拿 ≤3 行裁决结果，
 *      不把对局历史塞进上下文；本库与 tools/game.mjs、inbound/game-inbound.mjs 共享。
 *   ② **开始/结束有明确仪式** —— start 返回开场白、end 返回结算；15 分钟没动静自动收摊。
 *   ③ **每群一局** —— 同一个群同时只有一场进行中的游戏（再来一局=先结束再开）。
 *
 * 会话文件：{dataRoot}/.qqbot-extensions/tools/data/game-sessions.json
 *   { seq, sessions: { "<scope>:<peerId>": { id, kind, state, startedBy, startedAt, lastAt } } }
 *
 * 键的约定（与插件契约对齐）：
 *   · 工具侧：env.caps.scope + env.caps.peerId
 *   · 入站侧：ctx.scope + (ctx.groupId || ctx.senderId)  ← ext-inbound-context.js:614-652
 */

import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { pin, unpin, ensureWatcher, ensureLoaded, unload as unloadOllama } from '../../lib/model-policy.mjs';
import { loadConfig as loadLlmConfig, chat as llmChat } from '../../lib/local-llm.mjs';

export const IDLE_MINUTES = 15;          // 多久没动静自动收摊
const SEP = /[|｜,，\s]+/;

// ── 内置词库 ─────────────────────────────────────────────────────────
/** 成语接龙：常用成语（按首字分组没有意义，靠 Set 校验 + 首尾衔接） */
const IDIOM_LIST = `一心一意 意气风发 发扬光大 大快人心 心想事成 成家立业 业精于勤
勤能补拙 拙口钝辞 辞旧迎新 新陈代谢 谢天谢地 地大物博 博学多才 才高八斗 斗转星移
移风易俗 俗不可耐 耐人寻味 味同嚼蜡 蜡炬成灰 灰飞烟灭 灭绝人性 性命攸关 关怀备至
至高无上 上行下效 效犬马力 力挽狂澜 澜倒波随 随遇而安 安居乐业 业峻鸿绩 绩学之士
士别三日 日新月异 异想天开 开门见山 山清水秀 秀外慧中 中流砥柱 柱石之坚 坚如磐石
石破天惊 惊天动地 地久天长 长年累月 月明星稀 稀奇古怪 怪力乱神 神通广大 大显身手
手到擒来 来日方长 长驱直入 入木三分 分秒必争 争先恐后 后来居上 上善若水 水到渠成
成竹在胸 胸有成竹 竹报平安 安然无恙 恙满而归 归心似箭 箭在弦上 上下一心 心口如一
一如既往 往事如风 风调雨顺 顺水推舟 舟车劳顿 顿开茅塞 塞翁失马 马到成功 功成身退
退避三舍 舍己为人 人山人海 海阔天空 空前绝后 后来者居 上当受骗 骗吃骗喝 喝西北风
风平浪静 静观其变 变化多端 端倪可察 察言观色 色胆包天 天罗地网 网开一面 面面俱到
到知春暖 暖意融融 融会贯通 通风报信 信手拈来 来者不拒 拒人千里 里应外合 合情合理
理直气壮 壮志凌云 云开见日 日理万机 机不可失 失而复得 得心应手 手舞足蹈 蹈规循矩
矩步方行 行云流水 水涨船高 高枕无忧 忧国忧民 民不聊生 生龙活虎 虎虎生威 威风凛凛
凛然正气 气壮山河 河清海晏 晏然自若 若无其事 事半功倍 倍道兼行 行将就木 木已成舟
舟行碧波 波光粼粼 粼粼波光 光彩夺目 目不转睛 睛明眼亮 亮堂堂堂 堂堂正正 正大光明
明知故问 问道于盲 盲人摸象 象牙之塔 塔尖功德 德才兼备 备受关注 注目礼赞 赞不绝口
口若悬河 河东狮吼 吼天喊地 地老天荒 荒诞不经 经久不衰 衰兵必胜 胜券在握 握手言和
和风细雨 雨过天晴 晴空万里 里里外外 外强中干 干净利落 落落大方 方兴未艾 艾发衰容
容光焕发 发人深省 省吃俭用 用兵如神 神采飞扬 扬眉吐气 气吞山河 河山锦绣 绣花枕头
头头是道 道听途说 说一不二 二话不说 说曹操曹操 到了桥头 桥归桥路 路遥知马 马马虎虎
虎头蛇尾 尾大不掉 掉以轻心 心平气和 和颜悦色 色厉内荏 荏苒光阴 阴差阳错 错落有致
志同道合 合二为一 一鸣惊人 人定胜天 天涯海角 角立杰出 出类拔萃 萃聚精英 英姿飒爽
爽然若失 失道寡助 助人为乐 乐极生悲 悲欢离合 合浦珠还 还淳反朴 朴实无华 华而不实
实至名归 归根到底 底气十足 十全十美 美中不足 足智多谋 谋事在人 人定勝天 天下无双
双管齐下 下不为例 例行公事 事半功倍 倍受鼓舞 舞文弄墨 墨守成规 规行矩步 步步为营
营私舞弊 弊绝风清 清心寡欲 欲擒故纵 纵虎归山 山盟海誓 誓死不二 二龙戏珠 珠联璧合
合家欢乐 乐不思蜀 蜀犬吠日 日上三竿 竿头日进 进退两难 难能可贵 贵人多忘 忘乎所以
以德报怨 怨天尤人 人杰地灵 灵丹妙药 药到病除 除暴安良 良药苦口 口蜜腹剑 剑拔弩张
张灯结彩 彩云追月 月下老人 人云亦云 云淡风轻 轻描淡写 写意人生 生生不息 息息相关
关公面前 耍大刀 刀山火海 海纳百川 川流不息 息事宁人 人间正道 道貌岸然 然荻读书
书声琅琅 琅琅上口 口口相传 传为佳话 话里有话 话不投机 机智勇敢 敢作敢当 当仁不让
让人三分 分文不取 取长补短 短兵相接 接二连三 三心二意 意味深长 长话短说 说长道短
短小精悍 悍然不顾 顾全大局 局势稳稳 稳操胜券 券在必得 得意洋洋 洋洋洒洒 洒脱不羁
羁鸟恋林 林林总总 总而言之 之乎者也 业已成真 真情实感 感同身受 受益匪浅 浅尝辄止`
  .split(/\s+/).filter((w) => w.length === 4);

/** 真心话题库（群聊友好版） */
const TRUTH_POOL = [
  '最近一次熬夜到几点？在干嘛？', '群里你最先想到谁？为什么？', '说一个你至今没人知道的小习惯',
  '最近一次笑出声是因为什么？', '如果明天不用上班/上课，你最想干嘛？', '手机里最舍不得删的一张照片是什么？',
  '最近吃过最惊艳的东西是什么？', '你有什么坚持了很久的小事？', '说一个你最近的小目标',
  '上一首单曲循环的歌是哪首？', '最近一次收到礼物是什么？', '如果中了500万，第一件事干嘛？',
  '你最近学会的一件新东西是什么？', '说一个你觉得被低估的东西/事物', '你手机屏幕使用时间最长的App是哪个？',
];
/** 大冒险任务（线上可完成版） */
const DARE_POOL = [
  '用一句话夸下一位发言的人', '接下来一分钟，说话都带上「喵」结尾', '发一个你最近输入法记住的词（不解释）',
  '用表情包形容你现在的心情', '用唱歌的调子念出你上一条消息', '给群里随机第三个人发一句早安（现在几点都得发）',
  '接下来三句话里必须有一个成语', '用最正经的语气说一句特别无聊的事', '把你的微信步数报出来',
  '用一种动物的叫声回应下一条@你的消息', '现在做个深呼吸，然后说「满血复活！」', '说一句绕口令（比如：红鲤鱼与绿鲤鱼与驴）',
];

// ── 存档 ─────────────────────────────────────────────────────────────
export function sessionPath(dataRoot) {
  return join(String(dataRoot || ''), '.qqbot-extensions', 'tools', 'data', 'game-sessions.json');
}
function loadRaw(dataRoot) {
  const p = sessionPath(dataRoot);
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return (j && typeof j === 'object' && j.sessions) ? j : { seq: 0, sessions: {} };
  } catch { return { seq: 0, sessions: {} }; }
}
function saveRaw(dataRoot, d) {
  const p = sessionPath(dataRoot);
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + process.pid;
    writeFileSync(tmp, JSON.stringify(d, null, 1), 'utf8');
    try { renameSync(tmp, p); } catch { writeFileSync(p, JSON.stringify(d, null, 1), 'utf8'); }
    return true;
  } catch { return false; }
}
export function keyOf(scope, peerId) {
  return `${String(scope || 'group')}:${String(peerId || '')}`;
}
/** 读某群的活跃会话（懒过期：超过 IDLE_MINUTES 自动结算） */
export function activeOf(dataRoot, scope, peerId) {
  const d = loadRaw(dataRoot);
  const k = keyOf(scope, peerId);
  const s = d.sessions[k];
  if (!s) return null;
  if (Date.now() - Number(s.lastAt || 0) > IDLE_MINUTES * 60_000) {
    delete d.sessions[k];
    saveRaw(dataRoot, d);
    try { unpin('game'); } catch { /* 策略模块失败不影响收摊 */ }
    return null;
  }
  return s;
}
export function endSession(dataRoot, scope, peerId, why) {
  const d = loadRaw(dataRoot);
  const k = keyOf(scope, peerId);
  const s = d.sessions[k] || null;
  if (s) { delete d.sessions[k]; s.endedWhy = why || '手动'; saveRaw(dataRoot, d); }
  return s;
}
export function listSessions(dataRoot) {
  const d = loadRaw(dataRoot);
  const now = Date.now();
  const out = [];
  for (const [k, s] of Object.entries(d.sessions || {})) {
    if (now - Number(s.lastAt || 0) > IDLE_MINUTES * 60_000) continue;
    out.push({ key: k, id: s.id, kind: s.kind, startedAt: s.startedAt, lastAt: s.lastAt,
      idleMin: Math.round((now - Number(s.lastAt || 0)) / 60_000), score: s.state?.score ?? null });
  }
  return out;
}
export function killSession(dataRoot, key) {
  const d = loadRaw(dataRoot);
  if (d.sessions[key]) { delete d.sessions[key]; saveRaw(dataRoot, d); return true; }
  return false;
}

/** 工具/中间件复用的整档读写（与 activeOf 同一份文件，原子写） */
export function loadStore(dataRoot) { return loadRaw(dataRoot); }
export function saveStore(dataRoot, d) { return saveRaw(dataRoot, d); }

// ── 各游戏引擎 ────────────────────────────────────────────────────────
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];

// ── LLM 游戏支撑（2026-10-26）────────────────────────────────────────
// 主人要求：多加游戏，尤其是"能调本地模型"的；开局及时把本地模型叫醒，
// 玩完/闲置就让它离开显存（见 lib/model-policy.mjs）。
const LLM_HOLD_MS = 12 * 60 * 1000;      // 一局最多钉 12 分钟，超时自动松手
const SOUP_FALLBACK = [
  { puzzle: '一个男人走进餐厅，点了一碗海龟汤，尝了一口就哭了。为什么？', answer: '汤不是海龟做的——他想起多年前海难时同伴骗他吃的是海龟肉，其实是人肉。' },
  { puzzle: '一个女人每天都要看三次同一个信箱，看完就放心了。为什么？', answer: '信箱里是她给远方孩子留的信，孩子每天来取；看到信被取走说明孩子还安全。' },
  { puzzle: '他按下电梯的十楼，坐到七楼就出来了，然后走楼梯上去。为什么？', answer: '他个子矮，够不到十楼按钮；七楼是能按到的最高层。' },
];
const STORY_SEEDS = [
  '深夜的便利店只剩一个人，收银台的小姑娘忽然问我：要买雨衣吗？外面没下雨。',
  '鲸鱼在海底捡到一只会响的玻璃瓶，瓶里装着一句人类的话。',
  '凌晨三点，整栋楼的灯同时亮了，只有我家是暗的。',
];

async function askBrain(dataRoot, prompt, { maxTokens = 160, system = '', timeoutMs = 90000 } = {}) {
  try {
    const cfg = loadLlmConfig(dataRoot);
    // 游戏可以单独指定一个更会说话的小模型（gameModel），没配就用聊天模型
    const gm = String(cfg?.gameModel || '').trim();
    if (gm) cfg.model = gm;
    ensureWatcher(() => cfg.residency);
    const r = await llmChat({
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: String(prompt || '') }],
      cfg, maxTokens, timeoutMs,
    });
    return r.ok ? String(r.text || '').trim() : '';
  } catch { return ''; }
}

/** 开局/每步：把本地模型钉住（多步之间不冷启） */
function holdGame(note = '') {
  try { pin('game', LLM_HOLD_MS, note); } catch { /* 忽略 */ }
}

/** 收摊：松手 + 没有别的用途就把模型请出显存 */
async function releaseGame(dataRoot) {
  try { unpin('game'); } catch { /* 忽略 */ }
  try {
    const cfg = loadLlmConfig(dataRoot);
    await unloadOllama({ baseUrl: cfg.baseUrl });
  } catch { /* 忽略 */ }
}

// 引擎的 start/move 拿不到 dataRoot（签名是 (state/text)），用模块级游标传一次
let _curRoot = '';
function dataRootFor() { return _curRoot || 'F:/qqbot/dshqqbot'; }

const QUIZ_FALLBACK = [
  { q: '地球上最深的海沟叫什么？', a: '马里亚纳海沟' },
  { q: '鲸鱼是鱼吗？', a: '不是，是哺乳动物' },
  { q: '光在真空里每秒大约走多少公里？', a: '约 30 万公里' },
  { q: '成年蓝鲸的心脏大约有多重？', a: '约 180 公斤' },
  { q: '世界上最大的哺乳动物是什么？', a: '蓝鲸' },
];

/** 小模型出的题常跑偏：字数、句式、答案长度都过一遍，不合格就走本地题库 */
function cleanQuizQ(q) {
  return String(q || '')
    .replace(/^[\s?？。，、：:；;!！'"「」]+/, '')   // 小模型爱在开头加个问号
    .replace(/\s+/g, ' ')
    .replace(/[？?]{2,}/g, '？')                      // 也爱连打两个问号
    .replace(/[。，、；：]+$/, '')
    .trim();
}
function quizOk(j) {
  const q = cleanQuizQ(j?.q);
  const a = String(j?.a || '').trim();
  if (q.length < 6 || q.length > 60) return false;
  if (a.length < 1 || a.length > 40) return false;
  if (!/[？?]$/.test(q)) return false;                       // 必须是问句
  if (!/什么|多少|哪|谁|几|为什么|怎么|何时|哪里|多大|多长|多高|多深|哪个/.test(q)) return false;
  if (/^(不知道|无|略|暂无)$/.test(a)) return false;
  return true;
}

async function nextQuiz(dataRoot) {
  const raw = await askBrain(dataRoot,
    '你是出题人。出一道中文冷知识单选题式问答题（有唯一确定答案的事实题，不要考诗词出处、不要问"有多少座"这类含糊题）。题干 12~30 字、以问号结尾；答案 2~15 字。严格只输出一行 JSON：{"q":"题干","a":"答案"}',
    { maxTokens: 120 });
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      if (quizOk(j)) return { q: cleanQuizQ(j.q), a: String(j.a).trim() };
    }
  } catch { /* 兜底 */ }
  return pick(QUIZ_FALLBACK);
}

const ENGINES = {
  /** 猜数字：1~range，7 次机会 */
  guess: {
    title: '猜数字',
    start(args) {
      const range = Math.min(1000, Math.max(10, Number(args?.range) || 100));
      return { state: { answer: 1 + rnd(range), lo: 1, hi: range, tries: 0, maxTries: 7 },
        intro: `想好了一个 1~${range} 的整数，7 次机会，直接在群里报数就行（提示「大了/小了」）。` };
    },
    match: (t) => /^\d{1,4}$/.test(t),
    move(st, text) {
      const n = Number(text);
      if (n < st.lo || n > st.hi) return { reply: `不在范围里哦，现在是 ${st.lo}~${st.hi}。`, state: st };
      st.tries += 1;
      if (n === st.answer) return { reply: `🎉 猜中了！答案就是 ${n}（第 ${st.tries} 次）。`, state: st, done: true, win: true };
      if (st.tries >= st.maxTries) return { reply: `次数用完啦，答案是 ${st.answer}。再来一局喊「玩猜数字」。`, state: st, done: true, win: false };
      if (n < st.answer) { st.lo = Math.max(st.lo, n + 1); return { reply: `小了 ↑ 范围 ${st.lo}~${st.hi}（还剩 ${st.maxTries - st.tries} 次）`, state: st }; }
      st.hi = Math.min(st.hi, n - 1); return { reply: `大了 ↓ 范围 ${st.lo}~${st.hi}（还剩 ${st.maxTries - st.tries} 次）`, state: st };
    },
  },

  /** 数字炸弹：1~100 里埋一颗雷，轮流报数缩范围，谁踩雷谁输 */
  bomb: {
    title: '数字炸弹',
    start() {
      return { state: { bomb: 1 + rnd(100), lo: 1, hi: 100, last: '' },
        intro: '1~100 里藏了一颗「炸弹」，轮流报数，范围会越来越小，谁报中炸弹谁就「爆炸」💥（喊我「玩数字炸弹」再来一局）。' };
    },
    match: (t) => /^\d{1,3}$/.test(t),
    move(st, text, who) {
      const n = Number(text);
      if (n <= st.lo || n >= st.hi) return { reply: `要报 ${st.lo + 1}~${st.hi - 1} 之间的数（现在范围 ${st.lo}~${st.hi}）。`, state: st };
      if (n === st.bomb) return { reply: `💥 轰！${who || '这位朋友'} 报中了炸弹 ${n}，本局结束。`, state: st, done: true, win: false };
      const nearer = n < st.bomb;
      if (nearer) st.lo = n; else st.hi = n;
      st.last = who || '';
      return { reply: `安全！范围变成 ${st.lo}~${st.hi}。`, state: st };
    },
  },

  /** 成语接龙：本地词库校验 + 首尾衔接 */
  idiom: {
    title: '成语接龙',
    start() {
      const first = pick(IDIOM_LIST);
      return { state: { last: first, chain: [first], round: 0 },
        intro: `我先来：**${first}** —— 接一个以「${first.slice(-1)}」开头的成语（本地词库 ${IDIOM_LIST.length} 条，接不上或接错就算输）。` };
    },
    match: (t) => /^[\u4e00-\u9fa5]{4}$/.test(t),
    move(st, text) {
      const w = text.trim();
      st.round += 1;
      if (st.chain.includes(w)) return { reply: `「${w}」这局已经接过了，换一个。`, state: st };
      const tail = st.last.slice(-1);
      if (w[0] !== tail) return { reply: `要接「${tail}」开头的成语，「${w}」不对，再想想？`, state: st, round: st.round };
      const known = IDIOM_LIST.includes(w);
      if (!known) {
        // 词库未收录但字形合规：放过一次并记录（不判定输，友好优先）
        st.last = w; st.chain.push(w);
        const next = IDIOM_LIST.find((x) => x[0] === w.slice(-1));
        if (!next) return { reply: `「${w}」（词库外，本轮放过）。我接不上「${w.slice(-1)}」开头的……你赢了！`, state: st, done: true, win: true };
        st.last = next; st.chain.push(next);
        return { reply: `「${w}」（词库外，本轮放过）。我接：**${next}** —— 该你「${next.slice(-1)}」。`, state: st };
      }
      st.last = w; st.chain.push(w);
      const next = IDIOM_LIST.find((x) => x[0] === w.slice(-1) && !st.chain.includes(x));
      if (!next) return { reply: `好词！但「${w.slice(-1)}」开头的我接不上了……这局你赢！`, state: st, done: true, win: true };
      st.last = next; st.chain.push(next);
      return { reply: `我接：**${next}** —— 该你「${next.slice(-1)}」（第 ${st.round + 1} 轮）。`, state: st };
    },
  },

  /** 21点：你 vs 庄家（我） */
  bj: {
    title: '21点',
    start() {
      const deck = freshDeck();
      const player = [deck.pop(), deck.pop()];
      const dealer = [deck.pop(), deck.pop()];
      return { state: { deck, player, dealer, done: false },
        intro: `你的手牌：${fmt(player)}（${score(player)} 点）。我的明牌：${dealer[0]}。回复「要牌」或「停牌」。` };
    },
    match: (t) => /^(要牌|再来一张|hit|h|停牌|不要了|开|stand|s)$/i.test(t),
    move(st, text) {
      const want = /^(要牌|再来一张|hit|h)$/i.test(text);
      if (want) {
        st.player.push(st.deck.pop());
        const s = score(st.player);
        if (s > 21) return { reply: `你的牌：${fmt(st.player)} = ${s} 点，爆了！这局我赢 😜`, state: st, done: true, win: false };
        return { reply: `你的牌：${fmt(st.player)}（${s} 点）。要牌还是停牌？`, state: st };
      }
      // 停牌 → 庄家按 <17 必须要牌
      while (score(st.dealer) < 17 && st.deck.length) st.dealer.push(st.deck.pop());
      const ps = score(st.player), ds = score(st.dealer);
      let reply;
      if (ds > 21 || ps > ds) { reply = `结算：你 ${fmt(st.player)}=${ps}，我 ${fmt(st.dealer)}=${ds} —— 你赢！🎉`; }
      else if (ps === ds) { reply = `结算：你 ${ps}，我 ${ds} —— 平局。`; }
      else { reply = `结算：你 ${fmt(st.player)}=${ps}，我 ${fmt(st.dealer)}=${ds} —— 我赢 😎`; }
      return { reply, state: st, done: true, win: ps > ds || ds > 21 };
    },
  },

  /** 石头剪刀布：三局两胜 */
  rps: {    title: '石头剪刀布',
    start() {
      return { state: { me: 0, you: 0, round: 0 },
        intro: '三局两胜！直接在群里出「石头 / 剪刀 / 布」。' };
    },
    match: (t) => /^(石头|剪刀|布|拳头|锤子)$/i.test(t),
    move(st, text) {
      const norm = (x) => (x === '拳头' || x === '锤子' ? '石头' : x);
      const you = norm(text.trim());
      const me = pick(['石头', '剪刀', '布']);
      st.round += 1;
      let out;
      if (you === me) out = '平！';
      else if ((you === '石头' && me === '剪刀') || (you === '剪刀' && me === '布') || (you === '布' && me === '石头')) { st.you += 1; out = '这局你赢'; }
      else { st.me += 1; out = '这局我赢'; }
      const score = `你 ${st.you} : ${st.me} 我（第 ${st.round} 局）`;
      if (st.you >= 2 || st.me >= 2) {
        const win = st.you > st.me;
        return { reply: `${me} vs ${you}，${out}。最终 ${score} —— ${win ? '你赢了，佩服佩服 🫡' : '我赢啦 😝'}`, state: st, done: true, win };
      }
      return { reply: `我出 ${me}，你出 ${you}，${out}。比分 ${score}。继续！`, state: st };
    },
  },

  // ══ 下面三局要用本地小模型（开局把模型叫醒，收摊就让它离开显存）══

  /** 海龟汤：模型出谜 + 判"是/不是/无关" */
  soup: {
    title: '海龟汤',
    needsLlm: true,
    async start() {
      const raw = await askBrain(dataRootFor(),
        '你出一道经典的中文海龟汤（情境推理谜题）：汤面要有一个明显反常、需要解释的场景（15~50 字），汤底一句话说清真相（10~60 字）。不要出现"海龟汤"三个字，不要把答案写进汤面。严格只输出一行 JSON：{"puzzle":"汤面","answer":"汤底"}',
        { maxTokens: 200 });
      let pz = null;
      try {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) {
          const j = JSON.parse(m[0]);
          const puzzle = String(j?.puzzle || '').trim();
          const answer = String(j?.answer || '').trim();
          const ok = puzzle.length >= 10 && puzzle.length <= 80
            && answer.length >= 6 && answer.length <= 120
            && !/海龟汤/.test(puzzle) && !/海龟汤/.test(answer);
          if (ok) pz = { puzzle, answer };
        }
      } catch { /* 用兜底池 */ }
      if (!pz) pz = pick(SOUP_FALLBACK);
      return {
        state: { puzzle: pz.puzzle, answer: pz.answer, asked: 0 },
        intro: `【海龟汤】汤面：${pz.puzzle}\n（问我问题，我只回「是 / 不是 / 无关」；想直接看汤底喊「揭晓」）`,
      };
    },
    match: (t) => /[?？]\s*$/.test(t) || /^(揭晓|公布|看汤底|汤底|答案)$/.test(t),
    async move(st, text) {
      if (/^(揭晓|公布|看汤底|汤底|答案)$/.test(text)) {
        return { reply: `汤底：${st.answer}`, state: st, done: true, win: true };
      }
      st.asked += 1;
      const a = await askBrain(dataRootFor(),
        `海龟汤汤面：${st.puzzle}\n汤底（只有你知道，绝不能说出来）：${st.answer}\n玩家问：${text}\n只输出一行：先回答 是 或 不是 或 无关 或 接近，然后接最多 12 个字的吐槽。不要解释汤底，不要反问他。`,
        { maxTokens: 60 });
      const t = String(a || '').replace(/[\s　]+/g, ' ').trim();
      const m = t.match(/^(接近|差不多|是|对|没错|不是|不对|否|没有|无关)/);
      const word = !m ? '无关'
        : /^(接近|差不多)/.test(m[1]) ? '接近'
          : /^(是|对|没错)/.test(m[1]) ? '是'
            : /^(不是|不对|否|没有)/.test(m[1]) ? '不是' : '无关';
      const tail = t.slice(m ? m[0].length : 0).replace(/^[，,、；;。.：:\s　]+/, '').slice(0, 14);
      return { reply: tail ? `${word}。${tail}` : word, state: st };
    },
  },

  /** 故事接龙：模型每轮续写 1~2 句 */
  story: {
    title: '故事接龙',
    needsLlm: true,
    start() {
      const seed = pick(STORY_SEEDS);
      return { state: { last: seed, turns: 0 }, intro: `我先开头：「${seed}」\n想接就说「接：你的句子」，我接着往下写（喊「结束游戏」收摊）。` };
    },
    match: (t) => /^接[:：\s]/.test(t) || /^接龙[:：\s]?/.test(t),
    async move(st, text) {
      const seg = text.replace(/^接龙?[:：\s]*/, '').trim();
      if (!seg) return { reply: '接什么呀？写成「接：你的句子」。', state: st };
      st.turns += 1;
      st.last = seg;
      const a = await askBrain(dataRootFor(),
        `故事接龙。上一句是：「${seg}」\n请紧接着往下写，中文，1~2 句、不超过 50 字；不要复述上一句、不要总结、不要提问、不要写旁白说明。只输出续写的正文。`,
        { maxTokens: 80 });
      let next = String(a || '').replace(/^["「]|["」]$/g, '').replace(/\s+/g, ' ').trim();
      next = next.split(/(?<=[。！？!?…])/).slice(0, 2).join('').slice(0, 70);
      if (next.length < 4) next = '（我一时想不出来…你再说一句？）';
      st.last = next;
      return { reply: `${next}\n（第 ${st.turns} 段，继续就说「接：…」）`, state: st };
    },
  },

  /** 你问我答：模型出题 + 判分，三题一局 */
  quiz: {
    title: '你问我答',
    needsLlm: true,
    async start() {
      const q = await nextQuiz(dataRootFor());
      return { state: { ...q, round: 1, score: 0 }, intro: `【你问我答】第 1 题：${q.q}\n（回答写「答：xxx」，不会就喊「跳过」；共 3 题）` };
    },
    match: (t) => /^答[:：\s]/.test(t) || /^(跳过|不会|不知道|不懂|过|pass)$/i.test(t),
    async move(st, text) {
      const ans = text.replace(/^答[:：\s]*/, '').trim();
      const skip = /^(跳过|不会|不知道|不懂|过|pass)$/i.test(text) || /^(不知道|不会|不懂|忘了)$/.test(ans);
      let verdict = '跳过';
      if (!skip && ans) {
        const a = await askBrain(dataRootFor(), `题目：${st.q}\n标准答案：${st.a}\n玩家回答：${ans}\n判断玩家回答和标准答案是否一致，只输出「对」或「不对」，再接一句不超过 12 字的点评。`, { maxTokens: 40 });
        const s = String(a || '').trim();
        verdict = /^(对|正确|没错|是的)/.test(s) || /^「?对/.test(s) ? '对' : '不对';
        if (verdict === '对') st.score += 1;
      }
      if (st.round >= 3) {
        return { reply: `${verdict}。答案：${st.a}\n三题结束，你答对 ${st.score} 题 ${st.score >= 2 ? '厉害呀 🎉' : '再来一局？'}`, state: st, done: true, win: st.score >= 2 };
      }
      const next = { round: st.round + 1, score: st.score };
      const nq = await nextQuiz(dataRootFor());
      return { reply: `${verdict}。答案：${st.a}\n第 ${next.round} 题：${nq.q}`, state: { ...next, ...nq } };
    },
  },
};

/** 真心话大冒险：无状态，转一次给一题 */
export function spinTruth(mode) {
  const dare = mode === 'dare';
  return { text: dare ? pick(DARE_POOL) : pick(TRUTH_POOL), mode: dare ? '大冒险' : '真心话' };
}
/** 掷骰子：无状态 */
export function rollDice(sides) {
  const n = Math.min(1000, Math.max(2, Number(sides) || 6));
  return { n: 1 + rnd(n), sides: n };
}

function freshDeck() {
  const cards = [];
  for (const suit of ['♠', '♥', '♣', '♦']) {
    for (const r of ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']) cards.push(r + suit);
  }
  for (let i = cards.length - 1; i > 0; i--) { const j = rnd(i + 1); [cards[i], cards[j]] = [cards[j], cards[i]]; }
  return cards;
}
function score(cards) {
  let s = 0, aces = 0;
  for (const c of cards) {
    const r = c.slice(0, -1);
    if (r === 'A') { s += 11; aces += 1; }
    else if (['J', 'Q', 'K'].includes(r)) s += 10;
    else s += Number(r);
  }
  while (s > 21 && aces > 0) { s -= 10; aces -= 1; }
  return s;
}
const fmt = (cards) => cards.join(' ');

export function gameTitle(kind) { return ENGINES[kind]?.title || kind; }
export function gameKinds() { return Object.keys(ENGINES); }
export function engineOf(kind) { return ENGINES[kind] || null; }
export function idiomCount() { return IDIOM_LIST.length; }

/** 开一局（工具与入站中间件共用）：有旧局先礼貌结算，返回 {id, intro, title} */
export async function startSession(dataRoot, scope, peerId, kind, opts = {}) {
  const eng = engineOf(kind);
  if (!eng) return null;
  _curRoot = String(dataRoot || '');
  const prev = activeOf(dataRoot, scope, peerId);
  if (prev) endSession(dataRoot, scope, peerId, '重开');
  // 需要模型的一局：先把模型叫醒（一次性冷启），再把显存钉住，玩的过程中不反复加载
  if (eng.needsLlm) {
    holdGame(kind);
    try {
      const cfg = loadLlmConfig(dataRoot);
      if (cfg && cfg.enabled !== false) await ensureLoaded({ baseUrl: cfg.baseUrl, model: cfg.model });
    } catch { /* 模型起不来就让引擎走兜底题库 */ }
  }
  const started = eng.start(opts.args || {});
  const { state, intro } = started && typeof started.then === 'function' ? await started : started;
  const d = loadRaw(dataRoot);
  d.seq = Math.max(Number(d.seq) || 0, 0) + 1;
  const id = `G${d.seq}`;
  d.sessions[keyOf(scope, peerId)] = {
    id, kind, state,
    needsLlm: !!eng.needsLlm,
    startedBy: String(opts.startedBy || ''),
    startedByOpenid: String(opts.startedByOpenid || ''),
    startedAt: Date.now(), lastAt: Date.now(),
    log: [],
  };
  saveRaw(dataRoot, d);
  return { id, kind, title: eng.title, intro, needsLlm: !!eng.needsLlm };
}

/** 结束并返回结算信息（没有对局返回 null） */
export async function finishSession(dataRoot, scope, peerId, why) {
  const ended = endSession(dataRoot, scope, peerId, why || '手动');
  if (!ended) return null;
  if (ended.needsLlm) await releaseGame(dataRoot);
  return { id: ended.id, title: gameTitle(ended.kind) };
}

// ── 入站中间件用的「一步裁决」：裁决 + 存档 + 留痕，返回要发到群里的文本 ──
/**
 * @returns {{handled:boolean, reply?:string, done?:boolean, id?:string, kind?:string}}
 *   handled=false = 没接（消息会继续走正常链路）
 */
export async function applyMove(dataRoot, scope, peerId, text, who) {
  const s = activeOf(dataRoot, scope, peerId);
  if (!s) return { handled: false };
  const eng = engineOf(s.kind);
  if (!eng) { endSession(dataRoot, scope, peerId, '引擎缺失'); return { handled: false }; }
  const t = String(text || '').trim();
  if (!eng.match(t)) return { handled: false };
  _curRoot = String(dataRoot || '');
  // 用到模型的一局：每次出招把钉子续上（12 分钟内不会中途卸载）
  if (eng.needsLlm) holdGame(s.kind);
  const started = eng.move(s.state, t, who || '这位朋友');
  const r = started && typeof started.then === 'function' ? await started : started;
  const d = loadRaw(dataRoot);
  const k = keyOf(scope, peerId);
  if (r.done) {
    delete d.sessions[k];
  } else {
    const cur = d.sessions[k];
    if (cur) {
      cur.lastAt = Date.now();
      // 关键：把引擎吐回来的新状态写回存档，否则每步都从开局状态重来
      if (r.state && typeof r.state === 'object') cur.state = r.state;
      cur.log = Array.isArray(cur.log) ? cur.log : [];
      cur.log.push({ t: Date.now(), who: who || '', move: t.slice(0, 40), reply: String(r.reply || '').slice(0, 80) });
      if (cur.log.length > 10) cur.log = cur.log.slice(-10);
    }
  }
  saveRaw(dataRoot, d);
  if (r.done && s.needsLlm) await releaseGame(dataRoot);
  return { handled: true, reply: r.reply, done: !!r.done, id: s.id, kind: s.kind };
}
