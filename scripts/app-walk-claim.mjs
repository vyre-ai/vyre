#!/usr/bin/env node
// app-walk-claim: the browser claims a Vyre name against a STAND-IN names directory, in headless Chromium. TEST ONLY.
//
//   With a pairing: add --code-cmd, --answer-cmd and --owned-cmd (the server's wink.server.status as JSON); the pairing check fails on any refusal line and unless the server says owned:true.
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
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist"));
const NAMES = new URL(flag("--names", "http://127.0.0.1:8788"));
const OUT = path.resolve(flag("--out", "claim-out"));
// --code-cmd prints a fresh wink.server.code qr on the (unowned) test server; --answer-cmd answers its pairing question, with {words} replaced by the three words the page shows.
const CODE_CMD = flag("--code-cmd", "");
const ANSWER_CMD = flag("--answer-cmd", "");
// --owned-cmd prints the server's own wink.server.status (JSON); the pairing check passes only when it says owned:true. Required with --code-cmd and --answer-cmd: a page that merely stopped complaining is not proof.
const OWNED_CMD = flag("--owned-cmd", "");
const REFUSAL = /refus|could not|cannot reach|did not|failed|do not match|try again|denied|not available/i;
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
  if (q.url.startsWith("/v1/")) { r.writeHead(502, { "content-type": "text/plain" }); return r.end("no box here"); }
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
if (args.includes("--debug")) { page.on("console", (m) => console.log("  console:", m.type(), m.text().slice(0, 240))); page.on("pageerror", (e) => console.log("  pageerror:", String(e).slice(0, 240))); page.on("websocket", (w) => console.log("  ws:", w.url())); }
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
  // First run opens on the welcome: Get started goes to the name.
  await page.getByText("Get started", { exact: true }).first().click({ timeout: 25000 });
  await page.getByText("Choose your Vyre name").first().waitFor({ timeout: 25000 }).catch(() => {}); // the app retries the missing box for a few seconds before it draws
  if (!(await body()).includes("Choose your Vyre name")) throw new Error("the page does not offer the claim (built from a tree whose rc.ts says browserClaim: false, or from a cached bundle)");
});
alive = alive && await check(`a free name is offered: ${NAME}`, async () => { await page.locator("input").first().fill(NAME); await page.getByText(/is yours to take/).waitFor({ timeout: 10000 }); });
alive = alive && await check("Face ID sheet opens, Create makes the identity and shows the recovery code once", async () => {
  // the name step's button is "Create my name" (no biometric sheet) in newer builds, "Continue with Face ID" then a sheet in older ones
  await page.getByRole("button", { name: /Create my name|Continue with Face ID/ }).first().click();
  const sheet = page.getByRole("button", { name: /Create with (Face ID|your passkey)/ });
  if (await sheet.count().catch(() => 0)) await sheet.first().click();
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
if (CODE_CMD && ANSWER_CMD) {
  // The user's install order: identity first (above), then a space on a server, which pairs the server from this browser alone. STAND-INS: the server is a throwaway vyred on a test box
  // on the stand-in relay; the person at the server is this script answering with the words the page shows (the real answer is typed at the server's own console).
  alive = alive && await check("after the recovery code the app offers a space on a server I have", async () => {
    await page.getByRole("button", { name: /I saved it/ }).click();
    await page.getByText("Create a space").first().click();
    await page.locator("input").first().fill("ws" + Math.floor(Math.random() * 90000 + 10000));
    await page.getByText(/is yours to take/).waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: /^Continue/ }).click();
    await page.getByText("On a server you have").first().click();
    await page.getByRole("button", { name: /I ran it/ }).click();
    await page.getByText("Pair your server").waitFor({ timeout: 10000 });
  });
  let words = "";
  alive = alive && await check("the long code is pasted and the app shows three words (the server was paired from this browser, no box)", async () => {
    const qr = execSync(CODE_CMD, { encoding: "utf8" }).match(/vyre:\/\/wink\/2\?[^"\s]+/)?.[0];
    if (!qr) throw new Error("the code command printed no vyre://wink/2 code");
    await page.locator("input").first().fill(qr);
    await page.getByRole("button", { name: /^Continue/ }).click();
    const until = Date.now() + 60000;
    for (;;) {
      const m = /asking to pair\.\s*\n([a-z]+ [a-z]+ [a-z]+)\s*\n/.exec(await body());
      if (m) { words = m[1]; break; }
      if (Date.now() > until) throw new Error("the page never showed the three words: " + (await body()).slice(0, 200).replace(/\n/g, " | "));
      await page.waitForTimeout(500);
    }
  });
  alive = alive && await check("the person at the server says yes with those words and the app finishes", async () => {
    execSync(ANSWER_CMD.replace("{words}", words), { encoding: "utf8" });
    await page.waitForTimeout(Number(flag("--after-ms", "8000")));
    const t = await body();
    // Any refusal line on the page fails the walk ("The server refused this pairing" once passed 7 of 7), and the server itself must say it is owned.
    const line = t.split("\n").find((l) => REFUSAL.test(l));
    if (line) throw new Error("the page reports a refusal: " + line.slice(0, 200));
    if (/asking to pair/i.test(t)) throw new Error("the page is still waiting at the pairing step");
    if (!OWNED_CMD) throw new Error("no --owned-cmd given: the server's owned state is not asserted, so this walk cannot pass");
    let st;
    try { st = JSON.parse(execSync(OWNED_CMD, { encoding: "utf8" }).replace(/^[^{]*/, "").trim()); } catch (e) { throw new Error("--owned-cmd did not print JSON: " + String(e.message).slice(0, 120)); }
    const owned = st?.data?.owned ?? st?.owned;
    if (owned !== true) throw new Error("the server says owned: " + JSON.stringify(owned) + " (wink.server.status), so the pairing did not take");
    return "server owned: true";
  });
}
// After the pairing, walk the screens over the peer wire (the page is paired; there is no box at its origin): each screen once, on a fresh load, reporting what it shows and any refusal in the server's words.
const SCREENS = flag("--screens", "");
// --after-cmd runs once after the pairing and before the screens (a seed through the owner on the test server; a stand-in for the owner's session)
const AFTER_CMD = flag("--after-cmd", "");
if (CODE_CMD && ANSWER_CMD && SCREENS) {
  let afterOut = "";
  if (AFTER_CMD) { try { afterOut = execSync(AFTER_CMD, { encoding: "utf8" }); console.log("  after-cmd: " + afterOut.replace(/\s+/g, " ").slice(0, 300)); } catch (e) { console.log("  after-cmd FAILED: " + String(e.stdout || e.message).slice(0, 300)); } }
  const thread = /"id":\s*"([^"]+)"/.exec(afterOut)?.[1] ?? "";
  for (const route0 of SCREENS.split(",")) {
    const route = route0.replace("{thread}", thread);
    await check(`screen ${route}`, async () => {
      await page.goto(`${BASE}/app/${route}`, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(6000);
      const t = (await body()).replace(/\n+/g, " | ").slice(0, Number(flag("--body-chars", "260")));
      console.log(`  ${route}: ${t}`);
      if (/refus|could not|cannot reach|did not answer|not available|denied|person_session_required|no_identity|Choose your Vyre name/i.test(t)) throw new Error("refused or empty: " + t.slice(0, 160));
      return t.slice(0, 80);
    });
  }
}
// --steps "Label|Label|...": click each text in turn (from the last screen) and report what the page shows, so a record, a task and the chat can be opened by their names
const STEPS = flag("--steps", "");
if (CODE_CMD && ANSWER_CMD && STEPS) {
  for (const label of STEPS.split("|")) {
    await check(`open "${label}"`, async () => {
      await page.getByText(label, { exact: false }).first().click({ timeout: 10000 });
      await page.waitForTimeout(5000);
      const t = (await body()).replace(/\n+/g, " | ").slice(0, 420);
      console.log(`  after "${label}": ${t}`);
      if (/refus|could not|cannot reach|did not answer|not available|denied|person_session_required|no_identity|did not load/i.test(t)) throw new Error("refused: " + t.slice(0, 200));
    });
  }
}
if (args.includes("--debug")) console.log("PK:", await page.evaluate(() => [sessionStorage.getItem("__PK"), sessionStorage.getItem("__PKERR")]).catch(() => "?"));
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ at: new Date().toISOString(), name: NAME, results }, null, 2));
await browser.close(); server.close();
process.exit(results.every((x) => x.ok) ? 0 : 1);
