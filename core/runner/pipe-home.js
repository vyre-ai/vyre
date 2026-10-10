// @ts-check
// The home's end of a lent spawn (contracts/lent-spawn.md): a chat's agent process that runs on a person's lent computer, seen from the box as a ChildProcess. The Agent SDK on the box writes the process's stdin and reads
// its stdout and stderr as for a box session; this carries the bytes to the lender and back through one long-poll wire call, `lent.pipe`, exactly once and in order (`seq` and `ack` on both sides, a chunk is kept until the other
// side has said it has it). Nothing here decides where a session runs (the placement book does), what the lender may do (the Offers do) or whether a lender is fenced (the epoch does): lent-home.js asks, this carries.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { Writable, PassThrough } from "node:stream";

export const PIPE = Object.freeze({
  /** One chunk, decoded, and what one call may carry either way. */
  CHUNK: 32 * 1024, CALL_BYTES: 128 * 1024, CALL_CHUNKS: 16,   // a request is at most 256 KiB of JSON on the wire (kernel/remote/wire.js): 128 KiB of bytes is about 171 KiB of base64
  /** Bytes the SDK may have written that the lender has not taken before `stdin.write` says wait; bytes the lender has sent that the SDK has not read before the lender is told to hold. */
  DOWN_HIGH: 1024 * 1024, UP_HIGH: 4 * 1024 * 1024, HOLD_MS: 1000,
  /** A call the home has nothing to answer is held this long (the lender's default and its ceiling). */
  WAIT_MS: 20_000, WAIT_MAX_MS: 25_000,
  /** No lender took the session this soon: it never started. A kill the lender does not carry out this soon ends the process here. */
  START_MS: 15_000, KILL_MS: 5000,
});

/** Options of the SDK's flags that name a file, socket or folder on the box: they mean nothing on another computer. */
const PLUGIN_FLAG = `--${"plugin-dir"}`;
const BOX_PATH_FLAGS = new Set(["--settings", "--add-dir", "--debug-file", PLUGIN_FLAG, `--${"append-system-prompt-file"}`]);   // spelt apart: the provider's flag names stay in the adapters (test/provider-adapters)

/** Stands in the lender's arguments where the box's own Harness plugin was named (its hooks): the lender's runner puts its own copy of the plugin there, or takes the flag out. The Harness is a folder of Vyre, the same release on both computers. */
export const HARNESS_MARK = "@vyre-harness";
/** The Harness plugin folder of this box: where the Switchboard loads it from. */
const boxHarness = () => path.resolve(process.env.VYRE_HARNESS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "harness"));

/** The SDK's MCP servers that live inside the SDK itself (type "sdk": they ride the control channel over stdio), from a `--mcp-config` value that is JSON text or the path of a file on the box; the others name a program or socket on the box. @param {string} value */
function sdkServers(value) {
  try {
    const j = JSON.parse(value.trim().startsWith("{") ? value : fs.readFileSync(value, "utf8"));
    return Object.fromEntries(Object.entries((j && j.mcpServers) || {}).filter(([, v]) => v && /** @type {any} */ (v).type === "sdk"));
  } catch { return {}; }
}

/**
 * The SDK's arguments for the lender: every flag that names a file, socket or folder on the box (and its value) taken out, and the interpreter's script before the first flag. The one exception is the SDK's own in-process MCP servers,
 * which are kept (they need nothing but the process's stdio); the Vyre MCP server of the box is replaced by the lender's own door to the home (lent.http).
 * @param {unknown} args @returns {string[]}
 */
export function lenderArgs(args) {
  const out = /** @type {string[]} */ ([]);
  const a = Array.isArray(args) ? args.map(String) : [];
  // the SDK may start the program through an interpreter (node cli.js --flags): what comes before the first flag names a file on the box
  while (a.length && !a[0].startsWith("-")) a.shift();
  /** @type {Record<string, any>} */ const sdk = {};
  for (let i = 0; i < a.length; i++) {
    const flag = a[i].split("=")[0];
    if (flag === "--mcp-config") {
      const values = a[i].includes("=") ? [a[i].slice(a[i].indexOf("=") + 1)] : [];
      if (!a[i].includes("=")) while (i + 1 < a.length && !a[i + 1].startsWith("--")) values.push(a[++i]);
      for (const v of values) Object.assign(sdk, sdkServers(v));
      continue;
    }
    if (BOX_PATH_FLAGS.has(flag)) {
      // the Harness plugin of the box is the one folder that exists on both computers (the same Vyre release): its hooks run beside the session and reach the home through the door
      const inline = a[i].includes("="), value = inline ? a[i].slice(a[i].indexOf("=") + 1) : (i + 1 < a.length && !a[i + 1].startsWith("--") ? a[i + 1] : "");
      if (flag === PLUGIN_FLAG && value && path.resolve(value) === boxHarness()) out.push(PLUGIN_FLAG, HARNESS_MARK);
      if (!inline && value) i++;
      continue;
    }
    out.push(a[i]);
  }
  if (Object.keys(sdk).length) out.push("--mcp-config", JSON.stringify({ mcpServers: sdk }));
  return out;
}

const bad = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * @param {{ now?: () => number, startMs?: number, killMs?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [o]
 */
export function createPipes(o = {}) {
  const now = o.now || Date.now, setT = o.setTimer || setTimeout, clearT = o.clearTimer || clearTimeout;
  const startMs = o.startMs ?? PIPE.START_MS, killMs = o.killMs ?? PIPE.KILL_MS;
  /** @typedef {{ session: string, chat: string | null, person: string, command: string, args: string[], device: string, state: "starting" | "up" | "ended", epoch: number | null,
   *   downSeq: number, down: { seq: number, buf: Buffer }[], ackDown: number, downBytes: number, drain: null | (() => void), end: boolean, kill: string | null,
   *   upTaken: number, waiter: null | ((a: any) => void), waitTimer: any, startTimer: any, killTimer: any, proc: any, closed: boolean }} P */
  /** @type {Map<string, P>} */ const table = new Map();

  const wake = (/** @type {P} */ p, /** @type {any} */ extra) => {
    const w = p.waiter; if (!w) return;
    p.waiter = null; if (p.waitTimer) { clearT(p.waitTimer); p.waitTimer = null; }
    w(answerOf(p, extra));
  };
  const heldBack = (/** @type {P} */ p) => p.proc.stdout.readableLength + p.proc.stderr.readableLength > PIPE.UP_HIGH;
  /** The next chunks to go down, unacked, from the oldest: the lender takes them in order and a repeat of one it has is harmless. @param {P} p */
  const nextDown = p => {
    const out = [];
    let bytes = 0;
    for (const c of p.down) { if (out.length >= PIPE.CALL_CHUNKS || (out.length && bytes + c.buf.length > PIPE.CALL_BYTES)) break; out.push({ seq: c.seq, b64: c.buf.toString("base64") }); bytes += c.buf.length; }
    return out;
  };
  const answerOf = (/** @type {P} */ p, /** @type {any} */ extra = {}) => {
    const down = p.state === "ended" ? [] : nextDown(p);
    // told: a repeat rides later answers but does not make the next call return at once
    if (p.kill && p.state !== "ended") /** @type {any} */ (p).killTold = true;
    if (p.end && !p.down.length && p.state !== "ended") /** @type {any} */ (p).endTold = true;
    return { down, acked: p.upTaken, ...(p.end && !p.down.length && p.state !== "ended" ? { end: true } : {}), ...(p.kill && p.state !== "ended" ? { kill: p.kill } : {}), ...(p.state === "ended" ? { closed: true } : {}), ...(p.state !== "ended" && heldBack(p) ? { hold_ms: PIPE.HOLD_MS } : {}), ...extra };
  };
  const hasSomething = (/** @type {P} */ p) => p.state === "ended" || p.down.length > 0 || Boolean(p.end && !(/** @type {any} */ (p)).endTold) || Boolean(p.kill && !(/** @type {any} */ (p)).killTold) || heldBack(p);
  const backlog = (/** @type {P} */ p) => p.downBytes;

  /** The process ended (the lender said so, the session moved, it never started or it was killed and did not answer). Idempotent. @param {P} p @param {{ code: number | null, signal: string | null, moved?: any, error?: Error }} how */
  function finish(p, how) {
    if (p.state === "ended") return;
    p.state = "ended"; p.down = []; p.downBytes = 0;
    for (const k of ["startTimer", "killTimer", "waitTimer"]) { const t = /** @type {any} */ (p)[k]; if (t) { clearT(t); /** @type {any} */ (p)[k] = null; } }
    if (p.drain) { const d = p.drain; p.drain = null; d(); }
    wake(p);
    // the lender's last call may still be on its way and should hear "closed"; after a minute the entry is forgotten
    const forget = setT(() => { if (table.get(p.session) === p) table.delete(p.session); }, 60_000); forget.unref?.();
    const proc = p.proc;
    proc.exitCode = how.code; proc.signalCode = how.signal;
    if (how.moved) proc.moved = how.moved;
    // streams end first so the SDK reads every byte the lender sent, then exit and close as for a child process
    setImmediate(() => {
      if (how.error && proc.listenerCount("error")) proc.emit("error", how.error);
      proc.stdout.end(); proc.stderr.end();
      proc.emit("exit", how.code, how.signal);
      // as for a child process, `close` is after the streams are read to their end (nothing unread: nothing to wait for): the SDK has every byte the lender sent before it hears the process is over
      const drained = (/** @type {any} */ st) => new Promise(res => { if (st.readableEnded || st.destroyed || st.readableLength === 0) res(null); else { st.once("end", res); st.once("close", res); st.once("error", res); } });
      Promise.all([drained(proc.stdout), drained(proc.stderr)]).then(() => proc.emit("close", how.code, how.signal));
    });
  }

  /**
   * A ChildProcess-shaped object for a session that will run on `device`. The lender is asked in its next heartbeat; writes to stdin wait for it. If it does not take the session in `startMs`, the process fails as a spawn
   * that never started (`lent_unavailable`) and nothing ran.
   * @param {{ session: string, chat?: string | null, title?: string | null, computer?: string | null, person: string, device: string | null, command: string, args?: string[], signal?: AbortSignal }} i (`device` null: no computer is ready)
   */
  function spawn(i) {
    /** @type {P} */ const p = /** @type {any} */ ({ session: i.session, chat: i.chat || null, title: typeof i.title === "string" && i.title ? i.title.slice(0, 120) : null, person: i.person, command: i.command, args: lenderArgs(i.args), device: i.device || "", state: "starting", epoch: null,
      downSeq: 0, down: [], ackDown: 0, downBytes: 0, drain: null, end: false, kill: null, upTaken: 0, waiter: null, waitTimer: null, startTimer: null, killTimer: null, closed: false });
    const old = table.get(i.session);
    if (old && old.state !== "ended") finish(old, { code: null, signal: "SIGHUP" });
    const proc = new EventEmitter();
    /** @type {any} */ const pr = proc;
    pr.stdout = new PassThrough(); pr.stderr = new PassThrough();
    pr.stdin = new Writable({
      highWaterMark: PIPE.DOWN_HIGH,
      write(chunk, _enc, cb) {
        if (p.state === "ended") return cb();
        const buf = Buffer.from(chunk);
        for (let at = 0; at < buf.length; at += PIPE.CHUNK) { const part = buf.subarray(at, at + PIPE.CHUNK); p.down.push({ seq: ++p.downSeq, buf: part }); p.downBytes += part.length; }
        wake(p);
        if (backlog(p) <= PIPE.DOWN_HIGH) cb(); else p.drain = cb;
      },
      final(cb) { p.end = true; wake(p); cb(); },
    });
    pr.stdin.on("error", () => {});
    pr.pid = 0; pr.killed = false; pr.exitCode = null; pr.signalCode = null; pr.connected = false; pr.spawnfile = i.command; pr.spawnargs = [i.command, ...p.args]; pr.moved = null;
    // from the first moment the SDK's caller can say where it is starting: the computer's name and "starting" until the lender has the process up
    pr.lent = i.device ? { session: i.session, device: i.device, computer: i.computer || null, state: "starting", epoch: null } : null;
    if (i.device) setImmediate(() => { if (p.state === "starting") pr.emit("starting", pr.lent); });
    pr.kill = (/** @type {string} */ sig = "SIGTERM") => {
      if (p.state === "ended") return false;
      pr.killed = true;
      p.kill = sig === "SIGKILL" ? "SIGKILL" : "SIGTERM"; /** @type {any} */ (p).killTold = false;
      wake(p);
      // a lender that is gone cannot carry it out: the process is over here once it has had its time
      if (p.state === "starting" && !p.claimed) finish(p, { code: null, signal: p.kill });   // nobody has it yet: nothing to tell
      else if (!p.killTimer) { p.killTimer = setT(() => finish(p, { code: null, signal: "SIGKILL" }), killMs); p.killTimer.unref?.(); }
      return true;
    };
    pr.ref = () => {}; pr.unref = () => {};
    p.proc = proc;
    table.set(i.session, p);
    const never = () => finish(p, { code: null, signal: null, error: Object.assign(new Error("no computer of yours took this session in time"), { code: "lent_unavailable" }) });
    if (!i.device) setImmediate(never);   // no computer is ready: it fails as a spawn that never started, at once
    else { p.startTimer = setT(never, startMs); p.startTimer.unref?.(); }
    if (i.signal) { if (i.signal.aborted) pr.kill(); else i.signal.addEventListener("abort", () => pr.kill(), { once: true }); }
    return proc;
  }

  /**
   * The wire call. `i` is already checked against the book by lent-home (a current epoch, the computer that holds the session). Held up to `wait_ms` when there is nothing to say.
   * @param {string} session @param {number} epoch @param {string} device @param {any} i
   * @returns {Promise<any>}
   */
  function poll(session, epoch, device, i) {
    const p = table.get(session);
    const waitMs = Math.max(0, Math.min(PIPE.WAIT_MAX_MS, Number.isInteger(i && i.wait_ms) ? i.wait_ms : PIPE.WAIT_MS));
    if (!p) return new Promise(res => { const t = setT(() => res({ down: [], acked: 0, idle: true }), Math.min(waitMs, 2000)); t.unref?.(); });
    if (p.device !== device) throw bad("this session is not lent to this computer", "conflict");
    if (p.state === "ended") return Promise.resolve(answerOf(p));
    if (p.state === "starting") { p.state = "up"; p.epoch = epoch; if (p.startTimer) { clearT(p.startTimer); p.startTimer = null; } p.proc.connected = true; p.proc.lent = { ...(p.proc.lent || {}), session, device, state: "up", epoch }; setImmediate(() => p.proc.emit("spawn")); }
    else if (p.epoch !== epoch) { p.epoch = epoch; }
    // what the lender sent: taken in order, a repeat or a gap leaves `acked` where it was so the lender sends again from there
    const up = Array.isArray(i && i.up) ? i.up : [];
    if (up.length > PIPE.CALL_CHUNKS) throw bad("a call carries at most 16 chunks", "bad_input");
    let total = 0;
    const held = heldBack(p);   // the SDK is not reading: take nothing more until it does (the lender sends it again)
    for (const c of up) {
      if (held) break;
      if (!c || !Number.isInteger(c.seq) || c.seq < 1 || (c.stream !== "out" && c.stream !== "err") || typeof c.b64 !== "string" || !B64.test(c.b64)) throw bad("a chunk names its seq, its stream and its bytes", "bad_input");
      const buf = Buffer.from(c.b64, "base64");
      if (buf.length > PIPE.CHUNK) throw bad("a chunk is at most 32 KiB", "bad_input");
      total += buf.length;
      if (total > PIPE.CALL_BYTES) throw bad("a call carries at most 128 KiB", "bad_input");
      if (c.seq !== p.upTaken + 1) continue;
      p.upTaken = c.seq;
      (c.stream === "err" ? p.proc.stderr : p.proc.stdout).write(buf);
    }
    // what the lender has written to the process's stdin: those chunks are done
    if (Number.isInteger(i && i.ack) && i.ack > p.ackDown) {
      while (p.down.length && p.down[0].seq <= i.ack) { p.downBytes -= p.down[0].buf.length; p.down.shift(); }
      p.ackDown = i.ack;
      if (p.drain && backlog(p) <= PIPE.DOWN_HIGH) { const d = p.drain; p.drain = null; d(); }
    }
    if (i && i.exit && typeof i.exit === "object") {
      finish(p, { code: Number.isInteger(i.exit.code) ? i.exit.code : null, signal: typeof i.exit.signal === "string" ? i.exit.signal.slice(0, 20) : null });
      return Promise.resolve(answerOf(p));
    }
    if (hasSomething(p) || waitMs === 0) return Promise.resolve(answerOf(p));
    // nothing to say: held; a newer long call from the same lender takes this one's place (a short call, `wait_ms: 0`, never does)
    return new Promise(res => {
      if (p.waiter) { const prev = p.waiter; p.waiter = null; if (p.waitTimer) clearT(p.waitTimer); prev(answerOf(p)); }
      p.waiter = res;
      p.waitTimer = setT(() => { if (p.waiter === res) { p.waiter = null; p.waitTimer = null; res(answerOf(p)); } }, waitMs);
      p.waitTimer.unref?.();
    });
  }

  return {
    spawn, poll,
    /** The sessions waiting for a lender, for the heartbeat answer to `device`: it starts them. */
    wants(/** @type {string} */ device) { return [...table.values()].filter(p => p.state === "starting" && p.device === device && !p.claimed).map(p => ({ do: "start", session: p.session, ...(p.chat ? { chat: p.chat } : {}), pipe: true })); },
    /** What the home's definition of this session becomes when the lender that was asked starts it: the SDK's flags in place of the Space's bare program. Null when nobody spawned it here for this computer. */
    pending(/** @type {string} */ session, /** @type {string} */ device) { const p = table.get(session); return p && p.state === "starting" && p.device === device ? { command: p.command, args: p.args, chat: p.chat, title: /** @type {any} */ (p).title || null } : null; },
    /** The lender took the session: it is not asked again. */
    claimed(/** @type {string} */ session, /** @type {string} */ device) { const p = table.get(session); if (p && p.device === device) /** @type {any} */ (p).claimed = true; },
    has(/** @type {string} */ session) { const p = table.get(session); return Boolean(p && p.state !== "ended"); },
    /** The session left this lender (the server took it, the lender stopped it, a Space turned it off). `moved` says it went to the server and why. */
    end(/** @type {string} */ session, /** @type {{ moved?: { to: "server", reason: string | null, epoch: number | null }, signal?: string }} */ how = {}) {
      const p = table.get(session); if (!p || p.state === "ended") return;
      finish(p, { code: null, signal: how.signal || (how.moved ? "SIGHUP" : "SIGKILL"), ...(how.moved ? { moved: how.moved } : {}) });
    },
    /** Every pipe ends (the home stops). */
    stop() { for (const p of table.values()) finish(p, { code: null, signal: "SIGHUP" }); },
  };
}
