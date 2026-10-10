// @ts-check
// Lent spawn (contracts/lent-spawn.md): the bytes of a chat's agent process between the SDK on the home and a sandboxed process on a lender, through the kernel's wire. The home, the lender's client, the pump and the
// process are the real ones; the transport is the in-memory stand-in for Wink. The process here is a small node program (the sandbox, the checkpoints and the lease are the runner's own tests').
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rig, BOB } from "./testing/lent-rig.js";
import { startPump } from "./pipe-pump.js";
import { createPipes, lenderArgs, PIPE } from "./pipe-home.js";

const CAT_UPPER = "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase())); process.stdin.on('end', () => process.exit(0));";
const wait = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const read = (/** @type {any} */ stream, /** @type {number} */ n) => new Promise((res, rej) => { let b = ""; const t = setTimeout(() => rej(new Error("timed out with " + JSON.stringify(b.slice(0, 80)))), 8000); stream.on("data", (/** @type {any} */ d) => { b += d; if (b.length >= n) { clearTimeout(t); res(b); } }); });

/** The pump and the home wait on unref'd timers (a daemon has sockets to keep it alive; a test does not). */
const keepAlive = (/** @type {any} */ t) => { const k = setInterval(() => {}, 100); t.after(() => clearInterval(k)); };

/** A lender with a lease and a heartbeat that says it is well, and the home's spawn for a session. */
async function lent(/** @type {any} */ t, /** @type {{ session?: string, args?: string[], program?: string, pump?: any }} */ o = {}) {
  keepAlive(t);
  const r = await rig(t);
  const c = r.as(BOB, "dev_laptop");
  await c.vault.lease();
  await r.home.status(r.bob, { device_key: "KEY_LAPTOP" });   // the lender's runner says which key it lends under (lent.status) when it starts
  await c.beat({ sessions: [], well: true });
  const session = o.session || "s_pipe1";
  const proc = r.home.spawn({ session, person: BOB, args: o.args || ["--output-format", "stream-json"] });
  // what the SDK would have hooked up the moment it had the object: the events are kept from here, so a process that is quick cannot slip past a test that attaches later
  /** @type {any[]} */ const ended = [];
  const closed = new Promise(res => proc.on("close", (/** @type {any} */ code, /** @type {any} */ sig) => { ended.push([code, sig]); res([code, sig]); }));
  const hb = await c.beat({ sessions: [], well: true });
  const spec = await c.spec({ session });
  const child = spawn(process.execPath, ["-e", o.program || CAT_UPPER], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  const ctl = { pipe: (/** @type {any} */ i) => c.pipe(i), onKill: (/** @type {string} */ sig) => { child.kill(/** @type {any} */ (sig)); } };
  const pump = startPump({ child, session, pipe: (/** @type {any} */ i) => ctl.pipe(i), onKill: sig => ctl.onKill(sig), minGapMs: 5, longMs: 3000, retryMs: 20, ...(o.pump || {}) });
  t.after(() => pump.stop());
  return { r, c, proc, hb, spec, child, pump, session, ctl, closed, ended };
}

test("the SDK writes stdin on the home and reads the lender's process on the home, in order and exactly once", { timeout: 30_000 }, async t => {
  const w = await lent(t);
  assert.deepEqual(w.hb.directives, [{ do: "start", session: "s_pipe1", pipe: true }], "the lender is asked to start it in its next heartbeat");
  assert.equal(w.spec.pipe, true);
  assert.equal(w.spec.command, "claude");
  assert.deepEqual(w.spec.args, ["--output-format", "stream-json"], "the SDK's flags replace the Space's bare program");
  assert.deepEqual(w.spec.env, {}, "nothing of the box's environment");
  w.proc.stdin.write("hello\n");
  assert.equal(await read(w.proc.stdout, 6), "HELLO\n");
  for (let i = 0; i < 50; i++) w.proc.stdin.write(`line ${i}\n`);
  const want = Array.from({ length: 50 }, (_, i) => `LINE ${i}\n`).join("");
  assert.equal(await read(w.proc.stdout, want.length), want, "fifty writes come back as fifty lines, once each, in order");
  assert.deepEqual([w.proc.pid, w.proc.killed, w.proc.exitCode], [0, false, null]);
  assert.equal(w.proc.lent.device, "dev_laptop");
});

test("a lost answer loses nothing and repeats nothing: the lender sends again what was not acked, the home writes what it has once", { timeout: 30_000 }, async t => {
  let lose = 0;
  const w = await lent(t, { pump: { longMs: 300, minGapMs: 2, retryMs: 5 } });
  // every third answer is thrown away after the home has acted on the call
  const orig = w.ctl.pipe;
  let n = 0;
  w.ctl.pipe = async (/** @type {any} */ i) => { const a = await orig(i); if (++n % 3 === 0) { lose++; throw Object.assign(new Error("the link dropped"), { code: "unreachable" }); } return a; };
  const lines = Array.from({ length: 40 }, (_, i) => `row ${i}\n`);
  for (const l of lines) { w.proc.stdin.write(l); await wait(3); }
  const want = lines.join("").toUpperCase();
  assert.equal(await read(w.proc.stdout, want.length), want);
  await wait(100);
  assert.equal(w.proc.stdout.readableLength, 0, "nothing more arrived: no byte was repeated");
  assert.ok(lose >= 2, "answers were lost");
});

test("the process ending ends the SDK's process with its exit code, after every byte it said", { timeout: 30_000 }, async t => {
  const w = await lent(t, { program: "process.stdout.write('bye\\n'); process.stderr.write('oops\\n'); process.exit(3)" });
  const out = read(w.proc.stdout, 4), err = read(w.proc.stderr, 5);
  assert.equal(await out, "bye\n"); assert.equal(await err, "oops\n");
  assert.deepEqual(await w.closed, [3, null]);
  assert.equal(w.proc.exitCode, 3);
});

test("kill asks the lender to end the process tree, and a closed stdin reaches the process", { timeout: 30_000 }, async t => {
  const w = await lent(t, { program: "setInterval(() => {}, 1000)" });
  assert.equal(w.proc.kill(), true);
  const [, signal] = await w.closed;
  assert.equal(signal, "SIGTERM", "the signal the lender's process died of");
  assert.equal(w.proc.kill(), false, "a process that ended cannot be killed again");
  // stdin closed by the SDK: the process sees its end
  const v = await lent(t, { session: "s_pipe2" });
  v.proc.stdin.end();
  assert.deepEqual(await v.closed, [0, null]);
});

test("the session moving to the server ends the SDK's process as a move, not a crash, and a fenced lender writes nothing more", { timeout: 30_000 }, async t => {
  const w = await lent(t);
  w.proc.stdin.write("one\n");
  assert.equal(await read(w.proc.stdout, 4), "ONE\n");
  const taken = await w.r.home.takeOver("s_pipe1", "lid-closed", { auto: true });
  assert.equal(taken.changed, true);
  assert.deepEqual(await w.closed, [null, "SIGHUP"]);
  assert.deepEqual(w.proc.moved, { to: "server", reason: "lid-closed", epoch: 2 });
  // the lender's next call is fenced: it stops, and a byte it says now reaches no one
  await assert.rejects(w.c.pipe({ session: "s_pipe1", ack: 0 }), (/** @type {any} */ e) => e.code === "conflict" || e.code === "not_found");
});

test("a spawn nobody took never started: no ready computer fails at once, a computer that does not start it fails after the wait, and nothing ran either way", { timeout: 30_000 }, async t => {
  keepAlive(t);
  const r = await rig(t);
  const none = r.home.spawn({ session: "s_none", person: BOB });
  const e = await new Promise(res => { none.on("error", res); });
  assert.equal(/** @type {any} */ (e).code, "lent_unavailable");
  await new Promise(res => none.on("close", res));
  assert.equal(none.exitCode, null);
  // a lender that is not well is not asked
  const c = r.as(BOB, "dev_laptop"); await c.vault.lease(); await r.home.status(r.bob, { device_key: "KEY_LAPTOP" }); await c.beat({ sessions: [] });
  const unwell = r.home.spawn({ session: "s_unwell", person: BOB });
  assert.equal(/** @type {any} */ (await new Promise(res => unwell.on("error", res))).code, "lent_unavailable");
  // well, asked, but never starts it
  const pipes = createPipes({ startMs: 50 });
  const slow = pipes.spawn({ session: "s_slow", person: BOB, device: "dev_laptop", command: "claude" });
  assert.equal(/** @type {any} */ (await new Promise(res => slow.on("error", res))).code, "lent_unavailable");
});

test("the box's paths do not travel: flags that name a file, socket or folder on the box are dropped, with the interpreter's script before the first flag", () => {
  assert.deepEqual(lenderArgs(["/usr/lib/claude/cli.js", "--output-format", "stream-json", "--mcp-config", "/box/mcp.json", "--add-dir=/box/x", "--verbose", "--settings", "/box/s.json", "--permission-mode", "default"]),
    ["--output-format", "stream-json", "--verbose", "--permission-mode", "default"]);
  assert.deepEqual(lenderArgs(undefined), []);
});

test("output is not dropped for a slow reader: the lender is told to hold, and everything arrives when the SDK reads", { timeout: 30_000 }, async t => {
  const w = await lent(t, { program: "const big = 'x'.repeat(65536); let n = 0; (function go() { let ok = true; while (n < 96 && ok) { ok = process.stdout.write(big); n++; } if (n < 96) process.stdout.once('drain', go); else process.stdout.write('', () => process.exit(0)); })();" });
  w.proc.stdout.pause();
  await wait(1500);
  assert.ok(w.proc.stdout.readableLength <= PIPE.UP_HIGH + PIPE.CALL_BYTES, "the home does not hold more than its limit while the SDK is not reading: " + w.proc.stdout.readableLength);
  let total = 0;
  w.proc.stdout.on("data", (/** @type {any} */ d) => { total += d.length; });
  w.proc.stdout.resume();
  await w.closed;
  assert.equal(total, 96 * 65536, "every byte arrived");
});

test("a chat is not started on a computer while the server could not take it back: it sits frozen on a sleeping Mac otherwise", { timeout: 30_000 }, async t => {
  keepAlive(t);
  let loader = false;
  const r = await rig(t, { canResume: () => loader });
  const c = r.as(BOB, "dev_laptop");
  await c.vault.lease(); await r.home.status(r.bob, { device_key: "KEY_LAPTOP" }); await c.beat({ sessions: [], well: true });
  const no = r.home.spawn({ session: "s_early", person: BOB });
  assert.equal(/** @type {any} */ (await new Promise(res => no.on("error", res))).code, "lent_unavailable");
  loader = true;   // the resume loader exists now
  const yes = r.home.spawn({ session: "s_ok", person: BOB });
  assert.deepEqual((await c.beat({ sessions: [], well: true })).directives.map((/** @type {any} */ d) => d.session), ["s_ok"]);
  yes.kill();
});

test("an ended pipe is remembered long enough for the lender's last call to hear it closed, and then forgotten", async () => {
  /** @type {{ fn: () => void, ms: number }[]} */ const timers = [];
  const pipes = createPipes({ setTimer: /** @type {any} */ ((/** @type {() => void} */ fn, /** @type {number} */ ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; }), clearTimer: /** @type {any} */ ((/** @type {any} */ t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }) });
  const proc = pipes.spawn({ session: "s_forget", person: BOB, device: "dev_laptop", command: "claude" });
  await pipes.poll("s_forget", 1, "dev_laptop", { wait_ms: 0 });
  pipes.end("s_forget", { signal: "SIGTERM" });
  assert.equal((await pipes.poll("s_forget", 1, "dev_laptop", { wait_ms: 0 })).closed, true, "the lender's last call hears it is closed");
  for (const t of timers.filter(x => x.ms === 60_000)) t.fn();
  const gone = pipes.poll("s_forget", 1, "dev_laptop", { wait_ms: 0 });
  for (const t of timers.splice(0)) t.fn();   // an unknown session's call is answered idle on a timer of its own
  assert.deepEqual(await gone, { down: [], acked: 0, idle: true }, "a minute later nothing is kept of it");
  void proc;
});
