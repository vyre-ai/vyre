// @ts-check
// devtools (dev.*): DOM inspect, sources, console, state, lazy domains, floor, redaction. A fake
// cdp answers with canned CDP results; nothing here starts Chrome.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import dev from "./extension/caps/devtools.js";
import { makeCtx } from "./devtools-kit.js";
import { T } from "./test-support/trust.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGV4In0.c2lnbmF0dXJlMTIzNDU";
const dom = () => ({
  "DOM.getDocument": { root: { nodeId: 1 } },
  "DOM.querySelector": { nodeId: 7 },
  "DOM.getOuterHTML": { outerHTML: `<form id="f"><input name="csrf_token" type="hidden" value="abcdefSECRETVALUE1"><input type="password" value="hunter2hunter2"><p>${JWT}</p></form>` },
  "DOM.getAttributes": { attributes: ["id", "f", "data-token", "AKIA" + "ABCDEFGHIJKLMNOP", "class", "x"] },
  "DOM.getBoxModel": { model: { width: 10, height: 20 } },
  "CSS.getComputedStyleForNode": { computedStyle: [{ name: "display", value: "block" }, { name: "animation-name", value: "none" }] },
  "CSS.getMatchedStylesForNode": { matchedCSSRules: [{ rule: { selectorList: { text: ".x" }, origin: "regular", style: { cssProperties: [{ name: "color", value: "red" }] } } }] },
  "DOM.resolveNode": { object: { objectId: "o1" } },
  "DOMDebugger.getEventListeners": { listeners: [{ type: "click", useCapture: false, passive: false, once: false, scriptId: "9", lineNumber: 3, columnNumber: 1 }] },
});
const ser = x => JSON.stringify(x);

test("dev.inspect returns html, attributes, box, style subset, rules, listeners, redacted", async () => {
  const k = makeCtx({ respond: dom() });
  const r = await T(dev.ops["dev.inspect"])({ selector: "#f" }, k.ctx);
  assert.equal(r.attributes.id, "f");
  assert.equal(r.boxModel.width, 10);
  assert.deepEqual(r.computedStyle, { display: "block" });
  assert.equal(r.matchedRules[0].selector, ".x");
  assert.equal(r.listeners[0].type, "click");
  const s = ser(r);
  for (const raw of [JWT, "abcdefSECRETVALUE1", "hunter2hunter2"]) assert.ok(!s.includes(raw), raw);
  assert.ok(k.attachedSet.has(1), "attached lazily");
  assert.ok(k.calls("DOM.enable").length === 1);
  await T(dev.ops["dev.inspect"])({ selector: "#f", styles: "all" }, k.ctx);
  assert.equal(k.calls("DOM.enable").length, 1, "domains enabled once per tab");
});

test("dev.inspect bounds outerHTML at 20 kB and accepts nodeId and backendNodeId", async () => {
  const d = dom();
  d["DOM.getOuterHTML"] = { outerHTML: "<p>" + "a ".repeat(60_000) + "</p>" };
  d["DOM.pushNodesByBackendIdsToFrontend"] = { nodeIds: [9] };
  const k = makeCtx({ respond: d });
  const r = await T(dev.ops["dev.inspect"])({ backendNodeId: 5 }, k.ctx);
  assert.equal(r.truncated, true);
  assert.ok(r.outerHTML.length <= 20_000);
  assert.equal(k.calls("DOM.getOuterHTML")[0].params.nodeId, 9);
  await T(dev.ops["dev.inspect"])({ nodeId: 3 }, k.ctx);
  assert.equal(k.calls("DOM.getOuterHTML")[1].params.nodeId, 3);
  await assert.rejects(T(dev.ops["dev.inspect"])({}, k.ctx), e => e.code === "bad_request");
});

test("dev.inspect: no match is not_found", async () => {
  const d = dom();
  d["DOM.querySelector"] = { nodeId: 0 };
  await assert.rejects(T(dev.ops["dev.inspect"])({ selector: "#nope" }, makeCtx({ respond: d }).ctx), e => e.code === "not_found");
});

test("floor refusal blocks every dev op and enables nothing", async () => {
  const k = makeCtx({ respond: dom(), floor: () => ({ allow: false, why: "blind origin" }) });
  for (const op of ["dev.inspect", "dev.sources.list", "dev.sources.get", "dev.sources.search", "dev.console.read", "dev.console.eval", "dev.state"])
    await assert.rejects(dev.ops[op]({ selector: "x", expression: "1", query: "q", scriptId: "1" }, k.ctx), e => e.code === "blocked" && /blind/.test(e.message), op);
  assert.equal(k.sent.length, 0);
});

test("dev.console.eval is refused while stop is in force", async () => {
  const k = makeCtx({ stopped: () => true });
  await assert.rejects(T(dev.ops["dev.console.eval"])({ expression: "1+1" }, k.ctx), e => e.code === "stopped");
});

test("omitted tab uses the active tab", async () => {
  const k = makeCtx({ active: 42, respond: dom() });
  await T(dev.ops["dev.inspect"])({ selector: "a" }, k.ctx);
  assert.ok(k.sent.every(s => s.tab === 42));
});

const script = (k, id, url, extra = {}) => k.push(1, "Debugger.scriptParsed", { scriptId: id, url, length: 1234, ...extra });

test("sources: list from scriptParsed ring, filter, redaction, source map name only", async () => {
  const k = makeCtx();
  await T(dev.ops["dev.sources.list"])({}, k.ctx);
  script(k, "1", "https://bakery.example/app.js", { sourceMapURL: "https://bakery.example/maps/app.js.map?sig=abcdef" });
  script(k, "2", "https://bakery.example/vendor.js?access_token=verysecretvalue123");
  script(k, "3", "https://cdn.example/lib.js");
  const all = await T(dev.ops["dev.sources.list"])({}, k.ctx);
  assert.equal(all.count, 3);
  assert.ok(!ser(all).includes("verysecretvalue123"));
  assert.equal(all.scripts[0].sourceMap, "app.js.map");
  const f = await T(dev.ops["dev.sources.list"])({ filter: "cdn.example" }, k.ctx);
  assert.deepEqual(f.scripts.map(s => s.scriptId), ["3"]);
});

test("sources: ring is bounded and evicts the oldest", async () => {
  const k = makeCtx();
  await T(dev.ops["dev.sources.list"])({}, k.ctx);
  for (let i = 0; i < 3100; i++) script(k, String(i), `https://x.example/${i}.js`);
  const r = await T(dev.ops["dev.sources.list"])({ limit: 1000 }, k.ctx);
  assert.equal(r.total, 3000);
  await assert.rejects(T(dev.ops["dev.sources.get"])({ scriptId: "5" }, k.ctx), e => e.code === "not_found");
});

test("sources.get redacts, ranges by line, bounds at 200 kB", async () => {
  const src = `var a=1;\nvar k="${JWT}";\nvar c=3;`;
  const k = makeCtx({ respond: { "Debugger.getScriptSource": { scriptSource: src } } });
  await T(dev.ops["dev.sources.list"])({}, k.ctx);
  script(k, "1", "https://bakery.example/app.js");
  const r = await T(dev.ops["dev.sources.get"])({ scriptId: "1" }, k.ctx);
  assert.ok(!ser(r).includes(JWT));
  assert.equal(r.truncated, false);
  const ranged = await T(dev.ops["dev.sources.get"])({ url: "https://bakery.example/app.js", range: { startLine: 3, endLine: 3 } }, k.ctx);
  assert.equal(ranged.source, "var c=3;");
  k.respond["Debugger.getScriptSource"] = { scriptSource: "x ".repeat(300_000) };
  const big = await T(dev.ops["dev.sources.get"])({ scriptId: "1" }, k.ctx);
  assert.equal(big.truncated, true);
  assert.ok(big.source.length <= 200_000);
});

test("sources.search runs Debugger.searchInContent across scripts and redacts hits", async () => {
  const k = makeCtx({ respond: { "Debugger.searchInContent": (p) => ({ result: p.scriptId === "1" ? [{ lineNumber: 4, lineContent: `fetch("/api/orders", {headers:{a:"${JWT}"}})` }] : [] }) } });
  await T(dev.ops["dev.sources.list"])({}, k.ctx);
  script(k, "1", "https://bakery.example/app.js");
  script(k, "2", "https://bakery.example/other.js");
  const r = await T(dev.ops["dev.sources.search"])({ query: "/api/orders", regex: true }, k.ctx);
  assert.equal(r.count, 1);
  assert.equal(r.matches[0].line, 4);
  assert.ok(!ser(r).includes(JWT));
  assert.equal(k.calls("Debugger.searchInContent")[0].params.isRegex, true);
  await assert.rejects(T(dev.ops["dev.sources.search"])({}, k.ctx), e => e.code === "bad_request");
});

test("console: ordering, since, level, limit, and redaction of args and text", async () => {
  const k = makeCtx();
  await T(dev.ops["dev.console.read"])({}, k.ctx);
  k.push(1, "Runtime.consoleAPICalled", { type: "log", timestamp: 1, args: [{ type: "string", value: "hello" }, { type: "object", preview: { properties: [{ name: "password", type: "string", value: "hunter2hunter2" }, { name: "n", type: "number", value: "3" }] } }] });
  k.push(1, "Runtime.consoleAPICalled", { type: "warning", args: [{ type: "string", value: `token ${JWT}` }] });
  k.push(1, "Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: x is not a function" }, url: "https://bakery.example/app.js?sid=abcdefgh1234", lineNumber: 9 } });
  k.push(1, "Log.entryAdded", { entry: { level: "verbose", source: "network", text: "GET failed" } });
  const all = await T(dev.ops["dev.console.read"])({}, k.ctx);
  assert.deepEqual(all.entries.map(e => e.level), ["log", "warn", "error", "debug"]);
  assert.deepEqual(all.entries.map(e => e.seq), [1, 2, 3, 4]);
  const s = ser(all);
  assert.ok(!s.includes("hunter2hunter2") && !s.includes(JWT) && !s.includes("abcdefgh1234"));
  assert.ok(s.includes("hello"));
  const since = await T(dev.ops["dev.console.read"])({ since: 2 }, k.ctx);
  assert.deepEqual(since.entries.map(e => e.seq), [3, 4]);
  const errs = await T(dev.ops["dev.console.read"])({ level: "error" }, k.ctx);
  assert.equal(errs.entries.length, 1);
  const lim = await T(dev.ops["dev.console.read"])({ limit: 2 }, k.ctx);
  assert.deepEqual(lim.entries.map(e => e.seq), [3, 4]);
});

test("console ring holds 1000 entries", async () => {
  const k = makeCtx();
  await T(dev.ops["dev.console.read"])({}, k.ctx);
  for (let i = 0; i < 1100; i++) k.push(1, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "number", value: i }] });
  const r = await T(dev.ops["dev.console.read"])({ limit: 5000 }, k.ctx);
  assert.equal(r.count, 1000);
  assert.equal(r.entries[0].seq, 101);
});

test("console.eval redacts results and reports exceptions", async () => {
  const k = makeCtx({ respond: { "Runtime.evaluate": { result: { type: "object", value: { user: "alex", password: "hunter2hunter2", note: JWT } } } } });
  const r = await T(dev.ops["dev.console.eval"])({ expression: "window.me" }, k.ctx);
  assert.ok(!ser(r).includes("hunter2hunter2") && !ser(r).includes(JWT));
  assert.equal(r.value.user, "alex");
  k.respond["Runtime.evaluate"] = { exceptionDetails: { text: "x", exception: { description: `ReferenceError leaked ${JWT}` } } };
  const e = await T(dev.ops["dev.console.eval"])({ expression: "nope" }, k.ctx);
  assert.equal(e.ok, false);
  assert.ok(!ser(e).includes(JWT));
});

test("dev.state: cookie names and flags, storage names, no values anywhere", async () => {
  const k = makeCtx({ respond: {
    "Network.getCookies": { cookies: [{ name: "sid", value: "SESSIONVALUE12345", domain: "bakery.example", path: "/", secure: true, httpOnly: true, session: true }] },
    "Runtime.evaluate": { result: { value: { origin: "https://bakery.example", local: { theme: "dark", auth: JWT }, session: { cart: "SECRETCARTSTUFF" } } } },
  } });
  const r = await T(dev.ops["dev.state"])({}, k.ctx);
  assert.equal(r.cookies[0].name, "sid");
  assert.equal(r.cookies[0].httpOnly, true);
  assert.deepEqual(Object.keys(r.localStorage), ["theme", "auth"]);
  const s = ser(r);
  for (const raw of ["SESSIONVALUE12345", JWT, "SECRETCARTSTUFF", "dark"]) assert.ok(!s.includes(raw), raw);
});

test("domains switch off after 5 minutes without a reader, and on again when needed", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const k = makeCtx();
    await T(dev.ops["dev.console.read"])({}, k.ctx);
    await T(dev.ops["dev.sources.list"])({}, k.ctx);
    mock.timers.tick(4 * 60_000);
    await T(dev.ops["dev.console.read"])({}, k.ctx);
    mock.timers.tick(4 * 60_000);
    assert.equal(k.calls("Runtime.disable").length, 0, "a read restarts the clock");
    mock.timers.tick(61_000);
    await new Promise(r => setImmediate(r));
    assert.equal(k.calls("Runtime.disable").length, 1);
    assert.equal(k.calls("Debugger.disable").length, 1);
    await T(dev.ops["dev.console.read"])({}, k.ctx);
    assert.equal(k.calls("Runtime.enable").length, 2);
  } finally { mock.timers.reset(); }
});

test("tab close or detach forgets rings", async () => {
  const k = makeCtx();
  await T(dev.ops["dev.console.read"])({}, k.ctx);
  k.push(1, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "x" }] });
  dev.onEvent({ event: "tabs.removed", tab: 1 }, k.ctx);
  const r = await T(dev.ops["dev.console.read"])({}, k.ctx);
  assert.equal(r.count, 0);
  k.push(1, "Inspector.detached", {});
  const r2 = await T(dev.ops["dev.console.read"])({}, k.ctx);
  assert.equal(r2.count, 0);
});

const FB_ACCESS = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYzEyMyJ9.eyJ1c2VyX2lkIjoiYWJjMTIzIiwiZW1haWwiOiJhQGIuY29tIn0.c2lnbmF0dXJlZmlyZWJhc2V0b2tlbg";
const FB_REFRESH = "AMf-vBxQ7k2Zr9Lp0sT3uVwXyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2xY3z";

test("console.eval: Firebase access and refresh tokens are masked whatever they are returned under", async () => {
  const k = makeCtx({ respond: { "Runtime.evaluate": { result: { type: "object", value: { a: FB_ACCESS, nested: { stsTokenManager: { accessToken: FB_ACCESS, refreshToken: FB_REFRESH } }, list: [FB_REFRESH], line: `token-id: ${FB_ACCESS}` } } } } });
  const r = await T(dev.ops["dev.console.eval"])({ expression: "window.state" }, k.ctx);
  for (const raw of [FB_ACCESS, FB_REFRESH]) assert.ok(!ser(r).includes(raw), raw.slice(0, 12));
  const k2 = makeCtx({ respond: { "Runtime.evaluate": { result: { type: "string", value: `${FB_ACCESS} and ${FB_REFRESH}` } } } });
  const r2 = await T(dev.ops["dev.console.eval"])({ expression: "window.t" }, k2.ctx);
  assert.ok(!ser(r2).includes(FB_ACCESS) && !ser(r2).includes(FB_REFRESH));
});

test("console.eval: a script that opens the page's stored login is refused and points to api.call", async () => {
  const k = makeCtx({ respond: { "Runtime.evaluate": { result: { type: "string", value: "x" } } } });
  for (const expression of [
    "indexedDB.open('firebaseLocalStorageDb')",
    "(async()=>{const u=x.value.stsTokenManager.accessToken})()",
    "localStorage.getItem('access_token')",
    "document.cookie",
  ]) {
    await assert.rejects(T(dev.ops["dev.console.eval"])({ expression }, k.ctx), (/** @type {any} */ e) => e.code === "blocked" && /api\.call|chrome_api/.test(String(e.message)), expression);
  }
  assert.equal(k.calls("Runtime.evaluate").filter(s => String(s.params.expression).includes("firebaseLocalStorageDb")).length, 0, "nothing ran");
  const ok = await T(dev.ops["dev.console.eval"])({ expression: "document.title" }, k.ctx);
  assert.equal(ok.ok, true);
});

test("console.eval: a write the script makes with the page's login is refused, and nothing is sent", async () => {
  const k = makeCtx({ respond: { "Runtime.evaluate": (/** @type {any} */ p) => {
    const x = String(p.expression);
    if (x.includes("__vyreWrites")) return { result: { value: true } };
    if (x.includes("__vyreGuard") && x.includes("restore")) return { result: { value: [{ method: "DELETE", url: "https://backend.example.com/workflow/abc?token=SECRETSECRETSECRET12", why: "write", write: true }] } };
    return { result: { type: "string", value: "done" } };
  } } });
  await assert.rejects(T(dev.ops["dev.console.eval"])({ expression: "fetch('https://backend.example.com/workflow/abc',{method:'DELETE'})" }, k.ctx), (/** @type {any} */ e) => e.code === "blocked" && /DELETE/.test(String(e.message)) && /api\.call/.test(String(e.message)) && !/SECRETSECRET/.test(String(e.message)));
});
