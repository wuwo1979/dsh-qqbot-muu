#!/usr/bin/env node
/**
 * render_pet_v3.mjs — 多形态桌宠批量渲染（2026-10-31 v4：pet 统一渲染入口）
 *
 * 形态即配置（主人 2026-10-31 定：统一各 pet，渲染只认各形态自己的姿势集）：
 *   xiaolan — pet2：char-v2/pose-render 立绘（主人唯一满意的 2D 形象），6 动作全套，
 *             fit=0.86（举手姿势几乎顶满画布，不缩会出框，2026-11-01 主人反馈）；
 *             产物覆盖 harness dsh-pet/pet/xiaolan-animation/（小蓝桌面形象）。
 *   classic — pet1：原版少女 char-pet/pose（640×360 原生画幅），6 动作全套，
 *             产物落 harness dsh-pet/pet/classic-animation/（注册 classic-config.json）。
 *   pet3    — char-v3 de 娘（Claude 皮，形象接近大肥鱼），目前只有 happy 一姿势
 *             （抠图版 happy-alpha.png，画幅顶满 → fit=0.82），待机+开心两条；
 *             产物落 harness dsh-pet/pet/de-animation/（注册 de-config.json）。
 *
 * 姿势归一：poses 先经 align_char_poses.py 平移对齐（下半身中心+脚底基线），切姿势不跳。
 * 动作：remotion/PetAnim.jsx（待机=真静止，其余姿势切换+挤压拉伸）。
 *
 * 用法：cd F:\qqbot && node skills/video-frame-render/scripts/render_pet_v3.mjs [--form xiaolan|classic|pet3]
 */
import { writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

const REPO = 'F:/qqbot';
const PET_ROOT = join(process.env.APPDATA || '', 'dsh-desktop', 'harness', 'dsh-pet', 'pet');
const PET_DIR = join(PET_ROOT, 'xiaolan-animation');
const CLASSIC_DIR = join(PET_ROOT, 'classic-animation');
const DE_DIR = join(PET_ROOT, 'de-animation');

// ── 形态注册表：加新 pet = 在这里加一个条目 ─────────────────────────────
const PET_FORMS = {
  xiaolan: {
    label: 'pet2（char-v2 立绘）',
    poseDir: join(REPO, 'assets/char-v2/pose-render'),
    // PetAnim 姿势槽 → 素材文件（lift 缺素材，暂复用站姿）
    poses: { stand: 'idle.png', wave: 'wave.png', cheer: 'happy.png', talk: 'talk.png', point: 'point.png', lift: 'idle.png' },
    canvas: { width: 540, height: 720 },
    fit: 0.86, // 举手姿势 bbox 距顶仅 1.5%，不缩动作必出框（2026-11-01 主人反馈）
    jobs: [
      { file: '小蓝-待机', motion: 'idle-cute', seconds: 3.6 },
      { file: '小蓝-挥手', motion: 'wave-hello', seconds: 3.4 },
      { file: '小蓝-开心', motion: 'happy-jump', seconds: 3.0 },
      { file: '小蓝-说话', motion: 'talk-babble', seconds: 3.6 },
      { file: '小蓝-指', motion: 'point-out', seconds: 2.4 },
      { file: '小蓝-被拎起', motion: 'lift-dangle', seconds: 2.8 },
    ],
    deployDir: PET_DIR, // 覆盖桌面小蓝（初版备份 assets/pet-xiaolan-backup/20261031/）
  },
  classic: {
    label: 'pet1（原版少女）',
    poseDir: join(REPO, 'assets/char-pet/pose'),
    poses: { stand: 'stand.png', wave: 'wave.png', cheer: 'cheer.png', talk: 'talk.png', point: 'point.png', lift: 'lift.png' },
    canvas: { width: 640, height: 360 }, // 原版桌宠原生画幅，素材零缩放不失真
    fit: 0.94,
    jobs: [
      { file: '小蓝-待机', motion: 'idle-cute', seconds: 3.6 },
      { file: '小蓝-挥手', motion: 'wave-hello', seconds: 3.4 },
      { file: '小蓝-开心', motion: 'happy-jump', seconds: 3.0 },
      { file: '小蓝-说话', motion: 'talk-babble', seconds: 3.6 },
      { file: '小蓝-指', motion: 'point-out', seconds: 2.4 },
      { file: '小蓝-被拎起', motion: 'lift-dangle', seconds: 2.8 },
    ],
    deployDir: CLASSIC_DIR, // 桌面第二形态（classic-config.json 已注册）
  },
  pet3: {
    label: 'pet3（char-v3 de 娘）',
    poseDir: join(REPO, 'assets/char-v3'),
    // 目前只有 happy 一个姿势（抠图版）；补素材后在 poses/jobs 里加行
    poses: { stand: 'happy-alpha.png', cheer: 'happy-alpha.png' },
    canvas: { width: 540, height: 540 },
    fit: 0.82, // 素材 bbox 顶满画幅，留动作余量
    jobs: [
      { file: 'de娘-待机', motion: 'idle-cute', seconds: 3.6 },
      { file: 'de娘-开心', motion: 'happy-jump', seconds: 3.0 },
    ],
    deployDir: DE_DIR, // 桌面第三形态（de-config.json 已注册）
  },
};

function run(cmd, args, timeout = 300000) {
  return new Promise((done) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16e6 }, (err, so, se) => {
      done({ err, out: String(so || '') + String(se || '') });
    });
  });
}

const only = process.argv.includes('--form') ? process.argv[process.argv.indexOf('--form') + 1] : null;
const t0 = Date.now();
let ok = 0, fail = 0;

for (const [formId, form] of Object.entries(PET_FORMS)) {
  if (only && formId !== only) continue;
  console.log(`\n════ ${formId}（${form.label}）════`);
  const outDir = form.outDir || join(REPO, 'tmp', 'pet-v3');
  mkdirSync(outDir, { recursive: true });

  const poses = {};
  let missing = false;
  for (const [slot, file] of Object.entries(form.poses)) {
    const p = join(form.poseDir, file);
    if (!existsSync(p)) { console.error(`✘ 缺姿势素材 ${slot}: ${p}`); missing = true; break; }
    poses[slot] = p;
  }
  if (missing) { fail++; continue; }

  for (const job of form.jobs) {
    const spec = {
      poses,
      motion: job.motion,
      seconds: job.seconds,
      fps: 30,
      width: form.canvas.width,
      height: form.canvas.height,
      shadow: true,
      fit: form.fit || 1,
      out: join(outDir, `${job.file}.webm`),
    };
    const specPath = join(outDir, `${job.file}.spec.json`);
    writeFileSync(specPath, JSON.stringify(spec, null, 1));
    console.log(`── 渲染 ${job.file}（${job.motion}，${job.seconds}s，${form.canvas.width}x${form.canvas.height}）`);
    const r = await run(process.execPath, [join(REPO, 'skills/video-frame-render/scripts/render_remotion.mjs'), '--spec', specPath], 600000);
    const out = spec.out;
    if (r.err || !existsSync(out) || statSync(out).size < 10000) {
      console.error(`  ✘ 失败: ${String(r.err && r.err.message).slice(0, 120)}\n${r.out.split('\n').slice(-4).join('\n')}`);
      fail++;
      continue;
    }
    console.log(`  ✔ webm ${Math.round(statSync(out).size / 1024)}KB`);
    if (form.deployDir && existsSync(form.deployDir)) {
      copyFileSync(out, join(form.deployDir, `${job.file}.webm`));
      console.log(`  ✔ 已部署: ${join(form.deployDir, job.file + '.webm')}`);
    }
    ok++;
  }
}

console.log(`\n完成：成功 ${ok} / 失败 ${fail}，总耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
process.exit(fail ? 1 : 0);
