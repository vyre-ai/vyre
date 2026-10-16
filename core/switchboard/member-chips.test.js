// @ts-check
// A member's turn in a chat hears only a picked record and an account chip. A #Name in the words, and a vault, Drive or GitHub chip, are not resolved: those providers would answer under the owner's access.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Switchboard } from "./index.js";

/** @param {string[]} calls */
function rig(calls) {
  return /** @type {any} */ ({
    record: () => ({ project: null }),
    emit() {},
    hearActs: async () => {},
    deps: {
      call: async (/** @type {string} */ tool, /** @type {any} */ input) => {
        calls.push(`${tool}:${input && (input.kind || input.id || input.q) || ""}`);
        if (tool === "mentions.search") return { data: [{ kind: "vault", id: "owner-secret", name: "owner-secret" }] };
        return { data: { name: String(input.id), note: "ok", outside: true } };
      },
      recordTags: async (/** @type {any[]} */ chips) => ({ chips: chips.filter(c => c.kind !== "record"), tags: chips.filter(c => c.kind === "record").map(c => ({ kind: "record", id: c.id, name: c.id, hint: null, hosts: [], note: null, outside: true })) }),
    },
  });
}

const CHIPS = [{ kind: "vault", id: "owner-secret" }, { kind: "drive", id: "owner-file" }, { kind: "github", id: "owner/repo" }, { kind: "record", id: "urn:rec:1" }, { kind: "account", id: "claude" }];

test("a member's turn resolves no vault, Drive or GitHub chip and no #Name under the owner's access", async () => {
  const calls = /** @type {string[]} */ ([]);
  const sb = rig(calls);
  const heard = await Switchboard.prototype.ingress.call(sb, "t1", "use #owner-secret please", "deck", "u1", CHIPS, [], "deck", null, { memberTurn: true });
  assert.deepEqual(heard.map((/** @type {any} */ t) => t.kind).sort(), ["account", "record"]);
  assert.equal(calls.some(c => /mentions\.search|vault\.mention\.resolve/.test(c)), false, calls.join(" "));
  assert.equal(calls.some(c => /vault|drive|github/.test(c)), false, calls.join(" "));
});

test("the owner's own turn still resolves chips and #Names", async () => {
  const calls = /** @type {string[]} */ ([]);
  const sb = rig(calls);
  const heard = await Switchboard.prototype.ingress.call(sb, "t1", "use #owner-secret please", "deck", "u1", CHIPS, [], "deck", null, {});
  assert.ok(heard.some((/** @type {any} */ t) => t.kind === "vault"));
  assert.ok(calls.some(c => c.startsWith("mentions.search")));
});
