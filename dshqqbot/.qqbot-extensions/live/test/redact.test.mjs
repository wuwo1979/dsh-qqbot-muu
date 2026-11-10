import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, maskId, maskSecret, makeLogger } from '../redact.mjs';

test('maskId / maskSecret', () => {
  assert.equal(maskId(''), '');
  assert.equal(maskId('12'), '***');
  assert.ok(maskId('123456789').startsWith('12'));
  assert.equal(maskSecret('abcdef'), '***(6)');
});

test('日志脱敏：房间号、UID、token、Cookie 不落明文', () => {
  const r = createRedactor({ roomId: '22824550', uid: '123456789', tokens: ['abcdef012345'], cookies: { SESSDATA: 'sess-secret-value', bili_jct: 'csrf-secret' } });
  const line = 'room=22824550 uid=123456789 token=abcdef012345 SESSDATA=sess-secret-value bili_jct=csrf-secret open_id=open-abc';
  const out = r.scrubText(line);
  for (const raw of ['22824550', '123456789', 'abcdef012345', 'sess-secret-value', 'csrf-secret', 'open-abc']) {
    assert.equal(out.includes(raw), false, `raw ${raw} leaked: ${out}`);
  }
  assert.ok(out.includes('***'));
});

test('对象脱敏：键名命中直接替换', () => {
  const r = createRedactor({});
  const out = r.scrub({ uid: 987654321, room_id: 123456, token: 'tok-123456', nested: { open_id: 'o-1', uname: '观众A' } });
  assert.ok(out.uid.includes('*'));
  assert.ok(out.room_id.includes('*'));
  assert.equal(out.token, '***(10)');
  assert.equal(out.nested.open_id, '***');
  assert.equal(out.nested.uname, '观众A');
});

test('safeLogger 输出的每一行都经过脱敏', () => {
  const lines = [];
  const base = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
  const log = makeLogger(base, createRedactor({ roomId: '22824550' }), 'live');
  log.info('连接房间 22824550 成功');
  assert.equal(lines[0].includes('22824550'), false);
  assert.match(lines[0], /\[live\]/);
});
