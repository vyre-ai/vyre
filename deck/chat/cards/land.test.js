// @ts-check
// The land cards: the assistant's welcome and each known card's handler. Sample world only.
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
/** A fake vyred: tools by name (a value, or a function of the input), every call recorded. */
function vyred(answers = {}) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    const input = JSON.parse(o.body);
    calls.push({ tool, input });
    let a = tool in answers ? answers[tool] : {};
    if (typeof a === "function") a = a(input);
    if (a && a.$error) return { status: 409, statusText: "", json: async () => ({ error: a.$error }) };
    return { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const settle = () => new Promise(r => setTimeout(r, 10));
const { landCard, welcomeRow, drawable, KNOWN } = await import("./land.js");
const click = (/** @type {any} */ el) => el.dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
const act = (/** @type {any} */ c, /** @type {string} */ a) => $(c, `[data-act=${a}]`);

const welcome = () => ({ text: "Hi Alex. I'm Juno, your assistant.", cards: [
  { id: "claude", title: "Sign in to Claude", body: "The assistant runs on your account." },
  { id: "tailscale", title: "Finish Tailscale sign-in", body: "One step left.", href: "https://login.tailscale.com/a/abc" },
  { id: "history", title: "Bring in your past sessions", body: "Import them." },
  { id: "phone", title: "Add your phone", body: "Pair it once." },
] });

test("drawable: known ids and https links only; a model-written tool or an http link is never drawn", () => {
  const w = { cards: [...welcome().cards,
    { id: "run-anything", title: "Do it", body: "x", action: { tool: "vault.reveal", input: {} } },
    { id: "other", title: "Docs", body: "x", href: "https://example.com" },
    { id: "bad", title: "Bad", body: "x", href: "http://example.com" },
    { id: "javascript", title: "Bad", body: "x", href: "javascript:alert(1)" }] };
  assert.deepEqual(drawable(w).map(c => c.id), ["claude", "tailscale", "history", "phone", "other"]);
  assert.deepEqual(drawable(null), []);
  assert.ok(KNOWN.includes("import"));
});

test("welcomeRow: the words, then a card per open step; an update drops a card that is done", () => {
  vyred();
  const row = welcomeRow(welcome(), {});
  assert.equal(text($(row, ".cv-welcome-text")), "Hi Alex. I'm Juno, your assistant.");
  assert.equal($$(row, ".cv-land").length, 4);
  const left = welcome(); left.cards = left.cards.filter(c => c.id !== "claude");
  row.update({ text: "Hi Alex.", cards: left.cards });
  assert.deepEqual($$(row, ".cv-land").map(c => c.getAttribute("data-card")), ["tailscale", "history", "phone"]);
  row.update({ text: "Everything is set up.", cards: [] });
  assert.equal($(row, ".cv-welcome-cards"), null);
  row.stop();
});

test("claude: Sign in asks onboard.claude for the page, opens it, and Finish sends the pasted code", async () => {
  const v = vyred({ "onboard.claude": i => i.code ? { state: "done", needsCode: false } : { state: "working", url: "https://claude.ai/oauth/x", needsCode: true } });
  const opened = [];
  const c = landCard(welcome().cards[0], { open: h => opened.push(h) });
  click(act(c, "start")); await settle();
  assert.deepEqual(v.of("onboard.claude")[0].input, { mode: "setup-token" });
  click(act(c, "open"));
  assert.deepEqual(opened, ["https://claude.ai/oauth/x"]);
  click(act(c, "finish")); await settle();
  assert.match(text($(c, ".cv-land-problem")), /Paste the code first/);
  $(c, ".cv-land-code").value = "  abc-123 ";
  click(act(c, "finish")); await settle();
  assert.deepEqual(v.of("onboard.claude")[1].input, { mode: "setup-token", code: "abc-123" });
  assert.match(text(c), /Signed in/);
});

test("claude: a page that is not https is never opened", async () => {
  vyred({ "onboard.claude": { state: "working", url: "http://evil.example", needsCode: true } });
  const c = landCard(welcome().cards[0], { open: () => assert.fail("opened") });
  click(act(c, "start")); await settle();
  assert.equal(act(c, "open"), null);
  assert.match(text($(c, ".cv-land-problem")), /did not give a sign-in page/);
});

test("tailscale and phone: the link opens with the card's own https address; the phone card goes to Settings > Devices", () => {
  vyred();
  const opened = [];
  const t = landCard(welcome().cards[1], { open: h => opened.push(h) });
  click(act(t, "link"));
  const p = landCard(welcome().cards[3], { open: h => opened.push(h) });
  click(act(p, "phone"));
  assert.deepEqual(opened, ["https://login.tailscale.com/a/abc", "/settings#devices"]);
  const bad = landCard({ id: "tailscale", title: "x", body: "y", href: "http://nope" }, { open: h => opened.push(h) });
  assert.equal(act(bad, "link").disabled, true);
});

const scan = { sources: [{ id: "s1", path: "/home/alex/.claude/projects", kind: "claude", sessions: 12, bytes: 3_000_000, folders: [
  { cwd: "/home/alex/bakery", name: "bakery", sessions: 9, bytes: 2_500_000, suggested: true },
  { cwd: "/tmp/scratch", name: "scratch", sessions: 3, bytes: 500_000, suggested: false, why: "a temp folder" }] }],
  left_out: { vyre: 2, excluded: 0 }, claude_keeps_days: 30 };

test("history: scan, pick, plan, choose a pace (none preselected), start with what was chosen", async () => {
  const v = vyred({ "import.scan": scan, "import.plan": { plan: "plan_1", sessions: 9, bytes: 2_500_000, folders: ["/home/alex/bakery"], pace: { turns: 120, fast: { hours: 1 }, gentle: { days: 2 } } },
    "import.start": { run: "imp_1", sessions: 9, mode: "once", pace: "gentle" }, "import.status": {} });
  const c = landCard(welcome().cards[2], {});
  click(act(c, "scan")); await settle();
  const boxes = $$(c, "input");
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].checked, true, "a suggested folder starts ticked");
  assert.equal(boxes[1].checked, false, "a temp folder starts unticked");
  assert.match(text(c), /2 sessions from Vyre's own development/);
  click(act(c, "plan")); await settle();
  assert.deepEqual(v.of("import.plan")[0].input, { include: ["/home/alex/bakery"] });
  assert.equal(act(c, "start").disabled, true, "no pace is preselected");
  assert.match(text(c), /about 1 hour/);
  const radios = $$(c, "input").filter(i => i.getAttribute("type") === "radio");
  radios[1].checked = true; radios[1].dispatchEvent(new /** @type {any} */ (globalThis).Event("change"));
  click(act(c, "start")); await settle();
  assert.deepEqual(v.of("import.start")[0].input, { plan: "plan_1", mode: "once", pace: "gentle" });
  assert.match(text(c), /Started/);
});

test("history: an expired plan says so in plain words and goes back to the choice", async () => {
  vyred({ "import.scan": scan, "import.plan": { plan: "p", sessions: 1, bytes: 10, folders: [], pace: {} }, "import.start": { $error: { code: "not_found", message: "expired" } } });
  const c = landCard(welcome().cards[2], {});
  click(act(c, "scan")); await settle(); click(act(c, "plan")); await settle();
  const r = $$(c, "input").filter(i => i.getAttribute("type") === "radio")[0];
  r.checked = true; r.dispatchEvent(new /** @type {any} */ (globalThis).Event("change"));
  click(act(c, "start")); await settle();
  assert.match(text($(c, ".cv-land-problem")), /plan expired/);
  assert.ok(act(c, "back"));
});

test("history: a scan that fails leaves the button, with a plain line", async () => {
  vyred({ "import.scan": { $error: { code: "no_such_tool", message: "no such tool" } } });
  const c = landCard(welcome().cards[2], {});
  click(act(c, "scan")); await settle();
  assert.ok(act(c, "scan"));
  assert.ok($(c, ".cv-land-problem"));
});

test("import: draws each stage from import.status", async () => {
  vyred({ "import.status": { search: { done: 5, total: 5 }, meaning: { done: 2, total: 5 }, graph: { people: 3, orgs: 1, facts: 9, sessions: 5 }, personal: { done: 1, total: 4 }, searchable_sessions: 5,
    upload: { done: 5, total: 5, state: "done", quarantined: 1 } } });
  const c = landCard({ id: "import", title: "Reading your past sessions", body: "5 indexed so far." }, {});
  await settle();
  const stages = $$(c, ".cv-land-stage").map(s => text(s));
  assert.equal(stages.length, 4);
  assert.match(stages[0], /Sending to your server/);
  assert.match(stages[1], /Searchable now.*5 sessions/);
  assert.match(stages[2], /still reading 3 turns/);
  assert.match(stages[3], /3 people · 1 org · 9 facts/);
  c.stop();
});
