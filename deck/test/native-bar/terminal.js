// @ts-check
// The terminal side of the native bar comparison: a pty running the bar's fake claude, timed from
// bytes in to bytes out.
//
//   node deck/test/native-bar/terminal.js < /dev/null   (over ssh, give it no terminal stdin: `script` waits on it)
//
// Keystroke echo: 200 single characters written to the pty, each timed until it comes back.
// The fake claude reads stream-json lines, so the pty is in cooked mode and the echo is the tty's
// own; the real Claude Code draws its own echo in raw mode, which this does not measure.
// First token: a stream-json user message ("burst 21") written to the pty, timed until the first
// content_block_delta line comes out.
//
// The pty: node-pty when it is already installed (in this repo or next to it); it is not a
// dependency and this adds none. Without it, util-linux `script` (a system tool, not a new
// dependency) runs the fake under a pty. Without either, both metrics are "n/a".
// Prints one JSON line per metric, like run.js. Exits 0 always. A test helper, not part of the product.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { p95, percentile } from "./stats.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-claude.js");
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;
const out = (/** @type {any} */ r) => process.stdout.write(JSON.stringify(r) + "\n");
const round = (/** @type {number|null} */ v) => (v == null ? "n/a" : Math.round(v * 100) / 100);

/** @returns {{ how: string, write: (s: string) => void, onData: (f: (s: string) => void) => void, kill: () => void } | null} */
function openPty() {
  const env = { ...process.env, VYRE_NO_DIALOGS: "1", TERM: "xterm-256color" };
  delete env.FAKE_CLAUDE_TRANSCRIPTS;
  try {
    const req = createRequire(import.meta.url);
    const pty = req("node-pty");
    const p = pty.spawn(process.execPath, [FAKE, "--session-id", "bar-terminal"], { name: "xterm-256color", cols: 120, rows: 40, cwd: HERE, env });
    return { how: "node-pty", write: s => p.write(s), onData: f => p.onData(f), kill: () => p.kill() };
  } catch {}
  if (process.platform === "linux" && spawnSync("script", ["--version"], { encoding: "utf8" }).status === 0) {
    const cmd = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} --session-id bar-terminal`;
    // Its own process group, so the stop takes script and the fake under it together.
    const p = spawn("script", ["-q", "-f", "-c", cmd, "/dev/null"], { cwd: HERE, env, stdio: ["pipe", "pipe", "ignore"], detached: true });
    return { how: "util-linux script", write: s => p.stdin.write(s), onData: f => p.stdout.on("data", d => f(String(d))),
      kill: () => { try { p.stdin.end(); } catch {} try { process.kill(-(/** @type {number} */ (p.pid)), "SIGTERM"); } catch {} } };
  }
  return null;
}

const pty = openPty();
if (!pty) {
  const why = "no pty available: node-pty is not installed and util-linux script is missing";
  out({ id: "T1", metric: "terminal keystroke echo p95 (ms)", value: "n/a", budget: "compare with 1", pass: null, detail: why });
  out({ id: "T2", metric: "terminal first token (ms)", value: "n/a", budget: "compare with 2 and 3", pass: null, detail: why });
  process.exit(0);
}

let buf = "";
/** @type {((s: string) => void) | null} */ let waiter = null;
pty.onData(s => { buf += s; if (waiter) waiter(buf); });
const until = (/** @type {(b: string) => boolean} */ test, ms = 5000) => new Promise(resolve => {
  if (test(buf)) return resolve(true);
  const t = setTimeout(() => { waiter = null; resolve(false); }, ms);
  waiter = b => { if (test(b)) { clearTimeout(t); waiter = null; resolve(true); } };
});

try {
  // Up: the fake prints its hook line first.
  await until(b => b.includes("hook_response"), 10_000);
  await sleep(300);

  // Keystroke echo. Characters only, no newline, so the fake reads nothing until the line ends.
  const echo = [];
  const chars = "Northwind Bakery adds a pumpkin loaf and kit reviews the copy ".repeat(4).slice(0, 200);
  for (const c of chars) {
    const mark = buf.length;
    const t0 = now();
    pty.write(c);
    if (await until(b => b.length > mark && b.slice(mark).includes(c), 1000)) echo.push(now() - t0);
    await sleep(15);
  }
  // Clear the typed line: Ctrl-U kills it in cooked mode, and the empty line that follows is ignored.
  pty.write("\u0015\n");
  await sleep(200);
  out({ id: "T1", metric: "terminal keystroke echo p95 (ms)", value: round(p95(echo)), budget: "compare with 1", pass: null,
    detail: `${pty.how}; median ${round(percentile(echo, 50))} ms over ${echo.length} of 200 keys; the tty's own echo (cooked input), not Claude Code's raw-mode redraw` });

  // First token.
  pty.write(JSON.stringify({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } }) + "\n");
  await until(b => b.includes('"subtype":"init"'), 5000);
  const mark = buf.length;
  const t0 = now();
  pty.write(JSON.stringify({ type: "user", message: { role: "user", content: "burst 21" } }) + "\n");
  const got = await until(b => b.slice(mark).includes("content_block_delta"), 10_000);
  const ms = got ? now() - t0 : null;
  out({ id: "T2", metric: "terminal first token (ms)", value: round(ms), budget: "compare with 2 and 3", pass: null,
    detail: `${pty.how}; stream-json user line in to the first content_block_delta out, through the pty; the fake claude, no model` });
} catch (e) {
  out({ id: "T", metric: "terminal", value: "n/a", budget: "", pass: null, detail: "harness error: " + String(/** @type {any} */ (e)?.message || e) });
} finally {
  pty.kill();
  await sleep(200);
  process.exit(0);
}
