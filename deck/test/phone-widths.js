// @ts-check
// Below 720 px the Deck is the phone layout, with no exceptions (team/0.2.2/deck-v2/FIXES.md section 2). For each width 320, 360, 390, 430, 600 and 719 and each place,
// in a Chrome that is already running (CDP): the rail is not displayed, the bottom bar is, the page does not scroll sideways, and no text box is narrower than 8
// characters of its own size (the "one word per line" failure). The four places under More (Memory, Vault, Drive, Settings) are pushed screens on a phone,
// with their own Back and no bar (css/tabbar.css: "only on a page"), so there the check is Back instead of the bar. At 720 and 768 the rail is displayed and the bottom bar is not. Run on a runner (the pwa-shots workflow).
//
//   CDP=http://127.0.0.1:9422 node deck/test/phone-widths.js <deck url>
//
// Exits 1 on any failure and prints one JSON line per check.

import { openTab } from "./cdp.js";

const base = process.argv.slice(2).find(a => !a.startsWith("--")) || "http://127.0.0.1:4790";
const CDP = process.env.CDP || "http://127.0.0.1:9422";
const PLACES = ["/now", "/chat", "/projects", "/agents", "/memory", "/vault", "/files", "/settings"];
const PUSHED = new Set(["/memory", "/vault", "/files", "/settings"]);
const PHONE = [320, 360, 390, 430, 600, 719], DESK = [720, 768];

let failed = 0;
for (const width of [...PHONE, ...DESK]) {
  const phone = width < 720;
  const tab = await openTab(CDP, { width, height: 844, standalone: phone, mobile: phone });
  for (const path of PLACES) {
    await tab.go(base + path, 1800);
    const r = await tab.run(`
      const shown = el => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
      const rail = shown(document.querySelector(".rail"));
      const bar = shown(document.querySelector(".tabbar"));
      const back = !!document.querySelector("#deck[data-at='pushed']") && [...document.querySelectorAll(".ph-back, [data-back], .back")].some(shown);
      const wide = document.scrollingElement.scrollWidth > innerWidth + 1;
      let narrow = 0; const samples = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent.trim();
        if (t.length < 12 || !n.parentElement || !shown(n.parentElement)) continue;
        const cs = getComputedStyle(n.parentElement);
        if (cs.fontFamily.includes("mono") || cs.whiteSpace === "pre") continue;
        const range = document.createRange(); range.selectNodeContents(n);
        const w = range.getBoundingClientRect().width, size = parseFloat(cs.fontSize);
        if (w > 0 && range.getClientRects().length > 3 && w < size * 8) { narrow++; if (samples.length < 3) samples.push(t.slice(0, 40) + " | " + n.parentElement.tagName.toLowerCase() + "." + String(n.parentElement.className).slice(0, 40) + " | " + Math.round(w) + "px at " + size); }
      }
      const at = document.querySelector("#deck")?.dataset.at || "";
      return { rail, bar, back, at, wide, narrow, samples };`);
    const pushed = PUSHED.has(path);
    const ok = phone ? !r.rail && (pushed ? !r.bar && r.back : r.bar) && !r.wide && !r.narrow : r.rail && !r.bar;
    if (!ok) failed++;
    console.log(JSON.stringify({ width, path, ...r, ok }));
  }
  await tab.close?.();
}
if (failed) { console.error(`${failed} width checks failed`); process.exit(1); }
console.log("phone widths: all places hold at 320 to 719, and the rail shows from 720");
