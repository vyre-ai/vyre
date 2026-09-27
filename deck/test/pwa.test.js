// @ts-check
// The installed phone app's static promises: every file the service worker keeps at install
// exists, the manifest's icons and the iOS launch screens are really there, and the service
// worker still never caches a tool call beyond its two offline reads.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// vyred serves core/resilience/*.js beside the Deck's own files (core/daemon), and the Deck imports them.
const file = (/** @type {string} */ f) => path.join(f.startsWith("core/resilience/") ? path.join(DECK, "..") : DECK, f);
const read = (/** @type {string} */ f) => fs.readFileSync(file(f), "utf8");
const exists = (/** @type {string} */ p) => fs.existsSync(file(p === "/" ? "index.html" : p.slice(1)));

test("pwa: every path the service worker keeps at install is a file in deck/ (or core/resilience/, which vyred serves)", () => {
  const m = /const SHELL = \[([\s\S]*?)\];/.exec(read("sw.js"));
  assert.ok(m, "SHELL list in sw.js");
  const paths = [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
  assert.ok(paths.length > 20);
  for (const p of paths) assert.ok(exists(p), `${p} is kept at install but is not in deck/`);
});

test("pwa: every view module a phone tab imports is kept at install", () => {
  const m = /const SHELL = \[([\s\S]*?)\];/.exec(read("sw.js"));
  const kept = new Set([...(m?.[1] || "").matchAll(/"([^"]+)"/g)].map(x => x[1]));
  const seen = new Set();
  const walk = (/** @type {string} */ p) => {
    if (seen.has(p)) return;
    seen.add(p);
    for (const [, spec] of read(p.slice(1)).matchAll(/^import (?:[^"]*from )?"([^"]+)"/gm)) walk(path.posix.resolve(path.posix.dirname(p), spec));
  };
  for (const v of ["now", "projects", "chat", "find", "agents", "needs"]) walk(`/views/${v}.js`);
  walk("/js/app.js");
  walk("/chat/index.js");
  for (const p of seen) assert.ok(kept.has(p), `${p} is imported by the shell or a phone tab but not kept at install`);
});

test("pwa: the manifest installs standalone with any and maskable icons that exist", () => {
  const man = JSON.parse(read("manifest.webmanifest"));
  assert.equal(man.display, "standalone");
  assert.equal(man.start_url, "/now");
  assert.equal(man.background_color, "#0E0D0C", "Graphite, from TOKENS.md");
  assert.equal(man.theme_color, "#0E0D0C");
  const purposes = new Set(man.icons.map((/** @type {any} */ i) => i.purpose));
  assert.ok(purposes.has("any") && purposes.has("maskable"));
  for (const i of man.icons) assert.ok(exists(i.src), i.src);
  for (const s of man.shortcuts || []) assert.ok(s.url.startsWith("/"));
});

test("pwa: index.html has the iOS home-screen tags, and each launch screen it names exists", () => {
  const html = read("index.html");
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
  const splash = [...html.matchAll(/apple-touch-startup-image" href="([^"]+)"/g)].map(x => x[1]);
  assert.ok(splash.length >= 10);
  for (const s of splash) assert.ok(exists(s), s);
});

test("pwa: the service worker caches no tool call but its two offline reads", () => {
  const sw = read("sw.js");
  assert.match(sw, /OFFLINE_TOOLS = new Set\(\["threads\.get", "projects\.list"\]\)/);
  assert.match(sw, /url\.pathname\.startsWith\("\/v1\/"\)/, "GETs under /v1/ are never cached");
});

// ---- the phone shell (docs/design/phone.md section 3) ---------------------------------------

/** The rules inside deck.css's phone block (PHONE_QUERY), the one that starts the shell. */
function phoneCss() {
  const css = read("css/deck.css");
  const at = css.indexOf("@media (max-width: 719px), (max-height: 500px) and (pointer: coarse) {\n  .top { display: none; }");
  assert.ok(at > 0, "the phone block in deck.css");
  let depth = 0, i = css.indexOf("{", at);
  for (let j = i; j < css.length; j++) { if (css[j] === "{") depth++; else if (css[j] === "}" && --depth === 0) return css.slice(i, j); }
  return "";
}

test("pwa shell: no tab bar and no Projects tab on the phone; /projects still routes", () => {
  const app = read("js/app.js"), css = read("css/deck.css");
  assert.doesNotMatch(app, /tabbar|const TABS\b/, "app.js draws no tab bar");
  assert.doesNotMatch(css, /\.tabbar/, "deck.css styles no tab bar");
  assert.match(app, /\["\/projects", "projects"\]/, "the /projects route stays");
  assert.match(app, /\["\/projects\/:slug\/:thread", "projects"\]/);
});

test("pwa shell: three pages, Now Chats Agents, in pager order, and nothing else is a page", () => {
  const app = read("js/app.js");
  const m = /const PAGER = \[([\s\S]*?)\];/.exec(app);
  assert.ok(m, "PAGER in app.js");
  const pages = [...m[1].matchAll(/href: "([^"]+)", label: "([^"]+)"/g)].map(x => [x[1], x[2]]);
  assert.deepEqual(pages, [["/now", "Now"], ["/chat", "Chats"], ["/agents", "Agents"]]);
  // A swipe swaps the address in place; pages are not history.
  assert.match(app, /history\.replaceState\(history\.state, "", strip\[i\]\.href\)/);
  // The pager's pages are the three, then the place kept from the Places sheet, if any.
  assert.match(app, /const strip = \[\.\.\.PAGER\];/);
  // Rows that swipe on their own are left alone by the pager.
  assert.match(app, /\[data-swipe\]/);
  assert.match(phoneCss(), /\[data-swipe\] \{ touch-action: pan-y; \}/);
  assert.match(phoneCss(), /\.pager \{[^}]*scroll-snap-type: x mandatory/);
});

test("pwa shell: the header is 48 tall with the labels in Page type, and the Capsule floats 56 tall", () => {
  const css = phoneCss();
  assert.match(css, /\.ph-head \{[^}]*height: 48px/);
  assert.match(css, /\.ph-tab \{[^}]*font-size: 22px; line-height: 28px; font-weight: 600; letter-spacing: -0\.015em/);
  assert.match(css, /\.ph-initial \{[^}]*width: 34px; height: 34px/);
  assert.match(css, /\.capsule \{[^}]*position: fixed/);
  assert.match(css, /\.capsule \{[^}]*background: var\(--panel\); border: 1px solid var\(--rule-strong\); border-radius: 999px; box-shadow: var\(--light-top\)/);
  assert.match(css, /\.cap-mic \{ width: 40px; height: 40px/);
  assert.match(read("css/deck.css"), /--cap-h: 56px/);
  assert.match(read("css/deck.css"), /--cap-clear: calc\(var\(--cap-h\) \+ 16px \+ var\(--cap-bottom\)\)/);
  assert.match(css, /\.pager \.page \{ padding-bottom: var\(--cap-clear\); \}/, "a page's last row clears the Capsule");
  assert.match(css, /#deck:not\(\[data-at="page"\]\) \.capsule \{ display: none; \}/, "pushed screens hide the Capsule");
  // No colour of alarm anywhere in the shell.
  assert.doesNotMatch(css, /coral|\bred\b/i);
});

test("pwa shell: the Capsule's markup, placeholder and mic", async () => {
  const { install, text, $ } = await import("./fake-dom.js");
  install();
  // icons.js parses its drawings with DOMParser, which the fake DOM does not have.
  /** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
  /** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
  const { capsule, placeholder, assistantName } = await import("../js/capsule.js");
  assert.equal(placeholder("juno"), "Ask juno, find, or run");
  assert.equal(placeholder(null), "Ask Vyre, find, or run");
  assert.equal(assistantName([{ name: "kit", kind: "agent" }, { name: "juno", kind: "assistant" }]), "juno");
  assert.equal(assistantName({ agents: [{ name: "kit", kind: "agent" }] }), null);
  const opened = /** @type {any[]} */ ([]);
  const cap = capsule({ open: w => opened.push(w) });
  assert.ok($(cap.el, ".cap-open") && $(cap.el, ".cap-mic"), "the open button and the mic");
  assert.equal(text(cap.el).trim(), "Ask Vyre, find, or run");
  assert.equal($(cap.el, ".cap-mic").hidden, true, "no speech recognition here: no mic");
  cap.name("juno");
  assert.equal(text(cap.el).trim(), "Ask juno, find, or run");
  assert.equal($(cap.el, ".cap-open").getAttribute("aria-label"), "Ask juno, find, or run");
  // Where the browser can listen, the mic shows.
  /** @type {any} */ (window).webkitSpeechRecognition = class {};
  assert.equal($(capsule({ open() {} }).el, ".cap-mic").hidden, false);
  delete (/** @type {any} */ (window)).webkitSpeechRecognition;
});

test("pwa shell: dictated words go into Find and are never sent on their own", () => {
  const cap = read("js/capsule.js"), app = read("js/app.js");
  assert.match(cap, /if \(words\) o\.open\(words\)/);
  assert.doesNotMatch(cap, /agents\.ask|threads\.send|requestSubmit|\.submit\(/);
  assert.match(app, /go\("\/find\?q=" \+ encodeURIComponent\(words\)\)/);
  assert.doesNotMatch(app.slice(app.indexOf("function openFind"), app.indexOf("function openPlaces")), /requestSubmit|Enter|\.submit\(/);
});

test("pwa shell: light by default: passive gesture listeners, no interval, nothing polls", () => {
  for (const f of ["js/app.js", "js/capsule.js", "js/pwa.js", "js/keyboard.js"]) {
    const src = read(f);
    assert.doesNotMatch(src, /setInterval/, `${f} sets no interval`);
    for (const [, type, opts] of src.matchAll(/addEventListener\("(touch(?:start|move|end|cancel)|scroll(?:end)?)", [^\n]*?(\{ passive: true \})?\);?$/gm))
      assert.ok(opts, `${f}: the ${type} listener is passive`);
  }
});

test("pwa: a planner-ack push shows a silent notification under the ring's tag, then closes every one; a labelled ring shows its body", async () => {
  const vm = await import("node:vm");
  const on = {}, shown = [], closed = [], badges = [];
  const open = [{ tag: "planner-f_1", close: () => closed.push("ring") }];
  const self = { addEventListener: (type, fn) => { on[type] = fn; },
    navigator: { setAppBadge: async (...a) => { badges.push(a); } },
    registration: { showNotification: async (title, o) => { shown.push({ title, ...o }); if (o.tag === "planner-f_1") open.push({ tag: o.tag, close: () => closed.push("ack") }); },
      getNotifications: async ({ tag }) => open.filter(n => n.tag === tag) } };
  vm.runInNewContext(read("sw.js"), { self, URL, Response, caches: {}, fetch: () => {}, console });
  const push = async d => { const waits = []; on.push({ data: { json: () => d }, waitUntil: p => waits.push(p) }); assert.equal(waits.length, 1, "one waitUntil"); await Promise.all(waits); };
  await push({ kind: "planner-ack", tag: "planner-f_1", at: 1 });
  // Shown once (WebKit drops a subscription whose pushes show nothing), then closed with the ring.
  assert.equal(shown.length, 1);
  assert.deepEqual([shown[0].title, shown[0].body, shown[0].tag, shown[0].silent, shown[0].data.path], ["Vyre", "Answered.", "planner-f_1", true, "/now"]);
  assert.deepEqual(closed.sort(), ["ack", "ring"]);
  assert.equal(badges.length, 0, "an answered ring puts no dot on the icon");
  await push({ kind: "planner", title: "Reminder", path: "/planner/f_2", tag: "planner-f_2", body: "Call kit", at: 1 });
  assert.deepEqual([shown[1].title, shown[1].body, shown[1].tag], ["Reminder", "Call kit", "planner-f_2"]);
  assert.equal(badges.length, 0, "a planner ring puts no dot on the icon");
  await push({ kind: "ask", title: "A session is waiting for your answer", path: "/needs/a", tag: "ask-a", at: 1 });
  assert.equal(shown[2].body, "Waiting on your answer.");
  await push({ kind: "draft", title: "Held at the Gate", path: "/needs/g", tag: "draft-g", at: 1 });
  assert.equal(shown[3].body, "Held at the Gate.");
  assert.deepEqual(badges, [[], []], "an ask and a draft each set a dot, with no number");
  await push({ kind: "watch", title: "Done", path: "/now", tag: "watch-w", at: 1 });
  assert.equal(badges.length, 2);
  assert.match(read("sw.js"), /const BUILD = "dev";\nconst CACHE = "vyre-deck-8-" \+ BUILD;/);
});

test("pwa: a test push with a receipt shows the notification, then posts the receipt back as the Deck", async () => {
  const vm = await import("node:vm");
  const on = {}, steps = [];
  const self = { addEventListener: (type, fn) => { on[type] = fn; },
    registration: { showNotification: async (title, o) => { steps.push(["shown", title, o.tag]); }, getNotifications: async () => [] } };
  const fetch = async (url, init) => { steps.push(["post", url, init]); return { ok: true }; };
  vm.runInNewContext(read("sw.js"), { self, URL, Response, caches: {}, fetch, console });
  const waits = [];
  on.push({ data: { json: () => ({ kind: "test", title: "Vyre can reach this device", path: "/settings", tag: "test", receipt: "r4nd0m-n0nce", at: 1 }) }, waitUntil: p => waits.push(p) });
  assert.equal(waits.length, 1, "one waitUntil");
  await Promise.all(waits);
  assert.deepEqual(steps.map(s => s[0]), ["shown", "post"], "shown first, then posted");
  const [, url, init] = steps[1];
  assert.equal(url, "/v1/tools/push.receipt");
  assert.deepEqual(JSON.parse(JSON.stringify({ ...init, body: JSON.parse(init.body) })), { method: "POST", headers: { "content-type": "application/json", "x-vyre-caller": "deck" },
    body: { receipt: "r4nd0m-n0nce" }, credentials: "same-origin" });
  // No receipt, nothing posted; a failed post is swallowed.
  on.push({ data: { json: () => ({ kind: "test", tag: "test" }) }, waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  assert.equal(steps.filter(s => s[0] === "post").length, 1);
  const quiet = [];
  vm.runInNewContext(read("sw.js"), { self: { ...self, addEventListener: (t, fn) => { if (t === "push") quiet.push(fn); } }, URL, Response, caches: {}, fetch: async () => { throw new Error("offline"); }, console });
  const w = [];
  quiet[0]({ data: { json: () => ({ kind: "test", receipt: "x" }) }, waitUntil: p => w.push(p) });
  await Promise.all(w);
});

test("pwa: a push still shows when a browser has no app badge", async () => {
  const vm = await import("node:vm");
  const on = {}, shown = [];
  const self = { addEventListener: (type, fn) => { on[type] = fn; },
    registration: { showNotification: async (title, o) => { shown.push({ title, ...o }); }, getNotifications: async () => [] } };
  vm.runInNewContext(read("sw.js"), { self, URL, Response, caches: {}, fetch: () => {}, console });
  const waits = [];
  on.push({ data: { json: () => ({ kind: "ask", title: "A session is waiting for your answer", tag: "ask-b" }) }, waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  assert.equal(shown.length, 1);
  // And one whose setAppBadge throws.
  self.navigator = { setAppBadge: () => { throw new Error("no"); } };
  on.push({ data: { json: () => ({ kind: "draft", tag: "draft-c" }) }, waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  assert.equal(shown.length, 2);
});

test("pwa: push.seen is reported at launch, on visibility changes and on input after a quiet minute, with no timer", () => {
  const src = read("js/pwa.js");
  assert.match(src, /call\("push\.seen", \{ surface: surfaceId\(\), visible, standalone: standalone\(\), \.\.\.\(device \? \{ device \} : \{\}\) \}, \{ keepalive: !visible \}\)\.catch\(\(\) => \{\}\)/);
  assert.match(src, /device = store\?\.getItem\("vyre\.push\.device"\)/, "the push device rides along when this app has one");
  assert.match(src, /export const standalone = \(\) => \/\*\* @type \{any\} \*\/ \(navigator\)\.standalone === true \|\| matchMedia\("\(display-mode: standalone\)"\)\.matches;/);
  assert.match(src, /SEEN_EVERY = 60_000/);
  assert.match(src, /addEventListener\("pointerdown", touched, \{ passive: true, capture: true \}\)/);
  assert.match(src, /addEventListener\("keydown", touched, \{ passive: true, capture: true \}\)/);
  assert.doesNotMatch(src, /setInterval|setTimeout/);
});

// ---- the iOS pitfalls (one-app DIRECTION.md, "Smooth: the bar") -------------------------------

const block = (/** @type {string} */ css, /** @type {string} */ head) => {
  const at = css.indexOf(head);
  assert.ok(at >= 0, head);
  let depth = 0;
  for (let j = css.indexOf("{", at); j < css.length; j++) { if (css[j] === "{") depth++; else if (css[j] === "}" && --depth === 0) return css.slice(at, j); }
  return "";
};

test("pwa ios: one fixed shell at 100dvh, no page rubber band, no 100vh without a dvh after it", () => {
  const css = phoneCss();
  assert.match(css, /html, body \{ overflow: hidden; \}/);
  assert.match(css, /\.shell \{ position: fixed; inset: 0; height: 100vh; height: 100dvh; overflow: hidden; \}/);
  for (const m of css.matchAll(/100vh;?(.{0,20})/g)) assert.match(m[1], /^ ?height: 100dvh/, "100vh only as the fallback line before 100dvh");
  assert.match(read("css/deck.css"), /html, body \{ overscroll-behavior: none; \}/);
  assert.match(read("css/deck.css"), /\.page \{[^}]*overscroll-behavior-y: contain/);
  assert.match(read("css/sheet.css"), /\.sheet-body \{[^}]*overscroll-behavior: contain/);
  assert.match(read("chat/chat.css"), /\.thread-view \{ overscroll-behavior: contain;/);
});

test("pwa ios: safe areas on the shell (sideways too), the Capsule and sheets; viewport-fit=cover", () => {
  assert.match(read("index.html"), /name="viewport" content="[^"]*viewport-fit=cover/);
  const deck = read("css/deck.css");
  // Outside the phone block, so an installed iPad keeps clear too; a sideways phone is in the phone block.
  assert.match(deck, /^\.shell \{ padding-top: env\(safe-area-inset-top\); padding-left: env\(safe-area-inset-left\); padding-right: env\(safe-area-inset-right\); \}/m);
  assert.match(phoneCss(), /\.capsule \{[^}]*left: calc\(12px \+ env\(safe-area-inset-left\)\); right: calc\(12px \+ env\(safe-area-inset-right\)\)/);
  assert.match(deck, /--cap-bottom: max\(12px, env\(safe-area-inset-bottom\)\)/);
  const sheet = block(read("css/sheet.css"), "@media (max-width: 719px), (max-height: 500px) and (pointer: coarse) {\n  /* Sideways");
  assert.match(sheet, /\.sheet \{ padding-left: env\(safe-area-inset-left, 0px\); padding-right: env\(safe-area-inset-right, 0px\); \}/);
  assert.match(read("css/sheet.css"), /\.sheet \{[^}]*top: calc\(env\(safe-area-inset-top, 0px\) \+ 10px\)/);
  assert.match(read("css/sheet.css"), /\.sheet-actions \{[^}]*env\(safe-area-inset-bottom, 0px\)/);
});

test("pwa ios: taps have no delay, chrome and rows no callout, text selects in messages and code", () => {
  const css = phoneCss();
  assert.match(css, /:where\(a, button, input, select, textarea[^)]*\) \{ touch-action: manipulation; \}/);
  assert.match(css, /:where\(a, button, \.ph-head, \.capsule[^)]*\.np-row, \.thread-row[^)]*\) \{\s*-webkit-touch-callout: none; -webkit-user-select: none; user-select: none; \}/);
  assert.match(css, /:where\(\.cv-text[^)]*pre, code[^)]*\) \{\s*-webkit-touch-callout: default; -webkit-user-select: text; user-select: text; \}/);
  assert.match(read("css/deck.css"), /-webkit-tap-highlight-color: transparent/);
});

test("pwa ios: no field under 16 px on the phone", () => {
  const css = phoneCss();
  assert.match(css, /:where\(input:not\([^{]*textarea, select, \[contenteditable\]:not\(\[contenteditable="false"\]\)\) \{ font-size: 16px !important; \}/);
  assert.match(read("chat/chat.css"), /\.composer textarea \{ font-size: 16px;/);
  // The bigger ones stay bigger, never smaller than 16.
  for (const [, px] of css.matchAll(/\{ font-size: (\d+)px !important; \}/g)) assert.ok(Number(px) >= 16, px);
});

test("pwa ios: the keyboard lifts the composer and a sheet, and the transcript follows", () => {
  assert.match(phoneCss(), /--kb-lift: max\(0px, calc\(var\(--kb\) - env\(safe-area-inset-bottom, 0px\)\)\)/);
  assert.match(phoneCss(), /:root\[data-kb\] \.page:not\(:has\(> \.chat-session\)\) \{ padding-bottom: calc\(var\(--kb\) \+ 16px\); \}/);
  const chat = read("chat/chat.css");
  assert.match(chat, /:root\[data-kb\] \.chat-session > :is\(\.lease-bar, \.composer\) \{ transform: translateY\(calc\(-1 \* var\(--kb-lift\)\)\); \}/);
  assert.match(chat, /:root\[data-kb\] \.chat-session \.thread-view \{ padding-bottom: calc\(24px \+ var\(--kb-lift\)\); \}/);
  assert.match(read("css/sheet.css"), /:root\[data-kb\] \.sheet \{ bottom: var\(--kb\); \}/);
  const session = read("chat/session.js");
  assert.match(session, /window\.addEventListener\("deck:kb", onKb\)/);
  assert.match(session, /if \(following\) toBottom\(\); else if \(pad >= 0\) timeline\.scrollTop \+= p - pad;/);
  assert.match(read("js/pwa.js"), /watchKeyboard\(\);/);
});

test("pwa ios: kbInset is the visual viewport's loss at the bottom, floored at 0", async () => {
  const { kbInset, typesText } = await import("../js/keyboard.js");
  assert.equal(kbInset(844, { height: 844, offsetTop: 0 }), 0);
  assert.equal(kbInset(844, { height: 508, offsetTop: 0 }), 336);
  assert.equal(kbInset(844, { height: 508, offsetTop: 100 }), 236, "iOS panned the page up by 100");
  assert.equal(kbInset(844, { height: 900, offsetTop: 0 }), 0, "never negative");
  assert.equal(kbInset(844, { height: 507.6, offsetTop: 0 }), 336);
  assert.equal(kbInset(844, { height: 422, offsetTop: 0, scale: 2 }), 0, "pinch zoom is not a keyboard");
  assert.equal(kbInset(844, null), 0);
  assert.equal(typesText({ nodeType: 1, tagName: "TEXTAREA" }), true);
  assert.equal(typesText({ nodeType: 1, tagName: "INPUT", type: "search" }), true);
  assert.equal(typesText({ nodeType: 1, tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(typesText({ nodeType: 1, tagName: "DIV", isContentEditable: true }), true);
  assert.equal(typesText({ nodeType: 1, tagName: "BUTTON" }), false);
});

test("pwa ios: the keyboard listener runs only while a field has focus on a phone, one write a frame", async () => {
  const { watchKeyboard } = await import("../js/keyboard.js");
  /** @type {Record<string, Function>} */ const vvOn = {}, docOn = {};
  /** @type {any[]} */ const vvOpts = [], frames = [], events = [];
  const props = new Map(), attrs = new Set();
  let phone = true, scrolled = 0;
  const field = { nodeType: 1, tagName: "TEXTAREA", closest: () => null };
  const vv = { height: 844, offsetTop: 0, scale: 1,
    addEventListener: (/** @type {string} */ t, /** @type {Function} */ f, /** @type {any} */ o) => { vvOn[t] = f; vvOpts.push(o); },
    removeEventListener: (/** @type {string} */ t) => { delete vvOn[t]; } };
  const doc = { activeElement: /** @type {any} */ (null),
    documentElement: { style: { setProperty: (/** @type {string} */ k, /** @type {string} */ v) => props.set(k, v) },
      setAttribute: (/** @type {string} */ k) => attrs.add(k), removeAttribute: (/** @type {string} */ k) => attrs.delete(k) },
    addEventListener: (/** @type {string} */ t, /** @type {Function} */ f, /** @type {any} */ o) => { docOn[t] = f; assert.deepEqual(o, { passive: true }); },
    removeEventListener: () => {} };
  const win = { visualViewport: vv, document: doc, innerHeight: 844, scrollY: 0,
    matchMedia: () => ({ matches: phone }),
    scrollTo: () => { scrolled++; win.scrollY = 0; },
    requestAnimationFrame: (/** @type {Function} */ f) => { frames.push(f); return frames.length; }, cancelAnimationFrame: () => {},
    CustomEvent: class { constructor(/** @type {string} */ type, /** @type {any} */ o) { this.type = type; this.detail = o.detail; } },
    dispatchEvent: (/** @type {any} */ e) => events.push(e) };
  const flush = () => { for (const f of frames.splice(0)) f(); };
  const stop = watchKeyboard(win);
  assert.equal(Object.keys(vvOn).length, 0, "nothing listens before a field has focus");

  // A desktop-wide window: focus attaches nothing.
  phone = false; doc.activeElement = field; docOn.focusin({ target: field });
  assert.equal(Object.keys(vvOn).length, 0);
  phone = true;

  docOn.focusin({ target: field });
  assert.deepEqual(Object.keys(vvOn).sort(), ["resize", "scroll"]);
  for (const o of vvOpts) assert.deepEqual(o, { passive: true });
  flush();
  assert.equal(props.size, 0, "no keyboard yet: nothing written");

  // The keyboard rises: three resizes in one frame are one write, and iOS's pan is taken back.
  vv.height = 600; vvOn.resize(); vv.height = 520; vvOn.resize(); win.scrollY = 120; vv.height = 508; vvOn.scroll();
  assert.equal(frames.length, 1, "coalesced to one frame");
  flush();
  assert.equal(scrolled, 1);
  assert.equal(props.get("--kb"), "336px");
  assert.ok(attrs.has("data-kb"));
  assert.deepEqual(events.map(e => [e.type, e.detail.kb, e.detail.delta]), [["deck:kb", 336, 336]]);

  // Focus leaves and the keyboard goes: back to 0, and the listeners come off.
  doc.activeElement = null; docOn.focusout(); vv.height = 844; vvOn.resize(); flush();
  assert.equal(props.get("--kb"), "0px");
  assert.ok(!attrs.has("data-kb"));
  assert.deepEqual(events.at(-1).detail, { kb: 0, delta: -336 });
  assert.equal(Object.keys(vvOn).length, 0);
  stop();
});

test("pwa ios: long lists and the transcript skip off-screen rows; the newest 40 turns always draw", () => {
  const chat = read("chat/chat.css");
  assert.match(chat, /\.cv-timeline > :nth-last-child\(n\+41\) \{ content-visibility: auto; contain-intrinsic-size: auto 96px; \}/);
  assert.match(chat, /\.rows > \.thread-row \{ content-visibility: auto; contain-intrinsic-size: auto \d+px; \}/);
  assert.match(block(read("css/views/find.css"), "@media (max-width: 719px), (max-height: 500px) and (pointer: coarse) {"), /\.fd-row \{ content-visibility: auto; contain-intrinsic-size: auto \d+px; \}/);
});

test("pwa ios: a row swipe moves only the face's transform, once a frame, promoted only while it moves", () => {
  const src = read("js/now-phone.js"), css = read("css/views/now.css");
  assert.match(src, /if \(!frame\) frame = requestAnimationFrame\(follow\);/);
  assert.match(src, /face\.style\.transform = t;/);
  assert.doesNotMatch(src.slice(src.indexOf("function row("), src.indexOf("return { el, update };")), /style\.(left|marginLeft|width)\b/);
  assert.doesNotMatch(css, /\.np-face \{[^}]*will-change/, "no layer for every row at rest");
  assert.match(css, /\.np-face\.np-drag, \.np-face\.np-spring \{ will-change: transform; \}/);
});

test("pwa: the Deck's worker leaves /app/ to the one app's own worker", () => {
  const sw = read("sw.js");
  assert.match(sw, /if \(url\.pathname === "\/app" \|\| url\.pathname\.startsWith\("\/app\/"\)\) return;/);
  assert.ok(sw.indexOf('startsWith("/app/")') < sw.indexOf("e.respondWith((async"), "checked before the Deck answers from its cache");
});

// ---- a phone turned sideways stays a phone ---------------------------------------------------

/** Every .css file under deck/, vendor code aside. */
function cssFiles(/** @type {string} */ dir = DECK) {
  /** @type {string[]} */ const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "vendor" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...cssFiles(p));
    else if (e.name.endsWith(".css")) out.push(p);
  }
  return out;
}

test("pwa sideways: every CSS phone query also takes a short, wide touch screen, and its complement matches", async () => {
  const { PHONE_QUERY } = await import("../js/dom.js");
  assert.equal(PHONE_QUERY, "(max-width: 719px), (max-height: 500px) and (pointer: coarse)");
  const NOT_PHONE = "(min-width: 720px) and (min-height: 501px), (min-width: 720px) and (pointer: fine), (min-width: 720px) and (pointer: none)";
  let phone = 0;
  for (const f of cssFiles()) {
    const rel = path.relative(DECK, f);
    for (const m of fs.readFileSync(f, "utf8").matchAll(/@media ([^{]*)\{/g)) {
      const q = m[1].trim();
      assert.doesNotMatch(q, /76[01]px/, `${rel}: "@media ${q}" is the old 760 switch point; the phone query is at 719`);
      if (/^\((max-width: 719px|min-width: 720px)\)/.test(q)) {
        assert.ok(q === PHONE_QUERY || q === NOT_PHONE || /, \(hover: none\)$/.test(q), `${rel}: "@media ${q}" is a bare width query; use the phone query`);
        if (q === PHONE_QUERY) phone++;
      }
    }
  }
  assert.ok(phone > 20, "the phone blocks were found");
});

test("pwa sideways: the JS asks the phone question only through dom.js isPhone / PHONE_QUERY", () => {
  const dirs = ["js", "views", "chat", "onboard"];
  let users = 0;
  for (const d of dirs) {
    const walk = (/** @type {string} */ dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "vendor") walk(p); continue; }
        if (!e.name.endsWith(".js") || e.name.endsWith(".test.js")) continue;
        const src = fs.readFileSync(p, "utf8");
        const rel = path.relative(DECK, p);
        if (rel === path.join("js", "dom.js")) continue;
        assert.doesNotMatch(src, /["'`]\(max-width: (719|760)px\)/, `${rel} spells the phone query itself`);
        if (/\b(isPhone|PHONE_QUERY)\b/.test(src)) {
          assert.match(src, /import \{[^}]*\b(isPhone|PHONE_QUERY)\b[^}]*\} from "(\.\/|\.\.\/js\/)dom\.js"/, `${rel} takes the helper from dom.js`);
          users++;
        }
      }
    };
    const root = path.join(DECK, d);
    if (fs.existsSync(root)) walk(root);
  }
  assert.ok(users >= 9, `the phone checks use the helper (${users})`);
  const app = read("js/app.js");
  assert.match(app, /matchMedia\(PHONE_QUERY\)\.addEventListener\("change"/, "the rotation listener uses the same query");
});

test("pwa sideways: isPhone asks matchMedia the one query and is false without matchMedia", async () => {
  const { isPhone, PHONE_QUERY } = await import("../js/dom.js");
  /** @type {string[]} */ const asked = [];
  assert.equal(isPhone({ matchMedia: (/** @type {string} */ q) => { asked.push(q); return { matches: true }; } }), true);
  assert.deepEqual(asked, [PHONE_QUERY]);
  assert.equal(isPhone({}), false);
});

test("pwa: the Reconnecting pill floats under the header and takes no layout space (ADR 0029 R3)", () => {
  const css = read("css/deck.css");
  const rule = /\n\.reach \{([^}]*)\}/.exec(css);
  assert.ok(rule, "the .reach rule");
  assert.match(rule[1], /position: fixed/);
  assert.match(rule[1], /top: calc\(env\(safe-area-inset-top\) \+ 48px \+ 8px\)/);
  assert.match(rule[1], /border-radius: 999px/);
  assert.doesNotMatch(css, /\.reach \{[^}]*position: (relative|static)/, "no rule puts it back in the flow");
});
