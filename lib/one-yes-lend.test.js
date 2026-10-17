// @ts-check
// A member's yes at the tag (vault.me.mention.lend): her card reads in words, and the op is NOT a registry-floor moment. momentOf drives the floor, which would refuse the Switchboard's own (module) call;
// the Vault checks this yes itself (core/vault/mention-yes.js), and yes() does not consult the moment list for an op (opFitsMoment is the approvals card route's alone).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineOfOp, momentOf, MOMENT_OPS, yes } from "./one-yes.js";

test("her card says what she lends and to whom, not the generic line; the op is outside the floor's moment lists", async () => {
  const line = lineOfOp("vault.me.mention.lend", { asker: "per_x", id: "passport", thread: "t1", agent: "kit" }, "Your phone");
  assert.match(line, /let "kit" use "passport" for this turn, without seeing it/);
  assert.ok(!/run vault\.me\.mention\.lend/.test(line));
  assert.equal(momentOf("vault.me.mention.lend"), null, "the floor stays off for the Switchboard's call");
  for (const m of Object.values(MOMENT_OPS)) assert.ok(!m.includes("vault.me.mention.lend"));
});

test("yes() verifies an op that is on no moment list: only the verifier decides", async () => {
  const fields = { asker: "per_x", id: "passport", thread: "t1", agent: "kit" };
  const seen = /** @type {any[]} */ ([]);
  const r = await yes("vault", { op: "vault.me.mention.lend", fields }, { signature: "x" }, { verify: async i => { seen.push(i); return { ok: true, strength: "real" }; } });
  assert.equal(r.ok, true);
  assert.equal(seen[0].request.op, "vault.me.mention.lend");
});
