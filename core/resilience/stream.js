// @ts-check
// stream: follow vyred's events and never lose one (docs/adr/0029-resilience.md, R1, R3, R5).
//
// The reference client every surface can use as is, or copy: the CLI and the Mac link run it in
// Node, and it has no Node imports, so the Deck can load it too. What it guarantees:
//   - it holds a cursor from the first byte (vyred's `id:` on open), sends it on every reconnect,
//     and drops any event at or below it, so a drop, a restart or a path switch replays the gap
//     once and never twice;
//   - a `stream.reset` from vyred (its log is behind the cursor) is passed to onReset, and the
//     cursor follows it, so the surface reloads instead of waiting forever;
//   - a stream silent for `stallMs` (three missed heartbeats) is treated as dead;
//   - it tries each path in order (LAN, tailnet, relay) before waiting, waits 2 s to 60 s between
//     rounds, and while on a worse path probes the better ones every `probeMs` and moves back;
//   - pause() closes it while the app is hidden; resume() and kick() (a network change, a wake)
//     reconnect at once.
// The transport is passed in: `open` does one GET and yields text chunks. See ./node.js.

import { parse } from "./sse.js";
import { backoff as makeBackoff } from "./backoff.js";

/**
 * @typedef {(req: { base: string, path: string, headers: Record<string, string>, signal: AbortSignal }) =>
 *   Promise<{ status: number, chunks: AsyncIterable<string> }>} Open
 * @typedef {{ id: number, at: number, type: string, source: string, project: string|null, thread: string|null, payload: any }} VyreEvent
 * @typedef {{ state: "connecting"|"open"|"reconnecting"|"paused"|"stopped", path: string|null, attempt: number, why?: string, since: number|null }} StreamState
 */

/**
 * @param {{
 *   paths: string[], open: Open, onEvent: (e: VyreEvent) => void,
 *   onReset?: (e: VyreEvent) => void, onState?: (s: StreamState) => void,
 *   cursor?: number|null, save?: (cursor: number) => void, type?: string, headers?: Record<string, string>,
 *   stallMs?: number, probeMs?: number, backoff?: ReturnType<typeof makeBackoff>,
 *   fastProbeMs?: number, fastProbeFor?: number,
 * }} o
 */
export function follow({ paths, open, onEvent, onReset, onState, cursor = null, save, type = "*", headers = {},
  stallMs = 45_000, probeMs = 60_000, backoff = makeBackoff(), fastProbeMs = 150, fastProbeFor = 5_000 }) {
  if (!paths.length) throw new Error("follow needs at least one path to the box");
  let at = 0;                   // the path in use, an index into paths
  let tried = 0;                // paths tried since the last open, so a round ends before a wait
  let attempt = 0;
  let paused = false, stopped = false;
  /** @type {AbortController|null} */ let ac = null;
  /** @type {any} */ let wait = null;
  /** @type {any} */ let probe = null;
  /** @type {any} */ let fastTimer = null;
  let probing = false;
  let downSince = /** @type {number|null} */ (null);

  const tell = (/** @type {StreamState["state"]} */ state, /** @type {string|undefined} */ why = undefined) => onState?.({ state, path: paths[at] ?? null, attempt, why, since: downSince });
  const move = (/** @type {number} */ n) => { if (Number.isFinite(n) && (cursor === null || n > cursor)) { cursor = n; save?.(n); } };

  async function connect() {
    if (paused || stopped) return;
    clearTimeout(wait); wait = null;
    clearInterval(fastTimer); fastTimer = null;
    const my = ac = new AbortController();
    tell(attempt ? "reconnecting" : "connecting");
    let stall = setTimeout(() => my.abort(), stallMs);
    const alive = () => { clearTimeout(stall); stall = setTimeout(() => my.abort(), stallMs); };
    let why = "the stream ended";
    try {
      const q = `?type=${encodeURIComponent(type)}&since=${cursor === null ? "latest" : cursor}`;
      const h = { accept: "text/event-stream", ...headers, ...(cursor === null ? {} : { "last-event-id": String(cursor) }) };
      const r = await open({ base: paths[at], path: "/v1/events/stream" + q, headers: h, signal: my.signal });
      if (r.status !== 200) throw new Error(`the stream answered ${r.status}`);
      let opened = false, buf = "";
      for await (const chunk of r.chunks) {
        if (my.signal.aborted) break;
        alive();
        const p = parse(buf + chunk);
        buf = p.rest;
        for (const f of p.frames) {
          if (!opened) {
            // The first frame proves the path works: vyred sends `retry` and `id` before anything.
            opened = true; attempt = 0; tried = 0; downSince = null; backoff.reset();
            tell("open"); schedule();
          }
          if (!f.data) { move(Number(f.id)); continue; }
          let e;
          try { e = JSON.parse(f.data); } catch { continue; }
          if (e.type === "stream.reset") { cursor = Number(e.id); save?.(cursor); onReset?.(e); continue; }
          const id = Number(e.id);
          if (cursor !== null && id <= cursor) continue;
          move(id);
          try { onEvent(e); } catch {}
        }
      }
      if (my.signal.aborted) why = stopped || paused ? "closed" : "no heartbeat, or a path change";
    } catch (e) { why = my.signal.aborted ? "no heartbeat, or a path change" : /** @type {Error} */ (e).message; }
    finally { clearTimeout(stall); }
    if (ac === my) ac = null;
    const to = /** @type {any} */ (my).switchTo;
    if (to !== undefined && !paused && !stopped) { at = to; return connect(); }
    if (!paused && !stopped) down(why);
  }

  /** @param {string} why */
  function down(why) {
    clearInterval(probe); probe = null;
    downSince ??= Date.now();
    attempt++;
    // Try the next path at once; wait only when a whole round has failed, then start again from
    // the preferred path.
    tried++;
    if (tried < paths.length) { at = (at + 1) % paths.length; tell("reconnecting", why); return void connect(); }
    tried = 0; at = 0;
    tell("reconnecting", why);
    wait = setTimeout(connect, backoff.delay());
    fastReach();
  }

  // While a backoff wait is pending, probe path 0 every fastProbeMs and reconnect at once the
  // moment it answers, instead of waiting out whatever step the backoff timer is on: a wait
  // scheduled before the box comes back has no way to know it came back (native-bar budget 8).
  // Capped at fastProbeFor from the first failure (not each wait), so a box that stays down for a
  // while falls back to backoff alone rather than polling it forever.
  function fastReach() {
    clearInterval(fastTimer); fastTimer = null;
    if (downSince != null && Date.now() - downSince >= fastProbeFor) return;
    fastTimer = setInterval(async () => {
      if (probing || paused || stopped || !wait) return;
      probing = true;
      const pa = new AbortController();
      const t = setTimeout(() => pa.abort(), Math.min(2_000, fastProbeMs * 4));
      try {
        const r = await open({ base: paths[0], path: "/v1/health", headers, signal: pa.signal });
        for await (const _ of r.chunks) break;
        if (r.status === 200 && wait) { clearTimeout(wait); wait = null; clearInterval(fastTimer); fastTimer = null; at = 0; connect(); }
      } catch {} finally { clearTimeout(t); probing = false; }
    }, fastProbeMs);
  }

  // On a worse path, look for a better one now and then, and move when it answers.
  function schedule() {
    clearInterval(probe); probe = null;
    if (at === 0) return;
    probe = setInterval(async () => {
      for (let j = 0; j < at; j++) {
        const pa = new AbortController();
        const t = setTimeout(() => pa.abort(), 5_000);
        try {
          const r = await open({ base: paths[j], path: "/v1/health", headers, signal: pa.signal });
          for await (const _ of r.chunks) break;
          if (r.status === 200 && ac && !paused && !stopped) { /** @type {any} */ (ac).switchTo = j; ac.abort(); return; }
        } catch {} finally { clearTimeout(t); pa.abort(); }
      }
    }, probeMs);
  }

  connect();
  return {
    get cursor() { return cursor; },
    get path() { return paths[at]; },
    /** The app went to the background: close, and do not come back until resume(). */
    pause() { paused = true; clearTimeout(wait); clearInterval(probe); clearInterval(fastTimer); ac?.abort(); tell("paused"); },
    /** Back in front: reconnect now, from the cursor. */
    resume() { if (!paused || stopped) return; paused = false; backoff.reset(); tried = 0; at = 0; connect(); },
    /** The network changed or the device woke: the stream may be dead without knowing it. */
    kick() {
      if (paused || stopped) return;
      backoff.reset(); tried = 0;
      if (ac) { /** @type {any} */ (ac).switchTo = 0; ac.abort(); } else { at = 0; connect(); }
    },
    stop() { stopped = true; clearTimeout(wait); clearInterval(probe); clearInterval(fastTimer); ac?.abort(); tell("stopped"); },
  };
}
