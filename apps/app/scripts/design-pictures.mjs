// Picture tests: every fixture of the gallery (apps/app/ui/blocks/fixtures.generated.json) in headless Chromium at each surface, light and dark, compared with the reference pictures in
// design-refs/. A picture that changed is a design change: it writes before, after and diff images and exits 1, and the screen's owner says yes (--update) or no. The rules checker runs on
// every render: no sideways scroll, text of 12 or more (the uppercase section labels are the system's own micro size), touch targets of 44 on a phone, no console errors.
//
//   node scripts/design-pictures <out> [--dist dist-mock] [--refs ../../design-refs] [--only id,id] [--surface app,phone,chat] [--update] [--budget-mb 10]
// Surfaces: app (1280, full form), phone (390, compact), chat (390, glance). Themes: dark, paper. Files: <refs>/<id>/<surface>-<theme>.png.
// Needs `playwright` resolvable (PW_FROM, as shots.mjs does) and a web export of the app built with EXPO_PUBLIC_VYRE_MOCK=1.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const dist = path.resolve(flag("--dist", "dist-mock"));
const refs = path.resolve(flag("--refs", "../../design-refs"));
const only = (flag("--only", "") || "").split(",").filter(Boolean);
const surfaceOnly = (flag("--surface", "") || "").split(",").filter(Boolean);
const budgetMb = Number(flag("--budget-mb", "10"));
const update = bool("--update");
const [out] = args;
if (!out) { console.error("usage: design-pictures <out> [--dist d] [--refs d] [--only ids] [--surface names] [--update]"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

const fixturesFile = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../ui/blocks/fixtures.generated.json");
const ids = Object.keys(JSON.parse(fs.readFileSync(fixturesFile, "utf8")).fixtures).filter((id) => !only.length || only.includes(id));
const SURFACES = [{ name: "app", w: 1280, form: "full" }, { name: "phone", w: 390, form: "compact" }, { name: "chat", w: 390, form: "glance" }].filter((s) => !surfaceOnly.length || surfaceOnly.includes(s.name));
const THEMES = [{ name: "dark", scheme: "dark" }, { name: "paper", scheme: "light" }];

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

/** In the page: how many pixels differ between two PNGs, and the diff picture. */
const compare = (page, a, b) => page.evaluate(async ([x, y]) => {
  const load = (d) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = "data:image/png;base64," + d; });
  const [A, B] = await Promise.all([load(x), load(y)]);
  if (A.width !== B.width || A.height !== B.height) return { same: false, size: [A.width, A.height, B.width, B.height], changed: -1, diff: null };
  const px = (im) => { const c = document.createElement("canvas"); c.width = im.width; c.height = im.height; const g = c.getContext("2d"); g.drawImage(im, 0, 0); return g.getImageData(0, 0, im.width, im.height); };
  const da = px(A), db = px(B), c = document.createElement("canvas"); c.width = A.width; c.height = A.height;
  const g = c.getContext("2d"), o = g.createImageData(A.width, A.height);
  let changed = 0;
  for (let i = 0; i < da.data.length; i += 4) {
    const d = Math.max(Math.abs(da.data[i] - db.data[i]), Math.abs(da.data[i + 1] - db.data[i + 1]), Math.abs(da.data[i + 2] - db.data[i + 2]));
    const hit = d > 12; if (hit) changed++;
    o.data[i] = hit ? 255 : db.data[i]; o.data[i + 1] = hit ? 40 : db.data[i + 1]; o.data[i + 2] = hit ? 80 : db.data[i + 2]; o.data[i + 3] = hit ? 255 : 90;
  }
  g.putImageData(o, 0, 0);
  return { same: changed / (A.width * A.height) < 0.0005, changed, diff: c.toDataURL("image/png").split(",")[1] };
}, [a.toString("base64"), b.toString("base64")]);

/** The rules, in the page: what a person would see broken. */
const rules = (page, phone) => page.evaluate((phone) => {
  const bad = [];
  const root = document.getElementById("fixture");
  if (!root) return ["no #fixture on the page"];
  if (document.scrollingElement.scrollWidth > innerWidth + 1) bad.push("scrolls sideways");
  for (const e of root.querySelectorAll("*")) {
    const cs = getComputedStyle(e);
    if (e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(cs.fontSize) < 12 && cs.textTransform !== "uppercase") bad.push(`text under 12: "${e.textContent.trim().slice(0, 24)}"`);
    if (phone && e.getAttribute("role") === "button") { const r = e.getBoundingClientRect(); if (r.height && r.height < 44) bad.push(`touch target ${Math.round(r.height)} high: "${e.textContent.trim().slice(0, 24)}"`); }
  }
  return bad;
}, phone);

let browser = await chromium.launch();
const report = [];
let failed = 0;
const errors = [];
/** A fresh context and page for a surface and theme; the browser itself is relaunched when it has died (the shared test box is busy and has killed one mid-run). */
const open = async (s, t) => {
  if (!browser.isConnected()) browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: s.w, height: 900 }, colorScheme: t.scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  // The static server answers index.html for the service worker's script path: a harness artefact, not the screen's.
  page.on("console", (m) => { if (m.type() === "error" && !/unsupported MIME type/.test(m.text())) errors.push(m.text()); });
  return { ctx, page };
};
/** One picture: the page for a fixture, the element, its rule faults. Retried twice on a dead page or browser. */
const shoot = async (cur, s, t, id) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const { page } = cur;
      await page.goto(`http://127.0.0.1:${port}/app/gallery?f=${id}&form=${s.form}`, { waitUntil: "load", timeout: 30000 });
      await page.waitForSelector("#fixture", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(400);
      const el = page.locator("#fixture");
      if (!(await el.count())) return { missing: true };
      return { after: await el.screenshot(), rules: await rules(page, s.name !== "app") };
    } catch (e) {
      if (attempt >= 2) throw e;
      await cur.ctx.close().catch(() => {});
      Object.assign(cur, await open(s, t));
    }
  }
};
try {
  for (const s of SURFACES) for (const t of THEMES) {
    const cur = await open(s, t);
    for (const id of ids) {
      errors.length = 0;
      const row = { id, surface: s.name, theme: t.name, status: "same", rules: [] };
      const got = await shoot(cur, s, t, id);
      if (got.missing) { row.status = "missing"; row.rules.push("the fixture did not render"); failed++; report.push(row); console.log(`MISSING  ${id} ${s.name} ${t.name}`); continue; }
      const { after } = got;
      row.rules = got.rules;
      if (errors.length) row.rules.push(`console: ${errors.slice(0, 2).join(" | ").slice(0, 160)}`);
      const refFile = path.join(refs, id, `${s.name}-${t.name}.png`);
      if (update) { fs.mkdirSync(path.dirname(refFile), { recursive: true }); fs.writeFileSync(refFile, after); row.status = "written"; }
      else if (!fs.existsSync(refFile)) { row.status = "new"; failed++; }
      else {
        const before = fs.readFileSync(refFile), r = await compare(cur.page, before, after);
        if (!r.same) {
          row.status = "changed"; row.changed = r.changed; failed++;
          const dir = path.join(out, id); fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${s.name}-${t.name}.before.png`), before); fs.writeFileSync(path.join(dir, `${s.name}-${t.name}.after.png`), after);
          if (r.diff) fs.writeFileSync(path.join(dir, `${s.name}-${t.name}.diff.png`), Buffer.from(r.diff, "base64"));
        }
      }
      if (row.rules.length) failed++;
      if (row.status !== "same" || row.rules.length) console.log(`${row.status.toUpperCase().padEnd(8)} ${id} ${s.name} ${t.name}${row.changed ? ` (${row.changed} px)` : ""}${row.rules.length ? ` | rules: ${row.rules.slice(0, 3).join("; ")}` : ""}`);
      report.push(row);
    }
    await cur.ctx.close().catch(() => {});
  }
} finally { await browser.close().catch(() => {}); server.close(); }

let bytes = 0;
(function walk(d) { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : (bytes += fs.statSync(path.join(d, f.name)).size); })(refs);
const mb = bytes / 1048576;
if (mb > budgetMb) { console.log(`OVER BUDGET: ${refs} is ${mb.toFixed(1)} MB, the budget is ${budgetMb} MB`); failed++; }
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ at: new Date().toISOString(), refsMb: Number(mb.toFixed(2)), rows: report }, null, 1));
const n = (k) => report.filter((r) => r.status === k).length;
console.log(`${report.length} pictures: ${n("same")} same, ${n("changed")} changed, ${n("new")} new, ${n("written")} written, ${report.filter((r) => r.rules.length).length} with rule faults; refs ${mb.toFixed(1)} MB`);
process.exit(failed ? 1 : 0);
