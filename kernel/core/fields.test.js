import test from "node:test";
import assert from "node:assert/strict";
import { resolveFields, hasPlaceholder } from "./fields.js";

const SPACE = "spc_aaaaaaaaaaaa";
const rec = { data: { name: "Jane", fee: 4321, ssn: { sealed: "ssn", ref: "sv_1", present: true } } };
const read = async urn => (urn === `vyre://${SPACE}/contact/c1` ? rec : null);

test("a placeholder in an action becomes the value from the record the asker can read; a sealed field stays a slot for the door; nothing unreadable is sent", async () => {
  assert.equal(hasPlaceholder({ a: ["x", { b: "{{field:vyre://s/contact/c1#fee}}" }] }), true);
  assert.equal(hasPlaceholder({ a: "plain" }), false);
  const u = `vyre://${SPACE}/contact/c1`;
  const r = await resolveFields({ read, input: { to: "jane@example.com", body: `Dear {{field:${u}#name}}, your fee is {{field:${u}#fee}}. SSN {{field:${u}#ssn}}.`, n: 3 } });
  assert.equal(r.input.body, `Dear Jane, your fee is 4321. SSN {{field:${u}#ssn}}.`);
  assert.deepEqual(r.resolved, [{ urn: u, field: "name" }, { urn: u, field: "fee" }]);
  assert.deepEqual(r.slots, [{ record: u, field: "ssn" }]);
  assert.equal(r.input.n, 3);
  for (const bad of [`{{field:${u}#nope}}`, `{{field:vyre://${SPACE}/contact/zzz#name}}`, "{{field:not-a-urn#name}}"]) await assert.rejects(() => resolveFields({ read, input: { body: bad } }), { code: "placeholder_unreadable" }, bad);
  await assert.rejects(() => resolveFields({ read: async () => { throw new Error("boom"); }, input: { b: `{{field:${u}#name}}` } }), { code: "placeholder_unreadable" });
  const many = Array.from({ length: 60 }, () => `{{field:${u}#name}}`).join(" ");
  await assert.rejects(() => resolveFields({ read, input: { b: many } }), { code: "placeholder_unreadable" }, "too many");
});
