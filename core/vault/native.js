// @ts-check
// native: fill a login into the app in front of the person, for the Capsule (ADR 0006, section 6).
//
// The Capsule never holds a value. It names the item and the app it saw in front; vyred checks
// the item may go there and hands the username and password to mac/type.swift on stdin. The
// helper checks again, on its side, that the same app is still in front and, for a browser, that
// the tab's origin is exactly one of the login's hosts. For any other app the login must list the
// app's bundle id in its meta.apps: a login fills only where it was meant to.

import { lines } from "./mac/helper.js";

/** Browsers whose front tab's address the helper can read over AppleScript, and which dialect. */
export const BROWSERS = {
  "com.apple.Safari": "safari",
  "com.apple.SafariTechnologyPreview": "safari",
  "com.google.Chrome": "chrome",
  "com.google.Chrome.beta": "chrome",
  "com.brave.Browser": "chrome",
  "com.microsoft.edgemac": "chrome",
};

const BUNDLE = /^[A-Za-z0-9.-]{1,200}$/;
const REPLY_MS = 20_000;

const json = (v, d) => { if (v && typeof v === "object") return v; try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };

/** An http(s) origin, as vault.js computes it. */
function origin(u) {
  try { const x = new URL(String(u)); return ["http:", "https:"].includes(x.protocol) ? x.origin : null; } catch { return null; }
}

/** A login's allowed origins: its hosts and its url's origin. Exact, no suffixes. */
export function hostsOf(r) {
  const hs = new Set(json(r.hosts, []).map(origin).filter(Boolean));
  const u = r.url ? origin(r.url) : null;
  if (u) hs.add(u);
  return /** @type {string[]} */ ([...hs]);
}

/** Bundle ids a login may fill outside a browser: meta.apps once the sealed meta lands, else an apps column. */
export function appsOf(r) {
  const meta = json(r.meta, null);
  const apps = meta && Array.isArray(meta.apps) ? meta.apps : json(r.apps, []);
  return Array.isArray(apps) ? apps.filter(a => typeof a === "string") : [];
}

/** Friendly words for the app in a summary: "Safari" from com.apple.Safari. */
export function appLabel(bundle) {
  const b = String(bundle || "");
  const last = b.split(".").filter(Boolean).pop() || "the app";
  return last.replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 40) || "the app";
}

/** Throw a readable error with a code the tool layer can pass on. */
const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };

/**
 * @param {{ vault: any, helper: import("./mac/helper.js").Helper | null, platform?: string, name: string, app: { bundle: string, pid: number } }} o
 * @returns {Promise<{ filled: string[], via: string, app: string }>}
 */
export async function fillNative({ vault, helper, platform = process.platform, name, app }) {
  if (platform !== "darwin") refuse("unsupported", "filling apps works on a Mac only");
  if (!app || !BUNDLE.test(String(app.bundle || "")) || !Number.isInteger(app.pid) || app.pid <= 0) refuse("bad_input", "give the app's bundle id and pid");
  const r = vault.row(name);
  if (!r || r.kind !== "login") refuse("not_found", `no login named ${name}`);
  const browser = BROWSERS[/** @type {keyof typeof BROWSERS} */ (app.bundle)] || null;
  const hosts = hostsOf(r);
  if (browser && !hosts.length) refuse("wrong_origin", `${name} has no web address, so it does not fill a browser`);
  if (!browser && !appsOf(r).includes(app.bundle)) refuse("wrong_app", `${name} is not set up for ${appLabel(app.bundle)}; add the app to the login first`);
  if (!helper || !helper.usable()) refuse("unsupported", "filling apps needs the Xcode command line tools (swiftc)");

  const f = await vault.fields(r);
  const c = await helper.spawn([]);
  const answer = new Promise((resolve, reject) => {
    const t = setTimeout(() => { c.kill("SIGKILL"); reject(Object.assign(new Error("the fill helper did not answer"), { code: "timeout" })); }, REPLY_MS);
    let got = false;
    lines(c.stdout, msg => { if (!got) { got = true; clearTimeout(t); resolve(msg); } });
    c.stderr.resume();
    c.on("error", () => { clearTimeout(t); reject(Object.assign(new Error("the fill helper could not start"), { code: "unsupported" })); });
    c.on("exit", () => { if (!got) { clearTimeout(t); reject(Object.assign(new Error("the fill helper stopped"), { code: "internal" })); } });
  });
  c.stdin.on("error", () => {});
  c.stdin.end(JSON.stringify({ bundle: app.bundle, pid: app.pid, browser, hosts, username: f.username || "", password: f.password || "" }) + "\n");
  const out = /** @type {any} */ (await answer);
  if (!out || out.ok !== true) {
    // The helper's words are fixed strings in type.swift; pass only known codes and those words.
    const code = out && typeof out.code === "string" && /^[a-z_]{1,32}$/.test(out.code) ? out.code : "internal";
    refuse(code, out && typeof out.message === "string" ? out.message.slice(0, 200) : "the fill failed");
  }
  return { filled: Array.isArray(out.filled) ? out.filled.filter(x => x === "username" || x === "password") : [], via: out.via === "keys" ? "keys" : "ax", app: app.bundle };
}
