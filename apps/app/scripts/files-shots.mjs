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
      // Move to...: the right-click menu, the folder picker, a folder entered, and the move done (with its Undo)
      await page.getByText("Weekly report template.docx").first().click({ button: "right" }).catch(() => {}); await shot("5-menu");
      await page.getByText("Move to…", { exact: true }).first().click().catch(() => {}); await shot("6-picker");
      await page.getByText("Doe estate plan", { exact: true }).last().click().catch(() => {}); await shot("7-picker-in");
      await page.getByRole("button", { name: "Move", exact: true }).last().click().catch(() => {}); await shot("8-moved");
      // drag to move: a folder tile carried over another (the target is outlined and says what will happen), then dropped. A fresh load, so the sample world is as it started.
      await page.goto(base, { waitUntil: "networkidle" }); await page.waitForTimeout(5000);
      // a headless browser does not run a drag from the mouse, so the drag events are sent by hand from the page, with one shared DataTransfer: the page's own handlers do the rest
      await page.waitForSelector("[data-tile]", { timeout: 30000 }).catch(() => {});
      const fire = (type, name) => page.evaluate(([t, n]) => {
        const el = [...document.querySelectorAll("[data-tile]")].find((x) => (x.textContent || "").includes(n));
        if (!el) return false;
        window.__dt = window.__dt || new DataTransfer();
        el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
        return true;
      }, [type, name]);
      if (await fire("dragstart", "Juniper Studio")) {
        await page.waitForTimeout(200);
        await fire("dragenter", "Vyre site"); await fire("dragover", "Vyre site"); await page.waitForTimeout(200);
        await shot("9-drag-over-folder");
        await fire("drop", "Vyre site"); await fire("dragend", "Juniper Studio"); await shot("10-dropped");
      } else console.log("drag shots skipped: tiles not found");
      // New folder: the button, the name field, the folder made and selected, the project folder by its name, and the right-click on empty space. A fresh load again.
      await page.goto(base, { waitUntil: "networkidle" }); await page.waitForTimeout(5000);
      await page.getByRole("button", { name: "New folder" }).first().click().catch(() => {}); await shot("11-new-folder-field");
      await page.getByLabel("Folder name").first().fill("Plans").catch(() => {}); await page.keyboard.press("Enter").catch(() => {}); await shot("12-new-folder-made");
      await page.getByText("Projects", { exact: true }).first().dblclick().catch(() => {}); await shot("13-project-by-name");
      await page.goto(base, { waitUntil: "networkidle" }); await page.waitForTimeout(5000);
      await page.mouse.click(1000, 460, { button: "right" }).catch(() => {}); await shot("14-empty-space-menu");
    } else {
      await page.getByText("Space", { exact: true }).first().click().catch(() => {}); await shot("2-space");
      // Move to... on a phone: open a file, ask to move it, pick a folder
      await page.getByText("Juniper Studio", { exact: true }).first().click().catch(() => {}); await shot("3-folder");
      await page.getByText("Weekly report template.docx").first().click().catch(() => {}); await shot("4-file");
      await page.getByText("Move to…", { exact: true }).first().click().catch(() => {}); await shot("5-picker");
      await page.getByText("Doe estate plan", { exact: true }).last().click().catch(() => {}); await shot("6-picker-in");
      // New folder on a phone or a narrow window (the Drive screen, not the file manager)
      await page.goto(base, { waitUntil: "networkidle" }); await page.waitForTimeout(5000);
      await page.getByText("Space", { exact: true }).first().click().catch(() => {});
      await page.getByRole("button", { name: "New folder" }).first().click().catch(() => {}); await shot("7-new-folder");
    }
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
