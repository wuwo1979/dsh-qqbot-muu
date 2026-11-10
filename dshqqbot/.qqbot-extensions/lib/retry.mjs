/**
 * 零依赖的重试与串行队列（第 6 批：替代 p-retry / p-queue 的最小等价物）
 *
 * 边界故意很小：
 *  - withRetry 只管「抛错就重试」，不吞错，最终仍抛最后一次异常；
 *  - createSerialQueue 只管「同一时刻一个任务在跑 + 排队上限」，不负责定时/并发池。
 */

const sleep = (ms) => new Promise((res) => setTimeout(res, Math.max(0, Number(ms) || 0)));

/** 指数/固定退避重试。gapMs 为第 1 次重试的等待，之后按 factor 递增。 */
export async function withRetry(fn, { retries = 1, gapMs = 300, factor = 3, shouldRetry = () => true } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i >= retries || !shouldRetry(e, i)) break;
      await sleep(gapMs * Math.pow(factor, i));
    }
  }
  throw lastErr;
}

/** 串行队列：push 超上限时返回 { ok:false, dropped:true }，调用方自己计数。 */
export function createSerialQueue({ maxPending = Infinity } = {}) {
  let chain = Promise.resolve();
  let pending = 0;
  let dropped = 0;
  return {
    get pending() { return pending; },
    get dropped() { return dropped; },
    push(task) {
      if (pending >= maxPending) {
        dropped += 1;
        return { ok: false, dropped: true };
      }
      pending += 1;
      const promise = chain
        .then(task)
        .catch(() => { /* 任务失败不影响后续 */ })
        .finally(() => { pending -= 1; });
      chain = promise;
      return { ok: true, promise };
    },
  };
}
