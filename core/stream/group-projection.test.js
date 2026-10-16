// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as config from "../config/index.js";
import { open } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { Logs } from "./log.js";
import { createGroups } from "./group.js";
import { createFakeKernel } from "./fake-reply-port.js";

test("a projection failure clears working state and emits a status frame", async t => {
  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const fk = createFakeKernel();
  const logs = new Logs({ maxFrames: 100000, coalesce: false });
  const ctx = {
    log: () => {},
    kernel: fk.kernel,
    call: async (tool) => (tool === "threads.get" ? { data: { events: [] } } : { data: { id: "thr_1" } }),
  };
  const groups = createGroups({ ctx, logs, db, replyPort: fk.port });
  t.after(() => { groups.stop(); logs.close(); db.close(); });
  fk.create("g1", ["bob"], ["kit"]);
  const meta = {};
  await groups.mirror("g1", { people: ["bob"], assistants: ["kit"] }, meta, "person:bob", { person: "bob" });
  await groups.send({ chat: "g1", text: "hi", message: "m1", to: ["assistant:kit"], cwd: "/tmp" }, meta);
  await groups.idle();
  const kit = String(/** @type {any} */ (groups.member("g1", "assistant:kit")).thread);
  const m = /** @type {any} */ (groups.member("g1", "assistant:kit"));
  m.running = true;
  m.inTurn = true;
  const orig = fk.port.open;
  fk.port.open = async () => { throw new Error("projection broke"); };
  groups.onEvent({ id: 1, type: "thread.text", thread: kit, payload: { message: "a1", block: 0, delta: "x" } });
  if (m.pq) await m.pq;
  await groups.idle();
  fk.port.open = orig;
  assert.equal(m.running, false);
  assert.equal(m.inTurn, false);
  const st = logs.get("g1").read(0).filter((f) => f.type === "chat.status");
  assert.ok(st.some((f) => f.data.state === "waiting"), "the group log gets a status so clients leave Working");
});
