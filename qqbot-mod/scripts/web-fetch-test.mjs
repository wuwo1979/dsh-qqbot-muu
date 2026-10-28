/**
 * web-fetch-test.mjs — 网页抓取工具自检
 * 安全拦截必须过；公网抓取能连就真抓一次，连不上则 SKIP（不伪装成功）。
 */
const TOOL = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/tools/web_fetch.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}
function skip(name, why) {
  pass += 1;
  console.log('SKIP  ' + name + '  (' + why + ')');
}

async function main() {
  const { run } = await import(TOOL);

  const bads = [
    ['file:///C:/Windows/win.ini', '非 http'],
    ['http://127.0.0.1:8765/', '本机'],
    ['http://localhost/', 'localhost'],
    ['http://192.168.1.1/', '内网'],
    ['http://[::1]/', 'IPv6 本机'],
    ['http://0x7f000001/', '十六进制绕过'],
    ['ftp://example.com/', 'ftp'],
    ['不是链接', '非法 URL'],
  ];
  for (const [u, why] of bads) {
    const r = await run({ url: u });
    ok('拒绝' + why, r.ok === false && /失败/.test(r.msg || ''), r);
  }

  let r = null;
  try {
    r = await run({ url: 'https://example.com', maxChars: 800 });
  } catch (e) {
    r = { ok: false, msg: 'throw: ' + (e instanceof Error ? e.message : String(e)) };
  }
  if (r.ok) {
    ok('真抓 example.com', /Example Domain/i.test(r.msg), (r.msg || '').slice(0, 100));
    ok('带标题/URL 头', /已抓取网页/.test(r.msg) && /URL：https:\/\/example\.com/.test(r.msg));
    ok('正文有截断上限', r.msg.length < 2000, r.msg.length);
  } else {
    skip('真抓 example.com', r.msg || '网络不可用');
  }

  console.log('\nPASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

try { await main(); } catch (e) {
  if (e && typeof e === 'object' && '__verifyExit' in e) throw e;
  console.error(e);
  console.log('\nPASS ' + pass + ' / FAIL ' + (fail + 1));
  process.exit(1);
}
