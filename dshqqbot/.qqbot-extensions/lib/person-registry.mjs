/**
 * person-registry.mjs — 人物归一表（同一个人的多个昵称合成一个 personId）
 *
 * 为什么必须有这一层：
 *   群里同一个人会换昵称、改群名片、用小号；如果直接拿昵称当 key，同一个
 *   人会被拆成五份记忆，画像互相打架 —— 这就是"对用户性格的认知发生偏移"
 *   最常见的来源。所以主键必须是稳定的东西：优先 QQ 号，其次才是昵称。
 *
 * 归一规则：
 *   · 有 uin（QQ 号）→ personId = 'qq:' + uin，昵称只作为 alias 记录
 *   · 没有 uin → personId = 'nick:' + 昵称规范化后的短哈希
 *   · 同 uin 不同昵称 → 自动合并到同一 personId，旧昵称进 alias 列表
 *   · 同昵称不同 uin → **不合并**（这是两个不同的人，合并就是串号）
 *
 * 存储：<dataRoot>/.qqbot/person-registry.json，纯本地，不上传。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const FILE = 'person-registry.json';

export function registryPath(dataRoot) {
  return join(String(dataRoot || '.'), '.qqbot', FILE);
}

function emptyReg() {
  return { version: 1, people: {}, aliases: {} };
}

export function loadRegistry(dataRoot) {
  const p = registryPath(dataRoot);
  if (!existsSync(p)) return emptyReg();
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (!j || typeof j !== 'object') return emptyReg();
    return {
      version: 1,
      people: j.people && typeof j.people === 'object' ? j.people : {},
      aliases: j.aliases && typeof j.aliases === 'object' ? j.aliases : {},
    };
  } catch {
    return emptyReg();
  }
}

export function saveRegistry(dataRoot, reg) {
  const p = registryPath(dataRoot);
  try {
    mkdirSync(dirname(p), { recursive: true });
    // 先写临时文件再 rename：导入中途崩溃不会把整张表写坏
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
    renameSync(tmp, p);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** 昵称规范化：去空白、全角转半角、去尾部装饰符号 */
export function normalizeNick(nick) {
  return String(nick || '')
    .replace(/[\u3000\s]+/g, '')
    .replace(/[（(].*?[）)]/g, '')       // "张三(管理员)" → "张三"
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_\-·.]/g, '')
    .trim();
}

function shortHash(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
}

export function personIdOf({ uin, nick } = {}) {
  const u = String(uin || '').replace(/\D/g, '');
  if (u.length >= 5) return 'qq:' + u;
  const n = normalizeNick(nick);
  if (n) return 'nick:' + shortHash(n);
  return '';
}

/**
 * 登记一个身份，返回 personId。会顺手把新昵称塞进 alias 列表。
 * @returns {{personId:string, created:boolean, merged:boolean}}
 */
export function registerPerson(reg, { uin, nick, groupId } = {}) {
  const u = String(uin || '').replace(/\D/g, '');
  const n = normalizeNick(nick);
  let pid = '';
  if (u.length >= 5) {
    pid = 'qq:' + u;
  } else if (n) {
    // 没有 QQ 号时，先看这个昵称是不是已经归过某个人（比如同一人在别的
    // 消息里带过号）。命中就复用，否则同一个人会被拆成两份记忆。
    // 歧义昵称（多个人用过）不复用——宁可认不出，也不能串号。
    const known = reg.aliases[n];
    pid = known && known !== '?ambiguous' ? known : 'nick:' + shortHash(n);
  }
  if (!pid) return { personId: '', created: false, merged: false };

  const now = Date.now();
  let created = false;
  if (!reg.people[pid]) {
    reg.people[pid] = { id: pid, uin: uin ? String(uin) : '', nicks: [], firstSeen: now, lastSeen: now, groups: [] };
    created = true;
  }
  const p = reg.people[pid];
  p.lastSeen = now;
  if (n && !p.nicks.includes(n)) p.nicks.push(n);
  if (groupId != null) {
    const g = String(groupId);
    if (!p.groups.includes(g)) p.groups.push(g);
  }
  // alias 索引：昵称 → personId。同名被多个 uin 占用时标记为歧义，不再参与反查
  if (n) {
    const cur = reg.aliases[n];
    if (!cur) reg.aliases[n] = pid;
    else if (cur !== pid) reg.aliases[n] = '?ambiguous';
  }
  return { personId: pid, created, merged: !created };
}

/**
 * 反查：给 uin 或昵称，返回 personId。
 * 昵称歧义（多个人用过）时返回空串，宁可认不出也不要串号。
 */
export function resolvePerson(dataRoot, { uin, nick } = {}) {
  const u = String(uin || '').replace(/\D/g, '');
  if (u.length >= 5) return 'qq:' + u;
  const reg = loadRegistry(dataRoot);
  const n = normalizeNick(nick);
  if (!n) return '';
  const hit = reg.aliases[n];
  if (!hit || hit === '?ambiguous') return '';
  return hit;
}

/** 把一个人的所有已知昵称列出来（给画像/检索时做同义词扩展） */
export function aliasesOf(reg, personId) {
  const p = reg && reg.people ? reg.people[personId] : null;
  return p && Array.isArray(p.nicks) ? [...p.nicks] : [];
}

export default {
  registryPath, loadRegistry, saveRegistry, registerPerson, resolvePerson,
  aliasesOf, personIdOf, normalizeNick,
};
