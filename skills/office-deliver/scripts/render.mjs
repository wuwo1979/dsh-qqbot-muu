#!/usr/bin/env node
/**
 * render.mjs — 把 docx / xlsx / pptx 变成「能看的图」，用来做版式验收。
 *
 * 两条路，按顺序尝试：
 *  1) LibreOffice（首选）：普通子进程，沙箱里也能跑。
 *     soffice --headless --convert-to pdf  → 再用 pdf2png.py 栅格化 + 拼联系表
 *  2) Office COM（兜底）：PowerPoint 能直接导 PNG，Word/Excel 导 PDF。
 *     但 COM 需要 PowerShell 处于 FullLanguage，也就是**只有 danger-full-access 才能用**；
 *     workspace-write 下会被约束语言模式挡掉（报 CannotCreateTypeConstrainedLanguage）。
 *
 * 用法：
 *   node render.mjs <file> [--out dir] [--dpi 110] [--engine auto|lo|com] [--sheet] [--json]
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const PY = process.env.DSH_PYTHON
  || 'F:/DSH/DSH Desktop/resources/office-runtime/primary-runtime/dependencies/python/python.exe';

const SOFFICE_CANDIDATES = [
  process.env.DSH_LIBREOFFICE || '',
  'F:/qqbot/.tools/libreoffice/program/soffice.exe',
  'C:/Program Files/LibreOffice/program/soffice.exe',
  'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
  '/usr/bin/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
].filter(Boolean);

function log(...a) { console.error('[render]', ...a); }

export function findSoffice() {
  for (const p of SOFFICE_CANDIDATES) {
    if (!p || !existsSync(p)) continue;
    // Windows 上 soffice.exe 是无头转换的坑（会挂住/静默退出），优先用控制台入口 soffice.com
    if (process.platform === 'win32' && /soffice\.exe$/i.test(p)) {
      const com = p.replace(/soffice\.exe$/i, 'soffice.com');
      if (existsSync(com)) return com;
    }
    return p;
  }
  return '';
}

function runLo(file, outDir, soffice) {
  const profile = join(tmpdir(), `lo-profile-${process.pid}-${Date.now()}`);
  const args = [
    '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard',
    `-env:UserInstallation=file:///${profile.replace(/\\/g, '/')}`,
    '--convert-to', 'pdf', '--outdir', outDir, file,
  ];
  // 注意：沙箱里 stdio 走管道会 EPERM，必须 'ignore'（soffice 的输出我们不需要）
  const r = spawnSync(soffice, args, { stdio: 'ignore', timeout: 180000, windowsHide: true });
  if (r.error) throw new Error(`soffice 启动失败：${r.error.message}`);
  const pdf = join(outDir, basename(file, extname(file)) + '.pdf');
  if (!existsSync(pdf)) {
    throw new Error(`soffice 没产出 PDF（exit ${r.status}）：${(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  return pdf;
}

function runCom(file, outDir) {
  const ext = extname(file).toLowerCase();
  const jsonFile = join(outDir, 'com-report.json');
  // PowerShell 不写标准输出（沙箱里管道会 EPERM），结果统一落 com-report.json
  const script = `
$ErrorActionPreference='Stop'
$file='${file.replace(/'/g, "''")}'; $out='${outDir.replace(/'/g, "''")}'
$json='${jsonFile.replace(/'/g, "''")}'
$base=[IO.Path]::GetFileNameWithoutExtension($file)
$res=@{ ok=$true; engine=''; pdf='' }
$app=$null; $docObj=$null
try {
  if ('${ext}' -eq '.pptx' -or '${ext}' -eq '.ppt') {
    $app = New-Object -ComObject PowerPoint.Application
    $docObj = $app.Presentations.Open($file, $true, $false, $false)
    $n = $docObj.Slides.Count
    for ($i=1; $i -le $n; $i++) { $docObj.Slides.Item($i).Export("$out\\slide$i.png", "PNG", 1600, 900) }
    $pdf = "$out\\$base.pdf"
    # SaveAs(32)=PDF；ppSaveAsPDF 在 2007 需要装了另存为 PDF 加载项
    try { $docObj.SaveAs($pdf, 32) } catch { try { $docObj.ExportAsFixedFormat($pdf, 2) } catch { } }
    $res.engine='com-ppt'; $res.slides=$n; $res.pdf=$pdf
  } elseif ('${ext}' -eq '.docx' -or '${ext}' -eq '.doc') {
    $app = New-Object -ComObject Word.Application
    $app.Visible = $false; $app.DisplayAlerts = 0
    $docObj = $app.Documents.Open($file, $false, $true)
    $pdf = "$out\\$base.pdf"
    $docObj.ExportAsFixedFormat($pdf, 17)
    $res.engine='com-word'; $res.pages=$docObj.ComputeStatistics(2); $res.pdf=$pdf
  } else {
    $app = New-Object -ComObject Excel.Application
    $app.Visible = $false; $app.DisplayAlerts = $false
    $docObj = $app.Workbooks.Open($file, 0, $true)
    $pdf = "$out\\$base.pdf"
    try { $docObj.ExportAsFixedFormat(0, $pdf) } catch { $docObj.SaveAs($pdf, 57) }
    $res.engine='com-excel'; $res.pdf=$pdf
  }
} catch {
  $res.ok=$false; $res.error=$_.Exception.Message
}
# 先落报告：Office 2007 在 Close/Quit 时常抛 0x800706BE（RPC 失败），但导出其实已经成功
$res | ConvertTo-Json -Compress | Set-Content -Path $json -Encoding UTF8
# 收尾尽力而为：Quit 崩掉也不影响已经落盘的报告
try { if ($docObj) { $docObj.Close($false) } } catch { }
try { if ($app) { $app.Quit() } } catch { }
if (-not $res.ok) { exit 1 }
`;
  try { if (existsSync(jsonFile)) unlinkSync(jsonFile); } catch { /* ignore */ }
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { stdio: 'ignore', timeout: 180000, windowsHide: true });
  if (ps.error) throw new Error(`powershell 启动失败：${ps.error.message}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(jsonFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`COM 没有写报告（exit ${ps.status}）；沙箱下 PowerShell 是约束语言模式，New-Object -ComObject 不可用`);
  }
  if (!parsed.ok) throw new Error(`COM 失败：${parsed.error}`);
  return parsed;
}

function rasterize(pdf, outDir, dpi, sheet) {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = [join(here, 'pdf2png.py'), pdf, '--out', outDir, '--dpi', String(dpi)];
  if (sheet) args.push('--sheet');
  // 同上：stdio 必须 ignore，结果从 render-report.json 读
  const r = spawnSync(PY, args, { stdio: 'ignore', timeout: 180000 });
  if (r.error) throw new Error(`python 起不来：${r.error.message}`);
  const rep = join(outDir, 'render-report.json');
  if (!existsSync(rep)) throw new Error(`pdf2png 没有产出报告（exit ${r.status}）`);
  return JSON.parse(readFileSync(rep, 'utf8'));
}

function tryOne(engine, file, outDir, dpi, sheet) {
  const result = { file, outDir, engine: '', pdf: '', pngs: [], ok: false };
  if (engine === 'lo') {
    const soffice = findSoffice();
    if (!soffice) throw new Error('没有找到 LibreOffice（soffice）');
    result.engine = 'libreoffice';
    result.pdf = runLo(file, outDir, soffice);
    rasterize(result.pdf, outDir, dpi, sheet);
  } else {
    result.engine = 'office-com';
    const r = runCom(file, outDir);
    result.pdf = r.pdf || '';
    if (r.engine === 'com-ppt') {
      for (let i = 1; i <= r.slides; i++) result.pngs.push(join(outDir, `slide${i}.png`));
    } else if (r.pdf && existsSync(r.pdf)) {
      rasterize(r.pdf, outDir, dpi, sheet);
    }
  }
  result.ok = true;
  return result;
}

function main() {
  const argv = process.argv.slice(2);
  const file = resolve(argv[0] || '');
  const opt = (name, dflt = '') => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const flag = (name) => argv.includes(`--${name}`);
  if (!file || !existsSync(file)) { console.error('用法: node render.mjs <file> [--out dir] [--engine auto|lo|com]'); process.exit(2); }
  const outDir = resolve(opt('out', join(dirname(file), 'render')));
  const dpi = Number(opt('dpi', '110'));
  const engine = opt('engine', 'auto');
  mkdirSync(outDir, { recursive: true });

  // auto：先 LibreOffice（子进程，权限要求低），挂了再退 Office COM（保真度高，但要 danger-full-access）
  const order = engine === 'auto' ? ['lo', 'com'] : [engine];
  const attempts = [];
  let ok = null;
  for (const e of order) {
    try {
      ok = tryOne(e, file, outDir, dpi, flag('sheet'));
      break;
    } catch (err) {
      attempts.push({ engine: e, error: err.message });
    }
  }
  if (ok) {
    const out = { ...ok, attempts: attempts.length ? attempts : undefined };
    console.log(flag('json') ? JSON.stringify(out, null, 2)
      : JSON.stringify({ ok: true, engine: out.engine, pdf: out.pdf, outDir: out.outDir }));
    return;
  }
  const hint = attempts.some((a) => /COM|约束语言/.test(a.error))
    ? 'COM 需要 danger-full-access（workspace-write 下 PowerShell 是约束语言模式，New-Object -ComObject 不可用）'
    : '';
  console.log(JSON.stringify({ ok: false, file, outDir, attempts, hint }, null, 2));
  process.exit(1);
}

main();
