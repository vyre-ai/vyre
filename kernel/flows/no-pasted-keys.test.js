import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow } from "./schema.js";

const flow = (step) => ({ format: 1, name: "keys", label: "Keys", authorship: "builder", trigger: { on: "manual" }, steps: [{ id: "w", kind: "service", connector: "crm", method: "GET", path: "/v1/ping", ...step }] });
const say = (step) => checkFlow(flow(step)).map((p) => `${p.path}: ${p.message}`);

test("a key typed into a header or a query value is refused, and the words say where keys belong", () => {
  const msgs = say({ headers: { "x-trace": "sk-ant-api03-abcdefghijklmnopqrstuvwx" }, query: { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } });
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every((m) => /Keep keys in the Vault/.test(m)));
  assert.ok(msgs[0].startsWith("steps[0].headers.x-trace") || msgs.some((m) => m.includes("headers.x-trace")));
  assert.ok(msgs.some((m) => m.includes("query.token")));
});

test("plain header and query values, and values read from the Flow, stay allowed", () => {
  assert.deepEqual(say({ headers: { "x-trace": "run-42" }, query: { page: "2", q: { expr: "trigger.name" } } }), []);
});
