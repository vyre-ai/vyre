#!/usr/bin/env node
// onboard-walk: every path of the onboarding flow (/onboard) clicked through in headless Chromium on a web export built with the sample world, so a release cannot ship a dead end.
// It checks that each step lands on the screen named for it, that every failure state shows its way forward, that Back retraces the path, that Compute is skipped where it must be, and that no page throws.
//
//   EXPO_PUBLIC_VYRE_MOCK=1 npx expo export -p web --output-dir dist-mock
//   PW_FROM=<a folder with playwright installed>/ node scripts/onboard-walk.mjs --dist dist-mock [--out walk-out] [--base /app]   (--base "" for a root export; PW_CHROME for a Chrome you already have)
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
    pick: async (label, exact = false) => { await p.getByRole("radio", { name: label, exact }).first().click({ timeout: 6000 }); },
    type: async (label, v) => { await p.locator(`input[aria-label="${label}"], textarea[aria-label="${label}"]`).first().fill(v, { timeout: 6000 }); },
    field: async (i, v) => { await p.locator("input").nth(i).fill(v, { timeout: 6000 }); },
    toggle: async () => { await p.getByRole("switch").first().click({ timeout: 6000 }); },
    sees: async (text) => { await p.getByText(text, { exact: false }).first().waitFor({ timeout: 6000 }); },
    start: async (opts = {}) => {
      await p.goto(URL0, { waitUntil: "domcontentloaded" });
      await t.at("Try the new setup");
      if (opts.phone) await t.pick("Phone or browser");
      if (opts.later) await t.pick("Add a space later");
      if (opts.noCompute) await t.toggle();
      await t.press("Start");
    },
  };
  try { await fn(t); if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`); console.log(`ok   ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${String(e.message).split("\n").slice(0, 3).join(" ")}`); if (OUT) await p.screenshot({ path: path.join(OUT, `${name.replace(/\W+/g, "-")}.png`), fullPage: true }).catch(() => {}); }
  await ctx.close();
}

const PHRASE = "river amber stone quiet";
const aiAndSpace = async (t) => {
  await t.at("Connect your AI");
  await t.press("Sign in"); await t.sees("Signed in");
  await t.press("Continue"); await t.at("Create a space or join one");
};
const makeSpace = async (t, { allow }) => {
  await t.pick("Create a space"); await t.press("Continue"); await t.at("Name your space");
  await t.type("Space name", "Harlow Legal"); await t.press("Continue"); await t.at("Can members use their own computers?");
  await t.pick(allow ? "Allow" : "Do not allow", true); await t.press("Continue"); await t.at("Get a server");
  await t.press("I have a server"); await t.at("Run this on your server");
  await t.press("I have the code"); await t.at("Type the space code");
  await t.type("Space code", "wink11112222"); await t.press("Connect to my server"); await t.sees("not from a space that is waiting");
  await t.type("Space code", "WINK-0000-0000"); await t.press("Connect to my server"); await t.sees("expired");
  await t.type("Space code", "WINK-7QMK-4P2X"); await t.press("Connect to my server"); await t.at("Do the four words match?");
  await t.press("They do not match"); await t.sees("not your server"); await t.press("Enter a new code"); await t.at("Type the space code");
  await t.type("Space code", "WINK-7QMK-4P2X"); await t.press("Connect to my server"); await t.press("They match"); await t.at("Setting up Harlow Legal");
  await t.press("Continue");
};
const invite = async (t) => {
  await t.press("Invite people"); await t.at("Invite people");
  await t.press("Make the invite"); await t.sees("Add a name");
  await t.type("Name", "Sam"); await t.press("Admin. "); await t.press("Make the invite"); await t.at("Send Sam the invite");
  await t.press("They have the link"); await t.at("Confirm four words");
  await t.type("Their four words", "one two"); await t.press("Check the words"); await t.sees("do not match");
  await t.type("Their four words", PHRASE); await t.press("Check the words"); await t.at("Sam is an admin");
  await t.press("Invite someone else"); await t.at("Invite people");
  await t.type("Name", "Kim"); await t.press("Member. "); await t.press("Make the invite"); await t.press("I sent it"); await t.at("Kim is invited");
  await t.press("Back to the space");
};

await walk("new person, creates a space that allows computers", async (t) => {
  await t.start(); await t.at("Sign in to Vyre");
  await t.pick("I am new to Vyre"); await t.press("Continue"); await t.at("Pick your name");
  await t.type("Name", "ab"); await t.sees("3 to 20"); await t.type("Name", "alex"); await t.sees("taken");
  await t.type("Name", "morgan"); await t.press("Reserve this name"); await t.at("Save your recovery kit");
  await t.toggle(); await t.press("Continue"); await t.at("Let's set up your vault");
  await t.press("Create my master password"); await t.at("Create your master password");
  await t.field(0, "abc"); await t.field(1, "abc"); await t.press("Continue"); await t.sees("too easy to guess");
  await t.field(0, PHRASE); await t.field(1, PHRASE); await t.press("Continue"); await t.at("Only you know it");
  await t.toggle(); await t.press("Open my vault"); await t.at("Connect your AI");
  await t.press("Sign in"); await t.sees("Signed in");
  await t.p.getByRole("button", { name: "Sign in" }).nth(1).click(); await t.sees("did not finish signing in");
  await t.press("Try again"); await t.press("Add a key"); await t.at("Add an API key");
  await t.type("API key", "hello"); await t.press("Save to my vault"); await t.sees("Keys start with sk-");
  await t.type("API key", "sk-ant-abcdefgh12"); await t.press("Save to my vault"); await t.at("Connect your AI");
  await t.press("Continue"); await t.at("Create a space or join one");
  await makeSpace(t, { allow: true });
  await t.at("Use this computer for your work in Harlow Legal?");
  await t.pick("Allow: use this computer"); await t.press("Continue"); await t.at("You are in Harlow Legal");
  await invite(t); await t.at("You are in Harlow Legal");
  await t.press("Start the prototype again"); await t.at("Try the new setup");
});

await walk("returning person, every identity failure", async (t) => {
  await t.start(); await t.pick("I already have a name"); await t.press("Continue"); await t.at("Your name");
  await t.type("Name", "nobody"); await t.press("Continue"); await t.sees("No one has the name");
  await t.type("Name", "alex"); await t.press("Continue"); await t.at("Approve on your other device");
  await t.press("the other device says no"); await t.sees("did not approve"); await t.press("Ask again");
  await t.press("Use my recovery kit instead"); await t.at("Use your recovery kit");
  await t.type("Recovery code", "kit11112222"); await t.press("Use recovery code"); await t.sees("not the recovery code");
  await t.type("Recovery code", "KIT-7QMK-4P2X-9TBN"); await t.press("Use recovery code"); await t.at("Open your vault here");
  await t.type("Master password", "nope"); await t.press("Open my vault"); await t.sees("not your master password");
  await t.press("I forgot it"); await t.at("Use your recovery kit");
  await t.type("Recovery code", "KIT-7QMK-4P2X-9TBN"); await t.press("Use recovery code"); await t.at("Create a new master password");
});

await walk("returning person signs in, joins a space on a phone (no Compute)", async (t) => {
  await t.start({ phone: true }); await t.pick("I already have a name"); await t.press("Continue");
  await t.type("Name", "alex"); await t.press("Continue"); await t.press("Prototype: approve on the other device"); await t.at("Open your vault here");
  await t.type("Master password", "correct horse battery"); await t.press("Open my vault"); await aiAndSpace(t);
  await t.pick("Join a space"); await t.press("Continue"); await t.at("Join a space");
  await t.type("Invite link or code", "my expired invite"); await t.press("Continue"); await t.sees("expired or was already used");
  await t.type("Invite link or code", "https://web.vyre.run/join/abc123"); await t.press("Continue"); await t.at("Join Harlow Legal?");
  await t.press("Join Harlow Legal"); await t.at("Placing your vault"); await t.p.getByRole("button", { name: "Continue" }).first().click({ timeout: 8000 });
  await t.at("You are in Harlow Legal");
});

await walk("joins a space that does not allow computers (Compute skipped)", async (t) => {
  await t.start({ noCompute: true, later: true });
  await t.at("Create a space or join one"); await t.pick("Join a space"); await t.press("Continue");
  await t.type("Invite link or code", "https://web.vyre.run/join/abc123"); await t.press("Continue"); await t.press("Join Harlow Legal");
  await t.p.getByRole("button", { name: "Continue" }).first().click({ timeout: 8000 }); await t.at("You are in Harlow Legal");
});

await walk("joins a space that allows computers (Compute asked)", async (t) => {
  await t.start({ later: true });
  await t.pick("Join a space"); await t.press("Continue");
  await t.type("Invite link or code", "https://web.vyre.run/join/abc123"); await t.press("Continue"); await t.press("Join Harlow Legal");
  await t.p.getByRole("button", { name: "Continue" }).first().click({ timeout: 8000 });
  await t.at("Use this computer for your work in Harlow Legal?"); await t.press("Continue"); await t.at("You are in Harlow Legal");
});

await walk("creates a space that does not allow computers (Compute skipped)", async (t) => {
  await t.start({ later: true });
  await makeSpace(t, { allow: false }); await t.at("You are in Harlow Legal");
});

await walk("Back retraces every step", async (t) => {
  await t.start(); await t.at("Sign in to Vyre");
  await t.pick("I am new to Vyre"); await t.press("Continue"); await t.at("Pick your name");
  await t.type("Name", "morgan"); await t.press("Reserve this name"); await t.at("Save your recovery kit");
  await t.toggle(); await t.press("Continue"); await t.at("Let's set up your vault");
  await t.press("Create my master password"); await t.at("Create your master password");
  for (const want of ["Let's set up your vault", "Save your recovery kit", "Pick your name", "Sign in to Vyre"]) { await t.press("Back"); await t.at(want); }
});

await browser.close();
server.close();
console.log(failures ? `\n${failures} path(s) failed` : "\nevery onboarding path walked");
process.exit(failures ? 1 : 0);
