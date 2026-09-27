// @ts-check
// holder.js with a real shell: attach and an echo round trip, reattach with from=<offset> getting
// only the missed bytes, the keepMs end ("detached"), CLOSE, and that the process that started a
// holder going away (vyred's side) does not take the shell with it. Linux only: the pty is
// util-linux `script`, which the box has. Every holder a test starts is ended by that test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "../../test/scratch.mjs";
import { spawnHolder, dial, query } from "./holder.js";
import { T, frame, json } from "./ring.js";

const LINUX = process.platform === "linux";
const skip = !LINUX && "the pty runs on the box (util-linux script)";
const HERE = path.dirname(fileURLToPath(import.meta.url));

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await wait(50); } return fn(); };

/** A temp dir for the socket and the shell's folder, and a start() that cleans up after itself. */
function place(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "th-"));
  fs.chmodSync(dir, 0o700);
  /** @type {{ pid: number, sock: string }[]} */ const started = [];
  t.after(async () => {
    for (const h of started) {
      const info = await query(h.sock, 500).catch(() => null);
      try { process.kill(h.pid, "SIGTERM"); } catch {}
      await until(() => !alive(h.pid), 3000);
      try { process.kill(h.pid, "SIGKILL"); } catch {}
      // A holder killed hard leaves its pty behind: end that too.
      for (const g of [info && info.pty, info && info.leader]) if (g) { try { process.kill(-g, "SIGKILL"); } catch {} }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let n = 0;
  const opts = (o = {}) => ({ id: `t_test${++n}`, cwd: dir, shell: "/bin/sh", login: false, sock: path.join(dir, `h${n}.sock`), keepMs: 60_000, cols: 80, rows: 24, ...o });
  const start = async (o = {}) => { const h = await spawnHolder(opts(o)); started.push(h); return h; };
  return { dir, start, opts, started };
}

/** An attach connection that collects what the holder sends. */
async function attach(sock, hello = {}) {
  const c = { at: /** @type {any} */ (null), out: Buffer.alloc(0), exit: /** @type {any} */ (null), closed: false,
    get text() { return c.out.toString("utf8"); }, sock: /** @type {any} */ (null) };
  c.sock = await dial(sock, { mode: "attach", from: 0, ...hello }, f => {
    if (f.type === T.AT) c.at = json(f.body);
    else if (f.type === T.OUT) c.out = Buffer.concat([c.out, f.body]);
    else if (f.type === T.EXIT) c.exit = json(f.body);
  });
  c.sock.on("close", () => { c.closed = true; });
  c.keys = s => c.sock.write(frame(T.IN, s));
  c.waitFor = async (re, ms = 6000) => { if (!(await until(() => re.test(c.text), ms))) throw new Error(`timed out waiting for ${re} in ${JSON.stringify(c.text.slice(-300))}`); };
  await until(() => c.at, 2000);
  return /** @type {any} */ (c);
}

async function control(sock) {
  const c = { info: /** @type {any} */ (null), exit: /** @type {any} */ (null), closed: false, sock: /** @type {any} */ (null) };
  c.sock = await dial(sock, { mode: "control" }, f => {
    if (f.type === T.INFO) c.info = json(f.body);
    else if (f.type === T.EXIT) c.exit = json(f.body);
  });
  c.sock.on("close", () => { c.closed = true; });
  return c;
}

test("holder: attach, an echo round trip, and INFO with the meta it was given", { skip }, async t => {
  const { start } = place(t);
  const h = await start({ meta: { cwd: "/w", surface: "deck:abc", key: "deck||deck:abc", started: 1 } });
  assert.ok(alive(h.pid));
  assert.equal((fs.statSync(h.sock).mode & 0o777), 0o600);
  const a = await attach(h.sock);
  assert.deepEqual({ from: a.at.from, cut: a.at.cut, cols: a.at.cols, rows: a.at.rows }, { from: 0, cut: false, cols: 80, rows: 24 });
  a.keys("echo h''i\n");
  await a.waitFor(/\bhi\r?\n/);
  const info = await query(h.sock);
  assert.equal(info.id, "t_test1");
  assert.equal(info.pid, h.pid);
  assert.deepEqual(info.meta, { cwd: "/w", surface: "deck:abc", key: "deck||deck:abc", started: 1 });
  assert.equal(info.attached, 1);
  assert.equal(info.until, null, "an attached terminal has no end time");
  assert.ok(info.end >= a.out.length);
  a.sock.destroy();
});

test("holder: a reattach with from=<offset> gets only the bytes it missed", { skip }, async t => {
  const { start } = place(t);
  const h = await start();
  const a = await attach(h.sock);
  a.keys("echo fir''st\n");
  await a.waitFor(/\bfirst\r?\n/);
  // Something prints while nobody is attached.
  a.keys("sleep 0.4; echo mi''ssed\n");
  await a.waitFor(/sleep 0\.4/);
  await wait(100);
  const offset = a.at.from + a.out.length;
  a.sock.destroy();
  await until(() => a.closed);
  await wait(900);
  const info = await query(h.sock);
  assert.equal(info.attached, 0);
  assert.ok(info.until > Date.now(), "detached: the keep clock runs");
  assert.ok(info.end > offset, "the shell printed while detached");

  const b = await attach(h.sock, { from: offset });
  assert.deepEqual({ from: b.at.from, cut: b.at.cut }, { from: offset, cut: false });
  await b.waitFor(/\bmissed\r?\n/);
  assert.ok(!b.text.includes("first"), `replay went back too far: ${JSON.stringify(b.text)}`);
  assert.ok(!b.text.includes("sleep 0.4"));
  // The whole history from 0, and the older client's tail, still work.
  const c = await attach(h.sock, { from: 0 });
  await c.waitFor(/missed/);
  assert.ok(c.text.includes("first"));
  const d = await attach(h.sock, { from: null, tail: 10 });
  await until(() => d.out.length >= 10, 1000);
  assert.equal(d.out.length, 10);
  // A live key from one attach is seen by every attach.
  b.keys("echo bo''th\n");
  await b.waitFor(/\bboth\r?\n/);
  await c.waitFor(/\bboth\r?\n/);
  for (const x of [b, c, d]) x.sock.destroy();
});

test("holder: with nothing attached for keepMs it ends itself with \"detached\"", { skip }, async t => {
  const { start } = place(t);
  const h = await start({ keepMs: 400 });
  const a = await attach(h.sock);
  const ctl = await control(h.sock);
  // Attached: no end, however long.
  await wait(700);
  assert.ok(alive(h.pid));
  a.sock.destroy();
  await until(() => ctl.exit, 3000);
  assert.deepEqual(ctl.exit, { reason: "detached" });
  assert.ok(await until(() => !alive(h.pid), 4000), "the holder outlived its keep");
  assert.ok(!fs.existsSync(h.sock), "the socket file was left behind");
  assert.equal(await query(h.sock, 300), null);
});

test("holder: CLOSE ends the shell and its jobs, and every connection hears EXIT closed", { skip }, async t => {
  const { start } = place(t);
  const h = await start();
  const a = await attach(h.sock);
  a.keys("sleep 1000 & echo BG=$!\n");
  await a.waitFor(/BG=\d+/);
  const bg = Number(/BG=(\d+)/.exec(a.text)?.[1]);
  assert.ok(alive(bg));
  // An attach connection may not CLOSE; only control may.
  a.sock.write(frame(T.CLOSE, ""));
  await wait(300);
  assert.ok(alive(h.pid));
  const ctl = await control(h.sock);
  ctl.sock.write(frame(T.CLOSE, ""));
  await until(() => ctl.exit && a.exit, 3000);
  assert.deepEqual(ctl.exit, { reason: "closed" });
  assert.deepEqual(a.exit, { reason: "closed" });
  assert.ok(await until(() => !alive(bg), 4000), "a background job outlived the terminal");
  assert.ok(await until(() => !alive(h.pid), 4000));
});

test("holder: the shell exiting ends the holder with \"exited\"", { skip }, async t => {
  const { start } = place(t);
  const h = await start();
  const a = await attach(h.sock);
  a.keys("exit\n");
  await until(() => a.exit, 4000);
  assert.deepEqual(a.exit, { reason: "exited" });
  assert.ok(await until(() => !alive(h.pid), 4000));
});

test("holder: the process that started it dying (vyred's side) leaves the shell running", { skip }, async t => {
  const { opts, started } = place(t);
  const o = opts();
  // A stand-in for vyred: starts the holder, attaches, then is killed hard with the attach open.
  const code = `
    import { spawnHolder, dial } from ${JSON.stringify(path.join(HERE, "holder.js"))};
    const h = await spawnHolder(${JSON.stringify(o)});
    await dial(h.sock, { mode: "attach", from: 0 }, () => {});
    console.log(JSON.stringify(h));
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  parent.stdout.on("data", b => { out += b; });
  assert.ok(await until(() => out.includes("\n"), 6000), "the stand-in did not start a holder");
  const h = JSON.parse(out.trim());
  started.push(h);
  assert.equal((await query(h.sock)).attached, 1);
  parent.kill("SIGKILL");
  await new Promise(r => parent.once("exit", r));
  await wait(300);
  assert.ok(alive(h.pid), "the holder died with the process that started it");
  const info = await query(h.sock);
  assert.equal(info.attached, 0);
  assert.ok(alive(info.pty));
  const a = await attach(h.sock);
  a.keys("echo sti''ll\n");
  await a.waitFor(/\bstill\r?\n/);
  a.sock.destroy();
});

test("holder: a connection that does not start with a valid HELLO is dropped", { skip }, async t => {
  const { start } = place(t);
  const h = await start();
  const net = await import("node:net");
  const c = net.connect(h.sock);
  let closed = false;
  c.on("close", () => { closed = true; });
  c.on("error", () => {});
  c.on("connect", () => c.write(frame(T.IN, "echo nope\n")));
  assert.ok(await until(() => closed, 2000));
  assert.ok(alive(h.pid));
});
