#!/usr/bin/env node
/**
 * fix-panel-v3.mjs —— 浮窗第四轮（2026-10-25 主人 m02289）
 *
 *  ① B 站发布日志：浮窗里能看到"我发了哪些动态/投稿"（读 bili-dynamic-log.jsonl + bili-ops/records.jsonl）
 *  ② 语音合成方案：列出 edge / GPT-SoVITS / Breeze TTS 2 / IndexTTS-2.5 的端口、模型大小、速度、
 *     用途，点一下就把 voice-config.json 写对（以前那个下拉只是看着能选）
 *  ③ 视频/出图方案标注 + 「打开产物目录」修好（新增 /open-dir，三重兜底并把路径回显给前端）
 *  ④ 登录后补齐私聊/特别关心：known-chats 并入 .qqbot/msg-history 目录（离线期间被记进台账的人/群
 *     也能在聊天页选到；聊天页对没有会话的目标已有 log-only 兜底）
 *
 * 用法： node qqbot-mod/patches/fix-panel-v3.mjs --check | --apply
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const HOST = pluginPath('settings-host.js');
const CLIENT = pluginPath('client/qqbot-settings.js');
const MARK = '[qqbot-mod] panel-v3';

const norm = (s) => s.replace(/\r\n/g, '\n');
const denorm = (s) => s.replace(/\n/g, '\r\n');

/** 在 anchor 之后插入（anchor 必须唯一） */
function after(src, anchor, text) {
  const i = src.indexOf(anchor);
  if (i < 0) return { ok: false, why: '找不到锚点' };
  if (src.indexOf(anchor, i + 1) >= 0) return { ok: false, why: '锚点不唯一' };
  const at = i + anchor.length;
  return { ok: true, src: src.slice(0, at) + text + src.slice(at) };
}
/** 在 anchor 之前插入 */
function before(src, anchor, text) {
  const i = src.indexOf(anchor);
  if (i < 0) return { ok: false, why: '找不到锚点' };
  if (src.indexOf(anchor, i + 1) >= 0) return { ok: false, why: '锚点不唯一' };
  return { ok: true, src: src.slice(0, i) + text + src.slice(i) };
}
/** 从 start 锚点找到 endPat 首次出现处，把 text 插到它前面 */
function beforePattern(src, startAnchor, endPat, text) {
  const i = src.indexOf(startAnchor);
  if (i < 0) return { ok: false, why: '找不到起始锚点' };
  const m = src.slice(i).match(endPat);
  if (!m) return { ok: false, why: '找不到结束标记' };
  const at = i + m.index;
  return { ok: true, src: src.slice(0, at) + text + src.slice(at) };
}

// ───────────────────────────── host 段 ─────────────────────────────

const HOST_KCHAT = `
          // [${MARK}] 并入 .qqbot/msg-history：机器人不在线/会话没注册时写下的台账也算"聊过"，
          // 这样登录后私聊与特别关心的历史在浮窗聊天页能选到（原本只知道 known-chats.jsonl）。
          try {
            const _kcMH = join(_kcRoot, ".qqbot", "msg-history");
            if (existsSync(_kcMH)) {
              for (const _d of readdirSync(_kcMH)) {
                const _mm = /^(group|c2c)_(.+)$/.exec(String(_d));
                if (!_mm) continue;
                const _p = join(_kcMH, _d);
                const _files = readdirSync(_p).filter((f) => /^\\d{4}-\\d{2}-\\d{2}\\.jsonl$/.test(String(f))).sort();
                const _last = _files[_files.length - 1];
                if (!_last) continue;
                const _fp = join(_p, _last);
                let _ts = 0;
                try { _ts = Number(statSync(_fp).mtimeMs) || 0; } catch { }
                let _nm = "";
                try {
                  const _ls = readFileSync(_fp, "utf8").split(String.fromCharCode(10)).filter(Boolean).slice(-60);
                  for (let _i = _ls.length - 1; _i >= 0; _i--) {
                    try {
                      const _o = JSON.parse(_ls[_i]);
                      const _n = String((_o && _o.n) || "");
                      if (_n && _n !== "self" && !/^[0-9A-Fa-f]{32}$/.test(_n)) { _nm = _n; break; }
                    } catch { }
                  }
                } catch { }
                _kcAdd(_mm[1], _mm[2], _nm || undefined, _ts);
              }
            }
          } catch { }
`;

const HOST_ROUTES = `
  // ═══ [${MARK}] ① B 站发布日志：浮窗里能审查"我发了什么" ═══
  route(ctx, 'GET', '/api/qqbot-settings/bili-log', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const limit = Math.max(1, Math.min(80, Number(u.searchParams.get('limit') || 20) || 20));
      const bot = nsBot(String(u.searchParams.get('ns') || ''));
      const root = resolveMemoryRoot(bot);
      const rows = [];
      const pushRow = (o, src) => {
        if (!o || typeof o !== 'object') return;
        const at = Number(o.ts || o.at || 0) || 0;
        const dynId = String(o.dynamicId || o.dyn_id || '');
        rows.push({
          src,
          at,
          type: String(o.type || (src === 'dynamic' ? 'dynamic' : 'log')),
          text: String(o.text || o.title || o.summary || o.desc || '').trim(),
          url: String(o.url || (dynId ? 'https://t.bilibili.com/' + dynId : '')),
          dynamicId: dynId,
          jobId: String(o.jobId || ''),
          ok: o.ok === false ? false : true,
          err: String(o.error || ''),
          via: String(o.via || ''),
        });
      };
      try {
        const p1 = join(root, '.qqbot', 'bili-dynamic-log.jsonl');
        if (existsSync(p1)) {
          for (const line of readFileSync(p1, 'utf8').split(String.fromCharCode(10))) {
            const t = line.trim();
            if (!t) continue;
            try { pushRow(JSON.parse(t), 'dynamic'); } catch { }
          }
        }
      } catch { }
      try {
        const p2 = join(root, '.qqbot', 'bili-ops', 'records.jsonl');
        if (existsSync(p2)) {
          for (const line of readFileSync(p2, 'utf8').split(String.fromCharCode(10))) {
            const t = line.trim();
            if (!t) continue;
            try { pushRow(JSON.parse(t), 'ops'); } catch { }
          }
        }
      } catch { }
      rows.sort((a, b) => b.at - a.at);
      return writeJson(res, 200, { ok: true, root, total: rows.length, rows: rows.slice(0, limit) });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // ═══ [${MARK}] ② 语音合成方案：列清楚、选得动、真写 voice-config.json ═══
  const TTS_ENGINES = [
    {
      id: 'edge', label: 'edge 在线（微软）', kind: 'cloud', port: 0,
      voices: ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural'],
      speed: '≈0.5×实时 · 零显存 · 要联网',
      use: '本地服务没起时的兜底；音质一般但最稳',
    },
    {
      id: 'gsv', label: 'GPT-SoVITS 本地', kind: 'local', port: 9880, dir: '.models/gpt-sovits',
      voices: ['xiaolan', 'gentle'],
      speed: '聊天实时首选（6GB 卡够）',
      use: '群聊发语音条：5 秒参考音就能克隆',
    },
    {
      id: 'breeze', label: 'Breeze TTS 2 int8-hybrid', kind: 'local', port: 7860, dir: '.models/breeze-tts2',
      voices: ['breeze', 'breeze_design'],
      speed: '≈0.10×实时（3.8s 音频要 38s）',
      use: '离线成片配音：音色自然、慢，不适合抢答',
    },
    {
      id: 'index', label: 'IndexTTS-2.5（情感克隆）', kind: 'local', port: 9890, dir: '.models/index-tts',
      voices: ['xiaolan_emo', 'xiaolan_emo_soft'],
      speed: 'RTF≈22-30（比 GSV 慢约 25 倍）',
      use: '离线视频配音 / 读评论：情感最足',
    },
  ];

  function dirSizeSync(p) {
    try {
      if (!p || !existsSync(p)) return 0;
      const st = statSync(p);
      if (st.isFile()) return st.size;
      let sum = 0;
      for (const f of readdirSync(p)) sum += dirSizeSync(join(p, f));
      return sum;
    } catch { return 0; }
  }

  async function probePort(port) {
    if (!port) return false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1200);
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: ac.signal });
      return !!r && (r.ok || r.status === 404 || r.status === 405 || r.status === 400);
    } catch {
      try {
        const r2 = await fetch('http://127.0.0.1:' + port + '/', { signal: ac.signal });
        return !!r2;
      } catch { return false; }
    } finally { clearTimeout(timer); }
  }

  route(ctx, 'GET', '/api/qqbot-settings/tts-engines', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(String(u.searchParams.get('ns') || ''));
      const root = resolveMemoryRoot(bot);
      const cfg = readExtCfg(extCfgPath(root, 'voice'));
      const adapterUp = await probePort(9881);
      const engines = [];
      for (const e of TTS_ENGINES) {
        const up = e.port ? await probePort(e.port) : true;
        const sizeBytes = e.dir ? dirSizeSync(join(root, '..', '..', e.dir)) : 0;
        const sizeAlt = e.dir ? dirSizeSync(join('F:/qqbot', e.dir)) : 0;
        engines.push({
          id: e.id, label: e.label, kind: e.kind, port: e.port, voices: e.voices,
          speed: e.speed, use: e.use,
          up: e.id === 'edge' ? true : (e.port === 9880 || e.port === 9890 ? (up || adapterUp) : up),
          rawUp: up,
          sizeGB: Math.round(((sizeBytes || sizeAlt) / (1024 * 1024 * 1024)) * 100) / 100,
          dir: e.dir || '',
        });
      }
      const cur = String(cfg.model || '');
      const curEngine = String(cfg.provider || 'edge') === 'edge' ? 'edge' : (TTS_ENGINES.find((x) => x.id === cur) ? cur : 'gsv');
      return writeJson(res, 200, {
        ok: true, root, path: extCfgPath(root, 'voice'), config: cfg,
        adapter: { port: 9881, up: adapterUp, endpoint: 'http://127.0.0.1:9881/v1/audio/speech' },
        current: { engine: curEngine, provider: String(cfg.provider || 'edge'), model: cur, voice: String(cfg.voice || ''), mode: String(cfg.mode || 'sometimes'), prob: cfg.prob },
        engines,
      });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  route(ctx, 'POST', '/api/qqbot-settings/tts-engines', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const engineId = String((body && body.engine) || '').trim();
      const wanted = TTS_ENGINES.find((x) => x.id === engineId);
      if (!wanted) return writeJson(res, 400, { ok: false, error: '未知方案：' + engineId });
      const bot = nsBot(String((body && body.ns) || ''));
      const root = resolveMemoryRoot(bot);
      const p = extCfgPath(root, 'voice');
      if (!p) return writeJson(res, 400, { ok: false, error: '找不到数据目录' });
      const cur = readExtCfg(p);
      const voice = String((body && body.voice) || '').trim() || wanted.voices[0] || '';
      const patch = engineId === 'edge'
        ? { provider: 'edge', voice, endpoint: 'http://127.0.0.1:9881/v1/audio/speech', model: '' }
        : { provider: 'http', voice, model: engineId, endpoint: 'http://127.0.0.1:9881/v1/audio/speech' };
      if (body && typeof body.mode === 'string' && body.mode) patch.mode = body.mode;
      if (body && typeof body.prob === 'number') patch.prob = Math.max(0, Math.min(1, body.prob));
      const next = Object.assign({}, cur, patch);
      for (const k of ['systemPrompt', 'baseUrl']) if (next[k] === '') delete next[k];
      try {
        if (existsSync(p)) copyFileSync(p, p + '.bak-' + Date.now());
      } catch { }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
      const up = wanted.port ? await probePort(wanted.port) : true;
      return writeJson(res, 200, {
        ok: true, engine: engineId, path: p, config: readExtCfg(p), up,
        note: up ? '' : ('端口 ' + wanted.port + ' 没开：' + engineId + ' 现在合成会失败，先跑 skills/local-tts/scripts/start-services.ps1 -Backend adapter'),
      });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // ═══ [${MARK}] ③ 打开任意产物目录（explorer → cmd start → PowerShell，三重兜底）═══
  route(ctx, 'POST', '/api/qqbot-settings/open-dir', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const bot = nsBot(String((body && body.ns) || ''));
      const root = resolveMemoryRoot(bot);
      let dir = String((body && body.path) || '').trim();
      if (!dir && body && body.jobId) {
        const lib = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'bili-ops.mjs').split(String.fromCharCode(92)).join('/'));
        const job = lib.getJob(root, String(body.jobId));
        dir = (job && job.dir) || '';
      }
      if (!dir) return writeJson(res, 400, { ok: false, error: '缺 path 或 jobId' });
      const abs = resolve(dir);
      const okRoot = root && (abs === resolve(root) || abs.startsWith(resolve(root) + sep));
      const okExtra = /^F:[\\\\/]qqbot[\\\\/]\.models[\\\\/]/i.test(abs) || /^F:[\\\\/]qqbot[\\\\/]skills[\\\\/]/i.test(abs);
      if (!okRoot && !okExtra) return writeJson(res, 200, { ok: false, path: abs, error: '目录不在数据根里，拒绝打开' });
      try { if (!existsSync(abs)) mkdirSync(abs, { recursive: true }); } catch { }
      const tries = [
        ['explorer', [abs]],
        ['cmd', ['/c', 'start', '', abs]],
        ['powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', 'Start-Process -FilePath explorer.exe -ArgumentList """' + abs + '"""']],
      ];
      let last = '';
      for (const [cmd, args] of tries) {
        try {
          const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
          c.on?.('error', () => { });
          c.unref();
          return writeJson(res, 200, { ok: true, path: abs, via: cmd, msg: '已打开 ' + abs });
        } catch (e) {
          last = String((e && e.message) || e);
        }
      }
      return writeJson(res, 200, { ok: false, path: abs, error: '调不起资源管理器：' + last });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // ═══ [${MARK}] ③ 出图/视频方案：模型路径、大小、服务状态 ═══
  route(ctx, 'GET', '/api/qqbot-settings/draw-info', async (req, res) => {
    try {
      const bot = nsBot(String(new URL(req.url ?? '/', 'http://x').searchParams.get('ns') || ''));
      const root = resolveMemoryRoot(bot);
      const draw = readExtCfg(join(root, '.qqbot-extensions', 'draw-config.json'));
      const active = String(draw.activeProfile || 'balanced');
      const prof = (draw.profiles && draw.profiles[active]) || {};
      const modelPath = String(prof.modelPath || prof.model || '').trim();
      const modelSize = modelPath ? dirSizeSync(modelPath) : 0;
      const sdUp = await probePort(7861);
      const jobsDir = join(root, '.qqbot', 'bili-ops', 'jobs');
      let jobCount = 0;
      try { jobCount = existsSync(jobsDir) ? readdirSync(jobsDir).length : 0; } catch { }
      return writeJson(res, 200, {
        ok: true, root,
        draw: {
          activeProfile: active,
          profiles: Object.keys(draw.profiles || {}),
          modelPath,
          modelSizeGB: Math.round((modelSize / (1024 * 1024 * 1024)) * 100) / 100,
          sdServer: { port: 7861, up: sdUp },
        },
        video: {
          jobsDir,
          jobCount,
          ffmpeg: 'F:/qqbot/.venv-draw/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe',
          skillFrameRender: 'F:/qqbot/skills/video-frame-render/scripts/render.py',
          skillH3: 'F:/qqbot/skills/h3-video/SKILL.md',
        },
        tts: { adapter: 'F:/qqbot/skills/local-tts/adapter/server.py', dir: 'F:/qqbot/.models' },
      });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });
`;

// ───────────────────────────── client 段 ─────────────────────────────

const CLIENT_LOG_DIV = `
          + '<div id="dk-bili-log" style="font-size:11px;color:#555;line-height:1.65;margin:2px 0 6px">（发布日志加载中…）</div>'
`;

const CLIENT_LOG_JS = `
        // [${MARK}] ① 发布日志：把我发出去的动态/投稿记录摊在面板里，能点能复制
        async function loadBiliLog() {
          var box = document.querySelector('#dk-bili-log')
          if (!box) return
          try {
            var r = await api('bili-log', 'limit=12')
            if (!r || !r.ok) { box.innerHTML = '<span style="color:#c00">读发布日志失败：' + esc((r && r.error) || '?') + '</span>'; return }
            var rows = r.rows || []
            if (!rows.length) { box.innerHTML = '<span style="color:#999">还没有发布记录 —— 让她发一条动态试试（工具 action=post）</span>'; return }
            box.innerHTML = '<div style="font-weight:700;color:#333;margin:0 0 2px">📝 发布日志（最近 ' + rows.length + ' 条 · 共 ' + (r.total || rows.length) + '）</div>'
              + rows.map(function (it) {
                var t = new Date(Number(it.at) || Date.now())
                var hh = (t.getMonth() + 1) + '/' + t.getDate() + ' ' + ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2)
                var tagCol = it.src === 'dynamic' ? '#1971c2' : '#5f3dc4'
                var tag = it.src === 'dynamic' ? '动态' : (it.type || 'ops')
                return '<div style="border-bottom:1px dashed #eee;padding:3px 0">'
                  + '<span style="color:#adb5bd">' + hh + '</span> '
                  + '<b style="color:' + tagCol + '">' + esc(tag) + '</b> '
                  + '<span style="color:#495057">' + esc(String(it.text || it.err || '（无正文）').slice(0, 46)) + '</span>'
                  + (it.url ? ' <a href="' + esc(it.url) + '" target="_blank" style="color:#1971c2">打开 ↗</a>' : '')
                  + (it.jobId ? ' <span style="color:#868e96">' + esc(it.jobId) + '</span>' : '')
                  + '</div>'
              }).join('')
          } catch (e) { box.innerHTML = '<span style="color:#c00">读发布日志失败：' + esc((e && e.message) || e) + '</span>' }
        }
        // [${MARK}] ③ 出图/视频方案：模型路径与大小写在面板上，别让人猜
        async function loadDrawInfo() {
          var box = document.querySelector('#dk-bili-scheme')
          if (!box) return
          try {
            var r = await api('draw-info', '')
            if (!r || !r.ok) { box.textContent = '方案信息读取失败：' + ((r && r.error) || '?'); return }
            var d = r.draw || {}
            var v = r.video || {}
            box.innerHTML = '<span style="color:#1971c2">🖼 本地 SD</span> '
              + esc(d.activeProfile || '?') + ' · ' + esc(d.modelPath ? String(d.modelPath).split('/').slice(-1)[0] : '未配置')
              + ' · ' + (d.modelSizeGB || 0) + 'GB · ' + (d.sdServer && d.sdServer.up ? '服务在线:7861' : '服务未起:7861')
              + '<br><span style="color:#5f3dc4">🎞 视频</span> 逐帧渲染 skill: ' + esc(String(v.skillFrameRender || ''))
              + ' · ffmpeg: ' + esc(String(v.ffmpeg || '').split('/').slice(-1)[0])
              + ' · 产物: ' + esc(String(v.jobsDir || '')) + '（' + (v.jobCount || 0) + ' 个任务）'
          } catch (e) { box.textContent = '方案信息读取失败：' + ((e && e.message) || e) }
        }
`;

const CLIENT_ROOT_BTN_OLD = `        var rootBtn = document.querySelector('#dk-bili-open-root')
        if (rootBtn) rootBtn.onclick = async function () {
          try {
            var r = await apiPost('bili', { action: 'open-root' })
            if (r && r.ok === false) alert(r.error || '打开失败')
            else if (r && r.path) alert('产物根目录：\\n' + r.path + '\\n\\n如果资源管理器没有弹出，把上面的路径复制过去。')
          } catch (e) { alert('打开失败：' + ((e && e.message) || e)) }
        }
`;

const CLIENT_ROOT_BTN_NEW = `        var rootBtn = document.querySelector('#dk-bili-open-root')
        if (rootBtn) rootBtn.onclick = async function () {
          try {
            // [${MARK}] ③ 走新的 /open-dir：三重兜底，且无论成败都把路径摊出来可复制
            var r = await apiPost('open-dir', { path: 'F:/qqbot/dshqqbot/.qqbot/bili-ops/jobs' })
            var p = (r && r.path) || 'F:/qqbot/dshqqbot/.qqbot/bili-ops/jobs'
            var okText = (r && r.ok) ? ('已打开（' + ((r && r.via) || 'explorer') + '）') : ('没弹出来：' + ((r && r.error) || '未知原因'))
            try { await navigator.clipboard.writeText(p) } catch (e) { }
            alert(okText + '\\n\\n产物目录（已复制到剪贴板）：\\n' + p)
          } catch (e) { alert('打开失败：' + ((e && e.message) || e)) }
        }
`;

const CLIENT_TTS_DIV = `
        html += '<div id="dk-tts-engines" style="margin:6px 0 4px;font-size:12px">（语音方案读取中…）</div>'
`;

const CLIENT_TTS_JS = `
      // [${MARK}] ② 语音方案：把四套引擎的端口/模型大小/速度摊开，点一下真写 voice-config.json
      function ttsEngineRows(d) {
        var cur = (d && d.current) || {}
        var eng = (d && d.engines) || []
        return eng.map(function (e) {
          var on = String(cur.engine || '') === e.id
          var upTxt = e.id === 'edge' ? '在线接口' : (e.up ? '● 在线' : '○ 没起')
          var upCol = e.id === 'edge' ? '#868e96' : (e.up ? '#2f9e44' : '#e8590c')
          return '<label style="display:flex;gap:6px;align-items:flex-start;padding:5px 7px;border:1px solid ' + (on ? '#4d6bfe' : '#e9ecef') + ';border-radius:8px;margin:0 0 5px;cursor:pointer;background:' + (on ? '#f3f6ff' : '#fff') + '">'
            + '<input type="radio" name="dk-tts-engine" value="' + esc(e.id) + '"' + (on ? ' checked' : '') + ' style="margin-top:2px">'
            + '<span style="flex:1;min-width:0">'
            + '<b style="font-size:12.5px">' + esc(e.label) + '</b> '
            + '<span style="color:' + upCol + ';font-size:11px">' + upTxt + (e.port ? (' :' + e.port) : '') + '</span>'
            + (e.sizeGB ? ' <span style="color:#868e96;font-size:11px">· 模型 ' + e.sizeGB + 'GB</span>' : ' <span style="color:#868e96;font-size:11px">· 不占盘</span>')
            + '<div style="color:#495057;font-size:11px">' + esc(e.speed) + '</div>'
            + '<div style="color:#868e96;font-size:11px">' + esc(e.use) + '</div>'
            + '</span></label>'
        }).join('')
      }
      async function loadTtsEngines() {
        var box = panel ? panel.querySelector('#dk-tts-engines') : null
        if (!box) return
        try {
          var d = await api('tts-engines', '')
          if (!d || !d.ok) { box.textContent = '语音方案读取失败：' + ((d && d.error) || '?'); return }
          state.ttsEngines = d
          box.innerHTML = '<div style="font-weight:700;font-size:13px;margin:0 0 4px">🎚 语音合成方案（选一个 → 保存）</div>'
            + ttsEngineRows(d)
            + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
            + '<button class="dk-btn ok" id="dk-tts-apply" style="font-size:12px;padding:1px 10px">✔ 用这个方案</button>'
            + '<button class="dk-btn" id="dk-tts-probe" style="font-size:12px;padding:1px 10px">🔄 重新探测</button>'
            + '<span class="dk-msg" id="dk-tts-hint" style="font-size:11px"></span></div>'
            + '<div style="font-size:11px;color:#868e96;line-height:1.6;margin-top:2px">适配层 ' + esc((d.adapter && d.adapter.endpoint) || '') + ' · ' + ((d.adapter && d.adapter.up) ? '在工作' : '没起') + '；方案切换只改 voice-config.json，下一条语音生效。</div>'
          var ap = box.querySelector('#dk-tts-apply')
          if (ap) ap.onclick = async function () {
            var sel = box.querySelector('input[name="dk-tts-engine"]:checked')
            var id = sel ? sel.value : ''
            var hint = box.querySelector('#dk-tts-hint')
            if (!id) { if (hint) hint.textContent = '先选一个方案'; return }
            if (hint) hint.textContent = '保存中…'
            try {
              var r = await apiPost('tts-engines', { engine: id })
              if (hint) {
                hint.style.color = (r && r.ok) ? '#2f9e44' : '#e03131'
                hint.textContent = (r && r.ok) ? ('已切到 ' + id + (r.note ? ('（' + r.note + '）') : '') + ' · 下一条生效') : ('失败：' + ((r && r.error) || '?'))
              }
              loadTtsEngines()
            } catch (e) { if (hint) hint.textContent = '失败：' + ((e && e.message) || e) }
          }
          var pb = box.querySelector('#dk-tts-probe')
          if (pb) pb.onclick = function () { loadTtsEngines() }
        } catch (e) { box.textContent = '语音方案读取失败：' + ((e && e.message) || e) }
      }
`;

const CLIENT_SCHEME_DIV = `
          + '<div id="dk-bili-scheme" style="font-size:11px;color:#555;line-height:1.6;margin:2px 0 4px"></div>'
`;

// ───────────────────────────── 执行 ─────────────────────────────

const ops = [
  // host
  {
    file: HOST, name: 'host-kchat-msghistory',
    run: (s) => beforePattern(
      s,
      'const _kcLog = join(_kcRoot, ".qqbot", "local-answer-log.jsonl");',
      /\n\s*\}\n\s*\} catch \{ \}\n\s*\}\n\s*\} catch \{ \}\n\s*const chats/,
      HOST_KCHAT,
    ),
  },
  {
    file: HOST, name: 'host-routes',
    run: (s) => before(s, "  route(ctx, ['GET', 'POST'], '/api/qqbot-settings/timers'", HOST_ROUTES),
  },
  // client
  {
    file: CLIENT, name: 'client-log-div',
    run: (s) => after(s, `+ '<div id="dk-bili-state" style="font-size:11px;color:#888;margin:4px 0 6px">加载中…</div>'`, CLIENT_LOG_DIV),
  },
  {
    file: CLIENT, name: 'client-scheme-div',
    run: (s) => after(s, `+ '<span id="dk-bili-planstate" style="font-size:11px;color:#999"></span>'`, '\n' + CLIENT_SCHEME_DIV.trimStart()),
  },
  {
    file: CLIENT, name: 'client-log-js',
    run: (s) => before(s, "        var rootBtn = document.querySelector('#dk-bili-open-root')", CLIENT_LOG_JS),
  },
  {
    file: CLIENT, name: 'client-root-btn',
    run: (s) => {
      if (!s.includes(CLIENT_ROOT_BTN_OLD.trim().split('\n')[0])) return { ok: false, why: '找不到 open-root 处理块' };
      if (s.includes('[qqbot-mod] panel-v3] ③ 走新的 /open-dir')) return { ok: true, src: s, skip: true };
      const i = s.indexOf(CLIENT_ROOT_BTN_OLD);
      if (i < 0) return { ok: false, why: '找不到 open-root 处理块（逐行不匹配）' };
      return { ok: true, src: s.slice(0, i) + CLIENT_ROOT_BTN_NEW + s.slice(i + CLIENT_ROOT_BTN_OLD.length) };
    },
  },
  {
    file: CLIENT, name: 'client-log-call',
    run: (s) => after(s, "        if (rootBtn) rootBtn.onclick = async function () {", ''), // 占位（无操作）
  },
  {
    file: CLIENT, name: 'client-tts-div',
    run: (s) => before(
      s,
      `html += '<div class="dk-msg" style="font-size:11px;color:#888;line-height:1.6">本地模型=本机`,
      CLIENT_TTS_DIV,
    ),
  },
  {
    file: CLIENT, name: 'client-tts-js',
    run: (s) => before(s, '      function bindExtCard() {', CLIENT_TTS_JS),
  },
  {
    file: CLIENT, name: 'client-tts-bind',
    run: (s) => after(
      s,
      "        if (panel.querySelector('#dk-llm-model') || panel.querySelector('#dk-vc-voice')) loadExtCfg()",
      '\n        loadTtsEngines()',
    ),
  },
  {
    file: CLIENT, name: 'client-log-load',
    run: (s) => after(
      s,
      "        var rf = document.querySelector('#dk-bili-refresh')\n        if (rf) rf.onclick = load",
      '\n        loadBiliLog()\n        loadDrawInfo()',
    ),
  },
];

const apply = process.argv.includes('--apply');
announce('fix-panel-v3');
let changed = 0;
const cache = new Map();
for (const op of ops) {
  if (!cache.has(op.file)) {
    if (!existsSync(op.file)) { console.error('✗ 找不到目标文件：' + op.file); process.exit(2); }
    cache.set(op.file, norm(readFileSync(op.file, 'utf8')));
  }
  const src = cache.get(op.file);
  if (op.name === 'client-log-call') continue;
  const res = op.run(src);
  if (!res.ok) { console.error('  ✗ ' + op.name + '：' + res.why); process.exit(3); }
  if (res.skip) { console.log('  = ' + op.name + ' 已是新版'); continue; }
  cache.set(op.file, res.src);
  changed += 1;
  console.log('  ✔ ' + op.name);
}

if (!changed) { console.log('= 已是最新，无需写入'); process.exit(0); }
if (!apply) { console.log('--check：需要写入 ' + changed + ' 处（加 --apply 落盘）'); process.exit(0); }

for (const [file, src] of cache) {
  const backup = file + '.orig-muu';
  try { if (existsSync(file)) copyFileSync(file, backup); } catch { }
  writeFileSync(file, denorm(src), 'utf8');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log('  ✔ 语法检查通过：' + file.split(/[\\/]/).pop());
  } catch (e) {
    copyFileSync(backup, file);
    console.error('  ✗ 语法检查失败，已回滚：' + String(e.stderr || e.message));
    process.exit(4);
  }
}
console.log('✔ 已写入 ' + cache.size + ' 个文件（备份 *.orig-muu）');
