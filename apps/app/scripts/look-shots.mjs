// Screenshots of the Assistant look picker from the sample-world web export: first run's Assistant step (colours, the Customize icon button, the part rows of little faces) and Settings > Account
// (you and your Assistant, and the same picker in a sheet).
//   PW_FROM=<a folder with playwright installed>/ node scripts/look-shots.mjs <outdir> [--dist dist]
// 1400 and 390 wide, dark and light.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const dist = path.resolve(flag("--dist", "dist"));
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
const root = `http://127.0.0.1:${server.address().port}/app`;
const browser = await chromium.launch();
try {
  for (const [w, h] of [[1400, 900], [390, 844]]) for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, deviceScaleFactor: w > 600 ? 1 : 2 });
    const page = await ctx.newPage(); page.setDefaultTimeout(30000);
    page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 300)));
    const shot = async (name) => { await page.waitForTimeout(600); await page.screenshot({ path: path.join(out, `look-${name}-${w}-${theme}.png`), fullPage: false }); };
    // first run: the Assistant step
    await page.goto(`${root}/onboard?shot=setup.assistant`, { waitUntil: "networkidle" }); await page.waitForTimeout(3000);
    await shot("1-firstrun");
    await page.getByRole("button", { name: "Customize" }).first().click().catch(() => console.log("no Customize button on first run"));
    await shot("2-firstrun-customize");
    await page.getByRole("radio", { name: "Eyes: Wink" }).first().click().catch(() => {});
    await page.getByRole("radio", { name: "Blue" }).first().click().catch(() => {});
    await shot("3-firstrun-blue-wink");
    // Settings > Account: you and your Assistant
    await page.goto(`${root}/u/settings/account`, { waitUntil: "networkidle" }); await page.waitForTimeout(3000);
    await shot("4-settings-account");
    await page.getByRole("button", { name: "Change its look" }).first().click().catch(() => console.log("no Change its look button"));
    await shot("5-settings-sheet");
    await page.getByRole("button", { name: "Customize" }).last().click().catch(() => {});
    await shot("6-settings-sheet-customize");
    // the sidebar's foot (a wide screen only: a phone has the tab bar): the profile row, its menu, and the rail folded to the face
    if (w > 600) {
      await page.goto(`${root}/u/now`, { waitUntil: "networkidle" }); await page.waitForTimeout(2500);
      await shot("7-sidebar-foot");
      await page.getByRole("button", { name: /profile, appearance, spaces, lock and the sidebar/ }).first().click().catch(() => console.log("no profile row"));
      await shot("8-sidebar-menu");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+Backslash"); await shot("9-sidebar-folded");
    }
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
