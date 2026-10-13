// Screenshots of the Files screen from the sample-world web export (EXPO_PUBLIC_VYRE_MOCK=1 npx expo export -p web --output-dir dist-vux):
//   PW_FROM=<a folder with playwright installed>/ node scripts/files-shots.mjs <outdir> [--dist dist-vux]
// 1400 and 390 wide, dark and light: the Space root, a folder open, a file selected, and the grid.
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
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  let f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  // pdf.js (react-pdf) carries an `import.meta.url` that a classic script cannot parse; the shots do not open a PDF, so it is stubbed here.
  if (f.endsWith(".js")) res.end(fs.readFileSync(f, "utf8").replaceAll("import.meta.url", '"file:///stub"')); else fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/app/u/files`;
const browser = await chromium.launch();
try {
  for (const [w, h] of [[1400, 900], [390, 844]]) for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, deviceScaleFactor: w > 600 ? 1 : 2 });
    const page = await ctx.newPage(); page.setDefaultTimeout(30000);
    if (process.env.FILES_SHOTS_DEBUG) { page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 300))); page.on("requestfailed", (r) => console.log("reqfail", r.url().slice(0, 120))); }
    const shot = async (name) => { await page.waitForTimeout(600); await page.screenshot({ path: path.join(out, `files-${name}-${w}-${theme}.png`), fullPage: false }); };
    await page.goto(base, { waitUntil: "networkidle" }); await page.waitForTimeout(7000); console.log(w, theme, (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160));
    await shot("1-root");
    if (w > 600) {
      await page.getByText("Juniper Studio", { exact: true }).first().dblclick().catch(() => {}); await shot("2-folder");
      const f = page.getByText("Weekly report template.docx").first();
      if (await f.count()) { await f.click(); await shot("3-selected"); }
      await page.getByRole("button", { name: "Show as a grid" }).click().catch(() => {}); await shot("4-grid");
    } else {
      await page.getByText("Space", { exact: true }).first().click().catch(() => {}); await shot("2-space");
    }
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
