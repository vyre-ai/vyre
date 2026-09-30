// @ts-check
// The invisible password-field guard, run as the page would run it against a small fake DOM, and the
// rings that must not outlive a page.
import test from "node:test";
import assert from "node:assert/strict";
import { passwordFieldScript } from "./extension/shared/guards.js";
import dt from "./extension/caps/devtools.js";
import { makeCtx } from "./devtools-kit.js";

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
  await assert.rejects(() => dt.ops["dev.console.eval"]({ tab: 3, expression: "document.querySelector('input').value" }, k.ctx), /password field/);
});

test("the console ring and script cache go when the page's contexts are cleared", async () => {
  const k = makeCtx({ active: 3 });
  await dt.ops["dev.console.read"]({ tab: 3 }, k.ctx);
  await dt.ops["dev.sources.list"]({ tab: 3 }, k.ctx);
  k.push(3, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "balance is 42" }] });
  k.push(3, "Debugger.scriptParsed", { scriptId: "1", url: "https://bank.example/app.js", length: 10 });
  assert.equal((await dt.ops["dev.console.read"]({ tab: 3 }, k.ctx)).entries.length, 1);
  k.push(3, "Runtime.executionContextsCleared", {});
  assert.equal((await dt.ops["dev.console.read"]({ tab: 3 }, k.ctx)).entries.length, 0);
  assert.equal((await dt.ops["dev.sources.list"]({ tab: 3 }, k.ctx)).scripts?.length ?? 0, 0);
});
