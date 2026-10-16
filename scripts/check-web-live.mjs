#!/usr/bin/env node
// @ts-check
// check-web-live: the post-deploy check for web.vyre.run. Against the signed release (the app-out the deploy used) it proves that
//   1. the site answers and vyre-build.json names this release and this signed manifest;
//   2. every file of the release is served byte for byte (SRI hash against the signed manifest) and the page is the signed index.html;
//   3. the security headers are there (HSTS, a policy with no unsafe-inline or unsafe-eval, no frames);
//   4. with --browser: a fresh headless browser opens the first-run route, the first screen renders (a heading, the splash gone), the page
//      is a secure context where a passkey can be made, and nothing broke the policy or threw.
//   node scripts/check-web-live.mjs --app-out app-out [--url https://web.vyre.run] [--route /] [--browser] [--shot file.png]
// The browser needs playwright resolvable from PW_FROM (a folder with it installed); the workflow installs it.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { MANIFEST } from "../relay/app/manifest.js";

const a = process.argv.slice(2);
const flag = (/** @type {string} */ n, d = "") => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
const URL0 = flag("url", "https://web.vyre.run").replace(/\/+$/, "");
const appOut = flag("app-out", "app-out");
let bad = 0;
const ok = (/** @type {boolean} */ c, /** @type {string} */ m) => { console.log(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) bad++; };
const sri = (/** @type {Buffer} */ b) => `sha384-${crypto.createHash("sha384").update(b).digest("base64")}`;
const get = async (/** @type {string} */ p) => { const r = await fetch(URL0 + p, { headers: { "cache-control": "no-cache" } }); return { r, bytes: Buffer.from(await r.arrayBuffer()) }; };

const folders = fs.readdirSync(path.join(appOut, "v")).filter(n => /^[a-f0-9]{40}$/.test(n));
if (folders.length !== 1) { console.error(`${appOut}/v must hold exactly one build`); process.exit(1); }
const src = path.join(appOut, "v", folders[0]);
const manifestBytes = fs.readFileSync(path.join(src, MANIFEST));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const wantSha = crypto.createHash("sha256").update(manifestBytes).digest("hex");

// Right after a deploy an edge can still hold the old build for a moment: wait up to two minutes for it to be this one.
let info = null;
for (let i = 0; i < 12; i++) {
  try { const { r, bytes } = await get("/vyre-build.json"); if (r.ok) info = JSON.parse(bytes.toString("utf8")); } catch { info = null; }
  if (info && info.manifest === wantSha) break;
  await new Promise(r => setTimeout(r, 10000));
}
ok(!!info, `${URL0}/vyre-build.json answers`);
ok(info?.manifest === wantSha && info?.release === manifest.release, `it serves release ${manifest.release}, manifest ${wantSha.slice(0, 12)} (live says ${info?.release} ${String(info?.manifest).slice(0, 12)})`);
if (!info) process.exit(1);

let mismatched = 0;
for (const [f, h] of Object.entries(manifest.files)) {
  const { r, bytes } = await get(`/app/${f}`);
  if (!r.ok || sri(bytes) !== h) { mismatched++; console.log(`     ${f}: ${r.status}${r.ok ? " bytes differ from the signed manifest" : ""}`); }
}
ok(mismatched === 0, `all ${Object.keys(manifest.files).length} files of the release are served byte for byte`);
const page = await get("/");
ok(page.r.ok && crypto.createHash("sha256").update(page.bytes).digest("hex") === info.index, "the page at / is the release's signed index.html");
const csp = page.r.headers.get("content-security-policy") || "";
const scriptSrc = (csp.split("; ").find(d => d.startsWith("script-src")) || "");
ok(/default-src 'none'/.test(csp) && !/unsafe-eval/.test(csp) && !/unsafe-/.test(scriptSrc) && /frame-ancestors 'none'/.test(csp) && /script-src 'self'/.test(scriptSrc), "the Content-Security-Policy is strict for scripts (no unsafe-inline or unsafe-eval), with inline styles allowed");
ok(/max-age=\d{8,}/.test(page.r.headers.get("strict-transport-security") || ""), "HSTS is set");
ok(page.r.headers.get("x-content-type-options") === "nosniff" && !page.r.headers.get("set-cookie"), "nosniff, and no cookie");

if (a.includes("--browser")) {
  const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : null) });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const p = await ctx.newPage();
  /** @type {string[]} */ const problems = [];
  p.on("pageerror", e => problems.push(`error: ${String(e.message).slice(0, 160)}`));
  p.on("console", m => { if (/content security policy|refused to (load|execute|apply)/i.test(m.text())) problems.push(`policy: ${m.text().slice(0, 200)}`); });
  p.on("requestfailed", r => problems.push(`request failed: ${r.url().slice(0, 100)}`));
  await p.goto(URL0 + flag("route", "/"), { waitUntil: "domcontentloaded" });
  const heading = await p.locator("[role=heading]").first().innerText({ timeout: 30000 }).then(t => t.trim(), () => "");
  ok(heading.length > 0, `the first screen renders: "${heading}" at ${new URL(p.url()).pathname}`);
  const splashGone = await p.locator("#vyre-splash").waitFor({ state: "detached", timeout: 15000 }).then(() => true, () => false);
  ok(splashGone, "the splash cleared");
  const env = await p.evaluate(() => ({ secure: window.isSecureContext, pk: typeof PublicKeyCredential !== "undefined", origin: location.origin }));
  ok(env.secure && env.pk && env.origin === URL0, `a secure context with WebAuthn at ${env.origin}`);
  ok(problems.length === 0, problems.length ? problems.join(" | ") : "no policy violation, no page error, no failed request");
  if (flag("shot")) await p.screenshot({ path: flag("shot") });
  await browser.close();
}
process.exit(bad ? 1 : 0);
