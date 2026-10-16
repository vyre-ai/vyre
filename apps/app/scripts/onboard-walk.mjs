#!/usr/bin/env node
// onboard-walk: the first-run screens (/onboard) clicked through in headless Chromium on a web export built with the sample world, so a release cannot ship a dead end.
// Identity, then a space, then Ready. It does not walk a typed code, four words, a Solo role, or a phone signature on who owns a space.
//
//   EXPO_PUBLIC_VYRE_MOCK=1 npx expo export -p web --output-dir dist-mock
//   PW_FROM=<a folder with playwright installed>/ node scripts/onboard-walk.mjs --dist dist-mock [--out walk-out] [--base /app]
//
// Exit 0 when every path walked. The words it looks for are the screens' own; when copy changes, change them here in the same commit.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "dist-mock"));
const OUT = flag("--out", "") ? path.resolve(flag("--out", "")) : "";
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  let f = path.join(DIST, p);
  const missing = !f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory();
  if (missing && path.extname(p)) { res.writeHead(404); return res.end(); }
  if (missing) f = path.join(DIST, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = flag("--base", "/app");
const URL0 = `http://127.0.0.1:${server.address().port}${BASE}/onboard`;
const browser = await chromium.launch({ ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : null), args: ["--use-mock-keychain", "--password-store=basic"] });

const BANNED = [/four words/i, /Face ID signature/i, /Reserve this name/i, /\bSolo\b/, /typed code/i, /Check the words/i];
let failures = 0;
async function walk(name, fn) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, serviceWorkers: "block" });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
  const t = {
    p,
    title: async () => (await p.locator("[role=heading]").first().innerText({ timeout: 4000 }).catch(() => "")).trim(),
    at: async (want) => { const ok = await p.locator("[role=heading]", { hasText: want }).first().waitFor({ timeout: 6000 }).then(() => true, () => false); if (!ok) throw new Error(`expected the screen "${want}", found "${await t.title()}"`); },
    press: async (label) => { await p.getByRole("button", { name: label }).first().click({ timeout: 6000 }); },
    enabled: async (label) => p.getByRole("button", { name: label }).first().isEnabled(),
    pick: async (label) => { await p.getByRole("radio", { name: label }).first().click({ timeout: 6000 }); },
    type: async (label, v) => { await p.locator(`input[aria-label="${label}"], textarea[aria-label="${label}"]`).first().fill(v, { timeout: 6000 }); },
    sees: async (text) => { await p.getByText(text, { exact: false }).first().waitFor({ timeout: 6000 }); },
    absent: async (text) => { if (await p.getByText(text, { exact: false }).count()) throw new Error(`this screen still says "${text}"`); },
    body: async () => p.locator("body").innerText(),
    start: async () => { await p.goto(URL0, { waitUntil: "domcontentloaded" }); await t.at("Create your identity"); },
  };
  try {
    await fn(t);
    const body = await t.body();
    for (const re of BANNED) if (re.test(body)) throw new Error(`banned copy: ${re}`);
    const noisy = errors.filter((e) => !/color scheme|dark mode/i.test(e));
    if (noisy.length) throw new Error(`page errors: ${noisy.join(" | ")}`);
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${String(e.message).split("\n").slice(0, 3).join(" ")}`);
    if (OUT) await p.screenshot({ path: path.join(OUT, `${name.replace(/\W+/g, "-")}.png`), fullPage: true }).catch(() => {});
  }
  await ctx.close();
}

const PASS = "correct horse battery";
async function identity(t) {
  await t.start();
  await t.type("Username", "ab"); await t.sees("3 to 20");
  await t.type("Username", "alex"); await t.sees("vyre.run/u/alex");
  if (await t.enabled("Create")) throw new Error("Create should wait for a master password");
  await t.type("Master password", PASS);
  await t.type("Confirm master password", PASS);
  await t.press("Create");
  await t.at("Save your recovery key");
  await t.sees("R1-SAMPLE-KEY-SHOWN-ONCE");
  if (await t.enabled("Continue")) throw new Error("Continue should wait until the recovery key is saved");
  await pSwitch(t);
  await t.press("Continue");
}

async function pSwitch(t) {
  await t.p.getByRole("switch").first().click({ timeout: 6000 });
}

await walk("new person joins a space", async (t) => {
  await identity(t);
  await t.at("Your space");
  await t.pick("Join a space");
  await t.at("Join a space");
  const join = await t.body();
  if (/\bservers?\b/i.test(join)) throw new Error("the join path names a server");
  if (await t.enabled("Continue")) throw new Error("Continue should wait for an invite link");
  await t.type("Invite link", "https://vyre.run/i/abcdefgh");
  await t.press("Continue");
  await t.at("You are invited");
  await t.sees("juniper");
  await t.press("Join");
  await t.at("You're in");
  await t.press("Invite someone");
  await t.at("Invite someone");
  await t.press("Create link");
  await t.sees("https://vyre.run/i/sampletoken");
  await t.press("Done");
  await t.at("You're in");
  await t.sees("juniper");
  await t.pick("Join another space");
  await t.at("Join a space");
  const again = await t.body();
  if (/\bservers?\b/i.test(again)) throw new Error("the join path names a server");
  await t.type("Invite link", "https://vyre.run/i/secondtok");
  await t.press("Continue");
  await t.press("Join");
  await t.at("You're in");
  await t.sees("juniper");
  await t.sees("studio");
});

await walk("new person creates a space and waits", async (t) => {
  await identity(t);
  await t.pick("Create a space");
  await t.at("Where should it run?");
  if (await t.enabled("Show the command")) throw new Error("the command waits until a place is chosen");
  await t.pick("Linux server");
  await t.press("Show the command");
  await t.at("Waiting for it to come online");
  await t.sees("curl -fsSL vyre.run/i | sh");
  if (await t.enabled("Waiting")) throw new Error("Waiting stays off until the computer is online");
  await t.absent("Face ID");
});

await walk("ready can add a computer and a phone", async (t) => {
  await identity(t);
  await t.pick("Join a space");
  await t.type("Invite link", "https://vyre.run/i/abcdefgh");
  await t.press("Continue");
  await t.press("Join");
  await t.at("You're in");
  await t.pick("Add a computer");
  await t.at("Add your computer");
  await t.type("Space address", "https://juniper.vyre.run");
  await t.type("Username", "alex");
  await t.type("Master password", PASS);
  await t.press("Add this computer");
  await t.at("You're in");
  await t.pick("Add a phone");
  await t.at("Add your phone");
  await t.press("Add your phone");
  await t.sees("https://vyre.run/i/samplephone");
  await t.absent("Face ID");
});

await walk("Back retraces identity", async (t) => {
  await identity(t);
  await t.at("Your space");
  await t.press("Back");
  await t.at("Save your recovery key");
  await t.press("Back");
  await t.at("Create your identity");
});

await browser.close();
server.close();
console.log(failures ? `\n${failures} path(s) failed` : "\nevery onboarding path walked");
process.exit(failures ? 1 : 0);
