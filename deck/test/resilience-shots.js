// @ts-check
// A Chrome check of the Deck's resilience (docs/adr/0029-resilience.md) and the one app's /app/
// route, at one iPhone size, through a Chrome that is already running (CDP). Three flows:
//
//   pill     the box stops answering: the Reconnecting pill shows under the header and takes no
//            layout space; the device offline says "This phone is offline."; Retry brings it back.
//   outbox   a message sent while the box is out of reach waits on the phone ("Sending when your
//            box answers"), then goes once when it is back: one threads.send reaches the box.
//   app      /app is a 301 to /app/, a route under it gets the app's index.html, /app/sw.js is
//            the app's worker and the Deck's own worker leaves /app/ alone.
//
// "Out of reach" is Chrome's Fetch domain refusing /v1/* (ConnectionRefused), with a moment of
// offline to end the stream already open. A test helper, not part of the product.
//
//   CDP=http://127.0.0.1:9422 node deck/test/resilience-shots.js <deck url> <out dir>
//
// The deck url is a running world (deck/test/world.js); for the app flow the world's checkout
// needs an apps/app/dist (APP_FAKE=1 writes a small one first and removes it after).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTab } from "./cdp.js";

const [base = "http://127.0.0.1:4790", out = "resilience-shots"] = process.argv.slice(2);
const CDP = process.env.CDP || "http://127.0.0.1:9422";
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
fs.mkdirSync(out, { recursive: true });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const DEV = { width: 390, height: 844, standalone: true, mobile: true, scale: 3 };
const INSETS = { top: 47, topMax: 47, bottom: 34, bottomMax: 34, left: 0, leftMax: 0, right: 0, rightMax: 0 };

let failed = 0;
/** @param {string} label @param {string[]} bad */
function report(label, bad) {
  if (bad.length) { failed++; console.log(`FAIL ${label}: ${bad.join("; ")}`); } else console.log(`ok   ${label}`);
}

/** A phone tab whose /v1/* calls can be refused, as a box out of reach would be. */
async function phone() {
  const tab = await openTab(CDP, DEV);
  await tab.send("Emulation.setSafeAreaInsetsOverride", { insets: INSETS });
  const box = { down: false, /** @type {string[]} */ reached: [] };
  tab.on("Fetch.requestPaused", p => {
    if (box.down) { void tab.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionRefused" }); return; }
    const tool = String(p.request.url).split("/v1/tools/")[1];
    if (tool) box.reached.push(decodeURIComponent(tool) + " " + (p.request.postData || ""));
    void tab.send("Fetch.continueRequest", { requestId: p.requestId });
  });
  await tab.send("Fetch.enable", { patterns: [{ urlPattern: "*/v1/*", requestStage: "Request" }] });
  await tab.send("Network.enable");
  /** The box stops answering: refuse from now on, and end the stream that is open. */
  const drop = async () => {
    box.down = true;
    await tab.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(600);
    await tab.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  };
  return { tab, box, drop };
}

/** The pill's state: shown, its words, and whether it moved the view. */
const PILL = `const bar = document.querySelector('.reach'); const view = document.querySelector('#view, .view');
  return { shown: !!bar && !bar.hidden && getComputedStyle(bar).display !== 'none', words: bar ? bar.innerText.trim() : '',
    position: bar ? getComputedStyle(bar).position : '', viewTop: view ? Math.round(view.getBoundingClientRect().top) : null };`;

async function pill() {
  const { tab, box, drop } = await phone();
  try {
    await tab.go(base + "/now", 3000);
    const before = await tab.run(PILL);
    await drop();
    // Shown only after the first failed retry, so wait out the first backoff (2 s, jittered).
    let now = before;
    for (let i = 0; i < 40 && !now.shown; i++) { await sleep(250); now = await tab.run(PILL); }
    fs.writeFileSync(path.join(out, "390-pill-reconnecting.png"), await tab.shot());
    const bad = [before.shown && "the pill shows while the box answers",
      !now.shown && "no pill after the box stopped answering",
      now.shown && !/^Reconnecting/.test(now.words) && `the pill says "${now.words}"`,
      now.shown && !/Retry/.test(now.words) && "no Retry on the pill",
      now.position !== "absolute" && now.position !== "fixed" && `the pill is in the flow (position ${now.position})`,
      before.viewTop !== now.viewTop && `the view moved from ${before.viewTop} to ${now.viewTop}`].filter(Boolean);
    report("390-pill-reconnecting", /** @type {string[]} */ (bad));

    await tab.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await tab.run(`window.dispatchEvent(new Event("offline")); await wait(500);`);
    const off = await tab.run(PILL);
    fs.writeFileSync(path.join(out, "390-pill-offline.png"), await tab.shot());
    report("390-pill-offline", /** @type {string[]} */ ([!/This phone is offline/.test(off.words) && `the pill says "${off.words}"`].filter(Boolean)));

    await tab.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    box.down = false;
    await tab.run(`window.dispatchEvent(new Event("online")); document.querySelector('.reach button')?.click();`);
    let back = off;
    for (let i = 0; i < 40 && back.shown; i++) { await sleep(250); back = await tab.run(PILL); }
    fs.writeFileSync(path.join(out, "390-pill-back.png"), await tab.shot());
    const errs = tab.errors.filter(e => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|fonts\.g/.test(e));
    report("390-pill-back", /** @type {string[]} */ ([back.shown && `the pill stays after Retry ("${back.words}")`,
      errs.length && `errors: ${errs.join(" | ").slice(0, 300)}`].filter(Boolean)));
  } finally { await tab.close(); }
}

async function outbox() {
  const { tab, box, drop } = await phone();
  const words = "sent from the phone while the box was away " + Date.now().toString(36);
  try {
    await tab.go(base + "/chat", 2500);
    await tab.run(`await click('.chat-recent a.thread-row:nth-of-type(2)'); await wait(2500);`);
    await drop();
    await tab.run(`const ta = document.querySelector('.composer textarea'); ta.value = ${JSON.stringify(words)}; ta.dispatchEvent(new Event('input'));
      document.querySelector('.composer-send').click();
      for (let i = 0; i < 80 && !/Sending when your box answers/.test(document.querySelector('.composer-note')?.innerText || ''); i++) await wait(100);`);
    const waiting = await tab.run(`return { note: document.querySelector('.composer-note')?.innerText || '', box: document.querySelector('.composer textarea')?.value || '',
      sendOff: !!document.querySelector('.composer-send')?.disabled }`);
    fs.writeFileSync(path.join(out, "390-outbox-waiting.png"), await tab.shot());
    report("390-outbox-waiting", /** @type {string[]} */ ([!/Sending when your box answers/.test(waiting.note) && `the note says "${waiting.note}"`,
      waiting.box !== "" && "the words stayed in the box", waiting.sendOff && "Send stays off while it waits"].filter(Boolean)));

    box.down = false;
    await tab.run(`window.dispatchEvent(new Event("online")); document.querySelector('.reach button')?.click();`);
    const echoed = await tab.run(`for (let i = 0; i < 150 && !document.body.innerText.includes('echo: ' + ${JSON.stringify(words)}) && ![...document.querySelectorAll('.cv-queued-row')].some(r => r.innerText.includes(${JSON.stringify(words)})); i++) await wait(100);
      const t = document.body.innerText; return { mine: t.split(${JSON.stringify(words)}).length - 1, echo: t.includes('echo: ' + ${JSON.stringify(words)}),
      note: document.querySelector('.composer-note')?.innerText || '',
      queued: [...document.querySelectorAll('.cv-queued-row')].some(r => r.innerText.includes(${JSON.stringify(words)})) }`);
    fs.writeFileSync(path.join(out, "390-outbox-sent.png"), await tab.shot());
    const sends = box.reached.filter(r => r.startsWith("threads.send ") && r.includes(words));
    const errs = tab.errors.filter(e => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|fonts\.g/.test(e));
    report("390-outbox-sent", /** @type {string[]} */ ([sends.length !== 1 && `${sends.length} threads.send reached the box, not 1`,
      // A session not running in this world queues the message for after its turn: the words then show once, in the queued row.
      echoed.echo ? echoed.mine !== 2 && `the words show ${echoed.mine} times (want 2: the message and its echo)`
        : !echoed.queued && "the message is neither answered nor queued",
      !echoed.echo && echoed.mine !== 1 && `the words show ${echoed.mine} times (want 1: the queued row)`,
      /Sending when/.test(echoed.note) && "the waiting note stayed",
      errs.length && `errors: ${errs.join(" | ").slice(0, 300)}`].filter(Boolean)));
  } finally { await tab.close(); }
}

async function app() {
  const dist = path.join(REPO, "apps", "app", "dist");
  const fake = process.env.APP_FAKE === "1" && !fs.existsSync(dist);
  if (fake) {
    fs.mkdirSync(path.join(dist, "_expo", "static", "js"), { recursive: true });
    fs.writeFileSync(path.join(dist, "_expo", "static", "js", "entry-1a2b.js"), `document.getElementById("root").textContent = "the one app, " + location.pathname;
      navigator.serviceWorker?.register("/app/sw.js", { scope: "/app/" });`);
    fs.writeFileSync(path.join(dist, "index.html"), `<!doctype html><meta charset="utf-8"><title>Vyre app</title><div id="root"></div><script src="/app/_expo/static/js/entry-1a2b.js"></script>`);
    fs.writeFileSync(path.join(dist, "precache.json"), JSON.stringify({ build: "fake-1", files: ["/app/index.html", "/app/_expo/static/js/entry-1a2b.js"] }));
  }
  const { tab } = await phone();
  try {
    const r301 = await fetch(base + "/app", { redirect: "manual" });
    const sw = await fetch(base + "/app/sw.js");
    const swText = await sw.text();
    const asset = await fetch(base + "/app/_expo/static/js/entry-1a2b.js");
    const missing = await fetch(base + "/app/_expo/static/js/nope.js");
    // The Deck first, so its worker is installed, then a route under /app/.
    await tab.go(base + "/now", 3000);
    await tab.go(base + "/app/settings", 2500);
    await tab.go(base + "/app/settings", 2500); // a second load is under the app's worker
    const page = await tab.run(`const reg = await navigator.serviceWorker?.getRegistration('/app/');
      return { text: document.getElementById('root')?.innerText || document.body.innerText.slice(0, 80), title: document.title,
        scope: reg?.scope || '', controller: navigator.serviceWorker?.controller?.scriptURL || '' }`);
    fs.writeFileSync(path.join(out, "390-app-route.png"), await tab.shot());
    report("390-app-route", /** @type {string[]} */ ([
      r301.status !== 301 && `/app answered ${r301.status}, not 301`,
      r301.status === 301 && !/\/app\/$/.test(r301.headers.get("location") || "") && `/app went to ${r301.headers.get("location")}`,
      sw.status !== 200 && `/app/sw.js answered ${sw.status}`,
      sw.status === 200 && !/entry-1a2b\.js/.test(swText) && "/app/sw.js does not precache the export's files",
      asset.status !== 200 && `a hashed asset answered ${asset.status}`,
      asset.status === 200 && !/immutable/.test(asset.headers.get("cache-control") || "") && "a hashed asset is not immutable",
      missing.status !== 404 && `a missing /app/_expo/ file answered ${missing.status}, not 404`,
      !/the one app, \/app\/settings/.test(page.text) && `the route drew "${page.text}"`,
      !/\/app\/$/.test(page.scope) && `the app's worker scope is "${page.scope}"`,
      page.controller && !/\/app\/sw\.js/.test(page.controller) && `the page is controlled by ${page.controller}, not the app's worker`,
    ].filter(Boolean)));
  } finally {
    await tab.close();
    if (fake) fs.rmSync(dist, { recursive: true, force: true });
  }
}

for (const [name, run] of /** @type {[string, () => Promise<void>][]} */ ([["pill", pill], ["outbox", outbox], ["app", app]])) {
  if (ONLY && !ONLY.test(name)) continue;
  try { await run(); } catch (e) { failed++; console.log(`FAIL ${name}: ${/** @type {Error} */ (e).message.split("\n")[0]}`); }
}
process.exit(failed ? 1 : 0);
