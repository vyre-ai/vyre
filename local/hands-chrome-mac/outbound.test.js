// @ts-check
// Only what SENDS something as the person is held: everything else is hands-free after the grant.
import test from "node:test";
import assert from "node:assert/strict";
import { classifySend, held, digest, guardInstall, guardInstallWrites, guardCollect } from "./extension/shared/outbound.js";
import api from "./extension/caps/api.js";
import net from "./extension/caps/net.js";
import { makeCtx } from "./devtools-kit.js";

const GHL = "https://backend.leadconnectorhq.com";
const sends = [
  ["POST", `${GHL}/conversations/messages`], ["POST", `${GHL}/conversations/abc123/messages`], ["POST", `${GHL}/invoices/i1/send`],
  ["POST", `${GHL}/social-media-posting/loc1/posts`], ["POST", "https://x.test/v1/email/send"], ["PUT", `${GHL}/campaigns/c1/start`],
  ["POST", "https://x.test/graphql", '{"query":"mutation { sendMessage(id:1) { id } }"}'],
];
const free = [
  ["GET", `${GHL}/conversations/messages`], ["POST", `${GHL}/contacts/c1/tags`], ["PUT", `${GHL}/workflows/w1`],
  ["POST", `${GHL}/workflows`], ["POST", `${GHL}/contacts`], ["DELETE", `${GHL}/contacts/c1`], ["PATCH", `${GHL}/opportunities/o1`],
  ["POST", "https://x.test/graphql", '{"query":"mutation { updateContact(id:1) { id } }"}'],
];

test("classifySend: messages, posts and payments are sends; tags, workflows, reads and deletes are not", () => {
  for (const [m, u, b] of sends) assert.equal(classifySend(m, u, b).send, true, `${m} ${u}`);
  for (const [m, u, b] of free) assert.equal(classifySend(m, u, b).send, false, `${m} ${u}`);
});

test("held() names the request and gives a stable signature", () => {
  const h = held("post", `${GHL}/conversations/messages?token=abc`, "it messages", "POST x");
  assert.equal(h.held, true);
  assert.equal(h.control.name, `POST ${GHL}/conversations/messages`);
  assert.doesNotMatch(JSON.stringify(h), /token=abc/);
  assert.equal(h.sig, digest("POST x"));
});

test("the page guard scripts install a shim and read back what it caught", () => {
  assert.match(guardInstall, /window\.fetch = function/);
  assert.match(guardInstall, /classifySend/);
  assert.match(guardCollect, /restore\(\)/);
});

/** A catalog with one send entry and one tag entry, for api.call. */
async function withCatalog() {
  const k = makeCtx({ active: 3 });
  const entries = [
    { id: "e_send", method: "POST", host: "backend.leadconnectorhq.com", origin: GHL, pathTemplate: "/conversations/messages", query: {}, authKind: "cookie" },
    { id: "e_tag", method: "POST", host: "backend.leadconnectorhq.com", origin: GHL, pathTemplate: "/contacts/{id}/tags", query: {}, authKind: "cookie" },
  ];
  k.ctx.storage = { session: { get: async (/** @type {string} */ key) => ({ [key]: { [GHL]: { updated: 1, entries } } }), set: async () => {} } };
  const orig = (await import("./extension/caps/api.js")).default;
  return { k, orig };
}

test("api.call: a send is held unless asked, a tag call runs free, asked runs the send", async () => {
  const { k } = await withCatalog();
  k.respond["Runtime.evaluate"] = () => ({ result: { value: { status: 200, mime: "application/json", headers: {}, body: "{}" } } });
  const h = await api.ops["api.call"]({ tab: 3, entryId: "e_send", params: { body: { text: "hi" } } }, k.ctx);
  assert.equal(h.held, true, JSON.stringify(h));
  assert.match(h.control.name, /POST .*conversations\/messages/);
  const tag = await api.ops["api.call"]({ tab: 3, entryId: "e_tag", params: { path: { id: "c1" }, body: { tags: ["new"] } } }, k.ctx);
  assert.equal(tag.held, undefined, "a tag write is hands-free");
  assert.equal(tag.status, 200);
  const asked = await api.ops["api.call"]({ tab: 3, entryId: "e_send", asked: true, params: { body: { text: "hi" } } }, k.ctx);
  assert.equal(asked.held, undefined);
  assert.equal(asked.status, 200);
});

test("net.replay: a captured send is held unless asked", async () => {
  const k = makeCtx({ active: 3 });
  await net.ops["net.start"]({ tab: 3 }, k.ctx);
  k.push(3, "Network.requestWillBeSent", { requestId: "9", type: "XHR", request: { url: `${GHL}/conversations/messages`, method: "POST", headers: {}, postData: "{}" } });
  k.push(3, "Network.requestWillBeSent", { requestId: "10", type: "XHR", request: { url: `${GHL}/contacts/c1/tags`, method: "POST", headers: {}, postData: "{}" } });
  k.respond["Runtime.evaluate"] = () => ({ result: { value: { status: 200, mime: "application/json", headers: {}, body: "{}" } } });
  const h = await net.ops["net.replay"]({ tab: 3, id: "9" }, k.ctx);
  assert.equal(h.held, true);
  const sentBefore = k.sent.filter(s => s.method === "Runtime.evaluate").length;
  const ok = await net.ops["net.replay"]({ tab: 3, id: "10" }, k.ctx);
  assert.equal(ok.held, undefined, "a tag write is not a send");
  assert.ok(k.sent.filter(s => s.method === "Runtime.evaluate").length > sentBefore);
  const asked = await net.ops["net.replay"]({ tab: 3, id: "9", asked: true }, k.ctx);
  assert.equal(asked.held, undefined, "asked runs it");
});

test("dev.console.eval: the script runs, its own send is held back, asked runs it without the guard", async () => {
  const dt = (await import("./extension/caps/devtools.js")).default;
  const k = makeCtx({ active: 3 });
  const caught = [{ method: "POST", url: `${GHL}/conversations/messages`, why: "it messages, posts or charges as the person" }];
  k.respond["Runtime.evaluate"] = (/** @type {any} */ p) => p.expression === guardCollect ? { result: { value: caught } } : p.expression === guardInstallWrites ? { result: { value: true } } : { result: { type: "string", value: "done" } };
  const h = await dt.ops["dev.console.eval"]({ tab: 3, expression: "fetch('/conversations/messages',{method:'POST'})" }, k.ctx);
  assert.equal(h.held, true);
  assert.ok(k.sent.some(s => s.params && s.params.expression === guardInstallWrites), "the guard was installed");
  const plain = makeCtx({ active: 3 });
  plain.respond["Runtime.evaluate"] = () => ({ result: { type: "string", value: "done" } });
  const r = await dt.ops["dev.console.eval"]({ tab: 3, expression: "1", asked: true }, plain.ctx);
  assert.equal(r.ok, true);
  assert.ok(!plain.sent.some(s => s.params && s.params.expression === guardInstallWrites), "asked runs with no guard");
});
