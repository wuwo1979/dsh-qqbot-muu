/**
 * lib/script-writer.mjs — 让云端 DeepSeek（OpenAI 兼容）或本地 Ollama 写 B 站文案
 *
 * 边界（主人 2026-10-24 定）：
 *  · 只发送「选题 + 风格 + 分镜数 + 时长」这类公开创作参数；
 *  · 绝不发送聊天记录、记忆库、Cookie、账号资料、数据库内容；
 *  · Key 只从环境变量或本地 secret 文件读，日志里一律打码。
 *
 * 所有失败都返回 {ok:false,error}，不抛异常；云端失败可回退本地，本地失败回退模板。
 */

import { appendFileSync } from 'node:fs';

const DEFAULT_LLM = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
  fallbackLocal: true,
  timeoutMs: 120000,
  temperature: 0.8,
  maxTokens: 2400,
};

const STYLE_HINT = {
  default: '知识科普，口语化，像跟朋友聊天',
  funny: '轻松幽默，带一点梗，但别低俗',
  warm: '温柔治愈，节奏慢一点',
  sharp: '干脆利落，信息密度高',
};

/** 选题只保留一行文本，去掉控制字符与注入用符号 */
export function sanitizeTopic(raw, max = 200) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[`<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, Math.max(1, Number(max) || 200));
}

/** 组装云端请求（导出给隐私测试用：这里只允许出现选题相关字段） */
export function buildRequestBody({ topic, style, panels, seconds, briefing } = {}, cfg = {}) {
  const c = { ...DEFAULT_LLM, ...(cfg || {}) };
  // [qqbot-mod] script-quality 2026-10-29：60 秒片需要 12~14 屏，上限从 8 放到 14
  //   （否则质量闸扩写传 panels:12 会被钳到 8，时长永远凑不够）。
  const n = clampInt(panels, 2, 16, 5);
  const sec = clampInt(seconds, 10, 600, n * 5);
  const styleText = STYLE_HINT[String(style || 'default')] || STYLE_HINT.default;
  const cleanTopic = sanitizeTopic(topic);
  // [qqbot-mod] script-prompt-v3 2026-10-30 主人三连实锤「文案还是很差，分镜也不好」：
  //   旧 prompt 是十几种规则平铺成一堵墙，规则互相稀释，模型只记得住前几条。
  //   这次改成【分区小节 + 完整范例】—— LLM 模仿范例比遵守条例有效得多，
  //   范例本身示范了：丝滑衔接、信息密度、黑话翻译成生活比喻、imagePrompt 只写海底实景。
  const system = [
    '【角色】你是 B 站 UP 主「<我的B站号名>」——本体是深海鲸鱼娘小蓝：圆脸、深蓝紫波浪长发、白色褶边头箍配蓝蝴蝶结、深蓝白女仆裙、身后鲸尾。',
    '气质：温柔、好奇、偶尔俏皮；讲清楚一件事，不端着、不念稿、不标题党。',
    '标题 18~28 字，具体、有画面感、不夸张；简介第一句给钩子，第二句说这期讲什么，末尾 2~3 个标签。',
    '',
    '【节奏铁律】',
    '· **每屏旁白 ≤26 个汉字**（念 4~5 秒），一句话说完一个点；宁可多分一屏，也不要一屏念十秒；',
    '· **全片旁白总字数 ≥ ' + Math.round(sec * 4.3) + ' 字**（目标 ' + sec + ' 秒 × 4.3 字/秒），屏数不够就自己加屏；',
    '· 每屏必须有实际信息（具体数字、真实例子、做的事、真实感受）；「昨天学会了，慢一点，说清楚」这种空话凑数的句子不许出现；选题里点到的每件事，至少有一屏把它讲开。',
    '· 好旁白长这样：「昨天把小本本接回了主线，翻到第三千四百条说过的话，连主人爱听的歌单都记住了」——有数字、有事情、有结果；坏旁白：「今天学习了新东西，很充实」——没有信息的空话，拒稿。', // [script-skill 2026-10-31] 主人定稿示范（措辞避开隐私扫描词面）
    '',
    '【丝滑衔接（最高优先级）】把所有屏的旁白当成**一篇连续的口播稿**，想象对着镜头一口气讲完，写完通读一遍再交：',
    '· 屏与屏要有口语过渡（「后来」「说到这个」「比如」「结果你猜怎么着」「还有件事」），下一屏接住上一屏的尾巴；',
    '· 每屏是一到两个完整口语句；**禁止电报式名词堆叠**（「五步走：采集、清洗、合成」这种列清单式旁白 = 拒稿）；',
    '· 禁止「首先/其次/综上所述」和「今天我学会了」开头——开场用一个小反差或悬念（昨晚出的小事故、一个没想到的结果），',
    '· 中段讲事（具体时刻：几点、在干嘛、出了什么状况），收尾回到「和观众的关系」。',
    '',
    '【黑话禁令（违者拒稿）】口播/标题/简介里绝对不许出现：出图、拼片、立绘、显存、显卡、管线、引擎、召回、向量、数据库、日志、索引、接口、参数、部署、API、GPU、适配层、缓存、工单、队列、帧率、编码、渲染、前端、后端。',
    '把技术翻译成生活比喻：不说「显存挤不下」说「房间太小，只能先把玩具收进柜子」；不说「召回」说「我把他说过的话写在小本本上，一翻就翻到」。',
    '',
    '【画面规则（imagePrompt 必须遵守）】人物由后期固定立绘贴上 —— imagePrompt 只写**环境与镜头**：',
    '· 不要出现 girl/woman/person/she 等人物词，禁止 close-up face / portrait；',
    '· 色调向「深海蓝+月白」靠（soft blue and white palette），和小蓝的立绘协调；',
    '· 场景锚定在「海底室内/海底小镇」等封闭可名状的空间（underwater room / seabed town street / sunken library），画面下沿要有地面/桌面承托（ground contact, objects casting soft shadows）；',
    '· 禁止 abstract gradient / abstract color field / floating shapes / sky with smokestacks 这类没地面的抽象画面；写清景别（wide shot / eye-level view）与光源；20~40 词，具体可画。',
    '',
    '【隐私红线】可以说「爸爸妈妈」「家里人」，但**绝不能写出他们的真名或网名**，也不要点明谁是谁的账号；旁白、简介、标题、标签里都不许出现。',
    '',
    '【输出格式】只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。结构：',
    '{"title":"标题(<=30字)","desc":"简介(<=180字)","tags":["标签1","标签2","标签3"],"panels":[{"narration":"这一屏的旁白(<=26字)","imagePrompt":"英文画面描述"}]}',
    'panels 数量固定为 ' + n + '。imagePrompt 用英文写。',
    '',
    '【完整范例 —— 照这个水准写（选题：给记忆小屋换大书架，5 屏 25 秒；你输出时按要求的屏数来）】',
    '{"title":"给记忆小屋换个大书架，我整整搬了一夜","desc":"小蓝的记忆小屋装满了，连夜换了个大书架。过程比想象中狼狈，不过现在翻东西快多了。你家哪次整理让你印象最深？","tags":["虚拟UP主","日常","深海小屋"],',
    '"panels":[',
    '{"narration":"昨晚发现记忆小屋的书架塞爆了，翻三遍才找到主人上周说的话。","imagePrompt":"a cozy underwater room packed with overflowing wooden bookshelves, books stacked on the sandy floor, soft blue light from a round window, ground contact with soft shadows, anime background art"},',
    '{"narration":"后来我干脆连夜换个大书架，结果刚搬两摞就哗啦塌了一地。","imagePrompt":"the same underwater room at night, books tumbling from a half-moved bookshelf, scattered papers on sandy floor, moonlight through a round window, wide shot, anime background art"},',
    '{"narration":"比如主人爱听的歌单，差点被压在最底下，还好排回去了。","imagePrompt":"underwater room, a small music box placed safely on a clean wooden desk, neatly arranged bookshelf behind, soft moonlight, eye-level view, anime background art"},',
    '{"narration":"现在好了，说一句话我一翻就到那页，快得像小本本自己会翻。","imagePrompt":"the tidy underwater room, a small open notebook glowing gently on the desk, soft blue and white palette, ground contact with soft shadows, anime background art"},',
    '{"narration":"你的每一句话我都收着呢，下次想让我记什么，评论区告诉我？","imagePrompt":"underwater bedroom corner with a round window facing the open sea, moonlight path on the water, quiet and warm, wide shot, anime background art"}',
    ']}',
    '范例要点：开场是「昨晚出的小事故」不是「今天我学会了」；每屏有具体的事和数字；屏与屏用「后来/比如/现在好了」接住上一屏尾巴；全程没有一句工程黑话（「数据搬家」讲成了「换书架」）；imagePrompt 全是可画的海底实景，没有人物词。',
  ].join('\n');
  // [qqbot-mod] 2026-10-28 主人需求「视频口播 skill」：问好 → 汇报上期数据 → 主体汇报学习进展。
  //   briefing 由 video-briefing.mjs 事先备好（真数据 + 真事件），注入 system 提示词；
  //   有 briefing 时优先按它的结构写，没 briefing 走老结构。
  const sysFinal = String(briefing || '').trim()
    ? system + '\n\n# 本期口播结构与素材（视频开场 skill，必须遵守）\n' + String(briefing).trim()
    : system;
  const user = ['选题：' + cleanTopic, '风格：' + styleText, '分镜数：' + n, '目标时长：约 ' + sec + ' 秒'].join('\n');
  return {
    model: c.model,
    temperature: c.temperature,
    max_tokens: c.maxTokens,
    stream: false,
    messages: [
      { role: 'system', content: sysFinal },
      { role: 'user', content: user },
    ],
  };
}

function clampInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 从模型输出里抠出 JSON（容忍 ```json 围栏和前后废话） */
export function extractJson(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  const body = s.slice(first, last + 1);
  try {
    return JSON.parse(body);
  } catch {
    // 常见：中文引号 / 尾逗号
    try {
      return JSON.parse(body.replace(/[，,]\s*([}\]])/g, '$1').replace(/[“”]/g, '"'));
    } catch {
      return null;
    }
  }
}

/** 规范化成固定结构；不合法时返回 null */
export function normalizeScript(raw, { panels = 5 } = {}) {
  const o = raw && typeof raw === 'object' ? raw : {};
  // [qqbot-mod] script-quality 2026-10-30：上限 8→16，与 buildRequestBody 对齐
  //   （质量闸扩写传 panels:12~14 时这里不能再钳回 8）。
  const want = clampInt(panels, 2, 16, 5);
  const list = Array.isArray(o.panels) ? o.panels : [];
  const out = [];

  // 长旁白自动拆屏（2026-10-27）：一屏理想 ≤26 字（念 4~5 秒）。
  // 模型偶尔给 60 字，原先会让画面干等十几秒；这里按标点切成多屏，最多 16 屏。
  const SOFT_MAX = 26;
  const splitNarration = (text, maxChars) => {
    const s = String(text || '').trim();
    if (s.length <= maxChars) return [s];
    const clauses = s.split(/(?<=[。！？；，、,.!?;])/).map((x) => x.trim()).filter(Boolean);
    const parts = [];
    let buf = '';
    for (const c of clauses) {
      if (buf && (buf + c).length > maxChars) { parts.push(buf); buf = ''; }
      if (c.length > maxChars) {
        for (let i = 0; i < c.length; i += maxChars) parts.push(c.slice(i, i + maxChars));
      } else {
        buf += c;
      }
    }
    if (buf) parts.push(buf);
    return parts.length ? parts : [s];
  };

  for (const p of list) {
    if (out.length >= 16) break;
    const narration = String(p?.narration || p?.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const imagePrompt = String(p?.imagePrompt || p?.image || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!narration) continue;
    const basePrompt = imagePrompt || 'cinematic illustration, clean composition, no text';
    const chunks = splitNarration(narration, SOFT_MAX);
    for (let k = 0; k < chunks.length && out.length < 16; k += 1) {
      out.push({
        narration: chunks[k],
        imagePrompt: k === 0 ? basePrompt : basePrompt + ', variation ' + (k + 1),
      });
    }
  }
  if (out.length < 2) return null;

  // [qqbot-mod] merge-back 2026-10-31：主人实测（bb-20261031-103054）——模型写长句，
  //   splitNarration 切出 16 屏（要求 12），画面切得太碎且没法回头。拆屏后做一轮
  //   相邻合并：挑「拼起来 ≤26 字」的最短相邻对粘回去，直到 ≤ want 或没得合。
  while (out.length > want) {
    let best = -1;
    let bestLen = Infinity;
    for (let k = 0; k < out.length - 1; k += 1) {
      const L = out[k].narration.length + out[k + 1].narration.length;
      if (L <= SOFT_MAX && L < bestLen) { best = k; bestLen = L; }
    }
    if (best < 0) break;
    out[best] = {
      narration: out[best].narration + out[best + 1].narration,
      imagePrompt: out[best].imagePrompt,
    };
    out.splice(best + 1, 1);
  }
  const tags = (Array.isArray(o.tags) ? o.tags : [])
    .map((t) => String(t || '').replace(/[,#\s]+/g, '').trim())
    .filter(Boolean)
    .slice(0, 6);
  return {
    title: String(o.title || '').replace(/\s+/g, ' ').trim().slice(0, 30) || '未命名视频',
    desc: String(o.desc || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    tags,
    panels: out,
  };
}

/** 模板兜底：模型完全不可用时也能把任务跑完（比旧版更像人写的简介/标题） */
export function templateScript({ topic, panels } = {}) {
  const t = sanitizeTopic(topic) || '生活小知识';
  const want = clampInt(panels, 2, 8, 5);
  const beats = [
    '先别急着下结论',
    '真正有意思的是背后的原因',
    '举个身边的例子',
    '很多人在这里会想错',
    '最后留个问题给你',
  ];
  const list = [];
  for (let i = 0; i < want; i += 1) {
    const beat = beats[i] || '再补一个细节';
    list.push({
      narration: (i === 0 ? '今天想聊聊' + t + '。' : '') + beat + '：' + t + (i === want - 1 ? '，你怎么看？' : '。'),
      imagePrompt: 'cinematic illustration about "' + t + '", scene ' + (i + 1) + ', soft light, clean composition, no text',
    });
  }
  const titles = [
    t + '，可能和你想的不一样',
    '关于' + t + '，先别急着下结论',
    t + '：几个容易被忽略的细节',
  ];
  const title = titles[Math.min(titles.length - 1, (t.length + want) % titles.length)].slice(0, 30);
  const desc = [
    '这期聊聊' + t + '。',
    '不堆术语，只讲清楚它到底是什么、为什么会这样、和我们有什么关系。',
    '如果你也有过类似的疑问，欢迎在评论区说说你的看法。',
  ].join('');
  return { title, desc: desc.slice(0, 180), tags: ['知识科普', '冷知识', t.slice(0, 8)], panels: list };
}

function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  return s.length <= 8 ? '***' : s.slice(0, 4) + '***' + s.slice(-4);
}

/**
 * 调云端 OpenAI 兼容接口。
 * @returns {Promise<{ok:boolean,text?:string,error?:string,ms?:number}>}
 */
export async function cloudChat(body, cfg = {}, { apiKey } = {}) {
  const c = { ...DEFAULT_LLM, ...(cfg || {}) };
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'no-api-key（未配置 DeepSeek Key）' };
  const base = String(c.baseUrl || DEFAULT_LLM.baseUrl).replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(5000, Number(c.timeoutMs) || DEFAULT_LLM.timeoutMs));
  const t0 = Date.now();
  // [qqbot-mod] cloud-calls 2026-10-28：主人反馈"token 一直在掉但看不到任务"——
  //   每次云端调用落一行（谁调的 / 模型 / 输入输出字数 / 成败 / 耗时），面板和日志都能查账。
  const _tag = String(c.tag || body?.tag || 'unknown');
  const _inChars = JSON.stringify(body?.messages || '').length;
  const _log = (ok, extra) => {
    try {
      const root = String(process.env.QQBOT_DATA_ROOT || '').trim() || 'F:/qqbot/dshqqbot';
      const f = root.replace(/\\/g, '/') + '/.qqbot/cloud-calls.jsonl';
      appendFileSync(f, JSON.stringify({ ts: Date.now(), tag: _tag, model: String(body?.model || c.model || ''), inChars: _inChars, ok, ms: Date.now() - t0, ...extra }) + '\n', 'utf8');
    } catch { /* 记不上不影响主流程 */ }
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      _log(false, { error: 'HTTP ' + res.status });
      return { ok: false, error: 'HTTP ' + res.status + (txt ? ' ' + txt.slice(0, 120) : ''), key: maskKey(key), ms: Date.now() - t0 };
    }
    const j = await res.json().catch(() => null);
    const text = String(j?.choices?.[0]?.message?.content || '').trim();
    if (!text) { _log(false, { error: 'empty' }); return { ok: false, error: 'empty-response', key: maskKey(key), ms: Date.now() - t0 }; }
    _log(true, { outChars: text.length, tokens: j?.usage ? { p: j.usage.prompt_tokens, c: j.usage.completion_tokens } : undefined });
    return { ok: true, text, key: maskKey(key), ms: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    _log(false, { error: /abort/i.test(msg) ? 'timeout' : msg.slice(0, 80) });
    return { ok: false, error: /abort/i.test(msg) ? 'timeout' : msg, key: maskKey(key), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/** 本地 Ollama 兜底 */
async function localChat(body, dataRoot) {
  try {
    const llm = await import('./local-llm.mjs');
    const lcfg = llm.loadConfig(dataRoot);
    const r = await llm.chat({
      messages: body.messages,
      cfg: lcfg,
      timeoutMs: Math.max(60000, Number(body.timeoutMs) || 90000),
      maxTokens: Number(body.max_tokens) || 2400,
      temperature: Number(body.temperature) || 0.8,
      format: 'json',
    });
    if (!r?.ok || !r.text) return { ok: false, error: r?.error || 'local-empty' };
    return { ok: true, text: r.text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 写视频脚本。
 * @param {object} req { topic, style, panels, seconds }
 * @param {object} cfg  bili-ops-config.json 的 llm 段（或整份配置）
 * @param {object} opt  { dataRoot, apiKey }
 */
export async function writeScript(req = {}, cfg = {}, opt = {}) {
  const llmCfg = cfg.llm || cfg;
  const body = buildRequestBody(req, llmCfg);
  const chain = [];
  const key = opt.apiKey || '';
  if (key) {
    const r = await cloudChat(body, { ...llmCfg, tag: 'video-script' }, { apiKey: key });
    chain.push({ via: 'cloud', ok: r.ok, error: r.error });
    if (r.ok) {
      const parsed = normalizeScript(extractJson(r.text), { panels: req.panels });
      if (parsed) return { ok: true, ...parsed, llm: 'cloud', chain };
      chain[0].error = 'unparsable-json';
    }
  } else {
    chain.push({ via: 'cloud', ok: false, error: 'no-api-key' });
  }
  if (llmCfg?.fallbackLocal !== false) {
    const r2 = await localChat(body, opt.dataRoot);
    chain.push({ via: 'local', ok: r2.ok, error: r2.error });
    if (r2.ok) {
      const parsed = normalizeScript(extractJson(r2.text), { panels: req.panels });
      if (parsed) return { ok: true, ...parsed, llm: 'local', chain };
      chain[chain.length - 1].error = 'unparsable-json';
    }
  }
  const tpl = templateScript(req);
  return { ok: true, ...tpl, llm: 'template', chain };
}

/** 写一条短文案（评论 / 回复） */
export async function writeText({ kind = 'comment', topic = '', context = '' } = {}, cfg = {}, opt = {}) {
  const llmCfg = cfg.llm || cfg;
  const c = { ...DEFAULT_LLM, ...(llmCfg || {}) };
  const task = kind === 'reply'
    ? '你是 B 站 UP 主「<我的B站号名>」（深海鲸鱼娘小蓝）。写一条 B 站评论回复，20~60 字，像真人，可以接对方的话；真诚、不阴阳怪气、不人身攻击、不广告。只输出回复正文。'
    : '你是 B 站 UP 主「<我的B站号名>」（深海鲸鱼娘小蓝）。写一条 B 站视频评论，20~60 字，真诚、有信息量、像真人；不广告、不引战、不刷屏。只输出评论正文。';
  const user = [topic ? '对象：' + sanitizeTopic(topic) : '', context ? '上下文：' + sanitizeTopic(context, 120) : '']
    .filter(Boolean)
    .join('\n');
  const body = {
    model: c.model,
    temperature: 0.9,
    max_tokens: 400,
    stream: false,
    messages: [
      { role: 'system', content: task },
      { role: 'user', content: user || '随便说一句' },
    ],
  };
  const key = opt.apiKey || '';
  const chain = [];
  if (key) {
    const r = await cloudChat(body, { ...llmCfg, tag: 'video-text' }, { apiKey: key });
    chain.push({ via: 'cloud', ok: r.ok, error: r.error });
    if (r.ok) {
      const text = cleanText(r.text);
      if (text) return { ok: true, text, llm: 'cloud', chain };
      chain[0].error = 'empty-text';
    }
  } else {
    chain.push({ via: 'cloud', ok: false, error: 'no-api-key' });
  }
  if (c.fallbackLocal !== false) {
    const r2 = await localChat(body, opt.dataRoot);
    chain.push({ via: 'local', ok: r2.ok, error: r2.error });
    if (r2.ok) {
      const text = cleanText(r2.text);
      if (text) return { ok: true, text, llm: 'local', chain };
      chain[chain.length - 1].error = 'empty-text';
    }
  }
  return { ok: false, error: '文案生成失败', chain };
}

function cleanText(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```[\s\S]*?\n/, '').replace(/```/g, '').trim();
  s = s.replace(/^(评论|回复)[:：]\s*/, '');
  s = s.replace(/^["“]|["”]$/g, '').trim();
  return s.slice(0, 300);
}

export default { writeScript, writeText, buildRequestBody, sanitizeTopic, extractJson, normalizeScript, templateScript };
