/**
 * hooks/sticker-trash.mjs — 浮窗「表情包图库 · 回收站」的彻底清除接口
 *
 * 插件原生只提供 trash(可逆) / restore，没有"直接清空回收站"的入口；
 * 这里补一个 POST 路由：/api/qqbot-settings/stickers/trash-purge
 *   POST { dataDir?: string } → { ok, purged }
 *
 * 只做一件事：store.cleanupTrash(0)（物理删除 trash 层的文件 + 索引），
 * 不会碰 candidate / library / negative。
 *
 * ⚠️ 与 memory-panel 同款：钩子里不能直接写 ctx.webServer（会抛 without inject），
 *    必须先 ctx.inject(['webServer'], ...)。
 * ⚠️ 扩展目录不在插件的 node_modules 下，所以这里用 createRequire 按 profile 根
 *    去解析插件包里的 sticker-store.js，避免写死 AppData 版本号路径。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'sticker-trash';

/** 找到当前活插件里的 sticker-store.js（找不到返回空串） */
function resolveStickerStore() {
  const rel = join('node_modules', '@zaofan', 'dsh-qqbot', 'dist', 'features', 'sticker-store.js');
  const roots = [];
  try { roots.push(process.cwd()); } catch { /* ignore */ }
  const appdata = process.env.APPDATA || '';
  const profiles = appdata ? join(appdata, 'dsh-desktop', 'harness', 'profiles') : '';
  if (profiles) {
    try {
      for (const p of readdirSync(profiles)) roots.push(join(profiles, p));
    } catch { /* ignore */ }
  }
  for (const r of roots) {
    const p = join(r, rel);
    if (existsSync(p)) return p;
  }
  return '';
}

export async function run(env = {}) {
  const { ctx, dataRoot, logger } = env;

  const mount = (serverCtx, from) => {
    try {
      const ws = serverCtx && serverCtx.webServer;
      if (!ws || typeof ws.register !== 'function') {
        logger?.warn?.('[sticker-trash] 宿主没有 webServer，回收站清除不可用');
        return;
      }
      const dispose = ws.register({
        kind: 'exact',
        path: '/api/qqbot-settings/stickers/trash-purge',
        handler: (req, res) => {
          const write = (code, obj) => {
            try {
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify(obj));
            } catch { /* ignore */ }
          };
          if (!req.method || req.method !== 'POST') return write(405, { ok: false, error: '只支持 POST' });
          let raw = '';
          req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
          req.on('end', () => {
            (async () => {
              const body = (() => { try { return JSON.parse(raw || '{}') || {}; } catch { return {}; } })();
              const cfgDir = env.config?.sticker?.dataDir ? String(env.config.sticker.dataDir) : '';
              const dir = String(body.dataDir || cfgDir || join(String(dataRoot || ''), '表情包'));
              const storePath = resolveStickerStore();
              if (!storePath) return write(500, { ok: false, error: '找不到插件内的 sticker-store.js' });
              const mod = await import(pathToFileURL(storePath).href);
              mod.configureStickerStore(dir, logger);
              const store = mod.getStickerStore(dir);
              const purged = store.cleanupTrash(0);
              try { store.flush?.(); } catch { /* 落盘失败由 store 自己 warning */ }
              logger?.info?.(`[sticker-trash] 已彻底清除回收站 ${purged} 张（${dir}）`);
              write(200, { ok: true, purged, dataDir: dir });
            })().catch((e) => write(500, { ok: false, error: e instanceof Error ? e.message : String(e) }));
          });
        },
      });
      try {
        if (typeof env.registerDispose === 'function') env.registerDispose(dispose);
      } catch { /* ignore */ }
      logger?.info?.(`[sticker-trash] 已挂载 /api/qqbot-settings/stickers/trash-purge（${from}）`);
    } catch (err) {
      logger?.warn?.(`[sticker-trash] 注册路由失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 与 memory-panel 同款：延后 1.5s 再 inject，等宿主把 webServer 服务注册完
  if (ctx && typeof ctx.inject === 'function') {
    const delay = Number(env.injectDelayMs);
    const doInject = () => {
      try {
        ctx.inject(['webServer'], (serverCtx) => mount(serverCtx, 'inject'));
      } catch (err) {
        logger?.warn?.(`[sticker-trash] inject 失败，尝试直接挂载: ${err instanceof Error ? err.message : String(err)}`);
        mount(ctx, 'direct');
      }
    };
    try {
      setTimeout(doInject, Number.isFinite(delay) && delay >= 0 ? delay : 1500);
    } catch {
      doInject();
    }
    return { mounted: 'scheduled-inject' };
  }
  mount(ctx, 'direct');
  return { mounted: 'direct' };
}

export default run;
