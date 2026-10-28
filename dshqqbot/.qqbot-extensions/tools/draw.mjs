/**
 * tools/draw.mjs — 工具 `draw`：本地文生图（sd-turbo）
 *
 * 定位：**只有人明确叫她画**才用（"画一张…""给我画个…"），不主动刷图。
 * 链路：中文 prompt →（本地 Ollama 翻成英文）→ 常驻 SD 服务出图 → caps.image 直发
 *
 * 为什么直发：工具返回的文字模型还要再组织一遍，容易变成"我画好了（图片描述…）"却不真的发图；
 * caps.image 带的是本回合真 replyTarget，发出去就完事，返回体只留一句"已发"。
 */
import { loadConfig, draw, translatePrompt, status, dataRootOf } from '../lib/draw-core.mjs';

export const name = 'draw';

export const description =
  '画一张图并发到当前会话（本地 SD1.5，512px，约 5 秒；有人明确要求画图/画画时才用）。' +
  '画她自己的时候，prompt 里带上外形：圆脸、深蓝紫波浪长发、白色褶边头箍配蓝蝴蝶结、深蓝白女仆裙、身后鲸尾。';

export const inputSchema = {
  prompt: { type: 'string', required: true, description: '想画什么（中文就行，会翻成英文）' },
  size: { type: 'string', enum: ['square', 'wide', 'tall'], description: '画幅：square 方/wide 横/tall 竖（默认 square）' },
};

const SIZES = {
  square: { width: 512, height: 512 },
  wide: { width: 640, height: 384 },
  tall: { width: 384, height: 640 },
};

async function sendImage(env, path) {
  const caps = env?.caps;
  if (!caps) return { sent: false, why: '没有 caps（宿主没给能力包）' };
  try {
    if (typeof caps.image === 'function') {
      const r = await caps.image(path);
      if (r !== false) return { sent: true, how: 'caps.image' };
    }
  } catch (e) {
    return { sent: false, why: 'caps.image 抛错: ' + (e instanceof Error ? e.message : String(e)) };
  }
  try {
    if (typeof caps.media === 'function') {
      const r = await caps.media('image', path);
      if (r !== false) return { sent: true, how: "caps.media('image')" };
    }
  } catch (e) {
    return { sent: false, why: 'caps.media 抛错: ' + (e instanceof Error ? e.message : String(e)) };
  }
  return { sent: false, why: 'caps.image 返回 false（sender/目标缺失或上传失败）' };
}

export async function run(args, env) {
  const root = String(env?.caps?.dataRoot || process.env.QQBOT_MEMORY_DATA_ROOT || 'F:/qqbot/dshqqbot');
  const cfg = loadConfig(root);

  if (cfg.enabled === false) {
    return { ok: false, error: '画画功能关着（draw-config.json 的 enabled=false）' };
  }

  const prompt0 = String(args?.prompt || '').trim();
  if (!prompt0) return { ok: false, error: 'prompt 不能为空' };
  if (prompt0.length > 300) return { ok: false, error: 'prompt 太长了（≤300 字）' };

  const sizeKey = String(args?.size || 'square');
  const size = SIZES[sizeKey] || SIZES.square;

  // 中文 → 英文（sd-turbo 的文本编码器只认英文）
  let prompt = prompt0;
  let translated = false;
  const isZh = /[\u4e00-\u9fa5]/.test(prompt0);
  try {
    const tr = await translatePrompt(prompt0, cfg);
    if (tr.ok && tr.prompt) {
      prompt = tr.prompt;
      translated = tr.translated === true;
    } else if (isZh) {
      // 翻译不出来就别硬画：中文喂给 sd-turbo 只会出一张糊图，白烧 2 秒 + 显存
      return {
        ok: false,
        error: '中文描述没能翻成英文，画不出来（' + (tr.reason || '?') + '）',
        hint: '让她换个更具体的说法（"画一个戴帽子的鲸鱼娘"），或者直接用英文短句描述；别硬画，硬画出来的图是糊的。',
      };
    }
  } catch { /* 翻译抛错就用原文 */ }

  const r = await draw(prompt, { width: size.width, height: size.height }, cfg);
  if (!r.ok) {
    const st = await status(cfg);
    return {
      ok: false,
      error: '出图失败：' + (r.reason || '?'),
      hint: st.up
        ? '服务在但没画出来：看一眼 python 那边（显存不足？模型目录不对？）'
        : '本地出图服务没起来：跑 `node qqbot-mod/scripts/draw-selftest.mjs` 看看是 python 缺依赖还是模型没下',
    };
  }

  const sent = await sendImage(env, r.path);
  return {
    ok: true,
    sent: sent.sent,
    path: r.path,
    ms: r.ms,
    seed: r.seed,
    bytes: r.bytes,
    prompt: translated ? prompt : undefined,
    msg: sent.sent
      ? `画好了，已经发到群里（${r.ms}ms，${r.bytes ? Math.round(r.bytes / 1024) + 'KB' : '已保存'}）—— 别再重复描述这张图，正常说一句话就行`
      : `画好了但没发出去（${sent.why}），图片在 ${r.path}；可以说一句"画好啦"并把路径带上用 [MEDIA:image|路径] 发`,
  };
}

export default { name, description, inputSchema, run, expose: 'all' };
