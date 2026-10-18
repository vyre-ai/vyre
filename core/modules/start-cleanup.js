// @ts-check
// start-cleanup: what a module opened while it was starting is closed if the start then fails. A module registers each such thing with `ctx.own(close)`; if start() throws (or the registry refuses a
// tool it registered), the registry has no handle to call stop() on, so these closers run instead, each bounded, and the failure is then reported as before. A start that succeeds drops them: the module's own stop() owns the things from then on.

const CLOSE_MS = 5000;

/** @param {{ start(ctx: any): Promise<any> }} mod @param {any} ctx @param {(m: string) => void} log @param {string} name */
export async function startWithCleanup(mod, ctx, log, name) {
  /** @type {Array<() => any>} */ const closers = [];
  if (ctx && typeof ctx === "object") ctx.own = (/** @type {() => any} */ close) => { if (typeof close === "function") closers.push(close); return close; };
  try { return await mod.start(ctx); }
  catch (e) {
    for (const close of closers.reverse()) {
      /** @type {any} */ let timer;
      try { await Promise.race([Promise.resolve().then(close), new Promise(r => { timer = setTimeout(r, CLOSE_MS); timer.unref?.(); })]); }
      catch (err) { log(`warn: module ${name} could not close something its failed start opened: ${/** @type {Error} */ (err).message}`); }
      finally { clearTimeout(timer); }
    }
    throw e;
  }
}
