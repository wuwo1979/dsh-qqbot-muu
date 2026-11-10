/**
 * lib/sticker-schema.mjs — 表情包标签统一 schema（v2）
 *
 * 为什么要有它：
 *   index.json 里的 tags 一直是一串自由词（"无语"、"肥鱼思考"、"笑死我了"），
 *   检索只能整串模糊匹配；模型挑图时又得吃完整 desc，既慢又费 token。
 *
 * v2 把标签拆成五个面（一图多标签，互相正交）：
 *   emotion  情绪：无语 / 大笑 / 委屈……
 *   scene    场景：群聊 / 工作 / 吃饭……
 *   action   动作：挥手 / 躺 / 思考……
 *   intensity 强度：low(轻) / mid(中) / high(强)
 *   platform 平台：qq / wechat / both
 *
 * 兼容策略：
 *   · 老数据（只有 tags/desc）用 deriveFacets() 自动推导，不丢原标签；
 *   · 写标签统一走 applyTagSchema()，tags 会被拍平成 schema 词表，facets 单独存；
 *   · facetsOf() 每次校验 facetSource，插件侧改了 tags 也会自动重新推导；
 *   · 新增词只加在词表/映射里，不改调用方。
 */

export const SCHEMA_VERSION = 2;

export const EMOTIONS = [
  '开心', '大笑', '笑哭', '无语', '尴尬', '委屈', '难过', '生气', '惊讶', '震惊',
  '害怕', '累', '躺平', '得意', '疑惑', '吃瓜', '害羞', '可爱', '拒绝', '赞同',
  '加油', '期待', '心疼', '敷衍', '摸鱼', '慌张', '社死', '无奈', '思考', '庆祝',
  '晚安', '嫌弃', '馋', '困',
];

export const SCENES = [
  '日常', '群聊', '私聊', '工作', '学习', '吃饭', '睡觉', '打招呼', '告别',
  '庆祝', '安慰', '吐槽', '求助', '道歉', '邀约', '摸鱼', '深夜', '节日',
];

export const ACTIONS = [
  '挥手', '点头', '摇头', '拥抱', '摸头', '吃饭', '睡觉', '思考', '指', '跑',
  '跳', '举', '躺', '坐', '哭', '笑', '说话', '拎起', '换装', '唱歌', '跳舞',
  '玩', '喷水',
];

/** 强度：对外只用 low/mid/high，展示时给中文短标签 */
export const INTENSITY = { low: '轻', mid: '中', high: '强' };
/** 平台：both = QQ/微信都能用 */
export const PLATFORM = { qq: 'QQ', wechat: '微信', both: '通用' };

const EMOTION_RULES = [
  [/笑哭|笑到流泪|笑出眼泪/, '笑哭'],
  [/开心|高兴|愉快|笑容|微笑|有趣|好玩|温馨|和谐/, '开心'],
  [/笑死|笑不活|哈哈哈|大笑|狂笑|爆笑/, '大笑'],
  [/无语|服了|离谱|沉默|汗颜|扶额/, '无语'],
  [/社死|尴尬|窘/, '尴尬'],
  [/委屈|心酸|想哭|鼻酸/, '委屈'],
  [/难过|伤心|低落|破防|泪目/, '难过'],
  [/生气|愤怒|气死|炸毛|恼火/, '生气'],
  [/震惊|裂开|惊呆|卧槽|wtf|天啊/, '震惊'],
  [/惊讶|吃惊|真的假的|难以置信/, '惊讶'],
  [/害怕|吓|恐惧|瑟瑟|怂/, '害怕'],
  [/心累|疲惫|累瘫|累了|困|熬夜/, '累'],
  [/躺平|摆烂|咸鱼/, '躺平'],
  [/得意|骄傲|嚣张|最强|牛啊|飘了/, '得意'],
  [/疑惑|问号|不懂|迷茫|啥/, '疑惑'],
  [/吃瓜|围观|看戏/, '吃瓜'],
  [/害羞|脸红|羞涩|捂脸|不好意思/, '害羞'],
  [/可爱|萌|软乎乎|乖巧/, '可爱'],
  [/拒绝|达咩|不要|不行|婉拒/, '拒绝'],
  [/赞同|同意|可以|赞成|好耶|支持/, '赞同'],
  [/加油|冲鸭|fighting|鼓励/, '加油'],
  [/期待|等不及|想吃|盼/, '期待'],
  [/心疼|抱抱|安慰|摸摸/, '心疼'],
  [/敷衍|随便|糊弄|哦哦/, '敷衍'],
  [/摸鱼|偷懒|划水/, '摸鱼'],
  [/慌张|慌了|急|手忙脚乱/, '慌张'],
  [/无奈|摊手|没辙|算了/, '无奈'],
  [/思考|专注|托腮|想事情/, '思考'],
  [/庆祝|恭喜|生日快乐|干杯|撒花/, '庆祝'],
  [/晚安|睡了|睡觉|被窝/, '晚安'],
  [/嫌弃|白眼|鄙视|无语子/, '嫌弃'],
  [/馋|流口水|想吃/, '馋'],
  [/打哈欠|犯困|困倦/, '困'],
];

const SCENE_RULES = [
  [/群聊|群里|群友|场合|大家/, '群聊'],
  [/私聊|一对一|单独说/, '私聊'],
  [/工作|写代码|加班|上班|开会|摸鱼写/, '工作'],
  [/学习|考试|作业|复习|上课/, '学习'],
  [/吃饭|午餐|晚餐|早餐|火锅|零食|宵夜/, '吃饭'],
  [/睡觉|晚安|被窝|熬夜|打哈欠/, '睡觉'],
  [/打招呼|你好|嗨|早上好|在吗/, '打招呼'],
  [/再见|拜拜|走了|下线/, '告别'],
  [/庆祝|恭喜|生日快乐|干杯|红包|撒花/, '庆祝'],
  [/安慰|抱抱|难过|委屈|别哭/, '安慰'],
  [/吐槽|无语|离谱|服了|吐槽/, '吐槽'],
  [/求助|帮忙|救命|怎么办|求/, '求助'],
  [/道歉|对不起|抱歉|我的错/, '道歉'],
  [/邀约|一起|来玩|组队|约/, '邀约'],
  [/摸鱼|摆烂|躺平|偷懒/, '摸鱼'],
  [/深夜|凌晨|半夜/, '深夜'],
  [/节日|中秋|春节|圣诞|端午|新年|元宵/, '节日'],
];

const ACTION_RULES = [
  [/挥手|招手|拜拜|打招呼/, '挥手'],
  [/点头|认可/, '点头'],
  [/摇头|拒绝/, '摇头'],
  [/拥抱|抱抱|贴贴|抱住/, '拥抱'],
  [/摸头|揉头/, '摸头'],
  [/吃饭|啃|喝|吃/, '吃饭'],
  [/睡觉|躺|被窝|闭眼/, '睡觉'],
  [/思考|托腮|专注|想/, '思考'],
  [/指向|指着|指/, '指'],
  [/跑|逃跑|冲刺/, '跑'],
  [/跳|蹦|跃/, '跳'],
  [/举手|欢呼|举起/, '举'],
  [/躺|瘫|趴/, '躺'],
  [/坐|坐下/, '坐'],
  [/哭|流泪|泪/, '哭'],
  [/笑|哈哈|咧嘴/, '笑'],
  [/说话|聊天|讲|开口/, '说话'],
  [/拎|抓|悬空|被鼠标/, '拎起'],
  [/换装|试衣|打扮|换衣服/, '换装'],
  [/唱|哼歌|鲸歌/, '唱歌'],
  [/舞|跳舞|摇摆/, '跳舞'],
  [/玩游戏|玩具|摸鱼|玩/, '玩'],
  [/喷水|吐泡泡|水枪/, '喷水'],
];

/** 近义情绪组：query 字面没命中时，按同组标签兜底召回（只在地板场景使用） */
export const EMOTION_RELATED = {
  震惊: ['震惊', '惊讶'], 惊讶: ['惊讶', '震惊'],
  开心: ['开心', '大笑', '笑哭'], 大笑: ['大笑', '开心', '笑哭'],
  累: ['累', '困', '躺平'], 困: ['困', '累', '晚安'],
  难过: ['难过', '委屈', '心疼'], 委屈: ['委屈', '难过', '心疼'],
  生气: ['生气', '嫌弃', '拒绝'], 无语: ['无语', '无奈', '尴尬'],
  摸鱼: ['摸鱼', '躺平', '累'], 躺平: ['躺平', '摸鱼', '累'],
  加油: ['加油', '期待', '赞同'], 期待: ['期待', '开心', '加油'],
};

/** 查近义词组；认不出返回空数组 */
export function relatedEmotions(term) {
  const t = String(term || '').trim();
  if (EMOTION_RELATED[t]) return EMOTION_RELATED[t];
  const canon = canonFacet(t, 'emotion');
  return canon && EMOTION_RELATED[canon] ? EMOTION_RELATED[canon] : [];
}

const HIGH_CUES = /震惊|爆|疯狂|超|巨|非常|狂|炸|笑死|大哭|大怒|极度|最强|离谱|裂开/;
const LOW_CUES = /微微|轻轻|一点|稍微|小声|弱|淡淡/;

const PLATFORM_ALIAS = {
  qq: 'qq', QQ: 'qq', 扣扣: 'qq',
  wechat: 'wechat', wx: 'wechat', weixin: 'wechat', 微信: 'wechat',
  both: 'both', all: 'both', 通用: 'both', 双端: 'both',
};

const INTENSITY_ALIAS = {
  low: 'low', 低: 'low', 轻: 'low', 弱: 'low',
  mid: 'mid', 中: 'mid', 中等: 'mid', medium: 'mid',
  high: 'high', 高: 'high', 强: 'high', 重: 'high',
};

function listOf(v) {
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,，、/|]/).map((x) => x.trim()).filter(Boolean);
  return [];
}

export function uniq(list, max = 16) {
  const out = [];
  const seen = new Set();
  for (const x of listOf(list)) {
    const k = x.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

/** 把同义词收口到词表；认不出就返回 ''（由调用方当自由标签保留） */
export function canonFacet(value, facet) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const vocab = { emotion: EMOTIONS, scene: SCENES, action: ACTIONS }[facet] || [];
  if (vocab.includes(raw)) return raw;
  const rule = ({ emotion: EMOTION_RULES, scene: SCENE_RULES, action: ACTION_RULES }[facet] || [])
    .find(([re]) => re.test(raw));
  return rule ? rule[1] : '';
}

function textOf(item) {
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  return [
    ...tags,
    item?.desc, item?.descZh, item?.descShort, item?.note, item?.msgText,
  ].filter(Boolean).join(' ');
}

function deriveOne(text, rules, max) {
  const out = [];
  for (const [re, canon] of rules) {
    if (re.test(text) && !out.includes(canon)) out.push(canon);
    if (out.length >= max) break;
  }
  return out;
}

/** 从现有 tags/desc 推导 facets（纯函数，不读写文件） */
export function deriveFacets(item) {
  const text = textOf(item);
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  // 先按词表认标签（"开心"这种整词不一定能被正则覆盖），再用描述兜底
  const tagFacet = (facet) => tags.map((x) => canonFacet(x, facet)).filter(Boolean);
  const emotion = uniq([...deriveOne(text, EMOTION_RULES, 4), ...tagFacet('emotion')], 4);
  const scene = uniq([...deriveOne(text, SCENE_RULES, 3), ...tagFacet('scene')], 3);
  const action = uniq([...deriveOne(text, ACTION_RULES, 2), ...tagFacet('action')], 2);
  const intensity = HIGH_CUES.test(text) ? 'high' : (LOW_CUES.test(text) ? 'low' : 'mid');
  let platform = 'both';
  if (item?.facets?.platform) platform = canonPlatform(item.facets.platform);
  else if (item?.platform) platform = canonPlatform(item.platform);
  return {
    emotion,
    scene: scene.length ? scene : ['日常'],
    action,
    intensity,
    platform,
  };
}

function hashText(s) {
  let h = 5381;
  const t = String(s || '');
  for (let i = 0; i < t.length; i += 1) h = ((h << 5) + h + t.charCodeAt(i)) & 0x7fffffff;
  return String(h);
}

export function sourceKeyOf(item) {
  const tags = Array.isArray(item?.tags) ? item.tags.join('|') : '';
  return hashText(tags + '#' + (item?.desc || '') + '#' + (item?.descZh || ''));
}

/**
 * 读条目的 facets：schema v2 且来源没变就用存好的，否则现推。
 * 这样插件自带的 sticker_tag 改了 tags，扩展侧也能立刻看到新语义。
 */
export function facetsOf(item) {
  if (!item || typeof item !== 'object') return deriveFacets({});
  const f = item.facets;
  if (
    item.tagSchema === SCHEMA_VERSION
    && f && Array.isArray(f.emotion) && Array.isArray(f.scene) && Array.isArray(f.action)
    && f.intensity && f.platform
    && item.facetSource === sourceKeyOf(item)
  ) return f;
  return deriveFacets(item);
}

export function facetText(item) {
  const f = facetsOf(item);
  return [...f.emotion, ...f.scene, ...f.action, INTENSITY[f.intensity] || ''].filter(Boolean).join(' ');
}

/** 给模型看的极短标签（≤ max 字符），不塞 desc、不塞路径 */
export function shortTagline(item, max = 18) {
  const f = facetsOf(item);
  const head = f.emotion.slice(0, 2).join('/') || f.scene[0] || f.action[0] || '日常';
  const bits = [head];
  const scene = f.scene.find((x) => !head.includes(x));
  if (scene && scene !== '日常') bits.push(scene);
  const action = f.action.find((x) => !head.includes(x) && x !== scene);
  if (action) bits.push(action);
  if (f.intensity === 'high') bits.push('强');
  let s = bits.join('·');
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function canonPlatform(v) {
  const raw = String(v || '').trim();
  return PLATFORM_ALIAS[raw] || PLATFORM_ALIAS[raw.toLowerCase()] || 'both';
}

function canonIntensity(v) {
  const raw = String(v || '').trim();
  return INTENSITY_ALIAS[raw] || INTENSITY_ALIAS[raw.toLowerCase()] || '';
}

/** 入参 facets 归一化；认不出的情绪/场景/动作词退回自由标签，不丢信息 */
export function normalizeFacetInput(patch = {}) {
  const labels = [];
  const out = { emotion: [], scene: [], action: [], intensity: '', platform: '' };
  for (const facet of ['emotion', 'scene', 'action']) {
    for (const x of listOf(patch[facet])) {
      const c = canonFacet(x, facet);
      if (c) out[facet].push(c);
      else labels.push(x);
    }
    out[facet] = uniq(out[facet], facet === 'emotion' ? 4 : 3);
  }
  if (patch.intensity) out.intensity = canonIntensity(patch.intensity);
  if (patch.platform) out.platform = canonPlatform(patch.platform);
  return { facets: out, labels: uniq(labels, 12) };
}

/**
 * 统一写标签入口：把自由标签 + 五面标签写回条目。
 * @param {object} item  index.json 里的条目（原地改）
 * @param {object} patch {emotion,scene,action,intensity,platform,labels,tags,merge}
 */
export function applyTagSchema(item, patch = {}) {
  const merged = patch.merge !== false;
  const base = merged ? facetsOf(item) : { emotion: [], scene: [], action: [], intensity: 'mid', platform: 'both' };
  const { facets: input, labels } = normalizeFacetInput(patch);
  const facets = {
    emotion: uniq([...(base.emotion || []), ...input.emotion], 5),
    scene: uniq([...(base.scene || []), ...input.scene], 4),
    action: uniq([...(base.action || []), ...input.action], 3),
    intensity: input.intensity || base.intensity || 'mid',
    platform: input.platform || base.platform || 'both',
  };
  const legacy = [
    ...(Array.isArray(item.tags) ? item.tags : []),
    ...listOf(patch.tags),
    ...labels,
    ...facets.emotion, ...facets.scene, ...facets.action,
  ];
  item.tags = uniq(legacy, 16);
  item.facets = facets;
  item.tagSchema = SCHEMA_VERSION;
  item.facetSource = sourceKeyOf(item);
  item.tagUpdatedAt = Date.now();
  return item;
}

/** 组合过滤：facets 之间 AND，同一 facet 内 OR（命中任意一个即可） */
export function facetFilterMatch(item, filter = {}) {
  if (!filter || typeof filter !== 'object') return true;
  const f = facetsOf(item);
  const want = filter.platform ? canonPlatform(filter.platform) : '';
  if (want && want !== 'both' && f.platform !== 'both' && f.platform !== want) return false;
  for (const facet of ['emotion', 'scene', 'action']) {
    const terms = listOf(filter[facet]).map((x) => canonFacet(x, facet) || x);
    if (terms.length && !terms.some((x) => f[facet].includes(x))) return false;
  }
  if (filter.intensity) {
    const wantInt = canonIntensity(filter.intensity);
    const min = canonIntensity(filter.minIntensity);
    if (wantInt && f.intensity !== wantInt) return false;
    if (min) {
      const rank = { low: 0, mid: 1, high: 2 };
      if (rank[f.intensity] < rank[min]) return false;
    }
  }
  return true;
}

export function validateEntry(item) {
  const errors = [];
  if (!item || typeof item !== 'object') return { ok: false, errors: ['条目不是对象'] };
  if (!String(item.id || '').trim()) errors.push('缺 id');
  if (!String(item.layer || '').trim()) errors.push('缺 layer');
  if (!/^(jpe?g|png|gif|webp)$/i.test(String(item.ext || ''))) errors.push('ext 不合法');
  const f = facetsOf(item);
  if (!Array.isArray(f.emotion) || !Array.isArray(f.scene) || !Array.isArray(f.action)) errors.push('facets 结构不合法');
  if (!INTENSITY[f.intensity]) errors.push(`intensity 不合法：${f.intensity}`);
  if (!PLATFORM[f.platform]) errors.push(`platform 不合法：${f.platform}`);
  if (item.tagSchema !== SCHEMA_VERSION) errors.push(`tagSchema 不是 v${SCHEMA_VERSION}`);
  return { ok: errors.length === 0, errors };
}

/** 库级审计：覆盖率、重复（dhash）、缺图 */
export function auditItems(items = []) {
  const total = items.length;
  let tagged = 0;
  let described = 0;
  const emotion = { any: 0 };
  const scene = { any: 0 };
  const action = { any: 0 };
  const intensity = { low: 0, mid: 0, high: 0 };
  const platform = { qq: 0, wechat: 0, both: 0 };
  const byDhash = new Map();
  const byId = new Set();
  let dupes = 0;
  let missingSchema = 0;

  for (const it of items) {
    if (Array.isArray(it?.tags) && it.tags.length) tagged += 1;
    if (it?.desc || it?.descZh) described += 1;
    const f = facetsOf(it);
    if (f.emotion.length) emotion.any += 1;
    for (const x of f.emotion) emotion[x] = (emotion[x] || 0) + 1;
    if (f.scene.length) scene.any += 1;
    for (const x of f.scene) scene[x] = (scene[x] || 0) + 1;
    if (f.action.length) action.any += 1;
    for (const x of f.action) action[x] = (action[x] || 0) + 1;
    intensity[f.intensity] = (intensity[f.intensity] || 0) + 1;
    platform[f.platform] = (platform[f.platform] || 0) + 1;
    if (it?.dhash) {
      const n = byDhash.get(it.dhash) || 0;
      byDhash.set(it.dhash, n + 1);
      if (n === 1) dupes += 1;
    }
    if (String(it?.id || '') && byId.has(String(it.id))) dupes += 1;
    else if (it?.id) byId.add(String(it.id));
    if (it?.tagSchema !== SCHEMA_VERSION) missingSchema += 1;
  }

  return {
    total, tagged, described,
    emotionCoverage: total ? Math.round((emotion.any / total) * 100) : 0,
    sceneCoverage: total ? Math.round((scene.any / total) * 100) : 0,
    actionCoverage: total ? Math.round((action.any / total) * 100) : 0,
    intensity, platform, dupes, missingSchema,
    topEmotion: Object.entries(emotion).filter(([k]) => k !== 'any').sort((a, b) => b[1] - a[1]).slice(0, 8),
    topScene: Object.entries(scene).filter(([k]) => k !== 'any').sort((a, b) => b[1] - a[1]).slice(0, 8),
    topAction: Object.entries(action).filter(([k]) => k !== 'any').sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

export default {
  SCHEMA_VERSION, EMOTIONS, SCENES, ACTIONS, INTENSITY, PLATFORM,
  deriveFacets, facetsOf, applyTagSchema, facetFilterMatch, shortTagline,
  validateEntry, auditItems, normalizeFacetInput, sourceKeyOf, facetText,
};
