// @ts-check
// A call that takes over 2 s is written to the server log, so `vyre doctor` can count it ("warn: slow call <tool> took <n> ms"). The call itself is untouched: same answer, same error.

export const SLOW_CALL_MS = 2000;

/**
 * Time every call through `registry.call` and log the slow ones.
 * @param {{ call: (...a: any[]) => Promise<any> }} registry @param {(msg: string) => void} log @param {{ slowMs?: number, now?: () => number }} [o]
 */
export function timeCalls(registry, log, { slowMs = SLOW_CALL_MS, now = Date.now } = {}) {
  const inner = registry.call.bind(registry);
  registry.call = async (/** @type {string} */ tool, ...rest) => {
    const t0 = now();
    try { return await inner(tool, ...rest); }
    finally { const ms = now() - t0; if (ms > slowMs) { try { log(`warn: slow call ${String(tool)} took ${Math.round(ms)} ms`); } catch { /* a log that fails never fails a call */ } } }
  };
  return registry;
}

/**
 * Drop "warn: slow call" lines that land before vyred has said it is up. Startup is the warmup; doctor counts only what happens after. Every other line is logged as it is.
 * @param {(msg: string, extra?: any) => void} log
 * @returns {(msg: string, extra?: any) => void}
 */
export function holdUntilUp(log) {
  let up = false;
  return (msg, extra) => {
    if (typeof msg === "string" && /^vyred \S+ up\b/.test(msg)) up = true;
    if (!up && typeof msg === "string" && msg.startsWith("warn: slow call ")) return;
    log(msg, extra);
  };
}
