// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import mod from "../core/approvals/index.js";
import { holdFields, viewOf, pageOf } from "../lib/hold-fields.js";

const SECRET = "horse-battery-staple-99";
const NESTED = "nested-secret-42";

async function world() {
  const tools = new Map();
  await mod.start({ tool: (n, d) => tools.set(n, d), call: async () => ({ data: { covered: false } }), now: () => 1_000_000, modules: { isOutward: n => n === "mail.send" }, kernel: {} });
  return { run: (n, i, m = {}) => tools.get(n).run(i, m) };
}

test("a password never appears on an approval card", async () => {
  const input = {
    to: "juno@example.com", password: SECRET, recoveryKey: "AAAA-BBBB-CCCC-DDDD-EEEE-FF",
    note: "Invoice 1042", auth: { secret: NESTED, user: "alex" },
  };
  const fields = holdFields(input);
  const view = viewOf(input);
  const page = pageOf(input);
  const blob = JSON.stringify({ fields, view, page, input });
  assert.equal(blob.includes(SECRET), false);
  assert.equal(blob.includes(NESTED), false);
  assert.equal(blob.includes("AAAA-BBBB"), false);
  assert.equal(fields.password, undefined);
  assert.match(blob, /juno@example.com/);
  assert.match(blob, /Invoice 1042/);
  const w = await world();
  const card = await w.run("approvals.hold", { tool: "mail.send", fields, from: "mcp:agent:kit", input }, { caller: "module:registry" });
  const [pending] = (await w.run("approvals.pending", {}, { caller: "device:phone" })).approvals;
  const shown = JSON.stringify({ card, pending });
  assert.equal(pending.id, card.id);
  assert.equal(shown.includes(SECRET), false);
  assert.equal(shown.includes(NESTED), false);
  assert.match(shown, /juno@example.com/);
  assert.equal(JSON.stringify(pending.words).includes(SECRET), false);
});
