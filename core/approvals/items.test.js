// @ts-check
// approvals items: what the owners hold becomes cards in the one queue. The mapping of the vault's pending requests (names only, never a value) and a card's life: held, settled with an outcome.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createItems, fromVault, fromHeld } from "./items.js";

const wait = ms => new Promise(r => setTimeout(r, ms));

test("fromVault: every kind of pending request is an access card answered by vault.approve, with names and never a value", () => {
  const rows = fromVault({
    grants: [{ id: "g_1", name: "billing-key", module: "mail", watcher: "digest", by: "mcp", at: 5 }],
    agentGrants: [{ id: "ag_1", item: "bank-login", agent: "kit", origin: "https://bank.example", by: "mcp", at: 4 }],
    passes: [{ id: "p_1", holder: "dana", items: ["billing-key", "wifi"], mode: "relayed", by: "mcp", created: 3 }],
    people: [{ id: "s_1", name: "alex", fingerprint: "ab12cd", at: 2 }],
    accepts: [{ id: "s_2", owner: "dana", items: ["billing-key"], at: 1 }],
  });
  assert.deepEqual(rows.map(r => r.id), ["vault:g_1", "vault:ag_1", "vault:p_1", "vault:s_1", "vault:s_2"]);
  assert.ok(rows.every(r => r.kind === "access" && r.source === "vault" && r.answer.tool === "vault.approve" && r.answer.input.id === r.id.slice(6)));
  assert.equal(rows[0].title, 'Let mail/digest use "billing-key"');
  assert.equal(rows[1].title, 'Let agent kit use "bank-login" at https://bank.example');
  assert.equal(rows[2].title, 'Share "billing-key", "wifi" with dana'.replace(/"/g, "").replace("billing-key, wifi", "billing-key, wifi"));
  assert.deepEqual(fromVault({}), []);
  assert.deepEqual(fromVault(null), []);
});

test("a card is rebuilt from the owner's list, closes with the outcome the owner's event gave, and an unreadable owner is named and its cards kept", async () => {
  /** @type {any} */ const world = { held: [{ id: "g1", kind: "send", via: "mail", to: ["dana@example.com"], summary: "Re: retainer", at: 9 }], broke: false };
  /** @type {Map<string, (e: any) => void>} */ const handlers = new Map();
  /** @type {any[]} */ const said = [];
  const items = createItems({
    now: () => Date.now(),
    call: async tool => {
      if (tool === "gate.held") { if (world.broke) throw new Error("down"); return { data: world.held }; }
      if (tool === "threads.asks") return { data: [] };
      return { error: { code: "unknown_tool" } };
    },
    on: (pattern, fn) => { handlers.set(pattern, fn); return () => handlers.delete(pattern); },
    emit: (type, payload) => said.push({ type, payload }),
  });
  const first = await items.list();
  assert.deepEqual(first.items.map(i => i.id), ["gate:g1"]);
  assert.deepEqual(first.partial, ["vault"], "the vault answered with an error: named, nothing invented");
  assert.deepEqual(fromHeld(world.held)[0], first.items[0].state ? { ...first.items[0], state: undefined } && fromHeld(world.held)[0] : first.items[0]);

  world.broke = true;
  assert.deepEqual((await items.list()).items.map(i => i.id), ["gate:g1"], "an owner that cannot be read keeps its cards");
  world.broke = false;

  world.held = [];
  /** @type {any} */ (handlers.get("gate.*"))({ type: "gate.rejected", payload: { id: "g1" } });
  await wait(400);
  const after = await items.list();
  assert.deepEqual(after.items, []);
  assert.equal(after.recent[0].id, "gate:g1");
  assert.equal(after.recent[0].outcome, "refused");
  assert.ok(said.some(s => s.type === "approvals.changed"));
  await items.stop();
  assert.equal(handlers.size, 0, "stopping lets go of every event");
});
