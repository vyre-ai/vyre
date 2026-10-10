// @ts-check
// The lender's end of a lent spawn (contracts/lent-spawn.md): the sandboxed process of a chat, pumped through `lent.pipe`. Its stdout and stderr go up, the SDK's stdin comes down, exactly once and in order: a chunk is kept and
// sent again, unchanged, until the home says it has it (`acked`), and a chunk of stdin is written once whatever the home repeats (`ack`). The runner's own work on the same bytes (the transcript lines, the checkpoint at
// the end of a turn) is untouched; this only moves them.
//
// Two kinds of call, never more than one of each: a LONG one that sits at the home while there is nothing to send (it comes back the moment the SDK writes to stdin), and a SHORT one (`wait_ms: 0`) that carries output
// the moment there is some, spaced `minGapMs` apart so a chatty process does not use the lender's rate window.
import { PIPE } from "./pipe-home.js";

/**
 * @param {{ child: any, session: string, pipe: (i: { session: string, up?: any[], exit?: { code: number | null, signal: string | null }, ack: number, wait_ms?: number }) => Promise<any>,
 *   isFrozen?: () => boolean, onFenced?: () => void, onKill?: (sig: string) => void, sleep?: (ms: number) => Promise<void>, minGapMs?: number, retryMs?: number, longMs?: number, giveUpMs?: number }} o
 * @returns {{ stop(): void, done: Promise<void>, stats(): { up: number, down: number, queued: number } }}
 */
export function startPump(o) {
  const { child } = o;
  const sleep = o.sleep || (ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); }));
  const gap = o.minGapMs ?? 200, retry = o.retryMs ?? 1000, longMs = o.longMs ?? PIPE.WAIT_MS;
  let nextUp = 1, ackDown = 0, queuedBytes = 0, upSent = 0, downTaken = 0, last = 0;
  /** Output read and not yet acked, oldest first. @type {{ seq: number, stream: "out" | "err", buf: Buffer }[]} */ const unacked = [];
  /** @type {{ code: number | null, signal: string | null } | null} */ let exit = null;
  let stopped = false, paused = false, flushing = false, again = false, finished = false, holdUntil = 0, killed = false;
  /** @type {() => void} */ let stir = () => {};

  const take = (/** @type {"out" | "err"} */ stream) => (/** @type {Buffer | string} */ d) => {
    const buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
    for (let at = 0; at < buf.length; at += PIPE.CHUNK) { const part = buf.subarray(at, at + PIPE.CHUNK); unacked.push({ seq: nextUp++, stream, buf: part }); queuedBytes += part.length; }
    // a home that does not keep up is not outrun: the process is held at its pipe until the backlog is taken (output is never dropped)
    if (queuedBytes > PIPE.UP_HIGH && !paused) { paused = true; try { child.stdout.pause(); child.stderr.pause(); } catch { /* gone */ } }
    stir();
  };
  // a process that exits before it reads fails the write as an 'error' event; nobody else listens, and an unheard one is an uncaught exception (its exit says what happened)
  child.stdin.on("error", () => {});
  child.stdout.on("data", take("out"));
  child.stderr.on("data", take("err"));
  child.on("close", (/** @type {number | null} */ code, /** @type {string | null} */ signal) => { exit = { code, signal }; stir(); });

  const bodyUp = () => {
    const up = []; let bytes = 0;
    for (const c of unacked) { if (up.length >= PIPE.CALL_CHUNKS || (up.length && bytes + c.buf.length > PIPE.CALL_BYTES)) break; up.push({ seq: c.seq, stream: c.stream, b64: c.buf.toString("base64") }); bytes += c.buf.length; }
    return up;
  };
  /** What an answer means. Synchronous, so two answers in flight never interleave in the middle of one. @param {any} ans */
  const handle = ans => {
    if (stopped || !ans || typeof ans !== "object") return;   // a pump that was stopped writes nothing more, whatever answer is still on its way
    if (Number.isInteger(ans.acked)) {
      let freed = 0;
      while (unacked.length && unacked[0].seq <= ans.acked) { freed += unacked[0].buf.length; unacked.shift(); }
      upSent += freed; queuedBytes -= freed;
      if (paused && queuedBytes <= PIPE.UP_HIGH / 2) { paused = false; try { child.stdout.resume(); child.stderr.resume(); } catch { /* gone */ } }
    }
    if (Array.isArray(ans.down)) {
      for (const c of ans.down) {
        if (!c || !Number.isInteger(c.seq) || c.seq !== ackDown + 1 || typeof c.b64 !== "string") continue;   // a repeat or a gap: the home sends from ack+1 again
        try { child.stdin.write(Buffer.from(c.b64, "base64")); } catch { /* the process is gone: its exit says so */ }
        ackDown = c.seq; downTaken += 1;
      }
    }
    if (ans.end) { try { child.stdin.end(); } catch { /* gone */ } }
    // told once; the home repeats it until the process ends, and a home that has closed the pipe on a process still running ends it (the kill was lost, or the session moved)
    if (ans.kill && !killed) { killed = true; try { o.onKill?.(String(ans.kill)); } catch { /* the runner's own */ } }
    else if (ans.closed && !exit && !killed) { killed = true; try { o.onKill?.("SIGKILL"); } catch { /* the runner's own */ } }
    if (ans.closed) finished = true;
    if (Number.isInteger(ans.hold_ms) && ans.hold_ms > 0) holdUntil = Date.now() + Math.min(5000, ans.hold_ms);
  };
  /** One call. The exit goes only once every chunk before it is acked, so the SDK reads all the output first. @param {number} waitMs */
  const exchange = async waitMs => {
    const up = bodyUp();
    const sendExit = exit && !unacked.length ? exit : null;
    const ans = await o.pipe({ session: o.session, ...(up.length ? { up } : {}), ...(sendExit ? { exit: sendExit } : {}), ack: ackDown, wait_ms: waitMs });
    handle(ans);
    if (sendExit) finished = true;
  };
  const fenced = (/** @type {any} */ e) => {
    const code = e && e.code;
    if (code !== "conflict" && code !== "not_found") return false;
    stopped = true; finished = true;
    try { o.onFenced?.(); } catch { /* the runner's own */ }
    return true;
  };
  /** Move what is waiting up, now, one short call at a time. */
  const flush = async () => {
    if (flushing) { again = true; return; }
    flushing = true;
    try {
      do {
        again = false;
        if (!unacked.length && !exit) break;
        if (holdUntil > Date.now()) await sleep(holdUntil - Date.now());   // the home asked for time: output is kept, never dropped
        const since = Date.now() - last;
        if (since < gap) await sleep(gap - since);
        last = Date.now();
        await exchange(0);
      } while (!stopped && !finished && (again || unacked.length || exit));
    } catch (e) { if (!fenced(e)) await sleep(retry); }   // the home or the link is away: nothing is lost, everything unacked is sent again
    finally { flushing = false; }
  };
  stir = () => { void flush(); };

  const done = (async () => {
    let exitAt = 0;
    while (!stopped && !finished) {
      if (o.isFrozen && o.isFrozen()) { await sleep(500); continue; }
      // the process ended and the home never heard it: given up after a minute (the home takes a lender that is away)
      if (exit) { exitAt = exitAt || Date.now(); if (Date.now() - exitAt > (o.giveUpMs ?? 60_000)) break; }
      if (unacked.length || exit) { if (flushing) await sleep(25); else { await flush(); if (!finished && !stopped) await sleep(gap); } continue; }
      // nothing to send: sit at the home until it has something for the process (or the wait is up)
      try { await exchange(longMs); } catch (e) { if (!fenced(e)) await sleep(retry); }
    }
  })();
  return { stop() { stopped = true; stir(); }, done, stats: () => ({ up: upSent, down: downTaken, queued: queuedBytes }) };
}
