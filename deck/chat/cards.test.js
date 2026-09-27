// @ts-check
// The question card and the permission card in the fake DOM (deck/test/fake-dom.js), with a fake
// vyred behind fetch and a fake passkey: what each shows, the keys, and exactly what
// threads.answer is called with. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { install, text, $, $$, everything } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  // An svg with a circle in it, which icons.js's mark() colours.
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
  PublicKeyCredential: function PublicKeyCredential() {},
});
const buf = () => new Uint8Array([1, 2, 3]).buffer;
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true,
  value: { credentials: { get: async () => ({ rawId: buf(), response: { authenticatorData: buf(), clientDataJSON: buf(), signature: buf() } }) } } });

/** A fake vyred: the presence challenge, then tools by name; every tool call recorded. */
function vyred(answers = {}) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    if (String(url).includes("/v1/presence/challenge")) return { status: 200, json: async () => ({ data: { challenge: "ch1", webauthn: { challenge: "AAAA", rpId: "localhost" } } }) };
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    const input = JSON.parse(o.body);
    calls.push({ tool, input, presence: !!o.headers["x-vyre-presence"] });
    // An answer may be a function of the input; { $error } is a refusal.
    const a0 = tool in answers ? answers[tool] : { ok: true };
    const a = typeof a0 === "function" ? a0(input, !!o.headers["x-vyre-presence"]) : a0;
    if (a && a.$error) return { status: 409, statusText: "", json: async () => ({ error: a.$error }) };
    return { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const settle = () => new Promise(r => setTimeout(r, 5));
const key = k => /** @type {any} */ ({ key: k });

const fx = JSON.parse(readFileSync(new URL("./fixtures/session-blocks.json", import.meta.url), "utf8"));
const { questionCard } = await import("./question.js");
const { askCard } = await import("./ask-item.js");

test("question card: stepper, number keys, multi-select with space, review, Submit sends the answers", async () => {
  const api = vyred();
  const card = questionCard(structuredClone(fx.asks[0]));
  assert.equal(text($(card, ".cv-ask-kind")), "Question");
  assert.equal(text($(card, ".cv-q-step")), "1 of 2");
  assert.equal(text($(card, ".cv-q-chip")), "Slots", "the header as a meta word, not a caps chip");
  assert.equal(text($(card, ".cv-ask-meta")), "Vyre");
  assert.match(text(card), /1 of 2/);
  assert.match(text(card), /Which pickup slots should the form offer\?/);
  assert.match(text(card), /7:00 to 11:00/);
  assert.ok($(card, ".cv-q-preview"), "options with previews show a preview panel");
  assert.equal(card.onKey(key("1")), true); // picks "Mornings only" and moves on
  assert.match(text(card), /2 of 2/);
  assert.match(text(card), /Who should get the order emails\?/);
  // Multi-select: arrows move, space toggles; Enter moves on only once something is picked.
  card.onKey(key(" "));   // juno
  card.onKey(key("ArrowDown"));
  card.onKey(key(" "));   // kit
  card.onKey(key(" "));   // kit off again
  card.onKey(key(" "));   // kit on
  assert.equal($$(card, ".cv-q-opt[aria-checked=true]").length, 2);
  card.onKey(key("Enter"));
  assert.match(text(card), /Review/);
  assert.match(text(card), /Mornings only/);
  assert.match(text(card), /juno, kit/);
  card.onKey(key("Escape")); // back a step keeps what was picked
  assert.match(text(card), /2 of 2/);
  assert.equal($$(card, ".cv-q-opt[aria-checked=true]").length, 2);
  card.onKey(key("Enter"));
  card.onKey(key("Enter")); // submit from the review
  await settle();
  const [c] = api.of("threads.answer");
  assert.ok(c, "threads.answer was called");
  assert.equal(c.presence, false, "no passkey for an answer (no nagging)");
  assert.deepEqual(c.input, { ask: "ask_q1", decision: "allow", surface: "deck",
    answers: { "Which pickup slots should the form offer?": "Mornings only", "Who should get the order emails?": "juno, kit" } });
  assert.match(text(card), /Answered/);
  assert.equal(card.isOpen(), false);
  assert.equal(card.onKey(key("Enter")), false, "an answered card takes no keys");
});

test("question card: Other takes typed text; Decline sends deny; answered elsewhere folds", async () => {
  const api = vyred();
  const one = { ...structuredClone(fx.asks[0]), id: "ask_q2", questions: [fx.asks[0].questions[0]] };
  const card = questionCard(one);
  assert.doesNotMatch(text(card), /of 1/, "one question: no stepper");
  card.onKey(key("3")); // the Other row
  const input = /** @type {any} */ ($(card, "input.cv-q-input"));
  assert.ok(input, "Other shows a text field");
  input.value = "Saturdays 8 to 12";
  input.dispatchEvent(Object.assign(new Event("input"), { target: input }));
  input.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter", target: input, preventDefault() {} }));
  await settle();
  assert.deepEqual(api.of("threads.answer")[0].input.answers, { "Which pickup slots should the form offer?": "Saturdays 8 to 12" });

  const card2 = questionCard({ ...structuredClone(fx.asks[0]), id: "ask_q3" });
  const decline = $$(card2, "button").find(b => text(b) === "Decline");
  await decline.click();
  await settle();
  assert.deepEqual(api.of("threads.answer")[1].input, { ask: "ask_q3", decision: "deny", surface: "deck" });
  assert.match(text(card2), /Declined/);

  const card3 = questionCard({ ...structuredClone(fx.asks[0]), id: "ask_q4" });
  card3.answered("allow", { "Which pickup slots should the form offer?": "All day" });
  assert.match(text(card3), /Slots/);
  assert.match(text(card3), /All day/);
  assert.match(text(card3), /Answered/);
});

test("question card: the event's questions first, previews filled in by update()", () => {
  const bare = structuredClone(fx.asks[0]);
  for (const q of bare.questions) for (const o of q.options) delete o.preview;
  const card = questionCard(bare);
  assert.equal($(card, ".cv-q-preview"), null);
  card.onKey(key("ArrowDown"));
  card.update(structuredClone(fx.asks[0]));
  assert.ok($(card, ".cv-q-preview"));
  assert.match(text($(card, ".cv-q-preview")), /hours\(7, 18\)/, "the focused option's preview");
});

test("permission card: the full command, why, Allow once / Always / Deny with a reason", async () => {
  const api = vyred();
  const card = askCard(structuredClone(fx.asks[1]));
  assert.match(text(card), /Vyre wants to run a command/);
  assert.match(text(card), /\$ npm run deploy -- --site northwind-bakery/);
  assert.match(text(card), /Deploy the order form fix/);
  assert.match(text(card), /Deploying changes the live site\./);
  assert.ok($$(card, "button").some(b => /Always for this/.test(text(b))));
  assert.equal(card.onKey(key("Escape")), true);
  const why = /** @type {any} */ ($(card, "input.cv-why"));
  assert.ok(why, "Esc opens the reason field");
  why.value = "Not before kit checks the kitchen tablet";
  why.dispatchEvent(Object.assign(new Event("input"), { target: why }));
  why.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter", target: why, preventDefault() {} }));
  await settle();
  assert.deepEqual(api.of("threads.answer")[0].input, { ask: "ask_p1", decision: "deny", surface: "deck", message: "Not before kit checks the kitchen tablet" });
  assert.match(text(card), /Denied/);

  const c2 = askCard({ ...structuredClone(fx.asks[1]), id: "ask_p2" });
  c2.onKey(key("Enter"));
  await settle();
  assert.deepEqual(api.of("threads.answer")[1].input, { ask: "ask_p2", decision: "allow", surface: "deck" });
  assert.match(text(c2), /Allowed once/);

  const c3 = askCard({ ...structuredClone(fx.asks[1]), id: "ask_p3" });
  await $$(c3, "button").find(b => /Always for this/.test(text(b))).click();
  await settle();
  assert.equal(api.of("threads.answer")[2].input.decision, "always");
  assert.match(text(c3), /Always allowed/);
});

test("permission card: no Always unless offered; an Edit shows its diff; the old event shape still draws", () => {
  vyred();
  const edit = askCard({ id: "ask_e", tool: "Edit", kind: "permission", always: false, reason: null,
    detail: { file: "/home/alex/work/northwind-bakery/src/order/OrderForm.js", old: "a\nb", new: "a\nc" } });
  assert.match(text(edit), /Vyre wants to edit OrderForm\.js/);
  assert.equal($$(edit, "button").some(b => /Always/.test(text(b))), false);
  assert.equal($$(edit, ".cv-dl-del").length, 1);
  assert.equal($$(edit, ".cv-dl-add").length, 1);
  const legacy = askCard({ id: "ask_l", tool: "WebFetch", summary: "fetch https://example.com", destination: "https://example.com", reason: null, agent: "juno" });
  assert.match(text(legacy), /juno wants to fetch a page/);
  assert.match(text(legacy), /https:\/\/example\.com/);
  legacy.answered("cancelled");
  assert.match(text(legacy), /Withdrawn/);
  assert.doesNotMatch(everything(edit) + everything(legacy), /claude/i);
});

test("tool cards: the checklist, a short diff and a run open on their own; a read waits for a tap; Bash shows 6 lines", async () => {
  const { toolCard, personAv, agentAv } = await import("./blocks.js");
  const byTool = t => fx.blocks.find(b => b.tool === t);
  const open = el => el.hasAttribute("data-open");
  assert.equal(open(toolCard(byTool("TodoWrite"))), true);
  assert.equal(open(toolCard(byTool("Edit"))), true);
  const long = { ...byTool("Edit"), input: { file_path: "a.js", old_string: "x\n".repeat(20), new_string: "y\n".repeat(20) } };
  assert.equal(open(toolCard(long)), false, "a long diff waits for a tap");
  assert.equal(open(toolCard(byTool("Read"))), false);
  assert.equal(open(toolCard({ ...byTool("Read"), error: true, output: "no such file" })), true, "a failure opens");
  const bash = toolCard(byTool("Bash"));
  assert.equal(open(bash), true);
  assert.equal(text($(bash, ".cv-out")).split("\n").length, 6);
  assert.match(text(bash), /show all \(7 lines\)/);
  assert.equal(text(personAv("you", "alex")), "A");
  assert.ok($(personAv("you", null), ".cv-dot"));
  assert.equal(text(personAv("capsule")), "C");
  assert.ok($(agentAv("Vyre"), "svg"));
  assert.equal(text(agentAv("juno")), "ju");
});

test("permission card: the diff summary, totals first, a row per file on a tap, binary and 'and N more'", async () => {
  vyred();
  const push = askCard({ id: "ask_g", tool: "Bash", kind: "permission", always: false, reason: null,
    detail: { command: "git push origin main",
      changes: [
        { file: "src/intake/estate.ts", added: 96, removed: 41 },
        { file: "src/intake/probate.ts", added: 92, removed: 92 },
        { file: "public/harlow-legal-logo.png", added: null, removed: null, binary: true },
      ],
      totals: { files: 5, added: 188, removed: 133 }, truncated: true } });
  const sum = $(push, ".cv-changes");
  assert.ok(sum, "a push with changes shows the summary");
  const head = $(sum, ".cv-ch-head");
  assert.match(text(head), /Changed files/);
  assert.equal(text($(head, ".cv-ch-add")), "+188");
  assert.equal(text($(head, ".cv-ch-del")), "−133");
  assert.equal($(sum, ".cv-ch-list"), null, "per-file rows wait for a tap");
  assert.equal(head.getAttribute("aria-expanded"), "false");
  await head.click();
  const rows = $$(sum, ".cv-ch-row");
  assert.equal(rows.length, 3);
  assert.match(text(rows[0]), /src\/intake\/estate\.ts/);
  assert.equal(text($(rows[0], ".cv-ch-add")), "+96");
  assert.equal(text($(rows[0], ".cv-ch-del")), "−41");
  assert.match(text(rows[2]), /binary/);
  assert.equal($(rows[2], ".cv-ch-add"), null, "a binary file has no counts");
  assert.equal(text($(sum, ".cv-ch-more")), "and 2 more");
  assert.equal($(push, ".cv-ch-head").getAttribute("aria-expanded"), "true");
  // Open stays open when the card redraws (the Deny field), and the buttons stay below it.
  push.onKey(key("Escape"));
  assert.ok($(push, ".cv-ch-list"), "the rows stay open across a redraw");
  push.onKey(key("Escape"));
  assert.ok($(push, ".gate-actions"));
});

test("permission card: a single-file Edit keeps its inline diff with the summary above the buttons; no changes, no row", () => {
  vyred();
  const edit = askCard({ id: "ask_e2", tool: "Edit", kind: "permission", always: false, reason: null,
    detail: { file: "src/order/OrderForm.js", old: "a\nb", new: "a\nc",
      changes: [{ file: "src/order/OrderForm.js", added: 1, removed: 1 }], totals: { files: 1, added: 1, removed: 1 } } });
  assert.equal($$(edit, ".cv-dl-add").length, 1, "the inline diff stays");
  assert.match(text($(edit, ".cv-ch-head")), /Changed file\b/);
  assert.equal($(edit, ".cv-ch-more"), null);
  const kids = [...edit.children];
  const at = c => kids.findIndex(k => k.classList.contains(c));
  assert.ok(at("cv-changes") > at("cv-ask-what") && at("cv-changes") < at("gate-actions"), "summary between the diff and the buttons");

  const plain = askCard({ id: "ask_n", tool: "Edit", kind: "permission", always: false, reason: null,
    detail: { file: "src/order/OrderForm.js", old: "a", new: "b" } });
  assert.equal($(plain, ".cv-changes"), null);
  const empty = askCard({ id: "ask_n2", tool: "Bash", kind: "permission", always: false, reason: null,
    detail: { command: "git push", changes: [], totals: { files: 0, added: 0, removed: 0 } } });
  assert.equal($(empty, ".cv-changes"), null);
  assert.equal($(askCard({ id: "ask_n3", tool: "Bash", kind: "permission", reason: null }), ".cv-changes"), null, "no detail at all");
});

// ---- the design system's ask and question cards (ask-card.md, question-card.md) ---------------

/** A fake vyred whose threads.answer waits until the test lets it go, to see the busy state. */
function heldVyred() {
  const api = vyred();
  const inner = globalThis.fetch;
  /** @type {(() => void)[]} */
  const waiting = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    if (String(url).includes("threads.answer")) await new Promise(r => waiting.push(() => r(undefined)));
    return inner(url, o);
  });
  return { ...api, release: async () => { for (const go of waiting.splice(0)) go(); await settle(); } };
}
const act = (card, a) => $(card, `button[data-act=${a}]`);

test("permission card: a neutral header with the dot, Permission and who; A allows once, D denies at once", async () => {
  const api = vyred();
  const card = askCard({ ...structuredClone(fx.asks[1]), id: "ask_k1", agent: "kit", at: Date.UTC(2026, 8, 27, 14, 40) });
  assert.equal(card.tagName, "SECTION");
  assert.equal(card.getAttribute("aria-label"), "Permission ask from kit");
  assert.equal(card.getAttribute("tabindex"), "0");
  assert.ok($(card, ".cv-ask-head .cv-ask-dot"));
  assert.equal(text($(card, ".cv-ask-kind")), "Permission");
  assert.match(text($(card, ".cv-ask-meta")), /^kit · \d\d:\d\d$/);
  assert.equal(text($(card, ".ask-title")), "kit wants to run a command");
  // Allow once A (primary), Always (outline, not ghost), Deny D (ghost); the keys as plain text, hidden from readers.
  const allow = act(card, "allow"), always = act(card, "always"), deny = act(card, "deny");
  assert.match(allow.className, /btn-primary/);
  assert.doesNotMatch(always.className, /btn-ghost|btn-primary/, "Always is an outline button");
  assert.match(deny.className, /btn-ghost/);
  assert.equal(allow.getAttribute("aria-keyshortcuts"), "A");
  assert.equal(deny.getAttribute("aria-keyshortcuts"), "D");
  assert.equal(text($(allow, ".cv-ask-key")), "A");
  assert.equal(text($(deny, ".cv-ask-key")), "D");
  assert.equal($(allow, ".cv-ask-key").getAttribute("aria-hidden"), "true");
  assert.equal($(card, ".gate-actions .kbd"), null, "no boxed chip inside a button");
  assert.equal(card.onKey(key("a")), true);
  await settle();
  assert.deepEqual(api.of("threads.answer")[0].input, { ask: "ask_k1", decision: "allow", surface: "deck" });
  assert.match(text(card), /Allowed once/);
  assert.equal($(card, ".cv-ask-dot"), null, "answered: the dot and the violet label leave");
  assert.equal($(card, ".cv-ask-kind"), null);

  const c2 = askCard({ ...structuredClone(fx.asks[1]), id: "ask_k2" });
  assert.equal(c2.onKey(key("D")), true);
  assert.equal($(c2, "input.cv-why"), null, "D denies at once, with no note field");
  await settle();
  assert.deepEqual(api.of("threads.answer")[1].input, { ask: "ask_k2", decision: "deny", surface: "deck" });
  assert.match(text(c2), /Denied/);

  const c3 = askCard({ ...structuredClone(fx.asks[1]), id: "ask_k3" });
  c3.onKey(key("A"));
  await settle();
  assert.equal(api.of("threads.answer")[2].input.decision, "allow", "capital A too");
  const c4 = askCard({ ...structuredClone(fx.asks[1]), id: "ask_k4", always: false, always_project: "Harlow Legal" });
  assert.equal(text(act(c4, "always")), "Always in Harlow Legal");
});

test("permission card: the pressed button goes busy with its own verb; the other two wait", async () => {
  for (const [press, verb, decision] of [["allow", "Allowing", "allow"], ["always", "Saving rule", "always"], ["deny", "Denying", "deny"]]) {
    const api = heldVyred();
    const card = askCard({ ...structuredClone(fx.asks[1]), id: `ask_b_${press}` });
    if (press === "always") act(card, "always").click();
    else card.onKey(key(press === "allow" ? "a" : "d"));
    await settle();
    const b = act(card, press);
    assert.equal(text(b), verb, `${press} says ${verb}`);
    assert.equal(b.getAttribute("aria-busy"), "true");
    assert.ok($(b, ".cv-ask-spin"), "a spinner in place of the label");
    for (const other of ["allow", "always", "deny"].filter(x => x !== press)) {
      assert.equal(act(card, other).disabled, true, `${other} waits`);
      assert.equal(act(card, other).getAttribute("aria-busy"), null);
    }
    assert.equal(card.onKey(key("a")), false, "no second answer while one is on the way");
    await api.release();
    assert.equal(api.of("threads.answer").length, 1);
    assert.equal(api.of("threads.answer")[0].input.decision, decision);
    assert.equal($(card, ".cv-ask-spin"), null);
  }
});

test("permission card: a failed answer gives the buttons back, none busy", async () => {
  vyred({ "threads.answer": { $error: { code: "failed", message: "The box did not answer. Try again." } } });
  const card = askCard({ ...structuredClone(fx.asks[1]), id: "ask_f1" });
  card.onKey(key("a"));
  await settle();
  assert.match(text(card), /did not answer/);
  assert.equal(text(act(card, "allow")), "Allow onceA");
  assert.equal(act(card, "allow").disabled, false);
  assert.equal($(card, "[aria-busy=true]"), null);
});

/** A question with five choices and Other: more rows than a laptop card shows at once. */
const bigQuestion = () => ({ id: "ask_big", kind: "question", agent: "kit", questions: [{ question: "Which intake form should the Estate branch use?", header: "Intake", multiSelect: false,
  options: ["Estate intake v2", "Estate intake v1", "Probate short form", "Harlow Legal general", "Ask alex first"].map((label, n) => ({ label, description: `Choice ${n + 1} for Harlow Legal` })) }] });

test("question card: many choices keep every row and the footer; the number is a key chip on the right", async () => {
  const api = vyred();
  const card = questionCard(bigQuestion());
  const rows = $$(card, ".cv-q-opt");
  assert.equal(rows.length, 6, "five choices and Other");
  rows.forEach((r, n) => {
    const kids = r.children;
    const chip = kids[kids.length - 1];
    assert.ok(chip.classList.contains("kbd") && chip.classList.contains("cv-q-num"), `row ${n + 1} ends in its key chip`);
    assert.equal(text(chip), String(n + 1));
    assert.equal(chip.getAttribute("aria-hidden"), "true");
    assert.equal(r.getAttribute("aria-keyshortcuts"), String(n + 1));
    assert.ok(kids[0].classList.contains("cv-q-mark"), "the mark comes first");
  });
  assert.equal(text(rows[5]), "Other6");
  // The footer sits outside the scrolling body, as the card's own child, after the question.
  const kids = [...card.children];
  const at = c => kids.findIndex(k => k.classList.contains(c));
  assert.ok(at("cv-q-actions") > at("cv-q-q") && at("cv-q-q") > at("cv-ask-head"), "head, question, then the footer");
  assert.equal($(card, ".cv-q-body .cv-q-actions"), null, "the footer is not inside the scroller");
  assert.ok(btn(card, /^Submit/) && btn(card, /^Decline$/));
  assert.equal($(btn(card, /^Submit/), ".cv-ask-key").getAttribute("aria-hidden"), "true");
  assert.equal(btn(card, /^Submit/).disabled, true, "Submit waits for an answer");
  // Description tied to its row, the list named by the question.
  const d = $(rows[0], ".cv-q-desc");
  assert.equal(rows[0].getAttribute("aria-describedby"), d.getAttribute("id"));
  const list = $(card, ".cv-q-opts");
  assert.equal(list.getAttribute("role"), "radiogroup");
  assert.equal(text($(card, `#${list.getAttribute("aria-labelledby")}`)), "Which intake form should the Estate branch use?");
  // Arrow keys reach the last choice; 5 picks the fifth; the footer is still there after each redraw.
  for (let n = 0; n < 5; n++) card.onKey(key("ArrowDown"));
  assert.ok($$(card, ".cv-q-opt")[5].classList.contains("cv-focus"));
  assert.ok($(card, ".cv-q-actions"));
  card.onKey(key("5"));
  await settle();
  assert.deepEqual(api.of("threads.answer")[0].input.answers, { "Which intake form should the Estate branch use?": "Ask alex first" });
});

test("question card: Submit goes busy as Sending and keeps the footer; a checked box is ink", async () => {
  const api = heldVyred();
  const card = questionCard({ ...bigQuestion(), id: "ask_big2" });
  card.onKey(key("2"));
  await settle();
  const b = $(card, "button[data-act=submit]");
  assert.equal(text(b), "Sending");
  assert.equal(b.getAttribute("aria-busy"), "true");
  assert.ok($(b, ".cv-ask-spin"));
  assert.equal($(card, "button[data-act=decline]").disabled, true);
  await api.release();
  assert.match(text(card), /Answered/);
  assert.equal($(card, ".cv-ask-dot"), null);

  vyred();
  const multi = questionCard({ ...structuredClone(fx.asks[0]), id: "ask_m", questions: [fx.asks[0].questions[1]] });
  multi.onKey(key(" "));
  assert.ok($(multi, ".cv-q-box.cv-chk-on"));
  assert.equal($(multi, ".cv-q-opts").getAttribute("role"), "group");
});

// ---- a Mac session's ask, answered from here (federation v2) -----------------------------------------

const MACHINE = "alex's MacBook Pro";
const macAsk = (id) => ({ ...structuredClone(fx.asks[1]), id, machine: MACHINE, node: "nMacStable1" });
const btn = (card, re) => $$(card, "button").find(b => re.test(text(b)));

test("Mac ask: the usual buttons, 'on <mac>', and threads.answer carries the machine", async () => {
  const api = vyred({ "threads.answer": { ask: "ask_m1", answered: true, source: "mac", machine: MACHINE } });
  const card = askCard(macAsk("ask_m1"));
  assert.match(text(card), /on alex's MacBook Pro/);
  assert.doesNotMatch(text(card), /Answer it on/);
  assert.ok(btn(card, /Allow once/) && btn(card, /Deny/));
  assert.equal(card.isOpen(), true);
  card.onKey(key("Enter"));
  await settle();
  assert.deepEqual(api.of("threads.answer")[0].input, { ask: "ask_m1", decision: "allow", surface: "deck", machine: MACHINE });
  assert.equal(api.of("threads.answer")[0].presence, false);
  assert.match(text(card), /Allowed once/);

  const q = questionCard({ ...structuredClone(fx.asks[0]), id: "ask_m2", questions: [fx.asks[0].questions[0]], machine: MACHINE, node: "nMacStable1" });
  assert.match(text(q), /on alex's MacBook Pro/);
  await btn(q, /^Decline$/).click();
  await settle();
  assert.deepEqual(api.of("threads.answer")[1].input, { ask: "ask_m2", decision: "deny", surface: "deck", machine: MACHINE });
});

test("Mac ask refused: person_session_required sends the person to the box's sign-in page, then Try again (no proof on the answer)", async () => {
  let signedIn = false;
  const api = vyred({ "threads.answer": () => signedIn ? { answered: true, source: "mac", machine: MACHINE }
    : { $error: { code: "person_session_required", message: "answering a Mac's ask is the person's own action: sign in on this device with your passkey first" } } });
  const card = askCard(macAsk("ask_m3"));
  card.onKey(key("Enter"));
  await settle();
  assert.match(text(card), /Sign this browser in to answer asks on alex's MacBook Pro/);
  const a = /** @type {any} */ ($(card, "a.cv-person-signin"));
  assert.equal(a.getAttribute("href"), "/person/signin", "e2e's sign-in page on the box");
  assert.equal(a.getAttribute("target"), "_blank");
  assert.equal(card.isOpen(), true, "the card stays open");
  signedIn = true;
  await btn(card, /Try again/).click();
  await settle();
  const [first, again] = api.of("threads.answer");
  assert.equal(first.presence, false);
  assert.equal(again.presence, false, "a passkey proof on the answer is not a sign-in");
  assert.deepEqual(again.input, first.input);
  assert.match(text(card), /Allowed once/);
});

test("Mac ask refused: presence_required asks for a passkey or Touch ID and keeps the decision and reason", async () => {
  const api = vyred({ "threads.answer": (_i, proved) => proved ? { answered: true }
    : { $error: { code: "presence_required", message: "this ask approves a protected action: prove you are here (passkey or Touch ID) to answer it" } } });
  const card = askCard(macAsk("ask_m4"));
  card.onKey(key("Escape"));
  const why = /** @type {any} */ ($(card, "input.cv-why"));
  why.value = "Not to kit yet";
  why.dispatchEvent(Object.assign(new Event("input"), { target: why }));
  why.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter", target: why, preventDefault() {} }));
  await settle();
  assert.match(text(card), /Prove it is you first/);
  assert.doesNotMatch(text(card), /Denied/);
  await btn(card, /Use passkey or Touch ID/).click();
  await settle();
  const again = api.of("threads.answer")[1];
  assert.equal(again.presence, true);
  assert.deepEqual(again.input, { ask: "ask_m4", decision: "deny", surface: "deck", message: "Not to kit yet", machine: MACHINE });
  assert.match(text(card), /Denied/);
});

test("Mac ask refused: mac_offline and timeout say so with Try again; the card stays open", async () => {
  const errs = [
    { $error: { code: "mac_offline", message: "alex's MacBook Pro is offline; your answer was not sent" } },
    { $error: { code: "timeout", message: "alex's MacBook Pro did not answer in time; your answer may not have reached it" } },
    { answered: true },
  ];
  const api = vyred({ "threads.answer": () => errs.shift() });
  const q = questionCard({ ...structuredClone(fx.asks[0]), id: "ask_m5", questions: [fx.asks[0].questions[0]], machine: MACHINE, node: "nMacStable1" });
  q.onKey(key("1"));
  await settle();
  assert.match(text(q), /alex's MacBook Pro is offline; your answer was not sent/);
  assert.equal(q.isOpen(), true);
  assert.ok(btn(q, /^Submit/), "the buttons stay");
  await btn(q, /^Try again$/).click();
  await settle();
  assert.match(text(q), /did not answer in time; your answer may not have reached it/);
  assert.equal(q.isOpen(), true);
  await btn(q, /^Try again$/).click();
  await settle();
  assert.equal(api.of("threads.answer").length, 3);
  assert.ok(api.of("threads.answer").every(c => c.input.machine === MACHINE && c.presence === false));
  assert.match(text(q), /Answered/);
});

test("Mac refusals, by code: which step each needs; only an unknown tool, bad input or unsupported means the box cannot forward", async () => {
  const { macRefusal } = await import("./presence.js");
  assert.equal(macRefusal({ code: "person_session_required" }), "sign_in");
  assert.equal(macRefusal({ code: "presence_required" }), "presence");
  assert.equal(macRefusal({ code: "mac_offline" }), "retry");
  assert.equal(macRefusal({ code: "timeout" }), "retry");
  assert.equal(macRefusal({ code: "no_such_tool" }), "held");
  assert.equal(macRefusal({ code: "bad_input" }), "held");
  assert.equal(macRefusal({ code: "unsupported" }), "held");
  assert.equal(macRefusal({ code: "failed", message: "no ask ask_m9" }, {}), null, "a relayed ask already means the box forwards: its words, not the fallback");
  assert.equal(macRefusal({ code: "failed", message: "no ask ask_m9" }, { node: "nMacStable1" }), null);
  assert.equal(macRefusal({ code: "denied", message: "pair again" }, { node: "nMacStable1" }), null);
});

// ---- the rewind sheet: what it restores ------------------------------------------------------

test("the rewind sheet: Claude Code's three restores, code off on a box that restores the conversation only", async () => {
  const { rewindSheet } = await import("./pickers.js");
  /** @type {any[]} */
  const chose = [];
  let codeOk = /** @type {boolean|null} */ (false);
  const sheet = rewindSheet({ points: [{ uuid: "u2", text: "Rebuild the Estate intake", at: null }, { uuid: "u1", text: "Read the intake folder", at: null }],
    can: () => true, codeOk: () => codeOk, onChoose: async (p, r) => { chose.push([p.uuid, r]); return null; }, onClose: () => {} });
  const opts = () => $$(sheet.el, ".cv-rw-opt");
  assert.deepEqual(opts().map(b => text(b)), ["Restore code and conversation", "Restore conversation", "Restore code"]);
  assert.deepEqual(opts().map(b => b.disabled), [true, false, true], "an older box: the conversation only");
  assert.equal(opts()[0].getAttribute("title"), "Needs the sessions update");
  assert.equal(sheet.restore(), "conversation");
  sheet.key(/** @type {any} */ ({ key: "ArrowRight" }));
  assert.equal(sheet.restore(), "conversation", "arrows skip what is off");
  codeOk = true;
  sheet.refresh();
  assert.equal(sheet.restore(), "both", "the default once the box can put files back");
  sheet.key(/** @type {any} */ ({ key: "ArrowDown" }));
  sheet.key(/** @type {any} */ ({ key: "ArrowRight" }));
  assert.equal(text($(sheet.el, ".cv-rw-opt[aria-checked=true]")), "Restore conversation");
  sheet.key(/** @type {any} */ ({ key: "ArrowRight" }));
  assert.equal(text($(sheet.el, ".cv-rw-go")).replace("⏎", "").trim(), "Restore here");
  sheet.key(/** @type {any} */ ({ key: "Enter" }));
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(chose, [["u1", "code"]]);
});
