// @ts-check
// The lender's end of a preview (contracts/lent-spawn.md, `lent.preview`): a long call sits at the home while no browser asks for anything; a request that arrives comes back at once and is run against the dev
// server inside the sandbox (`run`), and each answer goes up in a short call of its own the moment it is ready, so a page is not held for the long call's next turn. Never more than one long call; at most
// MAX_RUNNING requests run at once. A fenced session (the home took it) or a stopped pump ends it.

const MAX_RUNNING = 8;

/**
 * @param {{ tunnel?: (job: any, io: { data: (b: Buffer) => void, end: () => void }) => { write: (b: Buffer) => void, end: () => void } | null }} _t
 * @param {{ session: string, tunnel?: (job: any, io: { data: (b: Buffer) => void, end: () => void }) => { write: (b: Buffer) => void, end: () => void } | null, poll: (i: { session: string, replies?: any[], wait_ms?: number }) => Promise<{ reqs?: any[] }>, run: (job: any) => Promise<any>, onFenced?: () => void,
 *   sleep?: (ms: number) => Promise<void>, longMs?: number, retryMs?: number }} o
 * @returns {{ stop(): void, done: Promise<void> }}
 */
export function startPreviewPump(o) {
  const sleep = o.sleep || (ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); }));
  const longMs = o.longMs ?? 20_000, retry = o.retryMs ?? 1000;
  let stopped = false, running = 0;
  /** @type {() => void} */ let end = () => {};
  const fenced = (/** @type {any} */ e) => { const c = String(e && e.code); return c === "conflict" || c === "not_found"; };
  /** Tunnels (a WebSocket upgrade): the dev server's side of each, and the order of what comes down and goes up. @type {Map<string, { io: { write: (b: Buffer) => void, end: () => void } | null, next: number, pend: Map<number, Buffer | null>, up: number, buf: Buffer[], timer: any }>} */
  const tunnels = new Map();
  const flushUp = (/** @type {string} */ id, /** @type {any} */ t, /** @type {boolean} */ last) => {
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    const all = Buffer.concat(t.buf); t.buf = [];
    for (let at = 0; at < all.length; at += 32 * 1024) reply(id, { tun: true, seq: ++t.up, b64: all.subarray(at, at + 32 * 1024).toString("base64") });
    if (last) reply(id, { tun: true, seq: t.up, end: true });
  };
  const down = (/** @type {any} */ item) => {
    const t = tunnels.get(String(item && item.id)); if (!t || !t.io || !Number.isInteger(item.seq)) return;
    t.pend.set(item.seq, item.end === true ? null : Buffer.from(String(item.b64 || ""), "base64"));
    for (let b = t.pend.get(t.next); b !== undefined; b = t.pend.get(t.next)) {
      t.pend.delete(t.next); t.next++;
      if (b === null) { t.io.end(); tunnels.delete(String(item.id)); return; }
      t.io.write(b);
    }
  };
  const open = (/** @type {any} */ job) => {
    if (!o.tunnel || tunnels.size >= 8) { reply(job.id, { tun: true, seq: 0, end: true }); return; }
    const t = { io: /** @type {any} */ (null), next: 1, pend: new Map(), up: 0, buf: /** @type {Buffer[]} */ ([]), timer: /** @type {any} */ (null) };
    tunnels.set(String(job.id), t);
    t.io = o.tunnel(job, {
      data: b => { t.buf.push(b); if (!t.timer) t.timer = setTimeout(() => flushUp(String(job.id), t, false), 15); },
      end: () => { flushUp(String(job.id), t, true); tunnels.delete(String(job.id)); },
    });
    if (!t.io) { tunnels.delete(String(job.id)); reply(job.id, { tun: true, seq: 0, end: true }); }
  };
  const handle = (/** @type {{ reqs?: any[], tun?: any[] }} */ ans) => {
    for (const it of (ans && Array.isArray(ans.reqs) ? ans.reqs : [])) if (it && it.tunnel === true) open(it);
    for (const it of (ans && Array.isArray(ans.tun) ? ans.tun : [])) down(it);
    for (const job of (ans && Array.isArray(ans.reqs) ? ans.reqs : [])) {
      if (job.tunnel === true) continue;
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
  return { stop() { stopped = true; for (const t of tunnels.values()) { try { t.io?.end(); } catch { /* gone */ } } tunnels.clear(); end(); }, done };
}
