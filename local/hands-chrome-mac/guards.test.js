// @ts-check
// The invisible password-field guard, run as the page would run it against a small fake DOM, and the
// rings that must not outlive a page.
import test from "node:test";
import assert from "node:assert/strict";
import { passwordFieldScript } from "./extension/shared/guards.js";
import dt from "./extension/caps/devtools.js";
import { makeCtx } from "./devtools-kit.js";
import { T } from "./test-support/trust.js";

/** A fake element/root just deep enough for the script. */
function input(/** @type {any} */ o = {}) {
  const attrs = { type: o.type, autocomplete: o.autocomplete, "aria-label": o.label };
  return { tagName: "INPUT", name: o.name || "", id: o.id || "", placeholder: o.placeholder || "", hidden: o.hidden === true, getAttribute: (/** @type {string} */ k) => /** @type {any} */ (attrs)[k] ?? null, getClientRects: () => (o.hidden ? [] : [1]), shadowRoot: null };
}
function root(/** @type {any[]} */ els) {
  return { querySelectorAll: (/** @type {string} */ sel) => (sel === "input" ? els.filter(e => e.tagName === "INPUT") : els) };
}
const run = (/** @type {any} */ doc) => new Function("document", "getComputedStyle", `return ${passwordFieldScript}`)(doc, () => ({ visibility: "visible", display: "block" }));

test("password guard: type=password, a declared password, and a show-password field switched to text all count", () => {
  assert.equal(run(root([input({ type: "password" })])), true);
  assert.equal(run(root([input({ type: "text", autocomplete: "current-password" })])), true);
  assert.equal(run(root([input({ type: "text", name: "user_password" })])), true, "a toggle turned it into text");
  assert.equal(run(root([input({ type: "text", label: "Confirm password" })])), true);
  assert.equal(run(root([input({ type: "text", placeholder: "Passcode" })])), true);
  assert.equal(run(root([input({ type: "email", name: "email" }), input({ type: "text", name: "search" })])), false);
  assert.equal(run(root([input({ type: "password", hidden: true })])), false, "a hidden field is not visible");
});

test("password guard: finds one inside an open shadow root and a same-origin iframe, not in a cross-origin frame", () => {
  const host = { tagName: "DIV", getAttribute: () => null, shadowRoot: root([input({ type: "password" })]) };
  assert.equal(run(root([host])), true);
  const same = { tagName: "IFRAME", getAttribute: () => null, shadowRoot: null, contentDocument: root([input({ type: "password" })]) };
  assert.equal(run(root([same])), true);
  const cross = { tagName: "IFRAME", getAttribute: () => null, shadowRoot: null, get contentDocument() { throw new Error("cross-origin"); } };
  assert.equal(run(root([cross])), false, "unreadable, and a script cannot read it either");
});

test("dev.console.eval refuses on a page with a password field", async () => {
  const k = makeCtx({ active: 3 });
  k.respond["Runtime.evaluate"] = (/** @type {any} */ p) => p.expression === passwordFieldScript ? { result: { value: true } } : { result: { type: "string", value: "leaked" } };
  await assert.rejects(() => T(dt.ops["dev.console.eval"])({ tab: 3, expression: "document.querySelector('input').value" }, k.ctx), /password field/);
});

test("the console ring and script cache go when the page's contexts are cleared", async () => {
  const k = makeCtx({ active: 3 });
  await T(dt.ops["dev.console.read"])({ tab: 3 }, k.ctx);
  await T(dt.ops["dev.sources.list"])({ tab: 3 }, k.ctx);
  k.push(3, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "balance is 42" }] });
  k.push(3, "Debugger.scriptParsed", { scriptId: "1", url: "https://bank.example/app.js", length: 10 });
  assert.equal((await T(dt.ops["dev.console.read"])({ tab: 3 }, k.ctx)).entries.length, 1);
  k.push(3, "Runtime.executionContextsCleared", {});
  assert.equal((await T(dt.ops["dev.console.read"])({ tab: 3 }, k.ctx)).entries.length, 0);
  assert.equal((await T(dt.ops["dev.sources.list"])({ tab: 3 }, k.ctx)).scripts?.length ?? 0, 0);
});

test("password guard fails closed: a page too big to look through, or one that throws, counts as a password page", () => {
  const many = root(Array.from({ length: 5001 }, () => input({ type: "text", name: "q" })));
  assert.equal(run(many), true);
  const broken = { querySelectorAll: () => { throw new Error("boom"); } };
  assert.equal(run(broken), true);
});

// ---- B1: a guarded script cannot send the page's data to a fresh origin (reviewer-2)
const pause = (/** @type {any} */ k, /** @type {string} */ id, /** @type {string} */ url, type = "Fetch") => k.push(3, "Fetch.requestPaused", { requestId: id, request: { url, method: "GET" }, resourceType: type });
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));

function egressRig(/** @type {any} */ script) {
  const k = makeCtx({ active: 3 });
  k.respond["Runtime.evaluate"] = async (/** @type {any} */ p) => {
    const e = String(p.expression || "");
    if (e === passwordFieldScript) return { result: { value: false } };
    if (e.includes("performance.getEntriesByType")) return { result: { value: ["https://services.example.com/v1/contacts", "https://app.example.com/dashboard"] } };
    if (e.includes("vyre-test-script")) { await script(k); await wait(); return { result: { type: "string", value: "done" } }; }
    return { result: { value: [] } };
  };
  return k;
}

test("egress guard: a fetch to a fresh origin carrying localStorage is failed and reported held; the app's own API and its known hosts still work", async () => {
  const k = egressRig(async (/** @type {any} */ kk) => {
    pause(kk, "own", "https://app.example.com/api/me");
    pause(kk, "known", "https://services.example.com/v1/contacts?limit=5");
    pause(kk, "evil", "https://attacker.example/c?d=%7B%22token%22%3A%22abc%22%7D");
    pause(kk, "beacon", "https://collect.attacker.example/b", "Ping");
    pause(kk, "img", "https://img.attacker.example/p.gif", "Image");
    pause(kk, "data", "data:image/gif;base64,R0lGOD");
  });
  const r = await T(dt.ops["dev.console.eval"])({ tab: 3, expression: "/*vyre-test-script*/ 1" }, k.ctx);
  assert.equal(r.held, true, JSON.stringify(r));
  assert.match(r.why, /attacker\.example/);
  assert.ok(!JSON.stringify(r).includes("token"), "the query never comes back");
  const failed = k.calls("Fetch.failRequest").map((/** @type {any} */ c) => c.params.requestId).filter((/** @type {string} */ id) => !id.startsWith("probe")).sort();
  const cont = k.calls("Fetch.continueRequest").map((/** @type {any} */ c) => c.params.requestId).sort();
  assert.deepEqual(failed, ["beacon", "evil", "img"]);
  assert.deepEqual(cont, ["data", "known", "own"]);
  assert.ok(k.calls("Fetch.enable").length >= 1);
  assert.ok(k.calls("Fetch.disable").length >= 1, "Fetch is switched off again when the script ends");
});

test("egress guard: asked lifts it, and a script that reaches only known origins returns its value", async () => {
  const k = egressRig(async (/** @type {any} */ kk) => { pause(kk, "evil", "https://attacker.example/c"); });
  const r = await T(dt.ops["dev.console.eval"])({ tab: 3, expression: "/*vyre-test-script*/ 1", asked: true }, k.ctx);
  assert.equal(r.held, undefined);
  assert.equal(k.calls("Fetch.enable").length, 0, "no guard when the person asked");
  const k2 = egressRig(async (/** @type {any} */ kk) => { pause(kk, "own", "https://app.example.com/api/me"); });
  const r2 = await T(dt.ops["dev.console.eval"])({ tab: 3, expression: "/*vyre-test-script*/ 1" }, k2.ctx);
  assert.equal(r2.ok, true);
  assert.equal(r2.value, "done");
});

test("egress guard: a browser-level rule blocks WebSockets and beacons of the tab for the guard window and is removed after", async () => {
  const k = egressRig(async () => {});
  await T(dt.ops["dev.console.eval"])({ tab: 3, expression: "/*vyre-test-script*/ 1" }, k.ctx);
  const dnr = /** @type {any} */ (k.ctx).dnr;
  assert.equal(dnr.rules.length, 1);
  assert.equal(dnr.rules[0].tab, 3);
  assert.ok(dnr.rules[0].allowHosts.includes("app.example.com") && dnr.rules[0].allowHosts.includes("services.example.com"), "own and known hosts stay allowed");
  assert.deepEqual(dnr.removed, [dnr.rules[0].id], "the rule is removed when the script ends");
  const k2 = egressRig(async () => {});
  await T(dt.ops["dev.console.eval"])({ tab: 3, expression: "/*vyre-test-script*/ 1", asked: true }, k2.ctx);
  assert.equal(/** @type {any} */ (k2.ctx).dnr.rules.length, 0, "no rule when the person asked");
});

test("egress guard: when the browser-level rule cannot be set, the script does NOT run (it is required until the stage proves the other layers hold), and the guard is taken down again", async () => {
  const k = egressRig(async () => {});
  /** @type {any} */ (k.ctx).dnr.fail = true;
  await assert.rejects(T(dt.ops["dev.console.eval"])({ tab: 3, expression: "/*vyre-test-script*/ 1" }, k.ctx), (/** @type {any} */ e) => e.code === "blocked" && /browser-level network rule/.test(e.message));
  assert.equal(k.sent.some((/** @type {any} */ x) => x.params && x.params.expression === "/*vyre-test-script*/ 1"), false, "the script never ran");
  const k2 = egressRig(async () => {});
  assert.equal((await T(dt.ops["dev.console.eval"])({ tab: 3, expression: "/*vyre-test-script*/ 1" }, k2.ctx)).contained, undefined, "no flag when the rule holds");
});

test("egress guard: a frame whose interceptor is not live (the probe never arrives at Fetch.requestPaused) refuses the script, and nothing of it runs", async () => {
  const k = makeCtx({ active: 3, blindProbe: true });
  let ran = false;
  k.respond["Runtime.evaluate"] = async (/** @type {any} */ p) => {
    const e = String(p.expression || "");
    if (e === passwordFieldScript) return { result: { value: false } };
    if (e.includes("performance.getEntriesByType")) return { result: { value: [] } };
    if (e.includes("vyre-test-script")) { ran = true; return { result: { type: "string", value: "done" } }; }
    return { result: { value: [] } };
  };
  await assert.rejects(T(dt.ops["dev.console.eval"])({ tab: 3, expression: "/*vyre-test-script*/ 1" }, k.ctx), /could not be confirmed live/);
  assert.equal(ran, false);
  assert.ok(k.calls("Fetch.disable").length >= 1, "the guard is taken down again");
});

test("ctx.dnr.block: one block rule over every resource type but the main frame, one exact-origin allow rule per origin, all removed by unblock", async () => {
  const { createCtx } = await import("./extension/lib/ctx.js");
  const { createFakeChrome } = await import("./test-support/fake-chrome.js");
  const chrome = createFakeChrome();
  /** @type {any[]} */ let rules = [];
  chrome.declarativeNetRequest = /** @type {any} */ ({
    getSessionRules: async () => rules,
    updateSessionRules: async (/** @type {any} */ o) => { rules = rules.filter(r => !(o.removeRuleIds || []).includes(r.id)).concat(o.addRules || []); },
  });
  const ctx = createCtx({ chrome });
  const b = await ctx.dnr.block({ tab: 7, allowOrigins: ["https://app.example.com", "https://api.example.com:8443", "https://x.example.com/evil path"] });
  assert.equal(b.ok, true);
  const block = rules.find(r => r.action.type === "block");
  assert.ok(block.condition.resourceTypes.includes("image") && block.condition.resourceTypes.includes("websocket") && block.condition.resourceTypes.includes("sub_frame"));
  assert.ok(!block.condition.resourceTypes.includes("main_frame"));
  assert.deepEqual(rules.filter(r => r.action.type === "allow").map(r => r.condition.urlFilter).sort(), ["|https://api.example.com:8443/", "|https://app.example.com/"]);
  assert.ok(rules.every(r => r.condition.tabIds[0] === 7));
  assert.ok(rules.filter(r => r.action.type === "allow").every(r => r.priority > block.priority));
  await ctx.dnr.unblock(b.ids);
  assert.equal(rules.length, 0);
});
