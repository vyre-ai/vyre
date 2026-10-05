// @ts-check
// runner.places: where the caller's chats run. Only chats the caller is in (kernel chats.mine), the computer's name and whether it is connected from the relay's device list; no chat list means no row.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import mod from "./index.js";
import { fakeSpace } from "./testing/fake-space.js";
import { seams } from "./index.js";

const person = id => ({ hops: [{ actor: { kind: "person", id } }] });
const A = "chat_aaaaaaaa-0000-0000-0000-000000000001", B = "chat_bbbbbbbb-0000-0000-0000-000000000002";
const ROWS = [{ session: "s1", device: "dev_1", chat: A }, { session: "s2", device: "dev_2", chat: B }, { session: "s3", device: "dev_1" }];

async function boot(t, { chain = () => person("per_a"), mine, rows = ROWS, devices } = {}) {
  const sp = fakeSpace(); const root = `/tmp/runner-places-${process.pid}-${Math.random().toString(36).slice(2)}`;
  seams.set(root, { ports: { device: "dev_kit", vault: sp.vault, sync: sp.sync, grants: () => ({ spaceAllows: true, memberAccepts: true }), spec: async () => null } });
  t.after(() => seams.delete(root));
  /** @type {Map<string, any>} */ const tools = new Map();
  const kernel = { owner: "per_a", chain: async meta => chain(meta), runnerHost: () => ({ lentRows: sp0 => (sp0 === "spc_x" ? rows : []) }), ...(mine ? { chats: { mine } } : {}) };
  const ctx = { paths: { root }, events: { emit() {}, on: () => () => {} }, tool: (n, d) => tools.set(n, d), kernel, call: async name => (name === "relay.devices.all" ? { data: { devices: devices || [] } } : { data: {} }) };
  const h = await mod.start(ctx); t.after(() => h.stop());
  return meta => tools.get("runner.places").run({ space: "spc_x" }, meta);
}

test("runner.places answers only the caller's own chats, with the computer's name and whether it is online", async t => {
  const places = await boot(t, { mine: async () => [{ chat: A }], devices: [{ id: "dev_1", name: "Office Mac", online: true }, { id: "dev_2", name: "Spare", online: false }] });
  assert.deepEqual((await places({ caller: "cli" })).places, [{ chat: A, session: "s1", computer: "Office Mac", device: "dev_1", online: true }]);
});

test("runner.places: another person's chat never appears, and a device the relay does not list is offline with no name", async t => {
  const places = await boot(t, { mine: async () => [{ id: B }], devices: [] });
  assert.deepEqual((await places({ caller: "cli" })).places, [{ chat: B, session: "s2", computer: null, device: "dev_2", online: false }]);
});

test("runner.places fails closed: no chat list means no rows, and a chat-less lent session never shows", async t => {
  const none = await boot(t, {}); assert.deepEqual((await none({ caller: "cli" })).places, []);
  const empty = await boot(t, { mine: async () => [] }); assert.deepEqual((await empty({ caller: "cli" })).places, []);
});

test("runner.places is a person's: an agent, a service or no chain is refused", async t => {
  for (const chain of [() => ({ hops: [{ actor: { kind: "person", id: "per_a" } }, { actor: { kind: "agent", id: "k" } }] }), () => ({ hops: [{ actor: { kind: "service", id: "x" } }] }), () => ({ hops: [] })]) {
    const places = await boot(t, { chain, mine: async () => [{ chat: A }] });
    await assert.rejects(places({ caller: "cli" }), e => e.code === "denied");
  }
});
