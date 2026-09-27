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
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(DECK, f), "utf8");
const exists = (/** @type {string} */ p) => fs.existsSync(path.join(DECK, p === "/" ? "index.html" : p.slice(1)));

test("pwa: every path the service worker keeps at install is a file in deck/", () => {
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

/** The rules inside deck.css's phone block (max-width: 760px), the one that starts the shell. */
function phoneCss() {
  const css = read("css/deck.css");
  const at = css.indexOf("@media (max-width: 760px) {\n  .top { display: none; }");
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
  assert.match(app, /history\.replaceState\(history\.state, "", PAGER\[i\]\.href\)/);
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
  assert.doesNotMatch(app.slice(app.indexOf("function openFind"), app.indexOf("function openSettings")), /requestSubmit|Enter|\.submit\(/);
});

test("pwa shell: light by default: passive gesture listeners, no interval, nothing polls", () => {
  for (const f of ["js/app.js", "js/capsule.js", "js/pwa.js"]) {
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
  assert.match(read("sw.js"), /const CACHE = "vyre-deck-6";/);
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
  assert.match(src, /call\("push\.seen", \{ surface: surfaceId\(\), visible \}, \{ keepalive: !visible \}\)\.catch\(\(\) => \{\}\)/);
  assert.match(src, /SEEN_EVERY = 60_000/);
  assert.match(src, /addEventListener\("pointerdown", touched, \{ passive: true, capture: true \}\)/);
  assert.match(src, /addEventListener\("keydown", touched, \{ passive: true, capture: true \}\)/);
  assert.doesNotMatch(src, /setInterval|setTimeout/);
});
