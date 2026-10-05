#!/usr/bin/env node
// render-check: every main screen of the app draws, at phone width and at desktop width, in headless Chromium. It serves a web export built with the sample world (EXPO_PUBLIC_VYRE_MOCK=1) at /app and visits each route.
// A screen fails when it throws (a page error), shows the router's "unmatched route" or an error boundary, or draws almost nothing. It does not judge the screens' words: the app walks do that against a real box.
//
//   EXPO_PUBLIC_VYRE_MOCK=1 npx expo export -p web --output-dir dist-mock
//   PW_FROM=<a folder with playwright installed>/ node scripts/render-check.mjs --dist dist-mock [--out render-out]
//
// Exit 0 when every screen drew. One PNG per screen and width goes to --out when it is given.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "dist-mock"));
const OUT = flag("--out", "") ? path.resolve(flag("--out", "")) : "";
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

/** The main screens, as the shell offers them (screens/shell/nav.ts) plus what the first run and a chat open. */
export const ROUTES = [
  "/u/now", "/u/chats", "/u/chats/new", "/u/search", "/u/projects", "/u/records/contact", "/u/records/matter", "/u/drive", "/u/calendar", "/u/memory", "/u/vault", "/u/flows", "/u/kits", "/u/assistants",
  "/u/settings", "/u/appearance", "/u/settings/devices", "/u/settings/customize", "/u/spaces", "/u/wink", "/u/install", "/u/install/create", "/u/install/join", "/session/demo",
];
const WIDTHS = [390, 1280];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  let f = path.join(DIST, p);
  const missing = !f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory();
  if (missing && path.extname(p)) { res.writeHead(404); return res.end(); }
  if (missing) f = path.join(DIST, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}/app`;
const browser = await chromium.launch({ args: ["--use-mock-keychain", "--password-store=basic"] });
let failed = 0;
for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, isMobile: width < 600, hasTouch: width < 600, colorScheme: "dark", serviceWorkers: "block" });
  for (const route of ROUTES) {
    const pg = await ctx.newPage();
    const errors = [];
    pg.on("pageerror", (e) => errors.push(String(e.message).slice(0, 140)));
    let why = "";
    try {
      await pg.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
      await pg.waitForFunction(() => document.body && document.body.innerText.replace(/\s+/g, " ").trim().length > 25, null, { timeout: 25000 }).catch(() => {});
      await pg.waitForTimeout(800);
      const text = (await pg.locator("body").innerText()).replace(/\s+/g, " ").trim();
      if (errors.length) why = `page error: ${errors[0]}`;
      else if (/unmatched route|page could not be found|something went wrong/i.test(text)) why = `error screen: ${text.slice(0, 90)}`;
      else if (text.length <= 25) why = "drew almost nothing";
      if (OUT) await pg.screenshot({ path: path.join(OUT, `${width}${route.replace(/\//g, "_")}.png`) });
    } catch (e) { why = String(e.message).split("\n")[0]; }
    if (why) failed++;
    console.log(`${why ? "FAIL" : "PASS"} ${String(width).padStart(4)} ${route}${why ? `  ${why}` : ""}`);
    await pg.close();
  }
  await ctx.close();
}
await browser.close(); server.close();
console.log(`${ROUTES.length * WIDTHS.length - failed} drew, ${failed} did not`);
process.exit(failed ? 1 : 0);
