// @ts-check
// The R3 connection states and the outbox rows (connection.ts), without React: the store is read
// through getState.

import { test } from "node:test";
import assert from "node:assert/strict";

// The store needs the app's own packages (zustand): the repo root's test run has none, so these
// run in the app's `npm test` (and CI's app.yml), and skip from the root.
const hasDeps = await import("zustand").then(() => true, () => false);
const strip = hasDeps && Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./connection.ts");

test("connection: a blip that heals on its first retry shows nothing; the next failure shows the pill", { skip: !strip }, async () => {
  const { toConnection } = await load();
  assert.equal(toConnection({ state: "connecting", attempt: 0 }), "live");
  assert.equal(toConnection({ state: "open", attempt: 0 }), "live");
  assert.equal(toConnection({ state: "reconnecting", attempt: 1 }), "live", "the first failure is quiet");
  assert.equal(toConnection({ state: "reconnecting", attempt: 2 }), "reconnecting", "the first retry failed too");
  assert.equal(toConnection({ state: "reconnecting", attempt: 2 }, { paths: 2 }), "live", "a round over two paths is one try");
  assert.equal(toConnection({ state: "reconnecting", attempt: 3 }, { paths: 2 }), "reconnecting");
  assert.equal(toConnection({ state: "open", attempt: 0 }, { online: false }), "offline");
  assert.equal(toConnection({ state: "paused", attempt: 0 }, { was: "reconnecting" }), "reconnecting", "hidden keeps what showed");
});

test("connection: the store follows the stream and the network", { skip: !strip }, async () => {
  const { connection } = await load();
  connection.paths(1);
  connection.stream({ state: "reconnecting", attempt: 2 });
  assert.equal(connection.get().status, "reconnecting");
  connection.online(false);
  assert.equal(connection.get().status, "offline");
  connection.online(true);
  assert.equal(connection.get().status, "reconnecting");
  connection.stream({ state: "open", attempt: 0 });
  assert.equal(connection.get().status, "live");
  assert.ok(connection.get().lastSeen);
});

test("connection: a write shows as sending at once and leaves only on the box's answer", { skip: !strip }, async () => {
  const { connection } = await load();
  const e = { key: "k1", tool: "threads.send", input: { thread: "kit", text: "Harlow Legal filing" }, at: 1 };
  connection.sending(e);
  assert.deepEqual(connection.get().outbox.map(i => [i.key, i.status]), [["k1", "sending"]]);
  // Another entry's change arrives before the outbox has stored k1: the row stays.
  connection.outbox({ pending: [] });
  assert.equal(connection.get().outbox.length, 1);
  connection.outbox({ pending: [{ ...e, state: "waiting" }] });
  assert.deepEqual(connection.get().outbox.map(i => i.status), ["sending"], "waiting on the box is still sending");
  connection.outbox({ pending: [{ ...e, state: "needs_presence" }] });
  assert.equal(connection.get().outbox[0].status, "needs_presence");
  connection.outbox({ pending: [], done: { entry: { ...e, state: "sending" } } });
  assert.equal(connection.get().outbox.length, 0);

  const f = { key: "k2", tool: "agents.create", input: { name: "juno" }, at: 2 };
  connection.sending(f);
  connection.outbox({ pending: [], refused: { entry: { ...f, state: "sending" }, error: { code: "exists", message: "juno exists" } } });
  assert.deepEqual(connection.get().outbox.map(i => [i.key, i.status, i.error?.code]), [["k2", "refused", "exists"]]);
  connection.dismiss("k2");
  assert.equal(connection.get().outbox.length, 0);
});
