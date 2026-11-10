/**
 * placeholder-text.mjs — 媒体占位标签 → 可读描述（桥接 / 入站 hook 共用口径）
 *
 * 背景：微信平板 WCX 推送未开时只能收到 `<type:sticker>` 这类裸标签，
 * 它们不是正文，绝不能原样进模型上下文。这里只做纯文本替换，不触网、不读文件。
 * 注意：wechat-bridge/event-classify.mjs 里有一份同样的映射（桥接是独立小包，
 * 不跨目录 import）；改这里时两边保持同步。
 */
export const TYPE_LABELS = {
  sticker: '对方发来一个表情',
  image: '对方发来一张图片',
  red_packet: '对方发来一个红包',
  system: '系统消息',
  file: '对方发来一个文件',
  voice: '对方发来一条语音',
  video: '对方发来一个视频',
  link: '对方分享了一个链接',
};

/**
 * 把文本里的 `<type:xxx>` 换成一句人话；未知类型删掉。
 * 全是未知标签时给一句兜底描述，保证不会返回空串。
 */
export function normalizeTypeTags(text) {
  const raw = String(text == null ? '' : text);
  let hit = false;
  const out = raw
    .replace(/<type\s*:\s*([a-z0-9_-]+)\s*>/gi, (_m, key) => {
      hit = true;
      return TYPE_LABELS[String(key || '').toLowerCase()] || '';
    })
    .replace(/[ \t\u3000]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (hit && !out) return '对方发来一条暂不支持的消息';
  return out;
}

/** 归一后仍是原始 XML 片段的，直接当“看不到内容的消息”处理，别让 XML 进上下文 */
export function readableFallback(text) {
  const s = normalizeTypeTags(text);
  if (!s) return '对方发来一条暂不支持的消息';
  return /^\s*</.test(s) ? '对方发来一条消息（暂时看不到内容）' : s;
}
