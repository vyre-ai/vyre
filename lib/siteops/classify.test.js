// @ts-check
// classify: every answer gets exactly one verdict and a next step; a status code alone is never enough.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, judge, botWall, nextStep } from "./classify.js";
import { parseOperation } from "./spec.js";

const make = (/** @type {any} */ o = {}) => {
  const r = parseOperation({ name: "listThings", kind: "read", request: { method: "GET", url: "https://s.test/api/v2/things?q=" }, trigger: { url: "https://s.test/things" },
    slots: [{ param: "query", at: ["query:q"] }], params: [{ name: "query", example: "alpha" }],
    response: { format: "json", extract: "results", shape: { "results[].id": "string", "results[].name": "string", "results[].url": "string", "results[].meta": "object" }, ...(o.response ?? {}) }, ...o.rest });
  assert.ok(r.ok, JSON.stringify(r));
  return /** @type {any} */ (r).op;
};
const j = (/** @type {any} */ b) => JSON.stringify(b);
const obs = (/** @type {number} */ status, /** @type {string} */ body, /** @type {any} */ headers = {}, url) => ({ status, body, headers: { "content-type": "application/json", ...headers }, ...(url ? { url } : {}) });
const good = j({ results: [{ id: "a", name: "A", url: "u", meta: {} }] });

test("ok: data present, an empty list is no results", () => {
  const op = make();
  assert.equal(classify(op, obs(200, good)).class, "ok");
  assert.equal(classify(op, obs(200, j({ results: [] }))).reason, "no results");
});

test("auth: 401, a login redirect, a login page where JSON was expected, a CSRF failure, a quiet 200 login_required", () => {
  const op = make();
  assert.equal(classify(op, obs(401, "{}")).class, "auth");
  assert.equal(classify(op, obs(200, good, {}, "https://s.test/login?next=/things")).class, "auth");
  assert.equal(classify(op, obs(200, "<html><form><input name=email><input type=password></form></html>", { "content-type": "text/html" })).class, "auth");
  assert.equal(classify(op, obs(419, "expired")).class, "auth");
  assert.equal(classify(op, obs(200, j({ require_login: true, status: "fail" }))).class, "auth");
});

test("rate: 429 with Retry-After, rate wording in a 200", () => {
  const op = make();
  const r = classify(op, obs(429, "", { "retry-after": "120" }));
  assert.equal(r.class, "rate");
  assert.match(r.reason, /retry after 120 s/);
  assert.equal(classify(op, obs(200, j({ message: "Too many requests, please wait a few minutes" }))).class, "rate");
});

test("blocked: bot walls by vendor markup, not by status; a checkpoint is blocked", () => {
  const op = make();
  assert.equal(classify(op, obs(403, "<title>Just a moment...</title>", { "content-type": "text/html" })).class, "blocked");
  assert.equal(classify(op, obs(200, "<html><title>Verify you are human</title></html>", { "content-type": "text/html" })).class, "blocked");
  assert.match(String(botWall(obs(200, '<a href="/checkpoint/challenge/abc">Let\'s do a quick security check</a>', { "content-type": "text/html" }))), /Checkpoint/);
  assert.equal(classify(op, obs(403, "forbidden")).class, "blocked");
});

test("drift: the path or the shape moved while the answer is fine; GraphQL schema errors", () => {
  const op = make();
  const moved = classify(op, obs(200, j({ items: [{ id: "a" }] })));
  assert.equal(moved.class, "drift");
  assert.equal(moved.missing, true);
  const shape = classify(op, obs(200, j({ results: [{ x1: 1, x2: 2, x3: 3, x4: 4 }] })));
  assert.equal(shape.class, "drift");
  assert.match(shape.reason, /shape changed/);
  assert.equal(classify(op, obs(200, "<html>Moved</html>", { "content-type": "text/html" })).class, "drift");
  assert.equal(classify(op, obs(200, j({ errors: [{ message: "PersistedQueryNotFound" }], data: null }))).class, "drift");
});

test("input: a 404 on a path input, a GraphQL not-found, a 400 naming the input", () => {
  const op = make({ rest: { request: { method: "GET", url: "https://s.test/api/v2/things/x" }, slots: [{ param: "query", at: ["path:3"] }] } });
  assert.equal(classify(op, obs(404, "{}")).class, "input");
  assert.equal(classify(op, obs(200, j({ errors: [{ message: "User not found" }], data: null }))).class, "input");
  assert.equal(classify(make(), obs(400, "the query is too short")).class, "input");
});

test("a write: a 200 with ok:false is an error, a non-JSON 200 is ok, and the next step never invites a second send", () => {
  const w = make({ rest: { kind: "send" } });
  assert.equal(classify(w, obs(200, j({ ok: false }))).class, "error");
  assert.equal(classify(w, obs(200, "queued", { "content-type": "text/plain" })).class, "ok");
  assert.match(String(nextStep("error", w, { ran: true })), /may have gone through/);
  assert.match(String(nextStep("auth", w, { ran: true })), /retry only if the write is not there/);
  assert.match(String(nextStep("auth", make())), /sign in again/);
  assert.equal(nextStep("ok", w), undefined);
});

test("judge extracts on ok and never throws on a bad recipe", () => {
  const op = make({ response: { pick: ["id", "name"] } });
  assert.deepEqual(judge(op, obs(200, good)).data, [{ id: "a", name: "A" }]);
  const broken = make();
  broken.response.pick = ["x=y~("];
  assert.equal(judge(broken, obs(200, good)).class, "error");
});
