/**
 * memory.mjs — 让她自己决定"记什么"（长期记忆的写入端）
 *
 * 为什么需要它：入站扩展只能沉淀**原话**（episode），真正的记忆应该是**提炼后的事实**。
 * 让她在对话里主动记一条，比机器猜准得多。
 *
 * scope 怎么解决：工具拿不到"当前是哪个群"，所以 add 只写**公共收件箱**，
 * 入站扩展在下一条消息到来时把它并进当前群（延迟一条消息，但绝不会写错群）。
 *
 * 用 /tools-reload 热加载，不用重启。
 */

// 存储后端在门面里选：优先 SQLite（memory-db），不可用自动回退 JSONL（memory-core）。
import { loadConfig, pushInbox, listAll, forgetAnywhere, remember } from '../lib/memory.mjs';

const DATA_ROOT_FALLBACK = 'F:/qqbot/dshqqbot';

function dataRoot() {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  try {
    const cfg = loadConfig(DATA_ROOT_FALLBACK);
    return cfg.dataRoot || DATA_ROOT_FALLBACK;
  } catch {
    return DATA_ROOT_FALLBACK;
  }
}

const KINDS = new Set(['fact', 'event', 'preference', 'relation']);

export default {
  name: 'memory',
  // description 刻意写短 —— 工具 schema 是每请求的固定开销
  description: '长期记忆：add=记住一条 / list=看最近记了什么 / forget=删掉一条。'
    + '只记"以后会用到"的：人的事实、她的承诺、群里的约定、她对某人的态度。闲聊原话不用记。',
  inputSchema: {
    action: { type: 'string', required: true, description: 'add | list | forget' },
    text: { type: 'string', description: 'add 必填：一句话，≤80 字，写成陈述句（"妈妈养了只猫叫年糕"）' },
    kind: { type: 'string', description: 'add 可选：fact=事实(默认) / event=发生过的事 / preference=偏好 / relation=对某人的态度' },
    subj: { type: 'string', description: 'add 可选：这条记的是谁（昵称）' },
    id: { type: 'string', description: 'forget 必填：记忆 id（list 里显示）' },
    limit: { type: 'number', description: 'list 可选：最多几条，默认 20' },
  },

  run: async (args, env) => {
    const log = env?.logger || console;
    const action = String(args?.action || '').trim();
    const root = dataRoot();

    try {
      if (action === 'add') {
        const text = String(args?.text || '').trim();
        if (!text) return { ok: false, msg: 'text 不能为空' };
        if (text.length > 120) return { ok: false, msg: `太长（${text.length} 字）—— 压到 80 字以内再记` };
        const kind = KINDS.has(args?.kind) ? args.kind : 'fact';
        // 直接进当前 scope 也行，但工具不知道 scope ⇒ 进收件箱，下条消息并入当前群
        const r = pushInbox(root, { text, kind, subj: args?.subj });
        if (!r.ok) return { ok: false, msg: `没记住：${r.reason}` };
        return { ok: true, msg: `记下了（${kind}）：${text}` };
      }

      if (action === 'list') {
        const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20));
        const items = listAll(root, { limit });
        if (items.length === 0) return { ok: true, msg: '记忆库还是空的。' };
        const lines = items.map((x, i) => `${i + 1}. [${x.id}] (${x.kind || '?'}) ${x.text}`);
        return { ok: true, msg: `最近 ${items.length} 条记忆：\n` + lines.join('\n') };
      }

      if (action === 'forget') {
        const id = String(args?.id || '').trim();
        if (!id) return { ok: false, msg: 'id 不能为空（先 list 看 id）' };
        const ok = forgetAnywhere(root, id);
        return { ok, msg: ok ? `已删 ${id}` : `没找到 ${id}` };
      }

      return { ok: false, msg: `不认识的 action: ${action}（add | list | forget）` };
    } catch (e) {
      log.warn?.(`[memory-tool] 异常: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, msg: '记忆操作出错了（已忽略，不影响聊天）' };
    }
  },
};

/** 便于外部脚本复用：把一个 scope 的记忆直接灌进去（不做收件箱） */
export async function rememberInto(root, scope, text, kind = 'fact', subj = '') {
  const cfg = loadConfig(root);
  return remember(root, scope, { text, kind, subj }, cfg);
}
