// @ts-check
// Screenshots of the box's Deck with a paired Mac (deck/test/mac-world.js), through a Chrome that
// is already running (CDP), on a laptop screen (1440x900) and an iPhone (390x844). Each screen
// asserts what it is there to show (a machine chip, the read-only note, the offline chip), that
// the page did not scroll sideways, and that it threw nothing. A test helper, not part of the
// product.
//
//   CDP=http://127.0.0.1:9422 node deck/test/mac-shots.js <mac world url> <out dir>
//
// Picks the Mac's Harlow intake session into the box's Harlow Legal project first, and takes the
// Mac off the simulated tailnet (POST /__mac/off) for the offline screens, then back on. Exits 1
// if any screen failed a check.

import fs from "node:fs";
import path from "node:path";
import { openTab } from "./cdp.js";

const [base = "http://127.0.0.1:4748", out = "mac-shots"] = process.argv.slice(2);
const CDP = process.env.CDP || "http://127.0.0.1:9422";
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
fs.mkdirSync(out, { recursive: true });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const tool = async (/** @type {string} */ name, /** @type {any} */ input = {}) => (await (await fetch(`${base}/v1/tools/${name}`, { method: "POST",
  headers: { "content-type": "application/json", "x-vyre-caller": "deck" }, body: JSON.stringify(input) })).json());

const INTAKE = "11111111-aaaa-4000-8000-000000000002";
const picked = await tool("projects.add-threads", { project: "harlow-legal", threads: [INTAKE] });
if (picked.error) console.log(`note: projects.add-threads: ${picked.error.message}`);

const DEVICES = [
  { name: "1440", width: 1440, height: 900, desktop: true },
  { name: "390", width: 390, height: 844, desktop: false },
];

const macRow = `[...document.querySelectorAll('.chat-recent a.thread-row')].find(a => a.querySelector('.tag.machine'))`;
const needChip = `if (!document.querySelector('.tag.machine:not(.off)')) throw new Error('no machine chip');`;
const needOff = `for (let i = 0; i < 40 && !document.querySelector('.machine-offline'); i++) await wait(100); if (!document.querySelector('.machine-offline')) throw new Error('no offline chip');`;

/** @type {{ name: string, path: string, script?: string, wait?: number, noShell?: boolean, phone?: boolean, desktop?: boolean, offline?: boolean }[]} */
const SCREENS = [
  { name: "chat-list", path: "/chat", script: needChip },
  { name: "chat-mac-session", path: "/chat", script: `for (let i = 0; i < 40 && !(${macRow}); i++) await wait(100);
      const a = ${macRow}; if (!a) throw new Error('no Mac row in Chat'); a.click(); await wait(2500);
      if (!document.body.innerText.includes('On alex-mac. Open it there to continue.')) throw new Error('no read-only note');
      if (document.querySelector('.composer textarea')) throw new Error('a composer on a Mac session');` },
  // Now opens on the passkey and setup cards; scroll to the rows the chips are on.
  { name: "now", path: "/now", script: `${needChip} document.querySelector('.tag.machine').scrollIntoView({ block: 'center' }); await wait(300);` },
  // The header's search box on a laptop; the Find page on a phone, where the header has none.
  { name: "search", path: "/now", desktop: true, script: `type('.search input', 'harlow'); await wait(2500);
      if (!document.querySelector('.search-pop .tag.machine')) throw new Error('no Mac hit in the search box');` },
  { name: "search", path: "/find?q=harlow", phone: true, wait: 3000, script: needChip },
  { name: "board", path: "/projects/harlow-legal", wait: 3000, script: needChip },
  { name: "onboard-history", path: "/onboard#history", wait: 3500, noShell: true },
  { name: "chat-offline", path: "/chat", offline: true, script: needOff },
  { name: "now-offline", path: "/now", offline: true, script: `${needOff} document.querySelector('.machine-offline').scrollIntoView({ block: 'center' }); await wait(300);` },
];

/** Take the Mac off the tailnet and wait until link.macs says so (hold + stale window). */
async function macOff() {
  await fetch(`${base}/__mac/off`, { method: "POST" });
  for (let i = 0; i < 60; i++) {
    const r = await tool("link.macs");
    if (Array.isArray(r.data) && r.data.some((/** @type {any} */ m) => m.online === false)) return;
    await sleep(500);
  }
  throw new Error("the Mac still reads online 30 s after the tailnet stopped");
}

let failed = 0, off = false;
/** @type {string[]} */ const consoleErrors = [];
for (const s of [...SCREENS].sort((a, b) => Number(!!a.offline) - Number(!!b.offline))) {
  for (const dev of DEVICES) {
    if (ONLY && !ONLY.test(s.name)) continue;
    if ((s.phone && dev.desktop) || (s.desktop && !dev.desktop)) continue;
    if (s.offline && !off) { await macOff(); off = true; }
    const label = `${dev.name}-${s.name}`;
    const tab = await openTab(CDP, { width: dev.width, height: dev.height, standalone: !dev.desktop, mobile: !dev.desktop, scale: dev.desktop ? 1 : 3 });
    try {
      if (!dev.desktop) await tab.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, topMax: 47, bottom: 34, bottomMax: 34, left: 0, leftMax: 0, right: 0, rightMax: 0 } });
      await tab.go(base + "/now", 300);
      await tab.run(`localStorage.removeItem("vyre.theme"); localStorage.removeItem("vyre.last");`);
      await tab.go(base + s.path, s.wait || 2500);
      if (s.script) await tab.run(s.script);
      await sleep(400);
      fs.writeFileSync(path.join(out, `${label}.png`), await tab.shot());
      const check = await tab.run(`return { sideways: document.documentElement.scrollWidth > innerWidth + 1, width: document.documentElement.scrollWidth }`);
      const errs = tab.errors.filter(e => !/fonts\.g/.test(e));
      for (const e of errs) consoleErrors.push(`${label}: ${e}`);
      const bad = [check.sideways && `scrolls sideways (${check.width} > ${dev.width})`, errs.length && `errors: ${errs.join(" | ").slice(0, 300)}`].filter(Boolean);
      if (bad.length) { failed++; console.log(`FAIL ${label}: ${bad.join("; ")}`); }
      else console.log(`ok   ${label}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${label}: ${/** @type {Error} */ (e).message.split("\n")[0]}`);
      try { fs.writeFileSync(path.join(out, `${label}.png`), await tab.shot()); } catch {}
    } finally {
      await tab.close();
    }
  }
}
if (off) await fetch(`${base}/__mac/on`, { method: "POST" });
if (consoleErrors.length) { console.log("console errors:"); for (const e of consoleErrors) console.log(`  ${e}`); }
process.exit(failed ? 1 : 0);
