// The ui-ux screenshot pass: every route of the exported SAMPLE web app (npm run export:web:mock) at phone, tablet and desktop widths in dark and
// paper, plus one detail page per list, and a keyboard Tab pass that screenshots each focus ring. Writes <out>/*.png and <out>/report.json.
//   node scripts/ux-shots.mjs --dist dist --out ux-shots
// Playwright comes from PW_FROM (a folder holding node_modules/playwright), as scripts/shots.mjs does.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const dist = path.resolve(flag("--dist", "dist"));
const out = path.resolve(flag("--out", "ux-shots"));
fs.mkdirSync(out, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(process.env.HOME, "shots/"));
const { chromium } = require("playwright");

const ROUTES = ["u/now", "u/now?scenario=client-pays", "u/now/needs", "u/now/doing", "u/projects", "u/records/contact", "u/records/matter", "u/calendar", "u/drive", "u/sites",
  "u/flows", "u/kits", "u/memory", "u/vault", "u/engineer", "u/spaces", "u/access", "u/appearance", "u/about", "u/settings", "u/settings/account", "u/settings/ai",
  "u/settings/assistants", "u/settings/customize", "u/settings/customize/matter", "u/settings/devices", "u/settings/notifications", "u/settings/privacy", "u/settings/rules",
  "u/settings/seeing", "u/settings/updates", "u/wink", "u/wink/add", "u/wink/invite", "u/wink/lend", "u/install", "u/install/create", "u/install/join"];
const SIZES = [{ n: "phone", w: 390, h: 844 }, { n: "tablet", w: 820, h: 1180 }, { n: "desktop", w: 1280, h: 800 }];
const THEMES = ["dark", "paper"];
const FOCUS_ROUTES = ["u/now", "u/projects", "u/records/contact", "u/spaces", "u/access", "u/drive", "u/vault", "u/flows", "u/kits", "u/settings", "u/install"];

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".json": "application/json", ".ico": "image/x-icon", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  let f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/app/`;
const name = (r) => r.replace(/[/?=&]/g, "_");

const report = { shots: 0, pages: [], focus: [] };
const browser = await chromium.launch();

// Facts read from the page: sideways overflow, targets under 44, clipped single-line text.
const facts = () => {
  const out = { overflowX: document.documentElement.scrollWidth - window.innerWidth, small: [], clipped: [] };
  const label = (e) => (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
  for (const e of document.querySelectorAll('button, [role="button"], a[href], input, [role="switch"], [role="tab"]')) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.height < 44 || r.width < 44) {
      // hitSlop does not show in the box, so only report what is under 32 in either direction
      if (r.height < 32 || r.width < 32) out.small.push(`${label(e)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  for (const e of document.querySelectorAll("*")) {
    const cs = getComputedStyle(e);
    if (cs.textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth + 1) out.clipped.push(label(e));
  }
  out.small = out.small.slice(0, 12); out.clipped = out.clipped.slice(0, 12);
  return out;
};

try {
  for (const s of SIZES) for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, colorScheme: theme === "paper" ? "light" : "dark", deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    let errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error" && !/unsupported MIME type/.test(m.text())) errors.push(m.text().slice(0, 200)); });
    const shoot = async (route, tag) => {
      errors = [];
      await page.goto(base + route, { waitUntil: "load" }).catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(700);
      const f = await page.evaluate(facts).catch(() => ({}));
      const file = `${s.n}-${theme}-${name(route)}${tag}.png`;
      await page.screenshot({ path: path.join(out, file), fullPage: true }).catch(() => {});
      report.shots++;
      report.pages.push({ file, route, size: s.n, theme, errors: [...errors], ...f });
      return file;
    };
    for (const r of ROUTES) {
      await shoot(r, "");
      // One detail page per list: the first tall row that is a button.
      if (["u/now", "u/projects", "u/records/contact", "u/flows", "u/kits", "u/sites", "u/settings/devices"].includes(r)) {
        const rows = page.locator('[role="button"]');
        const n = await rows.count();
        for (let i = 0; i < n; i++) {
          const b = await rows.nth(i).boundingBox();
          if (b && b.height >= 44 && b.width > 220 && b.y > 60) {
            await rows.nth(i).click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(700);
            if (page.url() !== base + r && !page.url().endsWith("/" + r)) { await shoot(page.url().replace(base, ""), "-detail"); }
            break;
          }
        }
      }
    }
    await ctx.close();
  }

  // The rail menus: open each one on a desktop and record what the page threw. A menu that blanks the page is a blocker.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
    const page = await ctx.newPage();
    const thrown = [];
    page.on("pageerror", (e) => thrown.push(String(e).slice(0, 300)));
    page.on("console", (m) => { if (m.type() === "error" && !/unsupported MIME type/.test(m.text())) thrown.push(m.text().slice(0, 300)); });
    await page.goto(base + "u/now", { waitUntil: "load" }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(800);
    for (const [name, sel] of [["space-switcher", '[aria-label^="Space:"]'], ["more-places", '[aria-label="More places"]']]) {
      thrown.length = 0;
      const el = page.locator(sel).first();
      const found = await el.count();
      if (found) await el.click({ timeout: 3000 }).catch((e) => thrown.push("click failed: " + String(e).slice(0, 120)));
      await page.waitForTimeout(600);
      const items = await page.locator('[role="menuitem"]').count();
      const blank = await page.evaluate(() => document.body.innerText.trim().length < 20);
      const file = `menu-${name}.png`;
      await page.screenshot({ path: path.join(out, file) }).catch(() => {});
      report.menus = [...(report.menus || []), { name, found, items, blank, thrown: [...thrown] }];
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
      if (blank) await page.goto(base + "u/now", { waitUntil: "load" }).catch(() => {});
    }
    await ctx.close();
  }

  // The keyboard pass: desktop, both themes. Tab through each route and screenshot the ring around what has focus.
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme === "paper" ? "light" : "dark" });
    const page = await ctx.newPage();
    for (const r of FOCUS_ROUTES) {
      await page.goto(base + r, { waitUntil: "load" }).catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(600);
      const seen = new Set();
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press("Tab");
        const info = await page.evaluate(() => {
          const e = document.activeElement;
          if (!e || e === document.body) return null;
          const cs = getComputedStyle(e), r = e.getBoundingClientRect();
          const visible = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none") || (cs.borderStyle !== "none" && false);
          return { label: (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().replace(/\s+/g, " ").slice(0, 40), tag: e.tagName, ring: !!visible, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
        }).catch(() => null);
        if (!info) continue;
        const key = `${info.label}|${Math.round(info.rect.x)}|${Math.round(info.rect.y)}`;
        if (seen.has(key)) break;
        seen.add(key);
        const pad = 16;
        const clip = { x: Math.max(0, info.rect.x - pad), y: Math.max(0, info.rect.y - pad), width: Math.min(1280, info.rect.w + pad * 2), height: Math.min(800, info.rect.h + pad * 2) };
        const file = `focus-${theme}-${name(r)}-${String(i).padStart(2, "0")}.png`;
        if (clip.width > 0 && clip.height > 0) await page.screenshot({ path: path.join(out, file), clip }).catch(() => {});
        report.focus.push({ file, route: r, theme, label: info.label, tag: info.tag, ring: info.ring });
        report.shots++;
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));
const menuBad = (report.menus || []).filter((m) => !m.found || !m.items || m.blank || m.thrown.length);
const bad = report.pages.filter((p) => p.overflowX > 1 || p.errors?.length);
const noring = report.focus.filter((f) => !f.ring);
const md = [`# ux-shots`, `${report.shots} shots, ${report.pages.length} pages, ${report.focus.length} focus stops.`,
  `Pages with sideways overflow or console errors: ${bad.length}`, ...bad.slice(0, 40).map((p) => `- ${p.file}: overflow ${p.overflowX}px ${p.errors?.[0] ?? ""}`),
  `Rail menus that did not open cleanly: ${menuBad.length}`, ...menuBad.map((m) => `- ${m.name}: found ${m.found}, items ${m.items}, blank ${m.blank} ${m.thrown[0] ?? ""}`),
  `Focus stops with no visible ring: ${noring.length}`, ...noring.slice(0, 40).map((f) => `- ${f.route} ${f.theme}: ${f.tag} "${f.label}"`)].join("\n");
fs.writeFileSync(path.join(out, "summary.md"), md);
console.log(md);
