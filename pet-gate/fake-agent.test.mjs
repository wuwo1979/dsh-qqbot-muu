#!/usr/bin/env node
/** 一次性测试用假 agent：代答 pet-anim（固定返回 muu 形态两动作） */
import { readFileSync } from 'node:fs';
const SEC = JSON.parse(readFileSync('F:/qqbot/pet-gate/secrets.json', 'utf8'));
const BODY = {
  ok: true,
  form: { id: 'muu', label: '大肥鱼', emoji: '🐟' },
  forms: [
    { id: 'xiaolan', label: '小蓝', emoji: '🐋', petId: 'xiaolan', active: false },
    { id: 'muu', label: '大肥鱼', emoji: '🐟', petId: 'main', active: true },
  ],
  anims: [{ name: '点击回应-元气挥手', label: '挥手' }, { name: '待机呼吸休闲', label: '待机' }],
  pool: [{ name: '写代码' }, { name: '三球抛接' }, { name: '撸猫' }],
  petOn: true,
};
console.log('[fake-agent] up');
for (;;) {
  try {
    const r = await fetch('http://127.0.0.1:8797/agent/poll', {
      method: 'POST', headers: { 'x-agent-key': SEC.agentKey, 'content-type': 'application/json' }, body: '{}',
    });
    const j = await r.json();
    for (const job of j.jobs || []) {
      const body = job.path === '/api/qqbot-settings/pet-anim' ? BODY : { ok: false };
      await fetch('http://127.0.0.1:8797/agent/result', {
        method: 'POST', headers: { 'x-agent-key': SEC.agentKey, 'content-type': 'application/json' },
        body: JSON.stringify({ id: job.id, status: 200, type: 'application/json; charset=utf-8', bodyB64: Buffer.from(JSON.stringify(body)).toString('base64') }),
      });
    }
  } catch { await new Promise((r2) => setTimeout(r2, 2000)); }
}
