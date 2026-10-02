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

/** @type {{ name: string, width: number, height: number, insets: { top: number, bottom: number }, desktop?: boolean }[]} */
const DEVICES = [
  { name: "390", width: 390, height: 844, insets: { top: 47, bottom: 34 } },
  { name: "430", width: 430, height: 932, insets: { top: 59, bottom: 34 } },
];
// DESKTOP=1 adds the Deck on a laptop screen, for cards that live on both (pairing), and
// DESKTOP=1280x800,2000x1100 names the sizes.
if (process.env.DESKTOP) for (const size of (process.env.DESKTOP === "1" ? "1440x900" : process.env.DESKTOP).split(",")) {
  const [width, height] = size.split("x").map(Number);
  DEVICES.push({ name: String(width), width, height, insets: { top: 0, bottom: 0 }, desktop: true });
}
if (process.env.PHONES === "0") DEVICES.splice(0, 2);

// Each screen: a path, then optional steps in the page, then the shot. `shell` is what the phone
// shell must show there (docs/design/phone.md section 3): "page" (the header with Now, Chats and
// Agents, and Lumen), "pushed" (no Lumen; the header only as a back row, or not at all when
// the view draws its own back) or "find" (Lumen opened: neither).
/** @type {{ name: string, path: string, script?: string | ((dev: { name: string }) => string), wait?: number, theme?: string, drag?: boolean, swipe?: boolean, reduce?: boolean, edge?: boolean, offline?: boolean, last?: string, expect?: string, swipes?: number, pin?: string, stub?: Record<string, any>, noShell?: boolean, shell?: string }[]} */
const SCREENS = [
  { name: "now", path: "/now" },
  { name: "now-paper", path: "/now", theme: "paper" },
  { name: "chat", path: "/chat" },
  { name: "chat-paper", path: "/chat", theme: "paper" },
  { name: "agents", path: "/agents" },
  { name: "agents-paper", path: "/agents", theme: "paper" },
  // The header's "+" on Agents opens the New agent form.
  { name: "agents-new", path: "/agents", script: `await click('.ph-plus'); await wait(600); if (!document.querySelector('.page:not(.away) #ag-new:not([hidden])')) throw new Error('the + did not open New agent');` },
  // A swipe left on Now lands on Chats, and the address follows.
  { name: "swipe-to-chats", path: "/now", swipe: true, expect: "/chat" },
  // Under Reduce Motion the pager does not slide; the same flick crossfades to Chats.
  { name: "swipe-reduced", path: "/now", swipe: true, reduce: true, expect: "/chat" },
  // The edge swipe back on a pushed screen (opened cold, so Back lands on Now).
  { name: "edge-back", path: "/agents/kit", edge: true, expect: "/now" },
  // A tap on a label jumps there.
  { name: "label-to-agents", path: "/now", script: `await click('.tb-item[data-view=agents]'); await wait(900);`, expect: "/agents" },
  // Lumen, tapped: Find as a full-height sheet.
  { name: "capsule-find", path: "/now", script: `await wait(1500); await click('.cap-open'); await wait(900);`, expect: "/find", shell: "find" },
  { name: "capsule-find-paper", path: "/now", theme: "paper", script: `await wait(1500); await click('.cap-open'); await wait(900);`, expect: "/find", shell: "find" },
  // The avatar: the More sheet over Now, and its Settings tile opens Settings pushed.
  { name: "places-sheet", path: "/now", script: `await click('.ph-avatar'); await waitFor('.sheet-places .plc-tile', 6000); await wait(600);
      if (document.querySelectorAll('.sheet-places .plc-tile').length !== 6) throw new Error('the More sheet has not six tiles');` },
  // The tab bar's More: the same sheet, from the bar.
  { name: "more-tab", path: "/now", script: `await click('.tb-more'); await waitFor('.sheet-more .plc-tile', 6000); await wait(600);
      if (document.querySelectorAll('.sheet-more .plc-tile').length !== 6) throw new Error('More has not six tiles');` },
  // Projects is a page now: its tab lands on the page, not pushed.
  { name: "tab-to-projects", path: "/now", script: `await click('.tb-item[data-view=projects]'); await wait(900);`, expect: "/projects" },
  { name: "settings-sheet", path: "/now", shell: "pushed", expect: "/settings", script: `await click('.ph-avatar'); await waitFor('.sheet-places .plc-tile', 6000); await wait(400);
      await click('.plc-tile[data-place=Settings]'); await waitFor('.page:not(.away) .set-sec', 6000); await wait(600);` },
  { name: "find", path: "/find", shell: "find" },
  { name: "find-query", path: "/find?q=intake", wait: 2500, shell: "find" },
  { name: "find-command", path: "/find?q=tell%20intake%20to%20add%20a%20phone%20field", wait: 2500, shell: "find" },
  { name: "pull-to-find", path: "/now", drag: true },
  { name: "chat-project", path: "/chat", script: `await click('.chat-projects a.thread-row'); await wait(1500);`, shell: "pushed" },
  { name: "chat-session", path: "/chat", script: `await click('.chat-recent a.thread-row'); await wait(2500);`, shell: "pushed" },
  // Sending from the phone: the fake claude streams an echo back; then a permission ask inline.
  { name: "chat-send", path: "/chat", shell: "pushed", script: `await click('.chat-recent a.thread-row:nth-of-type(2)'); await wait(2500);
      const ta = document.querySelector('.composer textarea'); ta.value = 'hello from the phone'; ta.dispatchEvent(new Event('input'));
      document.querySelector('.composer-send, .composer button[aria-label=Send]').click(); for (let i = 0; i < 80 && !document.body.innerText.includes('echo: hello from the phone'); i++) await wait(100);
      if (!document.body.innerText.includes('hello from the phone')) throw new Error('the sent line is not in the session');` },
  // Another session than chat-send's, and one per phone size: the world is shared, and a session
  // still waiting on its first ask queues the next message instead of asking again.
  { name: "chat-ask", path: "/chat", shell: "pushed", script: dev => `await click('.chat-recent a.thread-row:nth-of-type(${dev.name === "390" ? 3 : 4})'); await wait(2500);
      const ta = document.querySelector('.composer textarea'); ta.value = 'write notes.txt'; ta.dispatchEvent(new Event('input'));
      document.querySelector('.composer-send, .composer button[aria-label=Send]').click(); await waitFor('.ask-card', 10000).catch(() => null);
      if (!document.querySelector('.ask-card')) throw new Error('no ask card for the permission question');` },
  // Now's detail sheets (js/need-sheet.js), opened by a tap on each kind of row. The world needs
  // CHAT_DEMO=1 for the ask and the question; the held drafts are always there.
  { name: "now-sheet-ask", path: "/now", wait: 4000, script: `await waitFor('.np-row[data-kind=ask] .np-main', 15000); await click('.np-row[data-kind=ask] .np-main'); await wait(900);` },
  { name: "now-sheet-draft", path: "/now", script: `await waitFor('.np-row[data-kind=draft] .np-main', 8000); await click('.np-row[data-kind=draft] .np-main'); await wait(900);` },
  { name: "now-sheet-question", path: "/now", wait: 4000, script: `await waitFor('.np-row[data-kind=question] .np-main', 15000); await click('.np-row[data-kind=question] .np-main'); await wait(600);
      const c = document.querySelector('.ns-choice'); c && c.click(); await wait(300);` },
  { name: "now-sheet-draft-paper", path: "/now", theme: "paper", script: `await waitFor('.np-row[data-kind=draft] .np-main', 8000); await click('.np-row[data-kind=draft] .np-main'); await wait(900);` },
  // A row dragged 70 px right and let go short of 100: Approve stays showing (nothing is sent).
  { name: "now-swipe", path: "/now", wait: 4000, script: `await waitFor('.np-row .np-face', 15000);
      const f = document.querySelector('.np-row[data-kind=ask] .np-face') || document.querySelector('.np-row .np-face');
      const r = f.getBoundingClientRect(), y = r.top + r.height / 2, x = r.left + 60;
      const ev = (t, dx) => f.dispatchEvent(new PointerEvent(t, { pointerId: 7, clientX: x + dx, clientY: y, button: 0, bubbles: true, pointerType: "touch" }));
      ev("pointerdown", 0); await wait(40); ev("pointermove", 12); await wait(60); ev("pointermove", 40); await wait(60); ev("pointermove", 70); await wait(300); ev("pointermove", 70); ev("pointerup", 70); await wait(500);
      if (!document.querySelector('.np-show-r')) throw new Error('the approve side is not showing');` },
  { name: "agent-pushed", path: "/agents/kit", shell: "pushed" },
  { name: "settings", path: "/settings", shell: "pushed" },
  { name: "offline", path: "/chat", offline: true },
  // A Mac asking to pair. link.pair.request only answers over the tailnet, so the world cannot
  // make one: link.pending's answer is stubbed in the page, and nothing else is.
  { name: "pair", path: "/now", stub: { "link.pending": [{ id: "7f1c2a90", name: "alex's MacBook Pro", login: "alex@harlowlegal.com", node: "alex-mbp", in: 540_000 }] }, script: `if (matchMedia("(max-width: 719px), (max-height: 500px) and (pointer: coarse)").matches) { await waitFor('.np-row[data-kind=pair] .np-main', 8000); await click('.np-row[data-kind=pair] .np-main'); await wait(700); }
      const i = document.querySelector('.pair-code'); if (!i) throw new Error("no pairing card"); i.value = "482"; i.dispatchEvent(new Event("input")); i.value = "482913"; i.dispatchEvent(new Event("input")); await wait(200);` },
  // Undo is honest: a denied ask is not sent while its toast shows, and Undo means it never is.
  // Then an approve from the row's real button goes at once, with no presence proof (no-nag).
  { name: "now-undo", path: "/now", wait: 4000, script: `await waitFor('.np-row[data-kind=ask] .np-face', 15000);
      const sent = []; const real = window.fetch;
      window.fetch = (u, o) => { const t = String(u).split("/v1/tools/")[1]; if (t && /^(threads\\.answer|gate\\.)/.test(t)) sent.push({ t, proof: !!(o && o.headers && o.headers["x-vyre-presence"]) }); return real(u, o); };
      const row = document.querySelector('.np-row[data-kind=ask]'); const f = row.querySelector('.np-face');
      const r = f.getBoundingClientRect(), y = r.top + r.height / 2, x = r.right - 40;
      const ev = (t, dx) => f.dispatchEvent(new PointerEvent(t, { pointerId: 9, clientX: x + dx, clientY: y, button: 0, bubbles: true, pointerType: "touch" }));
      ev("pointerdown", 0); await wait(30); ev("pointermove", -20); await wait(30); ev("pointermove", -130); await wait(30); ev("pointerup", -130); await wait(400);
      if (!/Denied/.test(document.querySelector('.toast')?.textContent || "")) throw new Error("no Denied toast");
      if (row.isConnected && row.offsetHeight > 2) throw new Error("the denied row did not collapse");
      if (sent.length) throw new Error("the deny went before its toast ended");
      document.querySelector('.toast-undo').click(); await wait(4600);
      if (sent.length) throw new Error("Undo did not stop the deny: " + JSON.stringify(sent));
      const back = document.querySelector('.np-row[data-kind=ask] .np-kb-b'); if (!back) throw new Error("the row did not come back after Undo");
      back.click(); await wait(1500);
      const a = sent.find(x => x.t === "threads.answer"); if (!a) throw new Error("the approve was not sent");
      if (a.proof) throw new Error("the approve asked for a presence proof");
      if (!/Approved/.test(document.querySelector('.toast')?.textContent || "")) throw new Error("no Approved toast");` },
  // Onboarding's history and devices steps (the phone shell is not part of onboarding).
  { name: "onboard-history", path: "/onboard#history", wait: 3000, noShell: true },
  { name: "onboard-devices", path: "/onboard#devices", wait: 3000, noShell: true },
  // No assistant yet (onboarding's first step skipped): agents.list answers without juno.
  // The Glass mini card (js/glass-mini.js) from a stubbed sight: kit's computer is running.
  { name: "now-glass-mini", path: "/now", wait: 3000, stub: {
      "sight.targets": { targets: [{ target: "agent:kit", kind: "agent", label: "kit", live: true }] },
      "sight.steps": { steps: [{ target: "agent:kit", action: "click", summary: "Clicked Compose in Mail", ok: true, at: 0 }] },
      "sight.frame": { target: "agent:kit", image: "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0ODAiIGhlaWdodD0iMzAwIj48cmVjdCB3aWR0aD0iNDgwIiBoZWlnaHQ9IjMwMCIgZmlsbD0iIzJiMjkyNiIvPjxyZWN0IHg9IjI0IiB5PSIyNCIgd2lkdGg9IjQzMiIgaGVpZ2h0PSIzNiIgcng9IjYiIGZpbGw9IiMzYTM3MzMiLz48dGV4dCB4PSI0MCIgeT0iNDgiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjE2IiBmaWxsPSIjZjFlZWU2Ij5NYWlsOiBOZXcgbWVzc2FnZSB0byBkYW5hQGhhcmxvd2xlZ2FsLmNvbTwvdGV4dD48L3N2Zz4=", mime: "image/svg+xml", maxWidth: 480, at: 0 } },
    script: `await waitFor('.gm-card img', 8000); if (!document.querySelector('.gm-card[aria-label="Open Glass for kit\\'s computer"]')) throw new Error('no card for kit');` },
  { name: "no-assistant-now", path: "/now", stub: { "agents.list": [{ name: "kit", kind: "agent", projects: ["harlow-legal"], status: "idle" }] } },
  { name: "no-assistant-agents", path: "/agents", stub: { "agents.list": [{ name: "kit", kind: "agent", projects: ["harlow-legal"], status: "idle" }] } },
  // A cold launch from the home screen opens where the user left off, not at start_url, when
  // nothing needs them; with something waiting, it opens on Now.
  { name: "reopen", path: "/now", last: "/agents", expect: "/agents", stub: { "gate.held": [], "threads.asks": [] } },
  { name: "reopen-needs", path: "/now", last: "/agents", expect: "/now",
    stub: { "threads.asks": [{ id: "ask-1", kind: "permission", thread: "t-1", agent: "kit", tool: "Bash", at: 1, input: { command: "git push origin q3-report" } }] } },
  // Hold-to-pin on the phone: a held tile in More becomes a swipe page after Agents (no sixth tab) and More's first tile.
  { name: "pin-more", path: "/now", script: `await click('.tb-more'); await waitFor('.sheet-more .plc-tile', 6000); await wait(500);
      const hold = async name => { const a = document.querySelector('.sheet-more .plc-tile[data-place=' + name + ']'); const r = a.getBoundingClientRect();
        const ev = t => a.dispatchEvent(new PointerEvent(t, { pointerId: 5, clientX: r.left + 10, clientY: r.top + 10, button: 0, bubbles: true, pointerType: "touch" }));
        ev("pointerdown"); await wait(750); ev("pointerup"); await wait(300); };
      await hold('Vault');
      if (localStorage.getItem('vyre.pin') !== '/vault') throw new Error('the hold did not keep Vault');
      if (document.querySelectorAll('.tabbar .tb-item').length !== 5) throw new Error('a tab was added: the bar is four tabs and More');
      document.querySelector('.sheet-more .sheet-close').click(); await wait(700);
      await click('.tb-more'); await waitFor('.sheet-more .plc-tile', 6000); await wait(500);
      const first = document.querySelector('.sheet-more .plc-tile'); if (first.getAttribute('data-place') !== 'Vault' || !first.hasAttribute('data-kept')) throw new Error('the kept place is not the first tile, marked');` },
  // The pinned page is reached by swiping past Agents; More says where you are.
  { name: "pin-swipe", path: "/now", swipe: true, swipes: 4, expect: "/vault", pin: "Vault" },
  // A second hold lets it go: the page and the mark are gone, the bar never changed.
  { name: "pin-unpin", path: "/now", script: `await click('.tb-more'); await waitFor('.sheet-more .plc-tile', 6000); await wait(500);
      const hold = async name => { const a = document.querySelector('.sheet-more .plc-tile[data-place=' + name + ']'); const r = a.getBoundingClientRect();
        const ev = t => a.dispatchEvent(new PointerEvent(t, { pointerId: 5, clientX: r.left + 10, clientY: r.top + 10, button: 0, bubbles: true, pointerType: "touch" }));
        ev("pointerdown"); await wait(750); ev("pointerup"); await wait(300); };
      await hold('Vault'); if (localStorage.getItem('vyre.pin') !== '/vault') throw new Error('not pinned');
      await hold('Vault'); if (localStorage.getItem('vyre.pin') !== null) throw new Error('the second hold did not let it go');
      if (document.querySelector('.sheet-more .plc-tile[data-kept]')) throw new Error('the tile is still marked');
      if (document.querySelectorAll('.pager .pager-slot').length !== 4) throw new Error('the pager still has a fifth page');` },
];

// The Deck v2 passes, for showing the user the real thing (the sample world's data): Now, Chat, a thread, Projects, a project, Planner, Settings > Devices, in both
// themes. Run with ONLY="^v2-" and DESKTOP=1440x900 for the laptop and the phone together.
for (const [theme, suffix] of [[undefined, ""], ["paper", "-paper"]]) {
  const t = theme ? { theme } : {};
  SCREENS.push(
    { name: "v2-now" + suffix, path: "/now", wait: 3500, ...t },
    { name: "v2-chat" + suffix, path: "/chat", wait: 3000, ...t },
    { name: "v2-thread" + suffix, path: "/chat", shell: "pushed", ...t, script: `await waitFor('.chat-recent a.thread-row', 8000); await click('.chat-recent a.thread-row'); await wait(3000);` },
    { name: "v2-projects" + suffix, path: "/projects", wait: 3000, ...t },
    { name: "v2-project" + suffix, path: "/projects/harlow-legal", shell: "pushed", wait: 3000, ...t },
    { name: "v2-planner" + suffix, path: "/planner", shell: "pushed", wait: 3000, ...t },
    { name: "v2-devices" + suffix, path: "/settings#devices", shell: "pushed", wait: 3500, ...t });
}

let failed = 0;
for (const dev of DEVICES) {
  for (const s of SCREENS) {
    if (ONLY && !ONLY.test(s.name)) continue;
    const tab = await openTab(CDP, { width: dev.width, height: dev.height, standalone: !dev.desktop, mobile: !dev.desktop, scale: dev.desktop ? 1 : 3 });
    const label = `${dev.name}-${s.name}`;
    try {
      // The notch and the home indicator, where this Chrome can emulate them.
      await tab.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: dev.insets.top, topMax: dev.insets.top, bottom: dev.insets.bottom, bottomMax: dev.insets.bottom, left: 0, leftMax: 0, right: 0, rightMax: 0 } });
      if (s.theme) { await tab.go(base + "/now", 300); await tab.run(`localStorage.setItem("vyre.theme", ${JSON.stringify(s.theme)}); localStorage.removeItem("vyre.last"); localStorage.removeItem("vyre.pin");`); }
      else { await tab.go(base + "/now", 300); await tab.run(`localStorage.removeItem("vyre.theme"); localStorage.removeItem("vyre.last"); localStorage.removeItem("vyre.pin");`); }
      if (s.stub) await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
        const stub = ${JSON.stringify(s.stub)}, real = window.fetch;
        window.fetch = (u, o) => { const name = String(u).split("/v1/tools/")[1]; const d = name && stub[decodeURIComponent(name)];
          if (!d) return real(u, o);
          const data = Array.isArray(d) ? d.map(x => x.in != null ? (({ in: ms, ...rest }) => ({ ...rest, expires: Date.now() + ms }))(x) : x) : d;
          return Promise.resolve(new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } })); };
      })();` });
      // Let the first page finish routing, or its own remember("/now") lands after this.
      if (s.last) await new Promise(r => setTimeout(r, 1500));
      if (s.last) await tab.run(`localStorage.setItem("vyre.last", JSON.stringify({ path: ${JSON.stringify(s.last)}, at: Date.now() })); sessionStorage.clear();`);
      if (s.reduce) await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await tab.go(base + s.path, s.wait || 2200);
      if (s.script) await tab.run(typeof s.script === "function" ? s.script(dev) : s.script);
      if (s.offline) {
        await tab.send("Network.enable");
        await tab.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await tab.run(`window.dispatchEvent(new Event("offline")); await wait(800);`);
      }
      if (s.pin) await tab.run(`await click('.tb-more'); await waitFor('.sheet-more .plc-tile', 6000); await wait(500);
        const a = document.querySelector('.sheet-more .plc-tile[data-place=${s.pin}]'); const r = a.getBoundingClientRect();
        const ev = t => a.dispatchEvent(new PointerEvent(t, { pointerId: 5, clientX: r.left + 10, clientY: r.top + 10, button: 0, bubbles: true, pointerType: "touch" }));
        ev("pointerdown"); await wait(750); ev("pointerup"); await wait(300);
        document.querySelector('.sheet-more .sheet-close').click(); await wait(800);`);
      for (let n = 0; s.swipe && n < (s.swipes || 1); n++) {
        // A finger swiping from right to left low on the page, just above Lumen and clear of
        // the Needs rows (which swipe on their own and hold the pager still).
        const y = dev.height - dev.insets.bottom - 110;
        await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: dev.width - 40, y }] });
        for (let i = 1; i <= 10; i++) await tab.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: dev.width - 40 - i * 30, y }] });
        await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await new Promise(r => setTimeout(r, 1200));
      }
      if (s.pin) {
        const more = await tab.run(`return document.querySelector('.tb-more')?.getAttribute('aria-current') || ''`);
        if (more !== "page") throw new Error("More does not say where you are on the kept page");
      }
      if (s.edge) {
        // A finger from the left edge across most of the screen.
        const y = Math.round(dev.height / 2);
        await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 6, y }] });
        for (let i = 1; i <= 10; i++) await tab.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 6 + i * 26, y }] });
        await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await new Promise(r => setTimeout(r, 1200));
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
        head: document.querySelector('.ph-head') ? getComputedStyle(document.querySelector('.ph-head')).display : "none",
        title: document.querySelector('.ph-title') ? getComputedStyle(document.querySelector('.ph-title')).display : "none",
        tabs: document.querySelector('.tabbar') ? getComputedStyle(document.querySelector('.tabbar')).display : "none",
        capsule: document.querySelector('.capsule') ? getComputedStyle(document.querySelector('.capsule')).display : "none",
        tabbar: !!document.querySelector('.tabbar'), at: document.getElementById('deck')?.dataset.at || "",
        standalone: document.documentElement.dataset.display || "" }`);
      if (s.drag) {
        await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await new Promise(r => setTimeout(r, 1200));
        const after = await tab.run(`return location.pathname`);
        if (after !== "/find") { failed++; console.log(`FAIL ${label}: releasing the pull went to ${after}, not /find`); }
      }
      const errs = tab.errors.filter(e => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|fonts\.g/.test(e));
      const want = s.shell || "page", phoneShell = !dev.desktop && !s.noShell;
      const bad = [s.expect && check.path !== s.expect && `opened ${check.path}, not ${s.expect}`, check.sideways && "scrolls sideways",
        phoneShell && check.at !== want && `the shell is in ${check.at || "no"} mode, not ${want}`,
        phoneShell && want === "page" && (check.head !== "flex" || check.title === "none") && "no header with the page title",
        phoneShell && want === "page" && check.tabs !== "grid" && "no tab bar",
        phoneShell && want !== "page" && check.tabs !== "none" && "the tab bar shows on a pushed screen or Find",
        phoneShell && want === "page" && check.capsule !== "flex" && "no Lumen",
        phoneShell && want !== "page" && check.capsule !== "none" && "Lumen shows on a pushed screen",
        phoneShell && want === "find" && check.head !== "none" && "the header shows over Find",
        phoneShell && check.standalone !== "standalone" && "not standalone",
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
