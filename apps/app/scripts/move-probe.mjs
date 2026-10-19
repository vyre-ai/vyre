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
const base = `http://127.0.0.1:${server.address().port}/app/u/files`;
const browser = await chromium.launch();
// What the owner walk does, with its own driver's rules (scripts/proof-first-run.mjs click): by role button, radio, switch, then the words (exact), the first match. Reports what each finds once the Move dialog is open.
const report = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  const page = await ctx.newPage(); page.setDefaultTimeout(30000);
  await page.goto(base, { waitUntil: "networkidle" }); await page.waitForTimeout(6000);
  await page.getByText("Juniper Studio", { exact: false }).first().dblclick(); await page.waitForTimeout(1500);
  await page.getByText("Weekly report template.docx", { exact: false }).first().click({ button: "right", timeout: 15000 }); await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, "probe-1-menu.png") });
  const menu = { button: await page.getByRole("button", { name: "Move to…" }).count(), menuitem: await page.getByRole("menuitem", { name: "Move to…" }).count(), text: await page.getByText("Move to…", { exact: true }).count() };
  report.push(["menu entry counts", menu]);
  const cand = (t) => [["button", page.getByRole("button", { name: t, exact: false })], ["radio", page.getByRole("radio", { name: t, exact: false })], ["switch", page.getByRole("switch", { name: t, exact: false })], ["text", page.getByText(t, { exact: true })]];
  for (const [k, c] of cand("Move to…")) if (await c.count()) { await c.first().click({ timeout: 5000 }).catch((e) => report.push(["menu click failed via " + k, String(e).slice(0, 160)])); break; }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, "probe-2-dialog.png") });
  for (const name of ["Spring launch", "Vyre site"]) {
    const found = [];
    for (const [k, c] of cand(name)) found.push([k, await c.count()]);
    report.push([`candidates for "${name}" with the dialog open`, found]);
    for (const [k, c] of cand(name)) if (await c.count()) {
      const tried = await c.first().click({ timeout: 5000, trial: true }).then(() => "ok", (e) => "BLOCKED: " + String(e).split("\n").slice(0, 3).join(" | ").slice(0, 300));
      report.push([`first match by ${k} for "${name}", trial click`, tried]); break;
    }
  }
  report.push(["dialog text", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 600)]);
} finally { await browser.close(); server.close(); }
console.log(JSON.stringify(report, null, 1));
fs.writeFileSync(path.join(out, "probe.json"), JSON.stringify(report, null, 1));
