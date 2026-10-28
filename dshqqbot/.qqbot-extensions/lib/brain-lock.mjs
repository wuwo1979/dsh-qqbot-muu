/**
 * 单脑仲裁（brain-lock）—— 解决"左右脑互搏"
 *
 * 现场：用户问"你能发语音吗"，本地小模型秒答"我只会打字"，一秒后云端又答"我可以呀"并发语音。
 *
 * 为什么插件拦不住（读完 dist/features/ext-inbound.js:337-391 才确认）：
 *   1. 同一条消息确实只有一个脑（本地答了就 `annihilate` 吃掉链，云端根本不会跑）；
 *   2. 但两条消息会**交叠**：消息① 在 t0 被放行给云端（云端开始算），
 *      消息② 在 t0+1s 到，本地秒答 ⇒ 用户看到"本地说一句、云端再说一句"。
 *      云端那句是给消息① 的，可人看着就是两个脑子在抢话。
 *
 * 所以需要的是**按会话的节流**：谁先动手，另一个就在窗口内闭嘴。
 *   · 云端**被放行**（=本回合交给云算力）⇒ 记 cloud，窗口内本地不插嘴；
 *   · 云端**说完**（出站末块）⇒ 记 cloud，窗口内本地不插嘴；
 *   · 本地答完 ⇒ 记 local（留痕，给面板/调试看谁在说话）。
 *
 * 存储：`{dataRoot}/.qqbot/brain-lock.json`，结构 `{ "<scope>": {who, ts, why} }`。
 * 全是 try/catch：读写失败一律当"没有锁"（宁可让本地答，也不能把扩展搞崩）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MAX_SCOPES = 64;

/** 锁文件路径 */
export function lockFile(dataRoot) {
  return join(String(dataRoot || '.'), '.qqbot', 'brain-lock.json');
}

/**
 * 从入站 ctx 取**会话级**作用域。
 *
 * ⚠️ 不能用 `ctx.scope` —— 插件那个 getter 只返回 `'group'` / `'c2c'`（见
 * dist/features/ext-inbound-context.js:613、:648），**不带群号/对方 id**，
 * 拿它当 key 会让所有群共用一个锁（一个群聊着，别的群本地就哑了）。
 */
export function scopeOf(ctx) {
  try {
    const m = ctx?.message;
    if (m) {
      const gid = String(m.groupOpenid ?? '');
      if (gid) return 'group:' + gid;
      const sid = String(m.senderId ?? '');
      if (sid) return 'c2c:' + sid;
    }
    const s = String(ctx?.scope ?? '');
    // 宿主可能已经给了带 id 的 scope（有些版本会给 'group:<id>'），带上才用
    if (s.includes(':')) return s;
    const peer = String(ctx?.peerId ?? ctx?.session ?? '');
    if (peer) return (s || 'c2c') + ':' + peer;
    return s;
  } catch {
    return '';
  }
}

function readAll(dataRoot) {
  try {
    const raw = JSON.parse(readFileSync(lockFile(dataRoot), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(dataRoot, all) {
  try {
    // 只留最近的若干条，别让文件无限长
    const keys = Object.keys(all);
    if (keys.length > MAX_SCOPES) {
      keys
        .sort((a, b) => Number(all[b]?.ts || 0) - Number(all[a]?.ts || 0))
        .slice(MAX_SCOPES)
        .forEach((k) => { delete all[k]; });
    }
    const f = lockFile(dataRoot);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(all), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 记账：谁在这个会话说了话（who: 'local' | 'cloud'） */
export function mark(dataRoot, scope, who, extra = {}) {
  try {
    if (!scope) return false;
    const all = readAll(dataRoot);
    all[scope] = { who: String(who || ''), ts: Number(extra.now ?? Date.now()), why: String(extra.why || '') };
    return writeAll(dataRoot, all);
  } catch {
    return false;
  }
}

/** 看一眼：这个会话最近是谁在说话 */
export function peek(dataRoot, scope, now = Date.now()) {
  try {
    if (!scope) return null;
    const rec = readAll(dataRoot)[scope];
    if (!rec || !Number.isFinite(Number(rec.ts))) return null;
    return { who: String(rec.who || ''), ts: Number(rec.ts), why: String(rec.why || ''), age: now - Number(rec.ts) };
  } catch {
    return null;
  }
}

/**
 * 这个会话现在"安静"吗？（安静 = 没人在窗口内说过话，本地可以接手）
 *
 * 只有**云端**说过话会挡住本地；本地自己说过不算挡（否则本地连着答两句就被自己拦住）。
 * `who` 可传数组时任一命中都算挡。
 */
export function quiet(dataRoot, scope, ms, now = Date.now()) {
  const hold = Number(ms);
  if (!(hold > 0)) return true;
  const rec = peek(dataRoot, scope, now);
  if (!rec) return true;
  if (!(rec.age < hold)) return true;
  return rec.who !== 'cloud';
}

/** 清空（测试/热修用） */
export function reset(dataRoot) {
  try {
    return writeAll(dataRoot, {});
  } catch {
    return false;
  }
}

export default { lockFile, scopeOf, mark, peek, quiet, reset };
