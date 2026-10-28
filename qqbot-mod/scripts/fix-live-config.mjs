/**
 * fix-live-config.mjs — 修线上配置里的脏数据 / 危险开关（走插件自己的 HTTP 接口，不碰磁盘）
 *
 * 本次修两处（都在 `harness\qqbot-settings\web\im-qqbot.json` 实测出来的）：
 *   ① `smartReply: { scoreMode: "block'   # 'block' 模式会根据阈值…", threshold: "0.05   # …" }`
 *      —— 这是把「说明文字」整段粘进了值里，两个字段都是带注释的字符串。
 *      在 1.10.22 的 dist 里 `smartReply` 这个键**根本没人读**（真正生效的是 `localModel.valueGate`
 *      / `localModel.valueMinScore`），所以它是纯垃圾配置，留着只会让以后的人以为它是开关。
 *   ② 群覆盖 `localModel.overrides["group:…"]` 的 `valueGate: "block"` + `valueMinScore: 0.35`
 *      —— block 模式下相似度 <0.35 的消息**不唤醒她**。这正是"漏消息"的一条真实成因：
 *      群友随口一句的向量相似度经常低于 0.35，于是她被静音。按"准确性/及时性优先"，
 *      先退回 `log`（照常打分、照常记录，但不拦人），门槛降到 0.2 留观察数据。
 *
 * 用法：
 *   node qqbot-mod/scripts/fix-live-config.mjs            # 只看现状 + 打算怎么改
 *   node qqbot-mod/scripts/fix-live-config.mjs --apply    # 真改
 */

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const URL_BASE = (() => { const i = argv.indexOf('--url'); return i >= 0 && argv[i + 1] ? argv[i + 1] : 'http://127.0.0.1:43129'; })();
const NS = 'im-qqbot';

async function read() {
  const r = await fetch(`${URL_BASE}/api/qqbot-settings/read?ns=${NS}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('read HTTP ' + r.status);
  return r.json();
}

async function update(patch, revision) {
  const body = { ns: NS, patch };
  if (typeof revision === 'number') body.expectedRevision = revision;
  const r = await fetch(`${URL_BASE}/api/qqbot-settings/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('update HTTP ' + r.status + ': ' + t.slice(0, 300));
  return t;
}

const cur = await read();
const v = (cur && cur.value) || {};
const lm = v.localModel || {};
const overrides = lm.overrides || {};

const changes = [];

// ① smartReply 是死键（dist 里搜不到任何读取点），且值是带注释的字符串
if (v.smartReply != null) {
  changes.push({ what: 'smartReply（死键，值为带注释的字符串）', act: '删除' });
}

// ② 群覆盖里的 block 门槛
const nextOverrides = {};
for (const [k, ov] of Object.entries(overrides)) {
  const o = { ...ov };
  if (o.valueGate === 'block') {
    changes.push({ what: `${k} valueGate`, act: `block → log（不再静音）` });
    o.valueGate = 'log';
  }
  if (typeof o.valueMinScore === 'number' && o.valueMinScore > 0.2) {
    changes.push({ what: `${k} valueMinScore`, act: `${o.valueMinScore} → 0.2` });
    o.valueMinScore = 0.2;
  }
  nextOverrides[k] = o;
}

if (!changes.length) {
  console.log('✓ 配置已经很干净，无需修改');
  process.exit(0);
}

console.log('打算这样改：');
for (const c of changes) console.log('  · ' + c.what + '：' + c.act);

if (!APPLY) {
  console.log('\n（只预演。加 --apply 才会写入）');
  process.exit(0);
}

// 删除键：patch 里给 null 表示删除（插件 update 走的是浅合并 + null 清除）
const patch = { localModel: { ...lm, overrides: nextOverrides }, smartReply: null };
const out = await update(patch, cur.revision);
console.log('写入：' + String(out).slice(0, 200));

const after = await read();
const nv = (after && after.value) || {};
const okSmart = nv.smartReply === undefined || nv.smartReply === null;
const gates = Object.values(((nv.localModel || {}).overrides) || {}).map((o) => o.valueGate);
const okGate = gates.every((g) => g !== 'block');
console.log(okSmart ? '✓ smartReply 已清除' : '✗ smartReply 仍在：' + JSON.stringify(nv.smartReply));
console.log(okGate ? '✓ 已无 block 门槛，gate=' + gates.join(',') : '✗ 仍有 block：' + gates.join(','));
process.exit(okSmart && okGate ? 0 : 1);
