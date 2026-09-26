// @ts-check
// Shared test helpers. Every test gets its own VYRE_HOME in a temp folder; nothing ever touches
// the real ~/.vyre. A past prototype test read live state and printed a real key into a failure
// message, which is why this is the only way tests get a home.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// No test may run the machine's real tailscale: `vyre up` on a Mac with no box looks for one on
// the tailnet (ADR 0008). A path that does not exist reads as "Tailscale is not installed". A test
// that needs Tailscale sets its own fake, which replaces this.
if (!process.env.VYRE_TAILSCALE_BIN) process.env.VYRE_TAILSCALE_BIN = path.join(os.tmpdir(), "vyre-no-tailscale", "tailscale");

export function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-test-"));
  const real = path.join(os.homedir(), ".vyre");
  if (path.resolve(dir) === path.resolve(real)) throw new Error("a test tried to use the real ~/.vyre");
  const prev = process.env.VYRE_HOME;
  process.env.VYRE_HOME = dir;
  t.after(async () => {
    if (prev === undefined) delete process.env.VYRE_HOME; else process.env.VYRE_HOME = prev;
    // A test that ran `vyre up` in a child process may still have that vyred running: after-hooks
    // run in the order they were added, so this cleanup runs before the test's own `vyre down`.
    // Deleting the home under a live vyred orphaned it (fourteen of them, found running). So stop
    // any daemon this home started, unless it is this process (an in-process start()).
    await stopDaemon(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Stop a vyred child process started in this home, and wait for it to exit. */
async function stopDaemon(dir) {
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(dir, "vyred.pid"), "utf8")); } catch { return; }
  if (!pid || pid === process.pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(r => setTimeout(r, 50));
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

/** Write a module folder under root with the given manifest and entry source. */
export function writeModule(root, name, manifest, source) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name, version: "0.1.0", ...manifest }));
  fs.writeFileSync(path.join(dir, "index.js"), source);
  return dir;
}
