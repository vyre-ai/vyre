// @ts-check
// The artifact card, the viewer and the /a/<id> route in the fake DOM, with a fake vyred behind
// fetch. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { onLine: true } });

/** A fake vyred: tools by name (a function of the input, or data, or { $missing } / { $error }); every call recorded. */
function vyred(answers = {}) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    const input = JSON.parse(o.body);
    calls.push({ tool, input });
    const a0 = tool in answers ? answers[tool] : { $missing: true };
    const a = typeof a0 === "function" ? a0(input) : a0;
    if (a && a.$missing) return { status: 404, statusText: "", json: async () => ({ error: { code: "no_such_tool", message: "no such tool" } }) };
    if (a && a.$error) return { status: 409, statusText: "", json: async () => ({ error: { code: "refused", message: a.$error } }) };
    return { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const settle = () => new Promise(r => setTimeout(r, 10));

const { artifactCard, artifactFromEvent, artifactHref, parseArtifactRoute, artifactView, openArtifact, artifactScreen, shareArtifact, TOOLS, renderSrc } = await import("./artifact.js");

const V = { [TOOLS.versions]: { versions: [{ version: 1 }, { version: 2 }] } };
const CONTENT = { 1: "# Referrals\n\n39 in September.", 2: "# Referrals\n\n46 in October." };
const REPORT = { ...V, [TOOLS.get]: (/** @type {any} */ i) => ({ content: CONTENT[i.version], type: "report", title: "Quarterly report" }) };

test("thread.artifact becomes a render payload, and a bare event without an artifact is null", () => {
  const p = artifactFromEvent({ thread: "t1", artifact: "a1", version: 2, kind: "report", title: "Quarterly report" });
  assert.deepEqual(p, { kind: "artifact", id: "a1", thread: "t1", version: 2, type: "report", title: "Quarterly report", agent: null, at: null });
  assert.equal(artifactFromEvent({ thread: "t1" }), null);
  assert.equal(artifactFromEvent(null), null);
});

test("the card shows title, 'kind, version, made by, time', Open and Share", () => {
  const el = artifactCard({ kind: "artifact", id: "a1", title: "Quarterly report", type: "report", version: 2, agent: "juno", at: Date.now() - 2 * 60_000 }, {});
  assert.match(text(el), /Quarterly report/);
  assert.match(text(el), /report · v2 · made by juno · 2 min ago/);
  assert.deepEqual($$(el, "button").map(b => text(b)), ["Open", "Share"]);
  assert.equal($$(el, "button")[0].getAttribute("aria-label"), "Open Quarterly report");
});

test("the card for an event payload uses ctx.agent, and update() redraws in place", () => {
  const el = artifactCard(artifactFromEvent({ thread: "t1", artifact: "a1", version: 1, kind: "page", title: "Northwind menu" }), { agent: "kit" });
  assert.match(text(el), /page · v1 · made by kit/);
  el.update({ kind: "artifact", id: "a1", title: "Northwind menu", type: "page", version: 2, agent: "kit", public_days: 29 });
  assert.match(text(el), /v2/);
  assert.match(text(el), /Public · 29 days/);
});

test("a title that looks like markup stays text", () => {
  const el = artifactCard({ kind: "artifact", id: "a1", title: "<img src=x onerror=alert(1)>", type: "doc" }, {});
  assert.equal($(el, "img"), null);
  assert.match(text(el), /<img src=x/);
});

test("route: /a/<id> with an optional ?v=, the safe id subset only", () => {
  assert.equal(artifactHref("a1"), "/a/a1");
  assert.equal(artifactHref("a1", 3), "/a/a1?v=3");
  assert.equal(artifactHref("a b/c"), "/a/a%20b%2Fc");
  assert.deepEqual(parseArtifactRoute("/a/a1"), { id: "a1", version: null });
  assert.deepEqual(parseArtifactRoute("/a/a1/", "?v=3"), { id: "a1", version: 3 });
  assert.deepEqual(parseArtifactRoute("/a/a1", "?v=0"), { id: "a1", version: null });
  assert.deepEqual(parseArtifactRoute("/a/a1", "?v=x"), { id: "a1", version: null });
  assert.equal(parseArtifactRoute("/a"), null);
  assert.equal(parseArtifactRoute("/a/a1/extra"), null);
  assert.equal(parseArtifactRoute("/chat/a1"), null);
  assert.equal(parseArtifactRoute("/a/..%2Fetc"), null);
  assert.equal(parseArtifactRoute("/a/%E0%A4%A"), null);
  assert.equal(parseArtifactRoute("/a/a..b"), null);
  assert.deepEqual(parseArtifactRoute(artifactHref("draft_7-x.1", 2).split("?")[0], "?v=2"), { id: "draft_7-x.1", version: 2 });
});

test("the viewer lists versions, shows the newest as Markdown, and switches", async () => {
  const box = vyred(REPORT);
  const v = artifactView({ kind: "artifact", id: "a1", title: "Quarterly report", type: "report" }, { phone: false }, { phone: false });
  await settle();
  assert.deepEqual($$(v.bar, ".cv-art-pill").map(p => text(p)), ["v1", "v2"]);
  assert.equal($(v.bar, '[data-v="2"]').getAttribute("aria-checked"), "true");
  assert.match(text(v.el), /46 in October/);
  assert.equal(box.of(TOOLS.versions).length, 1);
  $(v.bar, '[data-v="1"]').click();
  await settle();
  assert.match(text(v.el), /39 in September/);
  assert.equal($(v.bar, '[data-v="1"]').getAttribute("aria-checked"), "true");
  assert.deepEqual(box.of(TOOLS.get).map(c => c.input.version), [2, 1]);
  v.dispose();
});

test("arrow keys move between versions", async () => {
  vyred(REPORT);
  const v = artifactView({ kind: "artifact", id: "a1", type: "report" }, {}, { phone: false });
  await settle();
  const ev = /** @type {any} */ (new Event("keydown")); ev.key = "ArrowLeft";
  $(v.bar, '[data-v="2"]').dispatchEvent(ev);
  await settle();
  assert.equal($(v.bar, '[data-v="1"]').getAttribute("aria-checked"), "true");
  assert.equal(ev.defaultPrevented, true);
});

test("Changes shows a unified diff of this version against the one before", async () => {
  vyred(REPORT);
  const v = artifactView({ kind: "artifact", id: "a1", type: "report" }, {}, { phone: false });
  await settle();
  $(v.bar, ".cv-art-changes").click();
  await settle();
  const t = text(v.el);
  assert.match(t, /46 in October/);
  assert.match(t, /39 in September/);
  assert.ok($(v.el, ".cv-diff"));
  assert.equal($(v.bar, ".cv-art-changes").getAttribute("aria-pressed"), "true");
  assert.equal($(v.bar, ".cv-art-changes").getAttribute("aria-busy"), null);
});

test("Changes on the first version says there is nothing to compare", async () => {
  vyred({ [TOOLS.versions]: { versions: [1] }, [TOOLS.get]: { content: "# Menu", type: "doc" } });
  const v = artifactView({ kind: "artifact", id: "a2", type: "doc" }, {}, { phone: false });
  await settle();
  $(v.bar, ".cv-art-changes").click();
  await settle();
  assert.match(text(v.el), /first version/);
});

test("a page kind is shown in the sandboxed frame at the render route, never as inline markup", async () => {
  vyred({ [TOOLS.versions]: { versions: [1, 2] }, [TOOLS.get]: { content: "<h1>hi</h1><script>alert(1)</script>", type: "page", title: "Northwind menu" } });
  const v = artifactView({ kind: "artifact", id: "a3", type: "page", title: "Northwind menu" }, {}, { phone: false });
  await settle();
  const fr = $(v.el, "iframe");
  assert.equal(fr.getAttribute("sandbox"), "allow-scripts");
  assert.equal(fr.getAttribute("src"), renderSrc("a3", 2));
  assert.equal($(v.el, "script"), null);
  assert.equal($(v.el, "h1"), null);
  // A second load of the frame: it navigated.
  fr.dispatchEvent(new Event("load")); fr.dispatchEvent(new Event("load"));
  assert.equal($(v.el, "iframe"), null);
  assert.match(text(v.el), /This page tried to open another site/);
});

test("the type comes from the tool when the card did not know it (the /a/<id> route)", async () => {
  vyred({ [TOOLS.versions]: { versions: [1] }, [TOOLS.get]: { content: "graph TD; a-->b", type: "diagram" } });
  const s = artifactScreen("a4", null, { phone: false });
  await settle();
  assert.ok($(s, "iframe"));
});

test("a box without the artifacts tools says so in plain words", async () => {
  vyred({});
  const v = artifactView({ kind: "artifact", id: "a1", type: "report" }, {}, { phone: false });
  await settle();
  assert.match(text(v.el), /can't show artifacts yet/);
  assert.ok(!/no_such_tool|\{/.test(text(v.el)));
});

test("a refused read is a plain line, not raw JSON", async () => {
  vyred({ ...V, [TOOLS.get]: { $error: "{\"code\":\"x\"}" } });
  const v = artifactView({ kind: "artifact", id: "a1", type: "report" }, {}, { phone: false });
  await settle();
  assert.match(text(v.el), /That did not go through/);
});

test("Open draws a side panel on a desktop: labelled dialog, title from the tool, Escape closes", async () => {
  vyred(REPORT);
  const host = document.createElement("div");
  const p = openArtifact({ kind: "artifact", id: "a1", title: "Quarterly report", type: "report" }, { phone: false, panelHost: host });
  await settle();
  const panel = $(host, "aside");
  assert.equal(panel.getAttribute("role"), "dialog");
  assert.equal(panel.getAttribute("aria-label"), "Quarterly report");
  assert.match(text(panel), /46 in October/);
  assert.equal($(panel, ".cv-art-panel-head button[aria-pressed]").hidden, true);
  const ev = /** @type {any} */ (new Event("keydown")); ev.key = "Escape";
  panel.dispatchEvent(ev);
  assert.equal($(host, "aside"), null);
  p.close();
});

test("a page or deck panel may be widened", async () => {
  vyred({ [TOOLS.versions]: { versions: [1] }, [TOOLS.get]: { content: "x", type: "deck" } });
  const host = document.createElement("div");
  openArtifact({ kind: "artifact", id: "a5", title: "Harlow deck", type: "deck" }, { phone: false, panelHost: host });
  await settle();
  const w = $(host, ".cv-art-panel-head button[aria-pressed]");
  assert.equal(w.hidden, false);
  w.click();
  assert.ok($(host, "aside").className.includes("cv-art-wide"));
  assert.equal(text(w), "Narrow");
  host.childNodes[0].remove?.();
});

test("only one panel is open at a time", async () => {
  vyred(REPORT);
  const host = document.createElement("div");
  openArtifact({ kind: "artifact", id: "a1", type: "report" }, { phone: false, panelHost: host });
  openArtifact({ kind: "artifact", id: "a2", type: "report" }, { phone: false, panelHost: host });
  assert.equal($$(host, "aside").length, 1);
});

test("on a phone Open is a sheet, with the version bar in the bottom actions", async () => {
  vyred(REPORT);
  const parts = { body: document.createElement("div"), actions: document.createElement("div") };
  let opts, closed = 0;
  openArtifact({ kind: "artifact", id: "a1", title: "Quarterly report", type: "report" }, { phone: true,
    sheet: (/** @type {any} */ o) => { opts = o; o.build(parts.body, () => {}, { head: document.createElement("div"), actions: parts.actions, sheet: document.createElement("div") }); return { close: () => closed++, el: document.createElement("div") }; } });
  await settle();
  assert.equal(opts.title, "Quarterly report");
  assert.ok($(parts.actions, ".cv-art-bar-phone"));
  assert.match(text(parts.body), /46 in October/);
});

test("S in the viewer opens the share sheet", async () => {
  vyred(REPORT);
  const v = artifactView({ kind: "artifact", id: "a1", title: "Quarterly report", type: "report" }, { phone: false, sheet: (/** @type {any} */ o) => { titles.push(o.title); return { close() {}, el: null }; } }, { phone: false });
  const titles = [];
  await settle();
  const ev = /** @type {any} */ (new Event("keydown")); ev.key = "s"; ev.target = v.el;
  v.el.dispatchEvent(ev);
  assert.deepEqual(titles, ["Share Quarterly report"]);
});

test("the share sheet makes a link through artifacts.share and shows a refusal in plain words", async () => {
  const box = vyred({ [TOOLS.share]: { url: "https://share.example/s/abc" } });
  /** @type {any} */ let build;
  shareArtifact({ kind: "artifact", id: "a1", title: "Quarterly report", type: "report", version: 2 }, { sheet: (/** @type {any} */ o) => { build = o.build; return { close() {}, el: null }; } });
  const body = document.createElement("div"), actions = document.createElement("div");
  build(body, () => {}, { actions });
  assert.match(text(body), /scans for keys and passwords/);
  $(actions, "button").click();
  await settle();
  assert.deepEqual(box.of(TOOLS.share)[0].input, { artifact: "a1", version: 2 });
  assert.match(text(body), /share\.example\/s\/abc/);

  vyred({ [TOOLS.share]: { $error: "Not now" } });
  const b2 = document.createElement("div"), a2 = document.createElement("div");
  build(b2, () => {}, { actions: a2 });
  $(a2, "button").click();
  await settle();
  assert.match(text(b2), /Not now/);
});

test("the frame view carries a line outside the frame saying the page is the agent's own, not Vyre", async () => {
  const { artifactView } = await import("./artifact.js");
  globalThis.fetch = /** @type {any} */ (async () => ({ status: 200, statusText: "", json: async () => ({ data: { versions: [{ version: 1, at: 1 }], version: 1, kind: "page", text: "<p>hi</p>" } }) }));
  const v = artifactView({ artifact: "a1", version: 1, kind: "page", title: "Menu", agent: "kit" }, {}, {});
  await new Promise(r => setTimeout(r, 20));
  const { text: t } = await import("../../test/fake-dom.js");
  const line = v.el.querySelector?.(".cv-art-origin");
  assert.ok(line, "the origin line is drawn");
  assert.match(t(line), /Made by kit\. It runs on its own and is not part of Vyre\./);
});

test("a generated image draws inline from the box's own content route, with its provider and prompt read once from artifacts.get", async () => {
  const v = vyred({ [TOOLS.get]: { kind: "image", format: "png", media: { mime: "image/png", bytes: 1234, provider: "grok", model: "grok-imagine", prompt: "a red door at dusk" } } });
  const el = /** @type {any} */ (artifactCard(artifactFromEvent({ thread: "t1", artifact: "m1", version: 1, kind: "image", title: "Red door", mime: "image/png", bytes: 1234 }), { agent: "kit" }));
  await settle();
  const img = $(el, "img");
  assert.equal(img.getAttribute("src"), "/v1/artifacts/content?id=m1");
  assert.equal(img.getAttribute("alt"), "Red door");
  assert.equal($(el, "a[download]").getAttribute("href"), "/v1/artifacts/content?id=m1&download=1");
  assert.match(text(el), /Made by kit · grok, grok-imagine/);
  assert.match(text(el), /Asked for:\s+a red door at dusk/);
  assert.equal(v.of(TOOLS.get).length, 1);
  assert.equal($(el, "iframe"), null, "media never goes in the frame");
});

test("video and audio take controls; a failed load says the item is gone in words; the prompt is text, never markup", async () => {
  vyred({ [TOOLS.get]: { kind: "video", media: { provider: "x", prompt: "<b>hi</b>" } } });
  const vid = /** @type {any} */ (artifactCard({ kind: "artifact", id: "v1", title: "Clip", type: "video" }, {}));
  assert.equal($(vid, "video").getAttribute("controls"), "");
  const aud = /** @type {any} */ (artifactCard({ kind: "artifact", id: "a9", title: "Take", type: "audio" }, {}));
  assert.ok($(aud, "audio"));
  await settle();
  assert.equal($(vid, "b"), null);
  assert.match(text(vid), /<b>hi<\/b>/);
  $(vid, "video").dispatchEvent(new /** @type {any} */ (globalThis).Event("error"));
  assert.match(text(vid), /no longer in the project/);
});

test("Use in…: lists the providers with a signed-in account, and choosing one asks the session (never the card) to switch, copy and tag", async () => {
  const { usableProviders } = await import("./artifact.js");
  assert.deepEqual(usableProviders([{ provider: "claude", accounts: [] }, { provider: "codex", accounts: [{ signed_in: true }] }, { provider: "grok", accounts: [{ signed_in: false }] }, { id: "codex" }]).map(x => x.provider), ["claude", "codex"]);
  const v = vyred({ [TOOLS.get]: { kind: "image", media: {} }, "providers.list": [{ provider: "claude", accounts: [] }, { provider: "codex", accounts: [{ signed_in: true }] }] });
  const el = /** @type {any} */ (artifactCard({ kind: "artifact", id: "m1", title: "Red door", type: "image" }, {}));
  const seen = [];
  el.addEventListener("deck:media-use", e => seen.push(e.detail));
  const use = $$(el, "button").find(b => text(b) === "Use in…");
  use.dispatchEvent(new /** @type {any} */ (globalThis).Event("click")); await settle();
  const items = $$(el, "[role=menuitem]");
  assert.deepEqual(items.map(b => text(b)), ["Claude", "Codex"]);
  items[1].dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
  assert.deepEqual(seen, [{ id: "m1", title: "Red door", provider: "codex", name: "Codex" }]);
  assert.equal(v.of("threads.switch").length + v.of("artifacts.media.copy").length, 0, "the card itself calls neither");
});
