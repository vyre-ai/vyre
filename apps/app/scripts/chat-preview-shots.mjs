// The preview card inside a real chat thread (the sample world's chat on the previews scenario), next to the assistant's own messages: at 1440 and 390, light and dark, with the card alone and with Open pressed
// (a pane beside the chat on a computer, a full-screen sheet on a phone).
//   PW_FROM=<a folder with playwright installed>/ node scripts/chat-preview-shots.mjs <outdir> [--dist dist-vux]
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const dist = path.resolve(flag("--dist", "dist-vux"));
const only = flag("--only", "");
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
const base = `http://127.0.0.1:${server.address().port}/app/chat-demo?scenario=previews&at=90000`;
const browser = await chromium.launch();
try {
  for (const [w, h] of [[1440, 900], [390, 844]]) for (const theme of ["light", "dark"]) {
    if (only && only !== `${w}:${theme}`) continue;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, deviceScaleFactor: w > 600 ? 1 : 2 });
    const page = await ctx.newPage(); page.setDefaultTimeout(60000);
    await page.goto(base, { waitUntil: "networkidle" });
    await page.getByText("Intake form", { exact: true }).first().waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, `chat-card-${w}-${theme}.png`) });
    await page.getByRole("button", { name: "Open" }).first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, `chat-open-${w}-${theme}.png`) });
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
