// @ts-check
// previews/thumb: the picture on a preview's card. When a preview comes up (and again after each restart) the box's own headless Chrome opens its address on this machine and takes one screenshot; the last good one is
// kept and shown until the next. Whatever Chrome is on this machine is used (Vyre ships none); with none, there is no picture and the card shows its mark. The file is the preview's own: private to the daemon's user, in a
// folder only it reads, and handed out only to a person who may open the preview. Plain Node: the browser is a child process with a deadline, never a library.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "chrome-headless-shell"];
const MAC = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];

/** The Chrome to use: config or VYRE_CHROME, else one on the path, else a Playwright download. Null when there is none. @param {NodeJS.ProcessEnv} [env] @param {string} [configured] */
export function findChrome(env = process.env, configured = "") {
  const ok = (/** @type {string} */ f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
  for (const f of [configured, env.VYRE_CHROME || ""]) if (f && ok(f)) return f;
  for (const dir of String(env.PATH || "").split(path.delimiter)) for (const n of CANDIDATES) { const f = path.join(dir, n); if (ok(f)) return f; }
  for (const f of MAC) if (ok(f)) return f;
  const pw = path.join(env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright"));
  try {
    for (const d of fs.readdirSync(pw).filter(x => /^chromium(_headless_shell)?-\d+$/.test(x)).sort().reverse()) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux64/chrome"]) { const f = path.join(pw, d, rel); if (ok(f)) return f; }
    }
  } catch { /* none downloaded */ }
  return null;
}

/**
 * One screenshot of a loopback address, to `out` (a PNG). Tries Chrome's own sandbox first, then without it (a container that cannot make one). Resolves true when the file was written.
 * @param {{ chrome: string, url: string, out: string, timeoutMs?: number, width?: number, height?: number }} o
 */
export async function capture({ chrome, url, out, timeoutMs = 20_000, width = 800, height = 500 }) {
  for (const sandbox of [true, false]) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-thumb-"));
    const tmp = out.replace(/\.png$/, "") + ".part.png"; // Chrome picks the format from the extension
    const args = ["--headless", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-networking",
      `--user-data-dir=${profile}`, `--window-size=${width},${height}`, "--virtual-time-budget=4000", "--host-resolver-rules=MAP *.localhost 127.0.0.1", `--screenshot=${tmp}`, ...(sandbox ? [] : ["--no-sandbox"]), url];
    const done = await new Promise(resolve => {
      const child = spawn(chrome, args, { stdio: "ignore", detached: true });
      const t = setTimeout(() => { try { process.kill(-(child.pid || 0), "SIGKILL"); } catch { /* gone */ } resolve(false); }, timeoutMs);
      child.on("error", () => { clearTimeout(t); resolve(false); });
      child.on("exit", () => { clearTimeout(t); resolve(true); });
    });
    fs.rmSync(profile, { recursive: true, force: true });
    try {
      if (done && fs.statSync(tmp).size > 200) { fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, out); return true; }
    } catch { /* no file: try the next way */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* none */ }
  }
  return false;
}
