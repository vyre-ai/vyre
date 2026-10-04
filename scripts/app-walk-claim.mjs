#!/usr/bin/env node
// app-walk-claim: the browser claims a Vyre name against a STAND-IN names directory, in headless Chromium. TEST ONLY.
//
//   node scripts/app-walk-claim.mjs --dist <web export built with rc.ts browserClaim flipped on a test copy, EXPO_PUBLIC_VYRE_NAMES_DIRECTORY=/names> --names http://host:port [--out dir]
//
// Stand-ins, written beside the step (the walk's rule): (1) the web claim is hidden in RC1 by screens/shell/rc.ts (`browserClaim: false`); a TEST copy of the tree is built with that one line flipped to true (sed on the copy, never on a release tree), plus EXPO_PUBLIC_VYRE_NAMES_DIRECTORY=/names; (2) the names directory is a stand-in
// (scripts/standin-directory.mjs on a test box), reached through this script's own same-origin /names proxy, which STRIPS Origin, Referer and Sec-Fetch headers, because the stand-in
// refuses a browser Origin it was not told ("not for browsers"); the real directory's CORS is the devbox team's. Build with `npx expo export -p web --clear`: a cached bundle keeps the old flag.
// Steps: install page shows the name step; the typed name is "yours to take"; Face ID sheet; Create; the recovery code shows; the directory now resolves the name. Exit 0 when all hold.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist"));
const NAMES = new URL(flag("--names", "http://127.0.0.1:8788"));
const OUT = path.resolve(flag("--out", "claim-out"));
const NAME = flag("--name", "walk" + Math.floor(Math.random() * 90000 + 10000));
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2" };
const server = http.createServer((q, r) => {
  if (q.url.startsWith("/names/")) {
    const headers = Object.fromEntries(Object.entries({ ...q.headers, host: NAMES.host }).filter(([k]) => !/^(origin|referer|sec-fetch-.*|sec-ch-.*)$/i.test(k)));
    const u = http.request({ host: NAMES.hostname, port: NAMES.port, path: q.url.slice(6), method: q.method, headers }, (x) => { r.writeHead(x.statusCode ?? 502, x.headers); x.pipe(r); });
    u.on("error", () => { r.writeHead(502); r.end(); });
    q.pipe(u);
    return;
  }
  let p = decodeURIComponent(q.url.split("?")[0]).replace(/^\/app/, "") || "/";
  const a = /\/((?:_expo|assets)\/.*)$/.exec(p); if (a) p = "/" + a[1];
  if (p === "/sw.js") { r.writeHead(200, { "content-type": "text/javascript" }); return r.end(""); }
  let f = path.join(DIST, p);
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, "index.html");
  r.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(r);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const results = [];
const check = async (name, fn) => {
  let ok = false, note = "";
  try { note = (await fn()) || ""; ok = true; } catch (e) { note = String(e.message).split("\n")[0].slice(0, 200); }
  await page.screenshot({ path: path.join(OUT, name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".png") }).catch(() => {});
  results.push({ name, ok, note }); console.log(`${ok ? "PASS" : "FAIL"}   ${name}${note ? ": " + note : ""}`);
  return ok;
};
const body = () => page.locator("body").innerText();

let alive = await check("install: the name step is open (the web claim flag is on)", async () => {
  await page.goto(`${BASE}/app/u/install`, { waitUntil: "networkidle" });
  if (!(await body()).includes("Choose your Vyre name")) throw new Error("the page does not offer the claim (built from a tree whose rc.ts says browserClaim: false, or from a cached bundle)");
});
alive = alive && await check(`a free name is offered: ${NAME}`, async () => { await page.locator("input").first().fill(NAME); await page.getByText(/is yours to take/).waitFor({ timeout: 10000 }); });
alive = alive && await check("Face ID sheet opens, Create makes the identity and shows the recovery code once", async () => {
  await page.getByRole("button", { name: /Continue with Face ID/ }).click();
  await page.getByRole("button", { name: /Create with (Face ID|your passkey)/ }).click();
  await page.getByText("Save your recovery code").waitFor({ timeout: 30000 });
  const t = await body();
  if (!/[a-z0-9]{4}(-[a-z0-9]{4}){5}-[a-z0-9]{2}/i.test(t)) throw new Error("no recovery code on screen");
});
alive = alive && await check("the directory now resolves the name (and the key is kept in this browser)", async () => {
  const r = await fetch(`${NAMES.origin}/v1/ids/resolve?name=${NAME}`);
  if (!r.ok) throw new Error(`resolve answered ${r.status}`);
  const kept = await page.evaluate(() => new Promise((res) => { const q = indexedDB.open("vyre-identity"); q.onsuccess = () => { try { const g = q.result.transaction("identity").objectStore("identity").get("self"); g.onsuccess = () => res(Boolean(g.result && g.result.name)); g.onerror = () => res(false); } catch { res(false); } }; q.onerror = () => res(false); }));
  if (!kept) throw new Error("no identity kept in IndexedDB");
});
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ at: new Date().toISOString(), name: NAME, results }, null, 2));
await browser.close(); server.close();
process.exit(results.every((x) => x.ok) ? 0 : 1);
