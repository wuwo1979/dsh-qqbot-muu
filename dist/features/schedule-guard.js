/**
 * schedule-guard.ts — 定时任务的「到点该不该开口」判断
 *
 * 为什么要有：
 *   每天固定 21:00 给妈妈发一句「记得加衣服」——那不是人，是闹钟。
 *   真人的关心是**有由头**的：今天降温了/下雨了/她那边很热，才想起来说一句。
 *   所以窗口任务可以挂一个 guard，到点先自己判断一下，不合适就不打扰（顺延到下一个点）。
 *
 * 支持：
 *   guard = { type: 'always' }                        总是说
 *   guard = { type: 'weather', city: '西安', when: ['cold'] }   只有天气符合才说
 *        when 可选值：cold(≤8℃) / hot(≥30℃) / rain(有降水) / snow(下雪) / any(能查到就发)
 *
 * 查天气用 Open-Meteo（免费、无 key、无需登录）：先 geocoding 拿经纬度，再取当前天气。
 * 任何一步失败 → 返回 false（宁可不发，也不要瞎发），并写日志。
 */
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WX_URL = 'https://api.open-meteo.com/v1/forecast';
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
async function getJson(url, timeoutMs = 6000, fetchImpl) {
    const f = fetchImpl ?? globalThis.fetch;
    if (typeof f === 'function') {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);
        try {
            const res = await f(url, { signal: ac.signal });
            if (res.ok)
                return await res.json();
        }
        catch { /* 落到 curl 兜底 */ }
        finally {
            clearTimeout(t);
        }
    }
    // 宿主机上有 curl（Windows 自带），且它认 HTTPS_PROXY —— node fetch 不认代理，这里补一条路
    const { execFile } = await import('node:child_process');
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
    const args = ['-sS', '--max-time', String(Math.max(3, Math.round(timeoutMs / 1000)))];
    if (proxy)
        args.push('--proxy', proxy);
    args.push(url);
    const out = await new Promise((resolve, reject) => {
        execFile('curl', args, { timeout: timeoutMs + 2000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
            if (err)
                reject(err);
            else
                resolve(stdout);
        });
    });
    return JSON.parse(out);
}
/** 查某个城市当前天气：{ temp, precip, code, text } */
export async function currentWeather(city, opts = {}) {
    const geo = await getJson(`${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`, opts.timeoutMs, opts.fetchImpl);
    const hit = geo?.results?.[0];
    if (!hit)
        throw new Error(`找不到城市：${city}`);
    const wx = await getJson(`${WX_URL}?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,precipitation,weather_code&timezone=auto`, opts.timeoutMs, opts.fetchImpl);
    const cur = wx?.current ?? {};
    return { temp: Number(cur.temperature_2m), precip: Number(cur.precipitation ?? 0), code: Number(cur.weather_code ?? 0), city: hit.name };
}
/**
 * 到点该不该开口。true=可以说，false=这次先不问（窗口任务会顺延到下一个点）。
 * 任何异常都返回 false —— 关心是加分项，宁可沉默也别乱发。
 */
export async function passesGuard(job, opts = {}) {
    const g = job?.guard;
    if (!g || typeof g !== 'object')
        return true;
    if (g.type === 'always')
        return true;
    if (g.type !== 'weather')
        return true;
    const city = String(g.city || '').trim();
    if (!city) {
        opts.logger?.warn?.(`[schedule] guard=weather 没给 city, job=${job.id} 跳过`);
        return false;
    }
    try {
        const w = await currentWeather(city, opts);
        const when = Array.isArray(g.when) && g.when.length ? g.when.map(String) : ['any'];
        const hit = when.some((rule) => {
            if (rule === 'any')
                return true;
            if (rule === 'cold')
                return Number.isFinite(w.temp) && w.temp <= 8;
            if (rule === 'hot')
                return Number.isFinite(w.temp) && w.temp >= 30;
            if (rule === 'rain')
                return w.precip > 0 || RAIN_CODES.has(w.code);
            if (rule === 'snow')
                return SNOW_CODES.has(w.code);
            return false;
        });
        opts.logger?.info?.(`[schedule] guard weather ${city} temp=${w.temp} precip=${w.precip} code=${w.code} → ${hit ? '可以开口' : '这次不打扰'}`);
        return hit;
    }
    catch (err) {
        opts.logger?.warn?.(`[schedule] guard 判断失败 job=${job.id}: ${err instanceof Error ? err.message : String(err)}`);
        // 查不到天气不等于不能关心 —— 窗口本身已经保证"是个合理的点"，默认照常开口。
        // 想严格就写 guard.onError='skip'。
        return String(g.onError || 'send') !== 'skip';
    }
}
//# sourceMappingURL=schedule-guard.js.map
