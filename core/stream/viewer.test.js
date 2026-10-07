// @ts-check
// V-1 (reviewer re-gate, chat-03): a field's own `placeholder: true` is never believed. Every placeholder is rebuilt from a whitelist of
// keys; each probe below is the reviewer's and fails on the code that passed a flagged field through untouched.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { render, forViewer, resolveRefs } from "./viewer.js";

const BOB = { id: "person:bob", roles: [] };
const frame = (/** @type {any} */ ...fields) => ({ v: 1, id: "f1", cur: 1, session: "s", type: "chat.tool-finished", data: { tool_id: "t", ok: true, result: { block: "record", title: "M", fields } } });
const out = (/** @type {any} */ f, v = BOB) => /** @type {any} */ (render(frame(f), v)).data.result.fields[0];
const KEYS = ["name", "label", "kind", "sealed", "placeholder", "value"];

test("V-1: a forged sealed placeholder with a ref and a hint comes out without them", () => {
  const f = out({ sealed: "ssn", placeholder: true, ref: "r_SECRET", hint: "***1234" });
  assert.ok(!JSON.stringify(f).includes("r_SECRET") && !JSON.stringify(f).includes("1234"));
  assert.ok(!("ref" in f) && !("hint" in f));
  assert.equal(f.placeholder, true);
  assert.deepEqual(Object.keys(f.value).sort(), ["can_reveal", "present", "sealed", "valid_format"]);
  assert.equal(f.value.sealed, "ssn");
});

test("V-1: a placeholder with a text sibling loses the text", () => {
  const f = out({ sealed: "ssn", placeholder: true, text: "123-45-6789" });
  assert.ok(!("text" in f) && !JSON.stringify(f).includes("123-45-6789"));
});

test("V-1: a read_roles field flagged as a placeholder loses its alt", () => {
  const f = out({ name: "fee", label: "Fee", kind: "money", placeholder: true, read_roles: ["admin"], alt: "secret text", value: { hidden: "role", kind: "money", present: true, leak: "x" } });
  assert.ok(!JSON.stringify(f).includes("secret text") && !JSON.stringify(f).includes("leak") && !("alt" in f) && !("read_roles" in f));
  assert.deepEqual(f.value, { hidden: "role", kind: "money", present: true });
});

test("V-1: a placeholder holds only whitelisted keys, even a flagged field with a readable value and extra keys", () => {
  for (const f of [
    { sealed: "ssn", placeholder: true, ref: "r", hint: "h", text: "t", alt: "a", extra: { x: 1 }, value: { sealed: "ssn", ref: "r2", present: true, valid_format: true, can_reveal: true, hint: "9" } },
    { name: "n", label: "L", kind: "text", placeholder: true, value: "plain secret", note: "n" },
    { name: "n", placeholder: true, kind: { evil: 1 }, label: { evil: 1 } },
  ]) {
    const o = out(f);
    assert.ok(Object.keys(o).every(k => KEYS.includes(k)), Object.keys(o).join());
    assert.ok(!JSON.stringify(o).includes("plain secret") && !JSON.stringify(o).includes("evil"));
    assert.ok(Object.keys(o.value).every(k => ["sealed", "hidden", "kind", "present", "valid_format", "can_reveal"].includes(k)));
  }
});

test("V-1: a forged can_reveal is recomputed from the viewer, not believed", () => {
  const f = out({ sealed: "ssn", placeholder: true, value: { sealed: "ssn", present: true, valid_format: true, can_reveal: true }, seal: { reveal_roles: ["owner"] } });
  assert.equal(f.value.can_reveal, false, "bob holds no reveal role");
  const o = /** @type {any} */ (render(frame({ sealed: "ssn", placeholder: true, seal: { reveal_roles: ["owner"] } }), { id: "person:o", roles: ["owner"] })).data.result.fields[0];
  assert.equal(o.value.can_reveal, true);
});

test("V-1: a genuinely sealed field and a plain read_roles field are still drawn right, and a plain readable field passes untouched", () => {
  const sealed = out({ name: "ssn", label: "SSN", kind: "sealed", value: { sealed: "ssn", ref: "seal:1", present: true, valid_format: true, hint: "9999" } });
  assert.ok(!JSON.stringify(sealed).includes("seal:1") && !JSON.stringify(sealed).includes("9999"));
  const gated = out({ name: "fee", label: "Fee", kind: "money", value: { amount: 1 }, read_roles: ["admin"] });
  assert.equal(gated.placeholder, true);
  const plain = { name: "t", label: "Title", kind: "text", value: "Harlow" };
  assert.deepEqual(out(plain), plain);
});

test("a cited field the server did not resolve is a chip, never a value; a resolved one is drawn per viewer", async () => {
  const cite = { block: "field-ref", record: "vyre://spc/matter/1", field: "fee", label: "Fee" };
  const f = { v: 1, id: "f", cur: 1, session: "s", type: "chat.text-done", author: "assistant:kit", data: { message: "m", blocks: [cite] } };
  const sync = /** @type {any} */ (forViewer(f, BOB)).data.blocks[0];
  assert.deepEqual([sync.block, sync.placeholder, sync.label], ["field", true, "Fee"]);
  const spec = { label: "Fee", kind: "money", value: { amount: 4200 }, read_roles: ["manager"] };
  const mk = (/** @type {string[]} */ roles) => ({ id: "p", roles, resolve: async () => spec });
  const mgr = /** @type {any} */ (await resolveRefs(f, mk(["manager"]))).data.blocks[0];
  assert.deepEqual([mgr.block, mgr.label, mgr.value], ["field", "Fee", { amount: 4200 }]);
  const mem = /** @type {any} */ (await resolveRefs(f, mk(["member"]))).data.blocks[0];
  assert.equal(mem.placeholder, true);
  assert.ok(!JSON.stringify(mem).includes("4200"));
  assert.equal(/** @type {any} */ (f).data.blocks[0].block, "field-ref", "the shared frame is not mutated");
  const gone = /** @type {any} */ (await resolveRefs(f, { id: "p", roles: ["manager"], resolve: async () => { throw new Error("x"); } })).data.blocks[0];
  assert.equal(gone.placeholder, true, "a failed lookup is a chip");
});

test("the room note on a terminal, diff or files block reaches the viewer as the server set it, and is never added or filtered otherwise", () => {
  const NOTE = "visible to everyone in this chat";
  const tool = (/** @type {any} */ result) => ({ v: 1, id: "f1", cur: 1, session: "s", type: "chat.tool-finished", data: { tool_id: "t", ok: true, result } });
  for (const b of [{ block: "terminal", command: "ls", output: "a", note: NOTE }, { block: "diff", path: "a.md", hunks: [], note: NOTE }, { block: "files", files: [{ path: "a.md" }], note: NOTE, detail: "1 found" }]) {
    assert.deepEqual(/** @type {any} */ (render(tool(b), BOB)).data.result, b, `${b.block}: the note and the rest, untouched`);
    assert.deepEqual(/** @type {any} */ (forViewer(tool(b), BOB)).data.result, b);
  }
  const plain = { block: "terminal", command: "ls", output: "a" };
  assert.ok(!("note" in /** @type {any} */ (render(tool(plain), BOB)).data.result), "a block with no note gets none");
});
