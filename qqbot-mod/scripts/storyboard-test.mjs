/**
 * storyboard-test.mjs — 「小剧场视频」链路自测（不需要显卡、不需要真模型）
 *
 * 做法：起一个替身出图服务（node:http），给它 3 个画面 → 真的走一遍 ffmpeg 拼 mp4，
 *      然后检查 mp4 文件头（ftyp）、体积、以及 sendMedia 有没有被调到。
 *
 * 跑法：node qqbot-mod/scripts/storyboard-test.mjs
 */
import http from 'node:http';
import zlib from 'node:zlib';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LF = String.fromCharCode(10);
const ROOT = 'F:/qqbot/qqbot-mod/.devdata-video';
const REAL = process.argv.includes('--real');

// ---- 手搓一个纯色 PNG（不依赖显卡/模型，也能让 ffmpeg 真的编出帧） ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
/** 纯色 PNG（w×h，RGB） */
export function pngSolid(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log('PASS  ' + name);
  } else {
    fail += 1;
    console.log('FAIL  ' + name + (extra ? '  ' + extra : ''));
  }
};
const skip = (name, why) => {
  pass += 1;
  console.log('SKIP  ' + name + '  (' + why + ')');
};

function clean() {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  mkdirSync(join(ROOT, '.qqbot-extensions'), { recursive: true });
}

function fakeServer(opts = {}) {
  const state = { draws: 0, prompts: [] };
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith('/health')) return send(200, { ok: true, loaded: true, device: 'fake' });
    if (req.url.startsWith('/stop')) return send(200, { ok: true });
    if (req.url.startsWith('/draw')) {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          body = {};
        }
        state.draws += 1;
        state.prompts.push(String(body.prompt || ''));
        const out = String(body.out || '').replace(/\\/g, '/');
        const w = Number(body.width) || 512;
        const h = Number(body.height) || 512;
        const n = state.draws;
        try {
          mkdirSync(join(out, '..'), { recursive: true });
          writeFileSync(out, pngSolid(w, h, [40 * (n % 6), 90, 180 - 20 * (n % 5)]));
        } catch (e) {
          return send(500, { ok: false, error: 'write: ' + e.message });
        }
        return send(200, { ok: true, path: out, ms: 1, seed: 7 });
      });
      return undefined;
    }
    return send(404, { ok: false });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, state, baseUrl: 'http://127.0.0.1:' + srv.address().port }));
  });
}

async function main() {
  clean();
  process.env.QQBOT_MEMORY_DATA_ROOT = ROOT;

  const core = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/draw-core.mjs');
  const sb = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/tools/storyboard.mjs');

  // ---------- ffmpeg 定位 ----------
  const exe = sb.findFfmpeg();
  ok('找得到 imageio-ffmpeg 的 ffmpeg', !!exe && existsSync(exe), exe);
  if (!exe) {
    console.log('');
    console.log('PASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail > 0 ? 1 : 0);
  }

  // ---------- concat 清单格式 ----------
  const list = sb.concatList(['F:/a/x1.png', 'F:/a/x2.png'], 1.5);
  const lines = list.split(LF);
  ok('清单：每张图一行 file + 一行 duration', lines.filter((l) => l.startsWith('file ')).length === 3, String(lines.length));
  ok('清单：duration 按秒写两位', lines.some((l) => l === 'duration 1.50'));
  ok('清单：末张重复一次（防最后一张被吃）', lines[lines.length - 1].includes('x2.png'));
  ok('清单：路径用正斜杠', !lines[0].includes(String.fromCharCode(92)));

  // ---------- 真拼一段 mp4（3 张纯色假图，512×512） ----------
  const imgs = [];
  const dir = join(ROOT, 'imgs');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 3; i += 1) {
    const p = join(dir, 'p' + i + '.png');
    writeFileSync(p, pngSolid(512, 512, [30 + i * 60, 80, 160]));
    imgs.push(p);
  }
  const out = join(ROOT, 'out.mp4');
  const v = await sb.toVideo(imgs, out, { ffmpeg: exe, secondsPer: 0.6, size: 'square' });
  ok('toVideo：成功', v.ok === true, JSON.stringify(v));
  ok('toVideo：mp4 文件生成', existsSync(out));
  if (existsSync(out)) {
    const buf = readFileSync(out);
    ok('toVideo：是真 mp4（ftyp）', buf.subarray(4, 8).toString('ascii') === 'ftyp', buf.subarray(4, 8).toString('ascii'));
    ok('toVideo：体积 > 1KB', buf.length > 1024, String(buf.length));
  }
  ok('toVideo：缺图时明确报错', (await sb.toVideo([], out, { ffmpeg: exe })).ok === false);
  ok('toVideo：ffmpeg 不存在时明确报错', (await sb.toVideo(imgs, out, { ffmpeg: 'F:/nope/ffmpeg.exe' })).ok === false);

  // ---------- run()：参数校验 ----------
  const bad1 = await sb.run({ panels: ['只有一个画面'] }, {});
  ok('run：只有 1 个画面被拒', bad1.ok === false, JSON.stringify(bad1));
  const bad2 = await sb.run({ panels: ['a', 'b', 'c', 'd', 'e', 'f'] }, {});
  ok('run：超过 5 个画面被拒', bad2.ok === false);

  // ---------- run()：替身服务 + 假 caps，全链路 ----------
  const fake = await fakeServer();
  core.saveConfig(ROOT, { baseUrl: fake.baseUrl, enabled: true, bootWaitMs: 4000, timeoutMs: 8000 });
  const sentVideos = [];
  const env = {
    caps: {
      dataRoot: ROOT,
      video: async (p) => {
        sentVideos.push(p);
        return true;
      },
      media: async () => false,
    },
  };
  const r = await sb.run({ panels: ['a whale in the sea', 'the same whale jumping', 'the whale waving bye'], secondsPer: 0.6 }, env);
  ok('run：ok=true 且 sent=true', r.ok === true && r.sent === true, JSON.stringify(r));
  ok('run：调了 3 次出图', fake.state.draws === 3, String(fake.state.draws));
  ok('run：caps.video 收到 mp4 路径', sentVideos.length === 1 && String(sentVideos[0]).endsWith('.mp4'), String(sentVideos[0]));
  ok('run：frames=3', r.frames === 3, String(r.frames));
  ok('run：mp4 真的存在且有体积', existsSync(r.path) && readFileSync(r.path).length > 1024);
  ok('run：返回体很短（省 token）', String(r.msg || '').length < 120, String(r.msg));

  // caps.video 失败 → 退 caps.media
  const fake2 = await fakeServer();
  core.saveConfig(ROOT, { baseUrl: fake2.baseUrl });
  const usedMedia = [];
  const env2 = {
    caps: {
      dataRoot: ROOT,
      video: async () => false,
      media: async (kind, p) => {
        usedMedia.push(kind + '|' + p);
        return true;
      },
    },
  };
  const r2 = await sb.run({ panels: ['a cat', 'the cat sleeping'], secondsPer: 0.5 }, env2);
  ok('run：caps.video 失败退 caps.media', r2.ok === true && r2.sent === true && usedMedia.length === 1, JSON.stringify(r2));
  ok('run：退路 kind=video', usedMedia.length === 1 && usedMedia[0].startsWith('video|'));

  // 没有 caps → 不抛
  const r3 = await sb.run({ panels: ['a dog', 'the dog running'], secondsPer: 0.5 }, {});
  ok('run：没有 caps 也不抛', r3.ok === true && r3.sent === false, JSON.stringify(r3));

  // 关掉画画开关
  core.saveConfig(ROOT, { enabled: false });
  const r4 = await sb.run({ panels: ['a', 'b'] }, env);
  ok('run：enabled=false 明确拒绝', r4.ok === false);
  core.saveConfig(ROOT, { enabled: true });

  // ---------- 真机（可选） ----------
  if (REAL) {
    core.saveConfig(ROOT, { baseUrl: 'http://127.0.0.1:7861', bootWaitMs: 120000, timeoutMs: 180000 });
    const rr = await sb.run({ panels: ['a cute blue whale girl smiling', 'the same whale girl waving her tail'], secondsPer: 1.0 }, env);
    ok('真机：拼出小剧场视频', rr.ok === true && rr.sent === true, JSON.stringify(rr));
    if (rr.ok) console.log('真机视频 = ' + rr.path + '  ' + Math.round(rr.bytes / 1024) + 'KB  ' + rr.ms + 'ms');
  }

  for (const s of [fake, fake2]) {
    try {
      s.srv.close();
    } catch {
      /* ignore */
    }
  }

  console.log('');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail > 0 ? 1 : 0);
}

try {
  await main();
} catch (e) {
  if (e && typeof e === 'object' && '__verifyExit' in e) throw e;
  console.log('FAIL  套件异常: ' + (e && e.message ? e.message : String(e)));
  console.log(String(e && e.stack ? e.stack : '').split(LF).slice(0, 6).join(LF));
  console.log('PASS ' + pass + ' / FAIL ' + (fail + 1));
  process.exit(1);
}
