// @ts-check
// Screenshots of the Deck as the installed phone app, at two iPhone sizes, through a Chrome that
// is already running (CDP). Emulates an iPhone: its user agent, touch, a 3x screen, standalone
// display mode and the notch's safe areas. Each screen also asserts the page did not scroll
// sideways and threw nothing. A test helper, not part of the product.
//
//   CDP=http://127.0.0.1:9422 node deck/test/pwa-shots.js <deck url> <out dir>
//
// The deck url is a running world (deck/test/world.js). Exits 1 if any screen failed a check.

import fs from "node:fs";
import path from "node:path";
import { openTab } from "./cdp.js";

const [base = "http://127.0.0.1:4790", out = "pwa-shots"] = process.argv.slice(2);
const CDP = process.env.CDP || "http://127.0.0.1:9422";
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
fs.mkdirSync(out, { recursive: true });

const DEVICES = [
  { name: "390", width: 390, height: 844, insets: { top: 47, bottom: 34 } },
  { name: "430", width: 430, height: 932, insets: { top: 59, bottom: 34 } },
];

// Each screen: a path, then optional steps in the page, then the shot.
/** @type {{ name: string, path: string, script?: string, wait?: number, theme?: string, drag?: boolean, offline?: boolean }[]} */
const SCREENS = [
  { name: "now", path: "/now" },
  { name: "now-paper", path: "/now", theme: "paper" },
  { name: "find", path: "/find" },
  { name: "find-query", path: "/find?q=intake", wait: 2500 },
  { name: "pull-to-find", path: "/projects", drag: true },
  { name: "chat", path: "/chat" },
  { name: "chat-project", path: "/chat", script: `click('.chat-projects a.thread-row'); await wait(1500);` },
  { name: "chat-session", path: "/chat", script: `click('.chat-recent a.thread-row'); await wait(2500);` },
  { name: "needs-draft", path: "/now", script: `const a = document.querySelector('a[href^="/needs/"]'); if (!a) throw new Error("no held item on Now"); a.click(); await wait(1500);` },
  { name: "agents", path: "/agents" },
  { name: "settings", path: "/settings" },
  { name: "offline", path: "/chat", offline: true },
];

let failed = 0;
for (const dev of DEVICES) {
  for (const s of SCREENS) {
    if (ONLY && !ONLY.test(s.name)) continue;
    const tab = await openTab(CDP, { width: dev.width, height: dev.height, standalone: true });
    const label = `${dev.name}-${s.name}`;
    try {
      // The notch and the home indicator, where this Chrome can emulate them.
      await tab.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: dev.insets.top, topMax: dev.insets.top, bottom: dev.insets.bottom, bottomMax: dev.insets.bottom, left: 0, leftMax: 0, right: 0, rightMax: 0 } });
      if (s.theme) { await tab.go(base + "/now", 300); await tab.run(`localStorage.setItem("vyre.theme", ${JSON.stringify(s.theme)});`); }
      else { await tab.go(base + "/now", 300); await tab.run(`localStorage.removeItem("vyre.theme");`); }
      await tab.go(base + s.path, s.wait || 2200);
      if (s.script) await tab.run(s.script);
      if (s.offline) {
        await tab.send("Network.enable");
        await tab.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await tab.run(`window.dispatchEvent(new Event("offline")); await wait(800);`);
      }
      if (s.drag) {
        // A finger pulling down 60 px from the top, held there for the shot.
        const x = dev.width / 2, y0 = dev.insets.top + 80;
        await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
        for (let i = 1; i <= 8; i++) await tab.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + 11 * i }] });
      }
      await new Promise(r => setTimeout(r, 400));
      fs.writeFileSync(path.join(out, `${label}.png`), await tab.shot());
      const check = await tab.run(`return { sideways: document.documentElement.scrollWidth > innerWidth + 1, path: location.pathname,
        tabbar: getComputedStyle(document.querySelector('.tabbar')).display, standalone: document.documentElement.dataset.display || "" }`);
      if (s.drag) {
        await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await new Promise(r => setTimeout(r, 1200));
        const after = await tab.run(`return location.pathname`);
        if (after !== "/find") { failed++; console.log(`FAIL ${label}: releasing the pull went to ${after}, not /find`); }
      }
      const errs = tab.errors.filter(e => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|fonts\.g/.test(e));
      const bad = [check.sideways && "scrolls sideways", check.tabbar !== "flex" && "no tab bar", check.standalone !== "standalone" && "not standalone",
        errs.length && `errors: ${errs.join(" | ").slice(0, 300)}`].filter(Boolean);
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
process.exit(failed ? 1 : 0);
