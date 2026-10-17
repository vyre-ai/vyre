// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildCall, entryId } from "../../lib/siteops/apilearn.js";
import { callApi, routeApi } from "./api-exec.js";

const entry = {
  id: entryId("GET", "bakery.example", "/api/orders/{id}"),
  method: "GET",
  origin: "https://bakery.example",
  host: "bakery.example",
  pathTemplate: "/api/orders/{id}",
  query: {},
  authKind: "cookie",
  statuses: [200],
  count: 3,
};

test("routeApi: picks a matching GET and calls it", async () => {
  const catalog = [entry];
  const res = await routeApi(catalog, "orders list", { path: { id: "9" } }, [], async () => ({ status: 200, mime: "application/json", responseBody: "{}" }));
  assert.equal(res.route, "api");
  assert.equal(res.entryId, entry.id);
});

test("callApi: holds writes without approved", async () => {
  const post = { ...entry, id: "e_post", method: "POST", pathTemplate: "/api/orders" };
  const held = await callApi(post, { body: { x: 1 } }, [], {}, { send: async () => ({}) }, "s");
  assert.equal(held.held, true);
  assert.equal(held.write, true);
});

test("callApi: holds outbound sends without approval", async () => {
  const post = { ...entry, id: "e_send", method: "POST", pathTemplate: "/api/messages/send" };
  const held = await callApi(post, {}, [], {}, { send: async () => ({}) }, "s");
  assert.equal(held.held, true);
  assert.equal(held.send, true);
});

test("buildCall + callApi read path", async () => {
  const built = buildCall(entry, { path: { id: "1" } });
  assert.match(built.url, /\/api\/orders\/1$/);
  const cdp = {
    async send(method, params, sessionId) {
      assert.equal(method, "Runtime.evaluate");
      assert.equal(sessionId, "sess");
      return { result: { value: { status: 200, mime: "application/json", headers: {}, body: '{"ok":true}' } } };
    },
  };
  const out = await callApi(entry, { path: { id: "1" } }, [], {}, cdp, "sess");
  assert.equal(out.status, 200);
  assert.match(String(out.responseBody), /ok/);
});
