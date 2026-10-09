// @ts-check
// Render a screen to a picture, for an agent that designs it (the Design MCP) and for the owner's before and after.
//
// The screen is drawn by the app itself: the app's /gallery route takes the resolved screen in its query and draws it with the same BlockScreen the app uses, and a headless Chrome takes the
// picture. A block with no content shows the catalogue's own sample, so a design can be seen before any data exists; the picture says so (sampled).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { BLOCKS, reduceScreen } from "../views/blocks.js";

/** Where a headless Chrome may be, in the order tried. CHROME overrides. */
export function findChrome(env = process.env, exists = fs.existsSync) {
  const candidates = [env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"];
  for (const c of candidates) if (c && exists(c)) return c;
  return "";
}

/**
 * The screen with sample content wherever a block has none, and the list of blocks that were sampled.
 * @param {any} screen @returns {{ screen: any, sampled: string[] }}
 */
export function withSamples(screen) {
  /** @type {string[]} */ const sampled = [];
  const blocks = Object.fromEntries(Object.entries(screen.blocks || {}).map(([k, b]) => {
    const blk = /** @type {any} */ (b), spec = BLOCKS[blk.type];
    if (!spec || (blk.content && Object.keys(blk.content).length) || blk.type === "actions") return [k, blk];
    sampled.push(k);
    return [k, { ...blk, content: spec.sample, ...(blk.type === "approval" && !blk.actions ? { actions: [{ id: "yes", title: "Yes" }, { id: "no", title: "Not now" }] } : {}) }];
  }));
  return { screen: { ...screen, blocks }, sampled };
}

/** The query value the gallery reads: the screen as base64url JSON. @param {any} screen */
export const encodeScreen = screen => Buffer.from(JSON.stringify(screen)).toString("base64url");

/**
 * @param {{ screen: any, surface?: "app" | "phone" | "chat" | "lumen", theme?: "dark" | "paper", width?: number, height?: number, appUrl: string, chrome?: string, out?: string, timeoutMs?: number }} o
 * @returns {Promise<{ file: string, sampled: string[], width: number, height: number }>}
 */
export async function renderScreen(o) {
  const chrome = o.chrome || findChrome();
  if (!chrome) throw Object.assign(new Error("no Chrome found: set CHROME to a Chrome or Chromium binary"), { code: "no_chrome" });
  if (!o.appUrl) throw Object.assign(new Error("no app address: set VYRE_APP_URL to where the Vyre app is served (https://.../app)"), { code: "no_app" });
  const surface = o.surface || "app", width = o.width || (surface === "app" ? 1280 : 390), height = o.height || 900;
  const { screen, sampled } = withSamples(o.screen);
  const reduced = reduceScreen(screen, surface);
  const q = encodeScreen(reduced);
  if (q.length > 60_000) throw Object.assign(new Error("that screen is too large to render here"), { code: "too_big" });
  const form = surface === "chat" || surface === "lumen" ? "glance" : surface === "phone" ? "compact" : "full";
  const url = `${o.appUrl.replace(/\/$/, "")}/gallery?screen=${q}&form=${form}&theme=${o.theme === "dark" ? "dark" : "paper"}`;
  const file = o.out || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vyre-design-")), `${surface}-${o.theme || "paper"}.png`);
  const shell = /headless[-_]shell/.test(path.basename(chrome));
  const args = [...(shell ? [] : ["--headless=new"]), "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "vyre-chrome-"))}`, `--window-size=${width},${height}`,
    "--virtual-time-budget=6000", `--blink-settings=preferredColorScheme=${o.theme === "dark" ? 1 : 0}`, `--screenshot=${file}`, ...((process.getuid && process.getuid() === 0) || process.env.VYRE_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), url];
  await new Promise((resolve, reject) => {
    const p = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", d => { err += String(d).slice(0, 2000); });
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(Object.assign(new Error("Chrome took too long to draw the screen"), { code: "timeout" })); }, o.timeoutMs || 60_000);
    p.on("error", e => { clearTimeout(timer); reject(e); });
    p.on("close", () => { clearTimeout(timer); fs.existsSync(file) ? resolve(undefined) : reject(Object.assign(new Error(`Chrome made no picture: ${err.split("\n").slice(-2).join(" ").slice(0, 200)}`), { code: "no_picture" })); });
  });
  return { file, sampled, width, height };
}
