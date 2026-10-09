// Screenshots of the preview card in each state, from the sample-world web export (EXPO_PUBLIC_VYRE_MOCK=1 npx expo export -p web --output-dir dist-vux):
//   PW_FROM=<a folder with playwright installed>/ node scripts/preview-shots.mjs <outdir> [--dist dist-vux]
// 1280 and 390 wide, light and dark: the four cards together, and the share sheet open on one.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const dist = path.resolve(flag("--dist", "dist-vux"));
const [out] = args;
fs.mkdirSync(out, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  let f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/app/shots-previews`;
const browser = await chromium.launch();
try {
  for (const [w, h] of [[1280, 900], [390, 844]]) for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, deviceScaleFactor: w > 600 ? 1 : 1.5 });
    const page = await ctx.newPage(); page.setDefaultTimeout(60000);
    const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`), fullPage: true }); };
    await page.goto(base, { waitUntil: "networkidle" }); await page.waitForTimeout(800);
    await shot("cards-all");
    await page.getByRole("button", { name: "Share" }).first().click(); await shot("share-sheet");
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
