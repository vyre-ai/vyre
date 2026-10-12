// The two-server proof in a browser: the exported web app (dist/, base path /app), app/two-servers-proof.tsx, headless Chromium. One identity paired to two pretend servers: what the Servers screen lists, the merged
// Spaces with their tags, what is refused under All spaces, an edit of a team record that must reach the team's server only, an approval held on the team's server answered there, and a window that runs on a server with
// nothing paired (Add a server is offered, with the typed code). Exits 1 on the first thing that is not so. Playwright comes from PW_FROM (outside the repo), as shots.mjs does.
//   node scripts/two-server-proof.mjs [--dist dist]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const di = args.indexOf("--dist");
const dist = path.resolve(di >= 0 ? args[di + 1] : "dist");
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
const browser = await chromium.launch();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

async function open(mode) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/app/two-servers-proof${mode ? `?mode=${mode}` : ""}`, { waitUntil: "networkidle" });
  return { page, errors };
}
const out = async (page, id = "out") => (await page.getByTestId(id).innerText()).trim();
const press = async (page, id, until) => { await page.getByTestId(id).click(); await page.waitForFunction(([i, t]) => (document.querySelector(`[data-testid="${i}"]`)?.textContent || "").includes(t), [until.id ?? "out", until.text], { timeout: 10000 }); };

try {
  // one identity, two servers
  {
    const { page, errors } = await open("");
    await page.getByText("Servers", { exact: false }).first().waitFor({ timeout: 15000 });
    check(await page.getByText("my droplet").first().isVisible(), "Servers lists the first server by name");
    check(await page.getByText("team droplet").first().isVisible(), "Servers lists the second server by name");
    check(await page.getByText("Space: Personal - Cloud").first().isVisible(), "the first server's Space carries the tag Personal - Cloud");
    check(await page.getByText("Space: Northwind").first().isVisible(), "the second server's Space carries its team name");
    check(await page.getByText("Add another server").first().isVisible(), "Add another server is there beside the list");
    await press(page, "rows", { id: "rows-out", text: "Northwind" });
    const rows = await out(page, "rows-out");
    check(/Personal - Cloud on boxa/.test(rows) && /Northwind on boxb/.test(rows), `the merged Spaces say which server each is on (${rows})`);
    await press(page, "all-create", { text: "REFUSED" });
    check(/pick_a_space/.test(await out(page)) && /Pick the Space this is for first/.test(await out(page)), "creating a record under All spaces asks which Space");
    await press(page, "all-vault", { text: "REFUSED" });
    check(/pick_a_space/.test(await out(page)), "the vault under All spaces is refused");
    await press(page, "b-vault", { text: "vault:" });
    await press(page, "b-record", { text: "edit:" });
    await press(page, "approvals", { text: "approvals:" });
    const ap = await out(page);
    check(/appr_b1@boxb/.test(ap), `the held act on the team's server shows in the inbox, tagged with that server (${ap})`);
    // the screens call api/box directly, not tool(): that path is routed too
    await press(page, "direct-vault", { text: "REFUSED" });
    check(/pick_a_space/.test(await out(page)), "a screen's direct call for the vault under All spaces is refused too");
    await press(page, "direct-answer", { text: "direct-answer:" });
    await press(page, "log", { text: "log:" });
    const log = await out(page);
    check(/vault\.list@boxb/.test(log) && !/vault\.list@boxa/.test(log), `the team's vault was read on the team's server only (${log})`);
    check(/records\.update@boxb/.test(log) && !/records\.update@boxa/.test(log), "an edit of a team record while the first Space is showing reached the team's server only");
    check(/approvals\.answer@boxb/.test(log) && !/approvals\.answer@boxa/.test(log), "the approval was answered on the server that holds it");
    check(!/records\.create@|vault\.list@boxa/.test(log), "nothing refused under All spaces was sent anywhere");
    check((log.match(/approvals\.answer@boxb/g) || []).length === 2 && !/approvals\.answer@boxa/.test(log), "the direct call answered the team's approval on the team's server as well");
    check(errors.length === 0, `no page errors${errors.length ? ": " + errors[0] : ""}`);
  }
  // a window that runs on a server, nothing paired
  {
    const { page, errors } = await open("boxless");
    await page.getByText("Add another server").first().waitFor({ timeout: 15000 });
    check(await page.getByText("Add another server").first().isVisible(), "a boxless window with nothing paired shows the add door in Servers");
    check(await page.getByText("Have a code from another device?").first().isVisible(), "and the typed-code pairing is offered beside it");
    check((await page.getByText("Upgrade to My Cloud").count()) > 0 || (await page.getByText("Add a server").count()) > 0, "My Cloud offers Add a server with no Personal space and no server paired");
    check(errors.length === 0, `no page errors${errors.length ? ": " + errors[0] : ""}`);
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
