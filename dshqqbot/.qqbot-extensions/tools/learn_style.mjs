/**
 * tools/learn_style.mjs — 学说话习惯
 *   action=scan 从指定群/最近记忆里提炼（默认）
 *   action=show 看现在学到的
 */
import { learnStyle, currentStyle } from '../lib/imitate.mjs';

export const name = 'learn_style';
export const description =
  '从群聊或导入记录里学说话习惯（短句/口头禅/标点），只学表达方式、不学别人隐私。主人说「学学他们怎么说话」时用。';

export const inputSchema = {
  action: { type: 'string', required: true, enum: ['scan', 'show'], description: 'scan=学一次；show=看当前学到的' },
  scope: { type: 'string', description: 'scan 可选：群/私聊 scope，如 group:<gid>；不填用记忆库' },
  limit: { type: 'number', description: 'scan 采样条数，默认 240' },
};

function dataRootOf(env) {
  return String((env && (env.caps && env.caps.dataRoot)) || process.env.QQBOT_MEMORY_DATA_ROOT || 'F:/qqbot/dshqqbot');
}

export async function run(args = {}, env = {}) {
  const dataRoot = dataRootOf(env);
  try {
    if (String(args.action || 'scan') === 'show') {
      const s = currentStyle(dataRoot);
      return { ok: true, style: s, msg: s || '还没学过，先 scan 一次' };
    }
    const r = learnStyle(dataRoot, { scope: args.scope || '', limit: Number(args.limit) || 240 });
    return r.ok ? { ok: true, ...r, msg: `学到了：${r.style}` } : { ok: false, error: r.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default { name, description, inputSchema, run, expose: 'all' };
