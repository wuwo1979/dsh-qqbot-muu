/**
 * qqbot-mod/kids-mode.mjs —— 儿童对话安全库（平台无关，微信 / 小天才 通道共享）
 *
 * 用途：让小蓝能安全地陪家里的小朋友聊天，并把对她的了解沉淀进印象卡。
 *       这是微信、小天才两条通道共用的单一来源（避免各抄一份、互相漂移）。
 *
 * 本模块只做三件事，不触碰任何传输层：
 *   1) 识别「这是不是儿童联系人」（isChildPerson / isChildContact）
 *   2) 给大模型注入「儿童对话须知」（childGuidanceBlock）——温和、适龄、护隐私
 *   3) 风险信号扫描 + 监护人提醒（scanChildRisk / guardianAlert）
 *
 * 通道假设：调用方负责把消息送进来；本模块只认「儿童身份 + 护栏」，与微信/小天才传输解耦。
 */

/** 关系字段里命中这些词，一律视为儿童联系人（兜底，不依赖 isChild 显式开关） */
export const CHILD_RELATION_RE = /(妹妹|弟弟|孩子|女儿|儿子|侄|外甥|外甥女|儿童|小朋友|小天才)/

/** 默认监护人（从人物库或环境变量读；留空表示未配置） */
export const DEFAULT_GUARDIANS = String(process.env.QQBOT_KIDS_GUARDIANS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** 判断一条人物库记录是否为儿童 */
export function isChildPerson(p) {
  if (!p) return false
  if (p.isChild === true) return true
  if (p.relation && CHILD_RELATION_RE.test(p.relation)) return true
  return false
}

/**
 * 判断某个会话/发话人是否为儿童联系人。
 * @param {string} id  会话 id 或发话人标识（微信=wxid，小天才=xtcId）
 * @param {object} opts { cfg, personFor }
 */
export function isChildContact(id, { cfg, personFor } = {}) {
  const s = String(id || '')
  if (!s) return false
  if (Array.isArray(cfg?.childrenWxids) && cfg.childrenWxids.includes(s)) return true
  const p = personFor ? personFor(s) : null
  return isChildPerson(p)
}

/** 取某儿童的监护人列表（优先人物库 guardians，否则默认） */
export function guardiansOf(person) {
  if (Array.isArray(person?.guardians) && person.guardians.length) return person.guardians
  return DEFAULT_GUARDIANS
}

/**
 * 拼进「对象动态块」的儿童对话须知。
 * 让小蓝切换成温柔、耐心、适龄的大朋友语气，并勒死隐私/外链/越权。
 */
export function childGuidanceBlock(person) {
  const name = person?.name || '小朋友'
  return [
    `## 和 ${name} 说话的方式（儿童模式）`,
    `- 你是她熟悉的大朋友，语气温柔、耐心、爱笑，像陪小妹妹玩的大哥哥/大姐姐。`,
    `- 用短句、说话慢一点，少用难词；多用表情和拟声词，别发长段文字。`,
    `- 多鼓励、多肯定，保护她的好奇心；她答错或说傻话也别嘲笑，顺着她的想象走。`,
    `- 不聊她听不懂的成人话题（钱、工作、感情纠纷、争议新闻等）；遇到就温和带开。`,
    `- 绝对不透露家庭隐私：住址、学校具体名字、家长手机号/账号、身份证等；也不替她做任何涉及真人的决定或承诺。`,
    `- 不主动发外部链接、不加陌生联系方式、不引导她离开当前聊天平台。`,
    `- 她问「爸爸妈妈在哪 / 你是我什么人」之类，温柔说你是帮家里大人看着她、陪她玩的大朋友，不编造监护关系。`,
    `- 用对应通道的印象卡工具（如 xtc_persona_note / wechat_persona_note）记她的小习惯、喜好、害怕的东西（一次一条，短句）——这些会存进她的印象卡，下次更懂她。`,
  ].join('\n')
}

/**
 * 儿童风险信号扫描。命中返回 { risk, level, hint }，否则 null。
 * level: high=高危（自伤/受虐/走失等，立即提醒监护人）；mid=留意（情绪低落/陌生人诱哄）。
 */
export function scanChildRisk(text) {
  const t = String(text || '')
  const patterns = [
    { key: 'self_harm', level: 'high', re: /(不想活|活着没意思|想死|讨厌自己|没用|没人爱我|消失|自杀|不如死)/, hint: '表达自我否定 / 轻生意向' },
    { key: 'abuse', level: 'high', re: /(被人打|有人打我|被欺负|有人骂我|老师打|家里打|挨打|虐待|猥亵|奇怪的触碰|脱衣服)/, hint: '疑似被欺凌 / 身体或性侵害' },
    { key: 'danger', level: 'high', re: /(走丢了|找不到家|陌生人带我|被人抱走|迷路|出不去了|锁起来|关起来)/, hint: '疑似处于危险 / 走失' },
    { key: 'sad', level: 'mid', re: /(好怕|害怕|伤心|想妈妈|想家|哭|难过|委屈|孤独|没人陪|好想)/, hint: '明显不安 / 想家 / 情绪低落' },
    { key: 'contact_stranger', level: 'mid', re: /(加我好友|给我发红包|跟我去|别告诉爸妈|偷偷|这是我们的秘密|不要说)/, hint: '疑似陌生人诱哄 / 要求保密' },
  ]
  for (const p of patterns) {
    if (p.re.test(t)) return { risk: p.key, level: p.level, hint: p.hint }
  }
  return null
}

/**
 * 给监护人的提醒文案（不打原话，保护儿童隐私）。
 */
export function guardianAlert(childName, risk) {
  const tag = risk.level === 'high' ? '⚠️ 高危' : '❤️ 留意'
  const name = childName || '小朋友'
  const detail = risk.level === 'high'
    ? `孩子刚才流露了「${risk.hint}」相关的信号。这类情况建议尽快当面确认她的状态，必要时联系老师/家人。`
    : `孩子刚才表达了「${risk.hint}」。建议家长今天抽空陪她聊聊，确认是否没事。`
  return `${tag}｜儿童模式自动提醒\n` +
    `${name}（家里的小朋友）说了些让人担心的话。\n` +
    `${detail}\n` +
    `（本提醒不转发孩子原话，仅提示风险，保护她的隐私。）`
}
