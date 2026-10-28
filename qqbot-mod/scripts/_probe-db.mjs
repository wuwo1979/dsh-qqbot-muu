import { DatabaseSync } from 'node:sqlite';
const p = 'F:\\qqbot\\qqbot-mod\\.devdata\\.qqbot\\memory.db';
const db = new DatabaseSync(p, { readOnly: true });
const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all();
for (const r of rows) console.log(r.name, '::', String(r.sql || '').replace(/\s+/g, ' ').slice(0, 220));
console.log('--- counts ---');
for (const t of ['mem', 'persona', 'meta']) {
  try { console.log(t, db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c); } catch (e) { console.log(t, 'ERR', e.message); }
}
console.log('--- sample mem ---');
try { console.log(JSON.stringify(db.prepare('SELECT * FROM mem LIMIT 2').all()).slice(0, 700)); } catch (e) { console.log('ERR', e.message); }
db.close();
