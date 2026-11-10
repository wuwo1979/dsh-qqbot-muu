import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { encodePacket, decodePackets } from '../adapters/bilibili-web.mjs';
import { normalizeBiliWeb, normalizeOpen } from '../event-model.mjs';

test('packet 编码/解码：明文', () => {
  const body = JSON.stringify({ cmd: 'DANMU_MSG', info: [] });
  const buf = encodePacket(5, body, 0, 1);
  const packets = decodePackets(buf);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].op, 5);
  assert.equal(packets[0].body.toString('utf8'), body);
});

test('packet 解码：version=2 zlib 嵌套', () => {
  const inner = encodePacket(5, JSON.stringify({ cmd: 'SEND_GIFT', data: { uid: 1 } }), 0, 1);
  const outer = encodePacket(5, deflateSync(inner), 2, 1);
  const packets = decodePackets(outer);
  assert.ok(packets.length >= 1);
  assert.equal(JSON.parse(packets[0].body.toString('utf8')).cmd, 'SEND_GIFT');
});

test('DANMU_MSG 归一化：uid 只保留掩码', () => {
  const rawUid = 123456789;
  const packet = {
    cmd: 'DANMU_MSG',
    info: [
      [0, 1, 25, 16777215, 1700000000000, 0, 0, 'msg-hash-01'],
      '你好呀',
      [rawUid, '观众A', 0, 0, 0, 0, 0, 0],
      [12, '小蓝的牌子', '主播', 1000, 0, ''],
      0,
      '',
      0,
      3,
    ],
  };
  const ev = normalizeBiliWeb(packet, {});
  assert.equal(ev.type, 'danmaku');
  assert.equal(ev.text, '你好呀');
  assert.equal(ev.user.name, '观众A');
  assert.equal(ev.user.guardLevel, 3);
  assert.ok(!String(ev.user.id).includes(String(rawUid)));
  assert.match(ev.user.id, /\*/);
});

test('SEND_GIFT 归一化：金额按 1000=1 元', () => {
  const ev = normalizeBiliWeb({ cmd: 'SEND_GIFT', data: { uid: 987654, uname: '老板', giftName: '小花花', num: 3, price: 5000, coin_type: 'gold', timestamp: 1700000000, tid: 't1' } }, {});
  assert.equal(ev.type, 'gift');
  assert.equal(ev.gift.total, 15000);
  assert.equal(ev.amount.rmb, 15);
  assert.equal(ev.user.name, '老板');
});

test('INTERACT_WORD msg_type=2 归一化为 follow', () => {
  const ev = normalizeBiliWeb({ cmd: 'INTERACT_WORD', data: { uid: 42, uname: '新朋友', msg_type: 2, timestamp: 1700000000 } }, {});
  assert.equal(ev.type, 'follow');
  assert.equal(ev.user.name, '新朋友');
});

test('官方 CMD 归一化：OPEN_LIVEROOM_DM', () => {
  const ev = normalizeOpen({ cmd: 'OPEN_LIVEROOM_DM', data: { open_id: 'open-1', uname: '观众B', msg: '在吗', msg_id: 'm1', timestamp: 1700000000, guard_level: 0 } }, {});
  assert.equal(ev.type, 'danmaku');
  assert.equal(ev.text, '在吗');
  assert.ok(!JSON.stringify(ev).includes('open-1'));
});
