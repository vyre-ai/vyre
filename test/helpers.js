// @ts-check
// Shared test helpers. Every test gets its own VYRE_HOME in a temp folder; nothing ever touches
// the real ~/.vyre. A past prototype test read live state and printed a real key into a failure
// message, which is why this is the only way tests get a home.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCRATCH, HOMES } from "./scratch.mjs";

// No test may run the machine's real tailscale: `vyre up` on a Mac with no box looks for one on
// the tailnet (ADR 0008). A path that does not exist reads as "Tailscale is not installed". A test
// that needs Tailscale sets its own fake, which replaces this.
if (!process.env.VYRE_TAILSCALE_BIN) process.env.VYRE_TAILSCALE_BIN = path.join(os.tmpdir(), "vyre-no-tailscale", "tailscale");

export function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-test-"));
  // A leaked home can come back holding only what a late write put there, so the name of the
  // test that made it is kept outside it.
  const name = /** @type {any} */ (t).fullName || t.name;
  try { fs.appendFileSync(HOMES, `${path.basename(dir)}\t${path.relative(path.resolve(import.meta.dirname, ".."), process.argv[1] || "?")}\t${name}\n`); } catch {}
  const real = path.join(os.homedir(), ".vyre");
  if (path.resolve(dir) === path.resolve(real)) throw new Error("a test tried to use the real ~/.vyre");
  const prev = process.env.VYRE_HOME;
  process.env.VYRE_HOME = dir;
  // No test reaches the user's real Tailscale: unless a test set its own fake, point the binary at
  // a path that does not exist, which every caller treats as "no tailnet". Child processes a test
  // spawns inherit it.
  const prevTs = process.env.VYRE_TAILSCALE_BIN;
  if (!prevTs) process.env.VYRE_TAILSCALE_BIN = path.join(dir, "no-tailscale");
  t.after(async () => {
    if (prev === undefined) delete process.env.VYRE_HOME; else process.env.VYRE_HOME = prev;
    if (prevTs === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prevTs;
    // A test that ran `vyre up` in a child process may still have that vyred running: after-hooks
    // run in the order they were added, so this cleanup runs before the test's own `vyre down`.
    // Deleting the home under a live vyred orphaned it (fourteen of them, found running). So stop
    // any daemon this home started, unless it is this process (an in-process start()).
    await stopDaemon(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * Stop a vyred child process started in this home, and wait for it to actually be gone before
 * returning: a caller that removes the home right after this resolves (as every one does) must
 * never do it out from under a process still holding it open, the same class of bug that once
 * orphaned fourteen running vyreds when their homes were deleted out from under them.
 */
export async function stopDaemon(dir) {
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(dir, "vyred.pid"), "utf8")); } catch { return; }
  if (!pid || pid === process.pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(r => setTimeout(r, 50));
  }
  // SIGTERM alone did not make it exit within 2.5s (a held-open SSE stream or a stuck signal
  // handler can do this). Force it, but say so loudly: a silent SIGKILL here would paper over a
  // real hang instead of surfacing it, the same class of bug that used to hang this whole suite.
  console.error(`test helpers: vyred pid ${pid} did not exit on SIGTERM within 2.5s, sending SIGKILL`);
  try { process.kill(pid, "SIGKILL"); } catch { return; }
  for (let i = 0; i < 20; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(r => setTimeout(r, 50));
  }
  console.error(`test helpers: vyred pid ${pid} still alive 1s after SIGKILL; the home will not be removed`);
  throw new Error(`vyred pid ${pid} would not die; not removing its home`);
}

/** Write a module folder under root with the given manifest and entry source. */
export function writeModule(root, name, manifest, source) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name, version: "0.1.0", ...manifest }));
  fs.writeFileSync(path.join(dir, "index.js"), source);
  return dir;
}

/**
 * A presence verifier that finds a person at every call, for tests of what a tool does once the
 * user has approved. The presence tests themselves (core/presence, test/daemon.test.js,
 * test/presence-bypass.test.js) use the real one.
 */
export const present = {
  required: () => false,
  verify: async () => ({ ok: true, method: "test" }),
  challenge: async () => ({ error: { code: "bad_input", message: "presence is not checked in this test" } }),
};

/**
 * Start vyred in a child process for a temp home, as `vyre up` would, but with `present` as its
 * verifier. `vyre down` stops it as usual.
 * @param {string} home
 */
export async function upPresent(home) {
  const { spawn } = await import("node:child_process");
  const { ping } = await import("../core/daemon/index.js");
  const config = await import("../core/config/index.js");
  const p = config.ensure(home);
  const fd = fs.openSync(path.join(p.logs, "vyred.out"), "a");
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "fixtures", "vyred-present.js")],
    { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, VYRE_HOME: home } });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await ping(p.socket)) return { code: 0, pid: child.pid };
    if (child.exitCode !== null) break;
  }
  return { code: 1 };
}
