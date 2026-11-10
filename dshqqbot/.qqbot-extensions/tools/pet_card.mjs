/**
 * pet_card — 生成一张小蓝形象卡（竖版 PNG），可顺手发到群或私聊
 *
 * 主人 2026-10-31：「其它人（管理员或群友）也能看到小蓝的形象，在手机上或电脑上，
 * 要轻量的那种」。
 * 做法只用了本机现有能力：PIL 合成一张 1080×1920 的图（形态配色底 + 立绘 + 一句状态），
 * 要发就交给现成的 qq_send —— 不架服务、不开端口、不占显存。
 *
 * 两套形态：xiaolan（小蓝）/ muu（普通大肥鱼）；每套形态下可换皮肤（outfit），
 * 资产与命名见 assets/pet-outfits/manifest.json，切换偏好按形态分开存、互不干扰。
 *
 * 用法：
 *   { form:'xiaolan', pose:'idle', outfit:'sakura', text:'今天想带你们看海' }   → 只出图
 *   { form:'muu', outfit:'sunset', send:true, target:'群名' }                    → 出图并发送
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formInfo, outfitsOf, currentOutfit, setOutfit, posePath, poseFallback, outfitInfo, defaultOutfit,
} from '../lib/pet-outfits.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');            // F:\qqbot
const PY_SCRIPT = join(REPO, 'qqbot-mod', 'scripts', 'pet_card.py');
const FORMS = ['xiaolan', 'muu'];
const POSES = ['idle', 'talk', 'wave', 'happy', 'point', 'stand'];

function loadDrawCfg(root) {
  try { return JSON.parse(readFileSync(join(String(root), '.qqbot-extensions', 'draw-config.json'), 'utf8')); } catch { return {}; }
}

function resolvePython(cfg) {
  const p = String(cfg.pythonBin || '').trim();
  if (p && existsSync(p)) return p;
  const fallback = 'F:/qqbot/.venv-draw/Scripts/python.exe';
  return existsSync(fallback) ? fallback : 'python';
}

function runPython(py, args, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(py, args, { stdio: 'ignore', windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, reason: 'spawn: ' + (e instanceof Error ? e.message : String(e)) });
    }
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, reason: 'spawn: ' + (e instanceof Error ? e.message : String(e)) });
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, reason: code === 0 ? '' : 'exit-' + code });
    });
  });
}

export default {
  name: 'pet_card',
  expose: 'all',
  description: '生成竖版形象卡（PNG，1080×1920，形态配色底+立绘+一句状态），支持小蓝/大肥鱼两套形态与皮肤，可选直接发到群/私聊。轻量：本机 PIL 合成，不架服务、不联网',
  inputSchema: {
    form: { type: 'string', enum: FORMS, description: '形态：xiaolan=小蓝（默认），muu=普通大肥鱼' },
    outfit: { type: 'string', description: '皮肤 id：xiaolan=default/deepsea/sakura/moon；muu=default/sunset/night/mint。不填沿用当前偏好' },
    pose: { type: 'string', enum: POSES, description: '用哪张立绘（默认按形态：小蓝 idle / 大肥鱼 stand）' },
    text: { type: 'string', description: '卡上那句状态字（一句话就够，最多 4 行）' },
    send: { type: 'boolean', description: 'true = 出图后直接发出去（需配 target）' },
    target: { type: 'string', description: 'send=true 时必填：群名 / 昵称 / openid（规则同 qq_send）' },
    scope: { type: 'string', enum: ['group', 'c2c'], description: 'send=true 时的目标类型（按名字发可省）' },
  },
  run: async (args, env) => {
    const root = String((env && env.caps && env.caps.dataRoot) || (env && env.dataRoot) || '').trim()
      || join(REPO, 'dshqqbot');
    if (!existsSync(PY_SCRIPT)) return { ok: false, msg: '找不到渲染脚本：' + PY_SCRIPT };

    const form = FORMS.includes(String(args.form || '')) ? String(args.form) : 'xiaolan';
    const info = formInfo(form);
    if (!info) return { ok: false, msg: `找不到形态配置：${form}（检查 assets/pet-outfits/manifest.json）` };
    let outfit = String(args.outfit || '').trim();
    if (outfit && outfitInfo(form, outfit)) setOutfit(root, form, outfit);
    if (!outfit || !outfitInfo(form, outfit)) outfit = currentOutfit(root, form);
    const outfitMeta = outfitInfo(form, outfit) || {};
    const pal = outfitMeta.palette || {};
    const pose = poseFallback(form, POSES.includes(String(args.pose || '')) ? String(args.pose) : '');
    const poseFile = posePath(form, outfit, pose);
    if (!existsSync(poseFile)) return { ok: false, msg: `立绘不存在：${poseFile}` };
    const credit = `${info.displayName || form} · ${info.title || ''}${outfit !== defaultOutfit(form) ? ' · ' + (outfitMeta.name || outfit) : ''}`;
    const text = String(args.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    // 落 {dataRoot}/pet-cards：宿主对 .qqbot 子目录有写限制（PIL 会 EPERM），别往里塞
    const dir = join(root, 'pet-cards');
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const out = join(dir, `pet-${form}-${outfit}-${pose}-${Date.now()}.png`);
    // 这台机器上 python 子进程写不进 {dataRoot}（EPERM），所以先渲染到工作区暂存目录，再由 node 搬过去
    const stage = join(REPO, 'tmp', 'qqbot-pet');
    try { mkdirSync(stage, { recursive: true }); } catch { /* ignore */ }
    const tmpOut = join(stage, `pet-${process.pid}-${Date.now()}.png`);

    const py = resolvePython(loadDrawCfg(root));
    const pyArgs = [
      PY_SCRIPT, '--out', tmpOut, '--pose', poseFile, '--text', text,
      '--credit', credit, '--accent', String(pal.accent || '#7fd7ff'),
      '--form', form, '--outfit', outfit, '--outfit-name', String(outfitMeta.name || outfit),
      '--bg-top', String((pal.bg || [])[0] || '#08131f'),
      '--bg-mid', String((pal.bg || [])[1] || '#103650'),
      '--bg-bottom', String((pal.bg || [])[2] || '#050e16'),
    ];
    const r = await runPython(py, pyArgs);
    if (!r.ok) return { ok: false, msg: `形象卡没画出来（${r.reason}）—— 检查 ${py} 有没有装 Pillow` };
    if (!existsSync(tmpOut)) return { ok: false, msg: '渲染脚本说成功，但文件不在：' + tmpOut };
    try {
      copyFileSync(tmpOut, out);
    } catch (e) {
      return { ok: false, msg: '图生成了但搬不过去：' + (e instanceof Error ? e.message : String(e)) };
    } finally {
      try { rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
    }

    const rel = out.replace(/\\/g, '/');
    if (!(args.send === true || args.send === 'true')) {
      return { ok: true, msg: `形象卡已生成：${rel}（${credit}，1080×1920）。要发就说 send:true + target` };
    }

    const target = String(args.target || '').trim();
    if (!target) return { ok: true, msg: `形象卡已生成：${rel}；但没给 target，所以没发` };
    const qqsend = await import('./qq_send.mjs');
    const s = await qqsend.default.run({
      target,
      scope: args.scope === 'group' ? 'group' : (args.scope === 'c2c' ? 'c2c' : undefined),
      image: rel,
      text: text || '',
    }, env);
    return { ok: !!s.ok, msg: `${rel}\n${s.msg || ''}`.trim() };
  },
};
