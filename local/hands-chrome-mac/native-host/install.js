// @ts-check
// install: registers run.vyre.chrome with Chrome and the other Chromium browsers, so the browser
// will start host.js when the Vyre extension asks. Chrome finds a native host by a manifest at a
// fixed per-browser place (a folder on macOS and Linux, a registry key pointing at a file on
// Windows), and only lets the extension ids named in allowed_origins talk to it, so the id is
// derived from the extension's key (or, for an unpacked extension with no key, its folder path).
//
// Everything is injectable (home, platform, registry) so tests write to a temp home and never
// touch a real browser directory or the real registry.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOST_NAME } from "../extension/shared/proto.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Chrome's extension ids are 32 letters a-p: the first 16 bytes of a SHA-256, one nibble per letter. @param {Buffer} bytes */
const idOf = bytes => [...crypto.createHash("sha256").update(bytes).digest().subarray(0, 16)]
  .map(b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");

/** The id of an extension whose manifest has `key`. @param {string} base64Key */
export const extensionIdFromKey = base64Key => idOf(Buffer.from(String(base64Key), "base64"));

/**
 * The id Chrome gives an unpacked extension with no key: the same hash over its absolute folder
 * path (UTF-16 on Windows, UTF-8 elsewhere).
 * @param {string} absPath @param {string} [platform]
 */
export const extensionIdFromPath = (absPath, platform = process.platform) =>
  idOf(Buffer.from(absPath, platform === "win32" ? "utf16le" : "utf8"));

/** The browsers we know, with the folder name each keeps under its own config root. */
export const BROWSERS = {
  chrome: { mac: "Google/Chrome", linux: "google-chrome", win: "Google\\Chrome" },
  chromium: { mac: "Chromium", linux: "chromium", win: "Chromium" },
  brave: { mac: "BraveSoftware/Brave-Browser", linux: "BraveSoftware/Brave-Browser", win: "BraveSoftware\\Brave-Browser" },
  edge: { mac: "Microsoft Edge", linux: "microsoft-edge", win: "Microsoft\\Edge" },
};
/** @typedef {keyof typeof BROWSERS} Browser */

/** @param {string} home @param {string} platform @param {Browser} b */
function manifestDir(home, platform, b) {
  const name = BROWSERS[b];
  if (platform === "darwin") return path.join(home, "Library", "Application Support", name.mac, "NativeMessagingHosts");
  return path.join(home, ".config", name.linux, "NativeMessagingHosts");
}
/** @param {Browser} b */
const regKey = b => `HKCU\\Software\\${BROWSERS[b].win}\\NativeMessagingHosts\\${HOST_NAME}`;

/** @param {{ home?: string, platform?: string, vyreHome?: string }} o */
function place(o) {
  const platform = o.platform || process.platform;
  const home = o.home || os.homedir();
  const vyreHome = o.vyreHome || process.env.VYRE_HOME || path.join(home, ".vyre");
  return { platform, home, vyreHome, windows: platform === "win32", winManifest: path.join(o.vyreHome || process.env.VYRE_HOME || path.join(home, ".vyre"), "chrome", `${HOST_NAME}.json`) };
}

/** The real registry: `reg add`/`delete`/`query` on the default value of a key. undefined reads, null deletes. */
export function realRegistry(/** @type {string} */ key, /** @type {string|null|undefined} */ valuePath) {
  if (valuePath === undefined) {
    try {
      const out = execFileSync("reg", ["query", key, "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = /REG_SZ\s+(.+)\s*$/m.exec(out);
      return m ? m[1].trim() : null;
    } catch { return null; }
  }
  if (valuePath === null) { try { execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" }); } catch { /* not there */ } return null; }
  execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", valuePath, "/f"], { stdio: "ignore" });
  return valuePath;
}

/** The launcher for this platform, absolute. @param {string} hostDir @param {boolean} windows */
export const launcherOf = (hostDir, windows) => path.join(hostDir, windows ? "run-host.cmd" : "run-host.sh");

/**
 * Browsers to write for when the caller did not choose: Chrome always, and any other whose
 * config folder already exists (a browser the person never ran has no folder to write into).
 * Windows cannot be probed cheaply, so it is Chrome only unless asked.
 */
function detect(p) {
  if (p.windows) return /** @type {Browser[]} */ (["chrome"]);
  return /** @type {Browser[]} */ (Object.keys(BROWSERS)).filter(b => b === "chrome" || fs.existsSync(path.dirname(manifestDir(p.home, p.platform, b))));
}

/**
 * Write the manifest for each browser (and, on Windows, the registry key), the node-path the
 * launchers read, and make the launcher executable.
 * @param {{ home?: string, platform?: string, vyreHome?: string, extensionId: string, browsers?: Browser[], hostDir?: string,
 *   registry?: (key: string, valuePath?: string|null) => any, nodePath?: string }} o
 */
export function install(o) {
  if (!/^[a-p]{32}$/.test(String(o.extensionId))) throw new Error(`"${o.extensionId}" is not a Chrome extension id (32 letters a to p)`);
  const p = place(o);
  const hostDir = o.hostDir || HERE;
  const launcher = launcherOf(hostDir, p.windows);
  if (!fs.existsSync(launcher)) throw new Error(`the launcher is missing: ${launcher}`);
  fs.writeFileSync(path.join(hostDir, "node-path"), o.nodePath || process.execPath);
  if (!p.windows) fs.chmodSync(launcher, 0o755);
  const manifest = {
    name: HOST_NAME,
    description: "Vyre: lets the Vyre extension talk to Vyre on this computer",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${o.extensionId}/`],
  };
  const body = JSON.stringify(manifest, null, 2) + "\n";
  const browsers = o.browsers && o.browsers.length ? o.browsers : detect(p);
  const registry = o.registry || realRegistry;
  /** @type {{ browser: Browser, file: string, key?: string }[]} */
  const written = [];
  for (const b of browsers) {
    if (!BROWSERS[b]) throw new Error(`unknown browser "${b}"`);
    if (p.windows) {
      fs.mkdirSync(path.dirname(p.winManifest), { recursive: true });
      fs.writeFileSync(p.winManifest, body);
      registry(regKey(b), p.winManifest);
      written.push({ browser: b, file: p.winManifest, key: regKey(b) });
    } else {
      const dir = manifestDir(p.home, p.platform, b);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${HOST_NAME}.json`);
      fs.writeFileSync(file, body);
      written.push({ browser: b, file });
    }
  }
  return { ok: true, extensionId: o.extensionId, launcher, written, manifest };
}

/** Remove what install wrote, for the given browsers (default: all we know). @param {{ home?: string, platform?: string, vyreHome?: string, browsers?: Browser[], registry?: (key: string, valuePath?: string|null) => any }} [o] */
export function uninstall(o = {}) {
  const p = place(o);
  const registry = o.registry || realRegistry;
  const browsers = o.browsers && o.browsers.length ? o.browsers : /** @type {Browser[]} */ (Object.keys(BROWSERS));
  /** @type {{ browser: Browser, file: string }[]} */
  const removed = [];
  for (const b of browsers) {
    if (p.windows) {
      registry(regKey(b), null);
      if (fs.existsSync(p.winManifest)) { fs.rmSync(p.winManifest, { force: true }); removed.push({ browser: b, file: p.winManifest }); }
    } else {
      const file = path.join(manifestDir(p.home, p.platform, b), `${HOST_NAME}.json`);
      if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); removed.push({ browser: b, file }); }
    }
  }
  return { ok: true, removed };
}

/**
 * Which browsers have the manifest, what extension each pins, and whether the launcher is there
 * and runnable.
 * @param {{ home?: string, platform?: string, vyreHome?: string, hostDir?: string, browsers?: Browser[], registry?: (key: string, valuePath?: string|null) => any }} [o]
 */
export function status(o = {}) {
  const p = place(o);
  const hostDir = o.hostDir || HERE;
  const launcher = launcherOf(hostDir, p.windows);
  const exists = fs.existsSync(launcher);
  let executable = false;
  if (exists) { try { fs.accessSync(launcher, fs.constants.X_OK); executable = true; } catch { executable = p.windows; } }
  if (p.windows && exists) executable = true;
  const browsers = o.browsers && o.browsers.length ? o.browsers : /** @type {Browser[]} */ (Object.keys(BROWSERS));
  /** @type {{ browser: Browser, file: string, extensionId: string|null, pointsAtLauncher: boolean }[]} */
  const installed = [];
  for (const b of browsers) {
    let file = p.windows ? p.winManifest : path.join(manifestDir(p.home, p.platform, b), `${HOST_NAME}.json`);
    if (p.windows) {
      const reg = (o.registry || realRegistry)(regKey(b));
      if (!reg) continue;
      file = String(reg);
    }
    let m = null;
    try { m = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const origin = (m.allowed_origins || [])[0] || "";
    installed.push({ browser: b, file, extensionId: (/^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin) || [])[1] || null, pointsAtLauncher: m.path === launcher });
  }
  return { installed, launcher, launcherExists: exists, launcherExecutable: executable, nodePath: readNode(hostDir) };
}
function readNode(/** @type {string} */ dir) { try { return fs.readFileSync(path.join(dir, "node-path"), "utf8").trim() || null; } catch { return null; } }
