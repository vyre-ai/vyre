import { test } from "node:test";
import assert from "node:assert/strict";
import { personTurn, mentionsOf, matchItems, textHash, MENTION_NOTE, MAX_MENTIONS } from "./said.js";

test("personTurn: the person's own surfaces only", () => {
  for (const c of ["cli", "local", "deck", "capsule", "tailnet:alex@harlow", "link:box"]) assert.equal(personTurn(c), true, c);
  for (const c of ["mcp", "mcp:agent:kit", "mcp:thread:abc", "harness:thread:abc", "hook", "module:teammates", "module:assistant", "guest", "cli:agent:kit", "deck:agent:kit", "tailnet:", "", undefined]) assert.equal(personTurn(c), false, String(c));
});

test("mentionsOf: #Name and #\"Name with spaces\" at a word start, once each; code, quotes and mid-word # mention nothing", () => {
  assert.deepEqual(mentionsOf("Use #GHLapikey to inventory pipelines"), ["GHLapikey"]);
  assert.deepEqual(mentionsOf("#GHLapikey first, then (#Stripe.live) and #\"Harlow prod key\"."), ["GHLapikey", "Stripe.live", "Harlow prod key"]);
  assert.deepEqual(mentionsOf("use #a and #A again"), ["a"], "case-insensitive, once");
  assert.deepEqual(mentionsOf("issue#12 and a#b and http://x.test/#frag"), []);
  assert.deepEqual(mentionsOf("run `echo #secret` then\n```\n#fenced\n```\n> #quoted\nplain"), []);
  assert.deepEqual(mentionsOf("see #key-"), ["key"], "trailing punctuation is not the name");
  assert.equal(mentionsOf(Array.from({ length: 20 }, (_, n) => `#k${n}`).join(" ")).length, MAX_MENTIONS);
  assert.deepEqual(mentionsOf(""), []);
});

test("matchItems: only a name vault has, exactly; a vault that fails or is absent means plain text", async () => {
  const call = async (tool, input) => tool === "vault.items.names"
    ? { data: { names: [{ name: "GHLapikey", kind: "token", hosts: ["services.leadconnectorhq.com"] }, { name: "GHLapikey2", kind: "token", hosts: [] }].filter(x => x.name.toLowerCase().includes(input.query.toLowerCase())) } }
    : { error: { code: "no_such_tool" } };
  assert.deepEqual(await matchItems(["ghlapikey", "missing"], call), [{ name: "GHLapikey", kind: "token", hosts: ["services.leadconnectorhq.com"] }]);
  assert.deepEqual(await matchItems(["x"], async () => { throw new Error("locked"); }), []);
  assert.deepEqual(await matchItems(["x"], async () => ({ error: { code: "no_such_tool" } })), []);
});

test("textHash and MENTION_NOTE: a hash, and a note that names hosts and never a value", () => {
  assert.match(textHash("hi"), /^[0-9a-f]{64}$/);
  const n = MENTION_NOTE([{ name: "GHLapikey", hosts: ["a.test"] }]);
  assert.match(n, /#GHLapikey \(on a\.test only\)/);
  assert.match(n, /never see its value/);
});
