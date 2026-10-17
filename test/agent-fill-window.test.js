// @ts-check
// The Vault fill in the agent's own Chrome: a new tab in the agent's own profile (so the sign-in carries over), the typed values handed to the computer to scrub, fields emptied at the end, the tab closed on failure,
// and no sign-in typed into a form that submits by GET.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentFill } from "../core/vault/agent-fill.js";

const SECRET = "SuperSecretPassw0rd!", USER = "alex@example.com", ORIGIN = "https://app.northwind.test";

const vaultStub = () => ({
  row: () => ({ name: "example-login", kind: "login", url: `${ORIGIN}/login`, hosts: [ORIGIN] }),
  fields: async () => ({ username: USER, password: SECRET }),
  agents: { recordUse: () => {} }, emit: () => {}, clock: () => Date.now(), access: { allowed: async () => true },
});

/** A scripted page. `get` makes the password's form say method=get; `origin` is what location.origin reads. */
function cdpStub({ get = false, origin = ORIGIN } = {}) {
  /** @type {Array<{ method: string, params: any }>} */ const calls = [];
  return {
    calls,
    async connect() {}, async close() {},
    async send(/** @type {string} */ method, /** @type {any} */ params) {
      calls.push({ method, params });
      if (method === "Target.createTarget") return { targetId: "tab-1" };
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      if (method === "Runtime.evaluate" && params && params.returnByValue) return { result: { value: origin } };
      if (method === "Runtime.evaluate") return { result: { objectId: "obj-1" } };
      if (method === "Runtime.callFunctionOn" && /getAttribute\('method'\)/.test(params.functionDeclaration)) return { result: { value: get } };
      return {};
    },
    on() { return () => {}; }, waitFor: async () => ({}),
  };
}
const run = async (/** @type {ReturnType<typeof cdpStub>} */ cdp) => {
  /** @type {any[]} */ const asked = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    asked.push({ tool, input });
    if (tool === "computers.fill.begin") return { data: { fill: "f1", cdpUrl: "http://c/cdp", token: "t".repeat(43) } };
    return { data: { ended: true } };
  };
  const out = await agentFill({ vault: /** @type {any} */ (vaultStub()), call, makeCdp: () => cdp }, { agent: "kit", item: "example-login", origin: ORIGIN }).then(r => ({ r }), e => ({ e }));
  return { ...out, asked };
};
const methods = (/** @type {ReturnType<typeof cdpStub>} */ c) => c.calls.map(x => x.method);

test("the fill signs in in a NEW TAB of the agent's own profile (no private context), hands the values to the computer first, and leaves the tab with its fields emptied", async () => {
  const cdp = cdpStub();
  const { r, e, asked } = await run(cdp);
  assert.equal(e, undefined);
  assert.ok(/** @type {any} */ (r).filled.includes("password"));
  assert.ok(!methods(cdp).includes("Target.createBrowserContext"), "the agent's cookie jar, not an isolated one, so the agent is signed in afterwards");
  assert.deepEqual(cdp.calls.find(c => c.method === "Target.createTarget")?.params, { url: "about:blank" });
  const begin = asked.find(a => a.tool === "computers.fill.begin");
  assert.ok(begin.input.values.includes(SECRET) && begin.input.values.includes(USER), "the exact values are registered for scrubbing before anything is typed");
  assert.ok(!methods(cdp).includes("Target.closeTarget"), "the signed-in tab is left for the agent");
  const clears = cdp.calls.filter(c => c.method === "Runtime.callFunctionOn" && /this\.value = ''/.test(c.params.functionDeclaration));
  assert.ok(clears.length >= 2, "every field typed is emptied");
  assert.ok(cdp.calls.some(c => c.method === "Runtime.evaluate" && /input\[type=password\]/.test(String(c.params.expression)) && /value = ""/.test(String(c.params.expression))), "and every password field");
  assert.ok(!JSON.stringify(asked.filter(a => a.tool === "computers.fill.end")).includes(SECRET));
});

test("a failed fill closes its tab: the wrong origin, and a form that submits by GET, each type nothing", async () => {
  const wrong = cdpStub({ origin: "https://evil.test" });
  const w = await run(wrong);
  assert.match(String(/** @type {any} */ (w.e).message), /not https:\/\/app\.northwind\.test/);
  assert.ok(methods(wrong).includes("Target.closeTarget") && !methods(wrong).includes("Input.insertText"));
  const get = cdpStub({ get: true });
  const g = await run(get);
  assert.equal(/** @type {any} */ (g.e).code, "get_form");
  assert.ok(methods(get).includes("Target.closeTarget"), "the tab is closed");
  assert.equal(methods(get).filter(m => m === "Input.insertText").length, 0, "the password was never typed");
  assert.ok(g.asked.some(a => a.tool === "computers.fill.end"), "the window is ended either way");
  // What the agent can be told. An Error stringifies to {}, so its message and code are read explicitly, for the GET-form failure and the wrong-origin refusal alike; the calls that end the window carry no value;
  // and the computer's own begin call is the only place the values go (it holds them to scrub them: asserted in the first test).
  const told = (/** @type {any} */ x) => JSON.stringify({ message: String(x.e && x.e.message), code: x.e && x.e.code, seen: x.e && x.e.seen, r: x.r });
  assert.ok(!told(g).includes(SECRET) && !told(w).includes(SECRET), "no refusal or error carries a value");
  assert.ok(!JSON.stringify(g.asked.filter(a => a.tool === "computers.fill.end")).includes(SECRET) && !JSON.stringify(w.asked.filter(a => a.tool === "computers.fill.end")).includes(SECRET));
  assert.deepEqual([...new Set(g.asked.filter(a => JSON.stringify(a).includes(SECRET)).map(a => a.tool))], ["computers.fill.begin"], "only the begin call carries the value");
});
