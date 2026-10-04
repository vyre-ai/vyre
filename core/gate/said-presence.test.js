// @ts-check
// gate.said.add asks for a person's proof when the permission is a payment, or names no agent (a blanket allow); a narrow send or post for
// a named agent stays one tap, and revoking never asks. The proof is bound to the exact permission (its summary names the kind, the
// recipients and the cap). Inside a real vyred; presence is a stand-in that applies the tool's own `when` and accepts a proof object.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

test("gate.said.add: presence for pay and for a blanket allow, not for a named agent; revoke never", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  const asked = [];
  const presence = {
    required: (_tool, def, input) => Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
    verify: async ({ def, input, proof }) => {
      asked.push(def.presence.summary ? await def.presence.summary(input) : "");
      return proof === "touch" ? { ok: true, method: "test" } : { ok: false, code: "presence_required", message: "a person must prove it" };
    },
    challenge: async () => ({ error: { code: "bad_input", message: "none" } }),
  };
  const d = await start({ presence, root, log: () => {} });
  t.after(() => d.stop());
  const add = (input, proof) => d.registry.call("gate.said.add", input, "local", proof ? { proof } : {});
  const narrow = { kind: "send", to: ["sam@harlowlegal.com"], agents: ["kit"], what: "kit may email Sam" };

  // Refused without a proof: a payment, and a blanket allow (no agents, or an empty list).
  const pay = { kind: "pay", to: ["acct_1"], limits: { max_amount: 50, currency: "usd" } };
  for (const input of [pay, { kind: "send", to: ["sam@harlowlegal.com"] }, { ...narrow, agents: [] }]) {
    const r = await add(input);
    assert.equal(r.error && r.error.code, "presence_required", JSON.stringify({ input, r }));
  }
  // The proof binds this exact permission: the summary names the kind, recipients, agent scope and cap.
  assert.equal((await add(pay, "touch")).error, undefined);
  assert.match(asked[asked.length - 1], /pay to acct_1 for any agent \(max amount 50, currency usd\)/);

  // A narrow send for a named agent needs no proof; a person's proof is not asked for either.
  const before = asked.length;
  const ok = await add(narrow);
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal(asked.length, before, "no proof was asked for the narrow permission");

  // Revoke never needs a proof.
  const list = (await d.registry.call("gate.said.list", {}, "local")).data;
  const id = (list.intents || list.items || list)[0].id;
  assert.equal((await d.registry.call("gate.said.revoke", { id }, "local")).error, undefined);
  // An agent still cannot add at all (the callers list), proof or not.
  assert.equal((await d.registry.call("gate.said.add", narrow, "mcp", { proof: "touch", thread: "t-1" })).error.code, "denied");
});
