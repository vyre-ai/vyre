// The Sheet on the exported web build must be styled: @rn-primitives drops className on its Overlay and Content, so the Sheet sets real style
// props from the theme. This opens the gallery's Sheet in headless Chromium at 390 and 1280 and reads getComputedStyle of the dialog's content (a background,
// padding, a border) and of its scrim. Optional in CI; needs `playwright` resolvable (the test server has it, the app does not).
//   node scripts/check-sheet.mjs [--dist dist] [--w 390,1280]       exit 1 and name each failure
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const dist = path.resolve(flag("--dist", "dist"));
const widths = flag("--w", "390,1280").split(",").map(Number);
const require = createRequire(process.env.PW_FROM || path.join(process.env.HOME, "shots/"));
const { chromium } = require("playwright");

/** A computed colour that paints something: not transparent, not rgba(...,0). Pure. */
export const paints = (c) => !!c && c !== "transparent" && !/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(c);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  let f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch();
const fails = [];
try {
  for (const w of widths) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 860 }, colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/app/u/appearance`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await page.getByText("Send with Face ID", { exact: true }).first().evaluate((e) => e.click());
    await page.waitForSelector("[role=dialog]", { timeout: 5000 });
    const s = await page.evaluate(() => {
      // [role=dialog] is Radix's own wrapper; the Sheet's styled content is its first child (that is the box the person sees).
      const root = document.querySelector("[role=dialog]");
      const d = root.firstElementChild || root;
      const cs = getComputedStyle(d);
      const r = d.getBoundingClientRect();
      // The scrim: the element behind the dialog that covers the viewport.
      const scrim = [...document.querySelectorAll("div")].find((e) => { const b = e.getBoundingClientRect(); return e !== d && b.width >= innerWidth - 1 && b.height >= innerHeight - 1 && /^rgba\(.*,\s*0?\.\d+\)$/.test(getComputedStyle(e).backgroundColor) && !e.contains(d) && getComputedStyle(e).position === "absolute"; });
      return { bg: cs.backgroundColor, padTop: parseFloat(cs.paddingTop), padLeft: parseFloat(cs.paddingLeft), border: parseFloat(cs.borderTopWidth), width: r.width, scrim: scrim ? getComputedStyle(scrim).backgroundColor : null };
    });
    const at = `${w}px`;
    if (!paints(s.bg)) fails.push(`${at}: dialog has no background (${s.bg})`);
    if (!(s.padTop > 0 && s.padLeft > 0)) fails.push(`${at}: dialog has no padding (${s.padTop}, ${s.padLeft})`);
    if (!(s.border > 0)) fails.push(`${at}: dialog has no border`);
    if (!paints(s.scrim)) fails.push(`${at}: no scrim behind the dialog (${s.scrim})`);
    console.log(`${at}: dialog ${Math.round(s.width)} wide, background ${s.bg}, padding ${s.padTop}, border ${s.border}, scrim ${s.scrim}`);
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
for (const f of fails) console.error("FAIL " + f);
if (!fails.length) console.log("sheet: styled at every width");
process.exit(fails.length ? 1 : 0);
