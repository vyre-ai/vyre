// @ts-check
// The box container's restart loop (core/daemon/loop.sh, ADR 0029 R4 and R7), with a fake vyred.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../test/helpers.js";

const LOOP = path.join(path.dirname(fileURLToPath(import.meta.url)), "loop.sh");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * A fake vyred: logs each start, exits with the next code in `codes`, or stays up until SIGTERM,
 * then exits with `termCode` after `termMs` (its drain).
 */
function fake(dir, codes, { termMs = 200, termCode = 0 } = {}) {
  const js = path.join(dir, "fake-vyred.mjs");
  fs.writeFileSync(js, `import fs from "node:fs";
const log = ${JSON.stringify(path.join(dir, "log"))};
const n = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(log, "start\\n");
const codes = ${JSON.stringify(codes)};
if (n < codes.length) process.exit(codes[n]);
process.on("SIGTERM", () => setTimeout(() => { fs.appendFileSync(${JSON.stringify(path.join(dir, "drained"))}, "yes"); process.exit(${termCode}); }, ${termMs}));
setInterval(() => {}, 1000);
`);
  return `${process.execPath} ${js}`;
}

function run(dir, codes, o) {
  const p = spawn("/bin/sh", [LOOP], { env: { ...process.env, VYRE_DAEMON: fake(dir, codes, o), VYRE_LOOP_PAUSE: "0.1" }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  p.stderr.on("data", d => { err += d; });
  const exited = new Promise(r => p.on("exit", code => r(code)));
  return { p, exited, err: () => err, starts: () => (fs.existsSync(path.join(dir, "log")) ? fs.readFileSync(path.join(dir, "log"), "utf8").split("\n").filter(Boolean).length : 0) };
}

test("loop: a vyred that exits is started again, and a container stop drains it and ends the loop", { timeout: 20_000 }, async t => {
  const dir = tempHome(t);
  const l = run(dir, [1]);
  t.after(() => { try { l.p.kill("SIGKILL"); } catch {} });
  for (let i = 0; i < 100 && l.starts() < 2; i++) await sleep(50);
  assert.equal(l.starts(), 2, "vyred was not started again after it exited");
  assert.match(l.err(), /exited \(1\); starting it again/);
  await sleep(200);
  l.p.kill("SIGTERM");
  assert.equal(await l.exited, 0);
  assert.equal(fs.readFileSync(path.join(dir, "drained"), "utf8"), "yes", "the loop ended before vyred drained");
  assert.equal(l.starts(), 2, "a stopping container started vyred again");
});

test("loop: five exits inside a minute leave vyred to Docker's restart policy", { timeout: 20_000 }, async t => {
  const dir = tempHome(t);
  const l = run(dir, [3, 3, 3, 3, 3, 3]);
  t.after(() => { try { l.p.kill("SIGKILL"); } catch {} });
  assert.equal(await l.exited, 3);
  assert.equal(l.starts(), 5);
  assert.match(l.err(), /5 times in a minute/);
});

test("loop: a stop passes on vyred's own exit code, even when vyred is gone before the loop waits again", { timeout: 20_000 }, async t => {
  // vyred drains at once and exits 7: the trapped wait returns 143, and the loop must not.
  const dir = tempHome(t);
  const l = run(dir, [], { termMs: 0, termCode: 7 });
  t.after(() => { try { l.p.kill("SIGKILL"); } catch {} });
  for (let i = 0; i < 100 && l.starts() < 1; i++) await sleep(50);
  await sleep(200);
  l.p.kill("SIGTERM");
  assert.equal(await l.exited, 7);
  assert.equal(l.starts(), 1);
});

test("loop: a vyred killed outright (SIGKILL) is started again", { timeout: 20_000 }, async t => {
  // dash, the box's /bin/sh, answers a second wait with the same 137, where bash says 127.
  const dir = tempHome(t);
  const l = run(dir, [137]);
  t.after(() => { try { l.p.kill("SIGKILL"); } catch {} });
  for (let i = 0; i < 100 && l.starts() < 2; i++) await sleep(50);
  assert.equal(l.starts(), 2, "vyred was not started again after a SIGKILL");
  assert.match(l.err(), /exited \(137\); starting it again/);
});
