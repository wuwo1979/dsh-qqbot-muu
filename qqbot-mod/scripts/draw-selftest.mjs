/**
 * draw-selftest.mjs — 本地出图链路自测
 *
 * 设计要点：
 *   · 大部分用例对着**假服务**跑（起一个 node:http，替身 python）
 *     —— 这样即使模型没下完 / 显卡被占，链路本身的 bug 也能被抓到
 *   · 只有 --real 时才叫真服务画一张（很慢、很吃显存）
 *
 * 跑法：
 *   node qqbot-mod/scripts/draw-selftest.mjs
 *   node qqbot-mod/scripts/draw-selftest.mjs --real
 */
import http from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-draw';
const EXT = 'F:/qqbot/dshqqbot/.qqbot-extensions';
const REAL = process.argv.includes('--real');

// 1x1 透明 PNG
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

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

function clean() {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  mkdirSync(join(ROOT, '.qqbot-extensions'), { recursive: true });
  mkdirSync(join(ROOT, '.qqbot', 'draw'), { recursive: true });
}

/** 替身出图服务 */
function fakeServer(opts = {}) {
  const state = { draws: 0, lastBody: null, stops: 0 };
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith('/health')) {
      if (opts.failHealth) return send(500, { ok: false });
      return send(200, { ok: true, loaded: true, device: 'cuda', model: String(opts.model || 'Counterfeit-V3.0_fix_fp16.safetensors'), kind: 'single-file', steps: 24, cfg: 7 });
    }
    if (req.url.startsWith('/stop')) {
      state.stops += 1;
      return send(200, { ok: true });
    }
    if (req.url.startsWith('/draw')) {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        try {
          state.lastBody = JSON.parse(raw || '{}');
        } catch {
          state.lastBody = null;
        }
        state.draws += 1;
        const out = String((state.lastBody && state.lastBody.out) || '').replace(/\\/g, '/');
        if (opts.failDraw) return send(500, { ok: false, error: 'CUDA out of memory' });
        try {
          writeFileSync(out, PNG_1PX);
        } catch (e) {
          return send(500, { ok: false, error: 'write failed: ' + e.message });
        }
        return send(200, { ok: true, path: out, ms: 7, seed: 42 });
      });
      return undefined;
    }
    return send(404, { ok: false });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({ srv, state, baseUrl: 'http://127.0.0.1:' + port });
    });
  });
}

function listenMode() {
  return process.argv.includes('--real') ? 'real' : 'fake';
}

async function main() {
  clean();
  process.env.QQBOT_MEMORY_DATA_ROOT = ROOT;

  const core = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/draw-core.mjs');
  const tool = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/tools/draw.mjs');

  // ---------- 配置面 ----------
  const cfg0 = core.loadConfig(ROOT);
  ok('默认配置：pythonBin 指向 venv', String(cfg0.pythonBin).includes('.venv-draw'), cfg0.pythonBin);
  ok('默认配置：512 步数 24（SD1.5 甜点）', cfg0.width === 512 && cfg0.steps === 24, String(cfg0.steps));
  ok('默认配置：CFG 7', cfg0.cfg === 7, String(cfg0.cfg));
  ok('默认配置：模型是单文件 SD1.5（不再默认 turbo）', /\.safetensors$/i.test(String(cfg0.modelDir)), cfg0.modelDir);
  ok('默认配置：负面词带 bad anatomy', String(cfg0.negative).includes('bad anatomy'), '');
  ok('默认配置：baseUrl 7861', String(cfg0.baseUrl).includes('7861'));
  core.saveConfig(ROOT, { width: 640, steps: 3, enabled: true });
  const cfg1 = core.loadConfig(ROOT);
  ok('配置能存能读', cfg1.width === 640 && cfg1.steps === 3);
  // 写回默认尺寸，后面的用例按 512 走
  core.saveConfig(ROOT, { width: 512, steps: 24 });

  // ---------- 服务不在时：不抛、给出人话原因 ----------
  core.saveConfig(ROOT, { baseUrl: 'http://127.0.0.1:1', pythonBin: 'F:/qqbot/nope/python.exe', bootWaitMs: 800 });
  const dead = await core.draw('a cat', {}, core.loadConfig(ROOT));
  ok('服务不在：draw 不抛且 ok=false', dead && dead.ok === false, JSON.stringify(dead));
  ok('服务不在：原因可读', /server:|no-python|boot/.test(String(dead.reason)), String(dead.reason));

  // ---------- 假服务：正常出图 ----------
  const fake = await fakeServer();
  core.saveConfig(ROOT, { baseUrl: fake.baseUrl, bootWaitMs: 5000, timeoutMs: 8000 });
  const st = await core.status(core.loadConfig(ROOT));
  ok('假服务：status 显示在线且已加载', st.up === true && st.loaded === true, JSON.stringify(st));

  const r1 = await core.draw('a blue whale', { width: 512, height: 512 }, core.loadConfig(ROOT));
  ok('假服务：draw 成功', r1.ok === true, JSON.stringify(r1));
  ok('假服务：文件真的存在', r1.ok && existsSync(r1.path), r1 && r1.path);
  ok('假服务：是 PNG（签名对）', r1.ok && readFileSync(r1.path).subarray(0, 4).toString('hex') === '89504e47');
  ok('假服务：bytes 已回填', r1.ok && r1.bytes > 0, r1 && String(r1.bytes));
  ok('假服务：seed 回传', r1.ok && r1.seed === 42);
  ok('假服务：prompt 带了风格后缀', !!(fake.state.lastBody && String(fake.state.lastBody.prompt).includes('anime illustration')), fake.state.lastBody && String(fake.state.lastBody.prompt));
  ok('假服务：negative 已传', !!(fake.state.lastBody && String(fake.state.lastBody.negative).length > 3));
  ok('假服务：steps 默认 24 已传', !!(fake.state.lastBody && Number(fake.state.lastBody.steps) === 24), String(fake.state.lastBody && fake.state.lastBody.steps));
  ok('假服务：cfg 默认 7 已传', !!(fake.state.lastBody && Number(fake.state.lastBody.cfg) === 7), String(fake.state.lastBody && fake.state.lastBody.cfg));

  // ---------- 换模型：服务里跑的是旧模型 → 先关掉再起新的 ----------
  const stale = await fakeServer({ model: 'old-model.safetensors' });
  core.saveConfig(ROOT, { baseUrl: stale.baseUrl, modelDir: 'F:/qqbot/.models/new-model.safetensors', pythonBin: 'F:/qqbot/nope/python.exe', bootWaitMs: 500 });
  const sw = await core.ensure(core.loadConfig(ROOT));
  ok('换模型：先给旧服务发 /stop', stale.state.stops === 1, 'stops=' + stale.state.stops);
  ok('换模型：随后尝试起新服务（这里没 python，如实失败）', sw.ok === false && String(sw.reason).includes('no-python'), JSON.stringify(sw));
  // 复原：模型对得上就别重启
  const same = await fakeServer({ model: 'new-model.safetensors' });
  core.saveConfig(ROOT, { baseUrl: same.baseUrl });
  const sw2 = await core.ensure(core.loadConfig(ROOT));
  ok('模型一致：不重启，直接用', sw2.ok === true && same.state.stops === 0, JSON.stringify(sw2));
  core.saveConfig(ROOT, { modelDir: core.DEFAULTS.modelDir, pythonBin: core.DEFAULTS.pythonBin });

  // ---------- 假服务：出图失败要如实报 ----------
  const bad = await fakeServer({ failDraw: true });
  core.saveConfig(ROOT, { baseUrl: bad.baseUrl });
  const r2 = await core.draw('a cat', {}, core.loadConfig(ROOT));
  ok('出图失败：ok=false 且带 error', r2.ok === false && String(r2.reason).includes('out of memory'), String(r2.reason));

  // ---------- 工具层：caps.image 直发 ----------
  const good = await fakeServer();
  core.saveConfig(ROOT, { baseUrl: good.baseUrl, enabled: true });
  const sent = [];
  const env = {
    caps: {
      dataRoot: ROOT,
      image: async (p) => {
        sent.push(p);
        return true;
      },
      media: async () => false,
    },
  };
  const out = await tool.run({ prompt: 'a whale with sunglasses', size: 'wide' }, env);
  ok('工具：ok=true 且 sent=true', out.ok === true && out.sent === true, JSON.stringify(out));
  ok('工具：真的调了 caps.image', sent.length === 1 && existsSync(sent[0]));
  ok('工具：wide 画幅 640x384', !!(good.state.lastBody && good.state.lastBody.width === 640 && good.state.lastBody.height === 384), JSON.stringify(good.state.lastBody));
  ok('工具：返回体不含大段图片描述（省 token）', String(out.msg || '').length < 120, String(out.msg));

  // caps.image 失败 → 要退 caps.media
  const good2 = await fakeServer();
  core.saveConfig(ROOT, { baseUrl: good2.baseUrl });
  const usedMedia = [];
  const env2 = {
    caps: {
      dataRoot: ROOT,
      image: async () => false,
      media: async (kind, p) => {
        usedMedia.push(kind + '|' + p);
        return true;
      },
    },
  };
  const out2 = await tool.run({ prompt: 'a whale' }, env2);
  ok('工具：caps.image 失败时退 caps.media', out2.ok === true && out2.sent === true && usedMedia.length === 1, JSON.stringify(out2));
  ok('工具：退路传的 kind 是 image', usedMedia.length === 1 && usedMedia[0].startsWith('image|'));

  // 没有 caps（宿主没给能力包）→ 不抛，如实说
  const out3 = await tool.run({ prompt: 'a whale' }, {});
  ok('工具：没有 caps 也不抛', out3.ok === true && out3.sent === false, JSON.stringify(out3));
  ok('工具：没 caps 时 msg 里给出路（MEDIA 语法）', String(out3.msg || '').includes('MEDIA:image'), String(out3.msg));

  // 关掉功能
  core.saveConfig(ROOT, { enabled: false });
  const out4 = await tool.run({ prompt: 'a whale' }, env);
  ok('工具：enabled=false 时明确拒绝', out4.ok === false && String(out4.error).includes('关着'), JSON.stringify(out4));
  core.saveConfig(ROOT, { enabled: true });

  // 空 prompt / 超长 prompt
  const out5 = await tool.run({ prompt: '   ' }, env);
  ok('工具：空 prompt 被拒', out5.ok === false);
  const out6 = await tool.run({ prompt: 'x'.repeat(400) }, env);
  ok('工具：超长 prompt 被拒', out6.ok === false);

  // 纯英文不翻译（不发模型请求）
  const tr = await core.translatePrompt('a cat sitting on a whale', core.loadConfig(ROOT));
  ok('翻译：英文原样通过且不调模型', tr.ok === true && tr.translated === false && tr.prompt.includes('whale'));

  // 假服务下 draw 不该受"服务不在"影响：连着画三张
  const good3 = await fakeServer();
  core.saveConfig(ROOT, { baseUrl: good3.baseUrl });
  const many = [];
  for (let i = 0; i < 3; i += 1) many.push(await core.draw('w' + i, {}, core.loadConfig(ROOT)));
  ok('连画三张都成功', many.every((x) => x.ok === true), JSON.stringify(many.map((x) => x.ok)));
  ok('连画三张：服务只被调 3 次', good3.state.draws === 3, String(good3.state.draws));

  // 清理假服务
  for (const s of [fake, bad, good, good2, good3]) {
    try {
      s.srv.close();
    } catch {
      /* ignore */
    }
  }

  // ---------- 真服务（可选） ----------
  if (REAL) {
    const realModel = 'F:/qqbot/.models/sd-turbo';
    ok('真机：模型目录存在', existsSync(realModel), realModel);
    core.saveConfig(ROOT, { baseUrl: 'http://127.0.0.1:7861', bootWaitMs: 120000, timeoutMs: 180000 });
    const t0 = Date.now();
    const rr = await core.draw('a cute blue whale girl, chibi', {}, core.loadConfig(ROOT));
    ok('真机：画出一张', rr.ok === true, JSON.stringify(rr));
    if (rr.ok) {
      const sz = existsSync(rr.path) ? readFileSync(rr.path).length : 0;
      ok('真机：文件 > 10KB（真图不是占位）', sz > 10000, String(sz));
      console.log('真机耗时 = ' + (Date.now() - t0) + 'ms  文件 = ' + rr.path + '  ' + Math.round(sz / 1024) + 'KB');
    }
  }

  console.log('');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail > 0 ? 1 : 0);
}

// 用顶层 await（而不是 main().catch(...)）：
//   verify-all.mjs 是 await import() 之后立刻读输出的，
//   如果 main() 悬空跑，总表只会看到"通过·明细加 -v"而抓不到 PASS 29 / FAIL 0。
try {
  await main();
} catch (e) {
  // verify-all.mjs 会把 process.exit 换成抛 {__verifyExit}：
  // 那是"正常结束"的信号，必须原样抛回去，不能当成套件异常。
  if (e && typeof e === 'object' && '__verifyExit' in e) throw e;
  console.log('FAIL  套件异常: ' + (e && e.message ? e.message : String(e)));
  console.log(String(e && e.stack ? e.stack : '').split(LF).slice(0, 6).join(LF));
  console.log('PASS ' + pass + ' / FAIL ' + (fail + 1));
  process.exit(1);
}
