// Screenshots of the exported web app (dist/, base path /app) in headless Chromium, for matching the prototype's reference shots (team/0.3/ui-ref).
//   node scripts/shots.mjs <outdir> <route>... [--dist dist] [--w 390,1280] [--theme dark,paper] [--h 860]
// A route is a path under /app (u/now, u/records/contact). Files: <outdir>/<w>-<route with _>-<theme>.png. Needs `playwright` resolvable (it is on the test server, not in the app).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const dist = path.resolve(flag("--dist", "dist"));
const widths = flag("--w", "390,1280").split(",").map(Number);
const themes = flag("--theme", "dark,paper").split(",");
const height = Number(flag("--h", "860"));
const [out, ...routes] = args;
fs.mkdirSync(out, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(process.env.HOME, "shots/"));
const { chromium } = require("playwright");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".ttf": "font/ttf" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  let f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch();
let bad = 0;
try {
  for (const w of widths) for (const theme of themes) {
    const ctx = await browser.newContext({ viewport: { width: w, height }, colorScheme: theme === "paper" ? "light" : "dark", deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    for (const r of routes) {
      const [route, query = ""] = r.split("?");
      await page.goto(`http://127.0.0.1:${port}/app/${route}${query ? "?" + query : ""}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(600);
      const sideways = await page.evaluate(() => document.scrollingElement.scrollWidth > innerWidth + 1);
      if (sideways) { bad++; console.log(`WARN ${w} ${r} ${theme}: scrolls sideways`); }
      const full = await page.evaluate(() => Math.max(document.scrollingElement.scrollHeight, ...[...document.querySelectorAll("*")].filter((e) => e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY !== "visible").map((e) => e.scrollHeight)));
      await page.setViewportSize({ width: w, height: Math.min(Math.max(full, height), 4000) });
      await page.screenshot({ path: path.join(out, `${w}-${route.replace(/\//g, "_")}-${theme}.png`) });
      await page.setViewportSize({ width: w, height });
    }
    if (errors.length) { console.log(`console errors at ${w} ${theme}:`, errors.slice(0, 5).join(" | ")); }
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
process.exit(bad ? 1 : 0);
