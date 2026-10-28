/**
 * voice.mjs — 让她"用嘴说话"（主动发语音条）
 *
 * 平时出站扩展会按概率自动把短回复转成语音；
 * 这个工具给她**自主权**：想专门念一句的时候自己调。
 *
 * ★ 2026-10-23 第二次修（真机第二次打我脸）：
 *   第一版改成"合成 → 排发件箱 → 出站 turnEnd 补发"，结果线上队列里躺着 2 条
 *   永远没人取（`{dataRoot}/.qqbot/voice-queue.json` mtime 停在 08:25）——
 *   说明 **turnEnd 那一跳并不可靠**（回合异常/会话复用失败时根本跑不到）。
 *
 *   第二版：工具被调用时宿主已经塞了 `env.caps`
 *   （`dist/channel-tools.js:3096-3119` 用 makeExtCaps 构造，内部持有
 *    **本回合真的 sender + replyTarget**），所以 `await env.caps.voice(path)`
 *   是**当场发、发对地方、不依赖任何后续钩子**的正解。
 *   只有在 caps 缺失或直发失败（返回 false / 抛错）时，才退回发件箱兜底。
 *
 *   ⚠️ 别再改回 `globalThis[Symbol.for('im-qqbot.outbound')].sendMedia()`：
 *      那条通道取 lastCtx，工具运行在回合中段时它是 null（`ext-outbound.js:358-362`）。
 */

import { synthesize, listVoices } from '../lib/tts-core.mjs';
import { enqueue, pending } from '../lib/voice-queue.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_ROOT_FALLBACK = 'F:/qqbot/dshqqbot';

function dataRoot(env) {
  const envRoot = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (envRoot) return envRoot;
  const capsRoot = String(env?.caps?.dataRoot || '').trim();
  if (capsRoot) return capsRoot;
  return DATA_ROOT_FALLBACK;
}

function voiceCfg(root) {
  const def = { voice: 'zh-CN-XiaoyiNeural', rate: '+8%', pitch: '+10Hz', timeoutMs: 20000 };
  try {
    const p = join(root, '.qqbot-extensions', 'voice-config.json');
    if (!existsSync(p)) return def;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return { ...def, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch { return def; }
}

/** 直发：优先 caps.voice，退而求其次 caps.media('voice', …)。返回 {sent, why} */
async function sendNow(caps, path) {
  if (!caps) return { sent: false, why: '没有 caps（宿主没给能力包）' };
  try {
    if (typeof caps.voice === 'function') {
      const r = await caps.voice(path);
      if (r === true) return { sent: true, why: 'caps.voice' };
      if (r === false) return { sent: false, why: 'caps.voice 返回 false（sender/目标缺失或上传失败）' };
      return { sent: false, why: `caps.voice 返回 ${String(r)}` };
    }
    if (typeof caps.media === 'function') {
      const r = await caps.media('voice', path);
      if (r === true) return { sent: true, why: "caps.media('voice')" };
      return { sent: false, why: 'caps.media 返回 false' };
    }
    return { sent: false, why: 'caps 里没有 voice/media' };
  } catch (e) {
    return { sent: false, why: `直发抛错: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export default {
  name: 'voice',
  description: '发一条语音（真·语音条）。想说出口的、带情绪的短句用它；技术长回答别用。'
    + 'action=list 看有哪些音色；action=status 看有没有待发的。',
  inputSchema: {
    action: { type: 'string', description: 'say(默认，念出来) | list(列音色) | status(待发队列)' },
    text: { type: 'string', description: 'say 必填：要念的话，≤70 字，别带表情/markdown' },
    voice: { type: 'string', description: '可选音色 id，默认用配置里的 zh-CN-XiaoyiNeural' },
  },

  run: async (args, env) => {
    const log = env?.logger || console;
    const root = dataRoot(env);
    const action = String(args?.action || 'say').trim();

    try {
      if (action === 'list') {
        return { ok: true, voices: listVoices() };
      }
      if (action === 'status') {
        const items = pending(root);
        return { ok: true, count: items.length, items: items.map((i) => i.text) };
      }

      const text = String(args?.text || '').trim();
      if (!text) return { ok: false, msg: 'text 不能为空' };
      if (text.length > 120) return { ok: false, msg: `太长（${text.length} 字）—— 语音只念短句，压到 70 字内` };

      const cfg = voiceCfg(root);
      const useVoice = String(args?.voice || cfg.voice);
      const r = await synthesize(text, {
        dataRoot: root,
        voice: useVoice,
        rate: cfg.rate,
        pitch: cfg.pitch,
        timeoutMs: cfg.timeoutMs,
        // 本地模型接线（2026-10-25）：voice-config.json 里写 provider/endpoint 就能切后端。
        // 原来这里只透传 dataRoot/voice/rate/pitch，provider 永远是默认 edge —— 改配置等于没改。
        provider: cfg.provider,
        endpoint: cfg.endpoint,
        model: cfg.model,
        apiKey: cfg.apiKey,
        speed: cfg.speed,
      });
      if (!r.ok) return { ok: false, msg: `合成失败：${r.error}` };

      const kb = (r.bytes / 1024).toFixed(0);

      // ① 当场直发（首选）
      const direct = await sendNow(env?.caps, r.path);
      if (direct.sent) {
        log?.info?.(`[voice] 已直发 ${r.bytes}B (${direct.why}): ${text.slice(0, 20)}`);
        return {
          ok: true,
          msg: `语音已发出（${kb}KB，${direct.why}）—— 别再说"我发了"，正常往下聊就行`,
          voice: useVoice,
          direct: true,
        };
      }

      // ② 退回发件箱兜底
      const q = enqueue(root, { path: r.path, text, voice: useVoice, bytes: r.bytes });
      if (!q.ok) return { ok: false, msg: `语音发不出去（直发失败：${direct.why}；排队也失败：${q.msg}）` };
      log?.warn?.(`[voice] 直发失败(${direct.why}) → 已排发件箱: ${text.slice(0, 20)}`);
      return {
        ok: true,
        msg: `语音合成好了（${kb}KB），直发没成功（${direct.why}），已排进发件箱等下一跳补发`,
        voice: useVoice,
        direct: false,
      };
    } catch (e) {
      return { ok: false, msg: `语音工具异常：${e instanceof Error ? e.message : String(e)}` };
    }
  },
};
