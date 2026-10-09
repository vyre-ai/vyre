// Screenshots of the Vault's Import page and the chat's key tags, from the sample-world web export (EXPO_PUBLIC_VYRE_MOCK=1 npx expo export -p web --output-dir dist-vux), in headless Chromium:
//   PW_FROM=<a folder with playwright installed>/ node scripts/vault-shots.mjs <outdir> [--dist dist-vux]
// Desktop and phone width, light and dark. It drives the page the way a person does: pick Bitwarden, choose the file, read the preview, import, then look in the projects and move the keys.
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
const base = `http://127.0.0.1:${server.address().port}/app/shots-vault`;
const browser = await chromium.launch();
try {
  for (const [w, h] of [[1280, 900], [390, 844]]) for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`), fullPage: true }); };
    const press = async name => { await page.getByRole("button", { name }).first().click(); await page.waitForTimeout(300); };
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await shot("import-1-home");
    await page.getByRole("button", { name: "Show all 15" }).click(); await shot("import-1b-all-sources");
    await page.getByText("Bitwarden", { exact: true }).first().click(); await shot("import-2-how");
    await press("Choose the file"); await shot("import-3-preview");
    await page.getByRole("radio", { name: "Use the file's" }).click(); await shot("import-3b-preview-use-file");
    await page.getByRole("button", { name: /^Import \d+ items/ }).click(); await shot("import-4-done");
    await page.goto(base, { waitUntil: "networkidle" });
    await press("Look in my projects"); await shot("projects-1-found");
    await page.getByRole("switch").first().click(); await shot("projects-1b-one-off");
    await page.getByRole("button", { name: /^Move \d+ keys/ }).click(); await shot("projects-2-done");
    await page.goto(base + "?part=chat", { waitUntil: "networkidle" }); await shot("chat-tags");
    if (errors.length) console.log(`page errors at ${w} ${theme}:`, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
