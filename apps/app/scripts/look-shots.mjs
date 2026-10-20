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

/**
 * The profile photo: Your profile with Upload photo, the crop sheet with a picture under the circle (a drawn stand-in photo, made here), zoomed and dragged, then the profile and the sidebar with the
 * saved photo. The sample build keeps the photo on the page only. Each saved photo drawn on the page is listed (its kind, pixels and size), so the run's log shows it is square and small.
 */
async function photoShots(ctx, page, shot, w, theme) {
  const pic = path.join(os.tmpdir(), `look-shots-photo-${w}-${theme}.png`);
  const maker = await ctx.newPage();
  await maker.setViewportSize({ width: 1200, height: 900 });
  await maker.setContent(`<body style="margin:0"><div style="width:1200px;height:900px;background:linear-gradient(135deg,#4b6cb7,#182848);display:flex;align-items:center;justify-content:center"><div style="width:420px;height:420px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#f3d1b5,#c98f6b);box-shadow:0 0 0 40px #2c3e50"></div></div></body>`);
  fs.writeFileSync(pic, await maker.screenshot({ type: "png" }));
  await maker.close();
  // a profile is per Space: the sample opens on All spaces, so pick its first Space with the switcher on Now, then open Your profile from the account menu (the rail's foot on a wide screen, the face
  // at the end of the title row on a phone). The sidebar is unfolded first if an earlier shot folded it.
  await page.goto(`${root}/u/now`, { waitUntil: "networkidle" }); await page.waitForTimeout(2500);
  const switcher = page.getByRole("button", { name: /Switch space/ }).first();
  if (!(await switcher.isVisible().catch(() => false)) && w > 600) { await page.keyboard.press("Control+Backslash"); await page.waitForTimeout(600); }
  await switcher.click().catch(() => console.log(`photo ${w} ${theme}: no Space switcher`));
  await page.waitForTimeout(500);
  await page.getByRole("menuitem", { name: /Juniper Studio/ }).first().click().catch(() => console.log(`photo ${w} ${theme}: no Juniper Studio in the switcher`));
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /your profile, AI accounts/ }).first().click().catch(() => console.log(`photo ${w} ${theme}: no account menu`));
  await page.waitForTimeout(500);
  await shot("p0-account-menu");
  await page.getByRole("menuitem", { name: "Your profile" }).first().click().catch(() => console.log(`photo ${w} ${theme}: no Your profile in the account menu`));
  await page.waitForTimeout(2000);
  await shot("p1-profile");
  const upload = page.getByRole("button", { name: /Upload photo|Change photo/ }).first();
  if (!(await upload.count())) { console.log(`photo ${w} ${theme}: no Upload photo button (the profile needs a Space showing)`); return; }
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 15000 }), upload.click()]).catch((e) => { console.log("no file chooser", String(e).slice(0, 200)); return [null]; });
  if (!chooser) return;
  await chooser.setFiles(pic);
  await page.waitForTimeout(1500);
  await shot("p2-crop");
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Zoom in" }).last().click().catch(() => {});
  const box = await page.getByLabel("Your photo, inside the circle").first().boundingBox().catch(() => null);
  if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 8 }); await page.mouse.up(); }
  await shot("p3-crop-zoomed");
  await page.getByRole("button", { name: "Save" }).last().click().catch(() => console.log("no Save"));
  await page.waitForTimeout(2500);
  await shot("p4-profile-photo");
  const saved = await page.evaluate(() => [...document.images].filter((i) => i.src.startsWith("data:image/")).map((i) => ({ kind: i.src.slice(5, i.src.indexOf(";")), pixels: `${i.naturalWidth}x${i.naturalHeight}`, bytes: Math.floor((i.src.length - i.src.indexOf(",") - 1) * 3 / 4) })));
  console.log(`photo ${w} ${theme}: saved photos drawn on the page: ${JSON.stringify(saved.slice(0, 4))} (${saved.length} in all)`);
  await page.getByRole("button", { name: "Remove photo" }).first().click().catch(() => console.log("no Remove photo"));
  await shot("p5-profile-removed");
}
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
    await photoShots(ctx, page, shot, w, theme);
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
