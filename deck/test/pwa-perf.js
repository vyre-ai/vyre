// @ts-check
// How fast the phone app switches pages, measured the way a person feels it: from the tap on a
// page label (or Lumen, for Find) to the first frame that shows the page's content (not a
// "Reading…" placeholder). Runs in a Chrome that
// is already running (CDP), as an iPhone at 390x844, with the CPU slowed 4x (a mid-range phone)
// and 60 ms added to every request (the tailnet from a phone).
//
//   CDP=http://127.0.0.1:9422 node deck/test/pwa-perf.js <deck url> [--budget 100]
//
// Two rounds over the three pages and Find (the first tap on each, then a revisit), then Chat: open a session,
// back to the list, open it again. Exits 1 when any step takes longer than the budget (default
// 100 ms), or opening a session the first time longer than 3x (it reads the session from the box).
// Prints one JSON line per switch, then a summary. A test helper, not part of the product.

import { openTab } from "./cdp.js";

const args = process.argv.slice(2);
const base = args.find(a => !a.startsWith("--")) || "http://127.0.0.1:4790";
const budget = Number(args[args.indexOf("--budget") + 1]) || 100;
const CDP = process.env.CDP || "http://127.0.0.1:9422";
const TABS = ["now", "chat", "find", "agents"];

const tab = await openTab(CDP, { width: 390, height: 844, standalone: true });
await tab.send("Network.enable");
await tab.go(base + "/now", 2500);
// Settle: the service worker installed and the first view drawn, before any slowing.
await tab.go(base + "/now", 2500);
await tab.send("Emulation.setCPUThrottlingRate", { rate: 4 });
await tab.send("Network.emulateNetworkConditions", { offline: false, latency: 60, downloadThroughput: -1, uploadThroughput: -1 });

/** Tap a tab and time it to the first frame whose view has real content. */
async function time(/** @type {string} */ name) {
  return tab.run(`
    // Find is Lumen opened; the pages are the header's labels. From Find, Done goes back first.
    const done = document.querySelector('.page[data-page="find"]:not(.away) .fd-done');
    if (done && "${name}" !== "find") { done.click(); await new Promise(r => setTimeout(r, 500)); }
    const a = "${name}" === "find" ? document.querySelector('.cap-open') : document.querySelector('.tb-item[data-view="${name}"]');
    // The pages beside the current one stay drawn in the pager, so only the page itself counts.
    const ready = () => {
      const page = document.querySelector('.page[data-page="${name}"]:not(.away)');
      const t = page ? page.innerText.trim() : "";
      return t.length > 40 && !/^(Reading|Loading|Opening|Looking)/m.test(t.split("\\n").slice(0, 3).join("\\n"));
    };
    const t0 = performance.now();
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    return await new Promise(resolve => {
      const tick = () => { if (ready()) resolve(Math.round(performance.now() - t0)); else if (performance.now() - t0 > 8000) resolve(-1); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });`);
}

const rows = [];
for (const round of ["first", "revisit"]) {
  for (const name of [...TABS.slice(1), TABS[0]]) {
    const ms = await time(name);
    await new Promise(r => setTimeout(r, 600)); // let background refreshes land before the next tap
    // The tabs are made while the phone is idle after launch, so a first tap is as quick as a revisit.
    const limit = budget;
    const ok = ms >= 0 && ms <= limit;
    rows.push({ round, tab: name, ms, limit, ok });
    console.log(JSON.stringify({ round, tab: name, ms, limit, ok }));
  }
}
// Chat, the way it is used: open a session from the list, go back, open it again.
async function chatStep(/** @type {string} */ label, /** @type {string} */ clickSel, /** @type {string} */ readySel, /** @type {number} */ limit) {
  const ms = await tab.run(`
    const t0 = performance.now();
    const el = [...document.querySelectorAll(${JSON.stringify(clickSel)})].find(x => !x.closest(".away"));
    if (!el) return -2;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    return await new Promise(resolve => {
      const tick = () => { const r = [...document.querySelectorAll(${JSON.stringify(readySel)})].some(x => !x.closest(".away"));
        if (r) resolve(Math.round(performance.now() - t0)); else if (performance.now() - t0 > 8000) resolve(-1); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });`);
  await new Promise(r => setTimeout(r, 600));
  const ok = ms >= 0 && ms <= limit;
  rows.push({ round: "chat", tab: label, ms, limit, ok });
  console.log(JSON.stringify({ round: "chat", tab: label, ms, limit, ok }));
}
await time("chat");
await new Promise(r => setTimeout(r, 600));
await chatStep("open session", ".chat-recent a.thread-row", ".thread-view .msg", budget * 3);
await chatStep("back to list", ".session-back", ".chat-recent a.thread-row", budget);
await chatStep("open it again", ".chat-recent a.thread-row", ".thread-view .msg", budget);

const errors = tab.errors.filter(e => !/fonts\.g|Failed to load resource/.test(e));
await tab.send("Emulation.setCPUThrottlingRate", { rate: 1 });
await tab.close();
const worst = r => Math.max(...rows.filter(x => x.round === r).map(x => x.ms));
console.log(`first taps: worst ${worst("first")} ms; revisits: worst ${worst("revisit")} ms; chat: ${rows.filter(x => x.round === "chat").map(x => `${x.tab} ${x.ms} ms`).join(", ")} (budget ${budget} ms)${errors.length ? `; page errors: ${errors.join(" | ")}` : ""}`);
process.exit(rows.every(r => r.ok) && !errors.length ? 0 : 1);
