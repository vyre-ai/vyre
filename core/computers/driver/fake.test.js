// @ts-check
// The fake driver keeps Docker's rules, so a pool bug that would fail on the box fails here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDriver } from "./fake.js";

const spec = { agent: "kit", image: "i", env: {}, labels: {}, volume: "vyre-home-kit" };

test("fake: state transitions follow Docker's", async () => {
  const d = new FakeDriver();
  const { id } = await d.create(spec);
  assert.equal((await d.inspect(id)).state, "exited");
  await assert.rejects(d.pause(id), /not running/);
  await d.start(id);
  await d.pause(id);
  await assert.rejects(d.start(id), /paused/);
  await d.unpause(id);
  await assert.rejects(d.unpause(id), /not paused/);
  await d.stop(id);
  assert.deepEqual(await d.list(), [{ id, agent: "kit", state: "exited" }]);
  await d.remove(id);
  assert.deepEqual(await d.inspect(id), { state: "missing", host: null });
  await assert.rejects(d.start(id), /no such container/);
});

test("fake: local mode points every computer at one real address", async () => {
  const d = new FakeDriver({ local: { host: "127.0.0.1", ports: { cdp: 9222, helper: 7123 } } });
  const { id } = await d.create(spec);
  await d.start(id);
  assert.deepEqual(await d.inspect(id), { state: "running", host: "127.0.0.1", ports: { vnc: 5900, cdp: 9222, helper: 7123 } });
});

test("fake: one driver per key, kept across restarts in the process", () => {
  const a = FakeDriver.for("home-a");
  assert.equal(FakeDriver.for("home-a"), a);
  assert.notEqual(FakeDriver.for("home-b"), a);
  FakeDriver.forget("home-a"); FakeDriver.forget("home-b");
  assert.notEqual(FakeDriver.for("home-a"), a);
  FakeDriver.forget("home-a");
});
