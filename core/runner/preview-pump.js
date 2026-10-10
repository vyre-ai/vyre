// @ts-check
// The lender's end of a preview (contracts/lent-spawn.md, `lent.preview`): a long call sits at the home while no browser asks for anything; a request that arrives comes back at once and is run against the dev
// server inside the sandbox (`run`), and each answer goes up in a short call of its own the moment it is ready, so a page is not held for the long call's next turn. Never more than one long call; at most
// MAX_RUNNING requests run at once. A fenced session (the home took it) or a stopped pump ends it.

const MAX_RUNNING = 8;

/**
 * @param {{ session: string, poll: (i: { session: string, replies?: any[], wait_ms?: number }) => Promise<{ reqs?: any[] }>, run: (job: any) => Promise<any>, onFenced?: () => void,
 *   sleep?: (ms: number) => Promise<void>, longMs?: number, retryMs?: number }} o
 * @returns {{ stop(): void, done: Promise<void> }}
 */
export function startPreviewPump(o) {
  const sleep = o.sleep || (ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); }));
  const longMs = o.longMs ?? 20_000, retry = o.retryMs ?? 1000;
  let stopped = false, running = 0;
  /** @type {() => void} */ let end = () => {};
  const fenced = (/** @type {any} */ e) => { const c = String(e && e.code); return c === "conflict" || c === "not_found"; };
  const handle = (/** @type {{ reqs?: any[] }} */ ans) => {
    for (const job of (ans && Array.isArray(ans.reqs) ? ans.reqs : [])) {
      if (running >= MAX_RUNNING) { reply(job.id, { error: "this computer is busy with other preview requests" }); continue; }
      running++;
      Promise.resolve().then(() => o.run(job)).then(r => reply(job.id, r), e => reply(job.id, { error: String(e && e.message || "the dev server did not answer") })).finally(() => { running--; });
    }
  };
  const reply = (/** @type {string} */ id, /** @type {any} */ r) => {
    o.poll({ session: o.session, replies: [{ id, ...r }], wait_ms: 0 }).then(handle).catch(e => { if (fenced(e)) { stopped = true; end(); o.onFenced?.(); } });
  };
  const done = (async () => {
    await new Promise(res => { end = () => res(undefined); (async () => {
      while (!stopped) {
        try { handle(await o.poll({ session: o.session, wait_ms: longMs })); }
        catch (e) { if (fenced(e)) { stopped = true; o.onFenced?.(); break; } await sleep(retry); }
      }
      res(undefined);
    })(); });
  })();
  return { stop() { stopped = true; end(); }, done };
}
