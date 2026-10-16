// @ts-check
// A session on a member's own computer goes to the server on its own when the computer stops answering, and comes back to the computer on its own when the person's standing choice is Always allow and the
// computer has stayed ready: no person acts. For every agent kind the registry knows (Claude, Codex, Grok, and any added later). The real kernel, Offers, lent home, checkpoint store and wire; the clock is the test's.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { rig, BOB, SPACE } from "./testing/lent-rig.js";
import { LENT_PROCESS_PROVIDERS } from "../../lib/lent-process-provider.js";
import { LAPSE_MS, STEADY_MS, COOLDOWN_MS } from "./placement-book.js";
import { createRemoteKernel } from "../../kernel/remote/client.js";
import { createMemoryTransport } from "../../kernel/remote/memory-transport.js";

// the rigs here give the Space a program by its path: honoured on a development build with this switch
process.env.VYRE_LENT_AGENT_DEV = "1";

const clockRig = async (/** @type {import("node:test").TestContext} */ t) => {
  const c = { t: 1_000_000 }; /** @type {any[]} */ const resumed = [], said = [];
  const r = await rig(t, { now: () => c.t, resume: async (/** @type {any} */ i) => { resumed.push(i); }, emit: (/** @type {string} */ type, /** @type {any} */ p) => said.push([type, p]) });
  const chat = (await r.g.chats.create(r.bob, { people: [] })).id;
  return { ...r, c, resumed, said, chat };
};
const texts = async (/** @type {any} */ view) => (await view.transcript(1)).map((/** @type {any} */ e) => e.line);

for (const kind of LENT_PROCESS_PROVIDERS) {
  test(`${kind}: the computer goes quiet, the server carries on from the last whole turn; the computer comes back and, under Always allow, takes the session again at the person's next message; no turn is lost or run twice`, async t => {
    const r = await clockRig(t); const c = r.as(BOB, "dev_laptop"); await c.vault.lease();
    const beat = (/** @type {boolean} */ well) => c.beat({ sessions: r.home.book.get("s1")?.where === "mac" ? [{ session: "s1", epoch: c.epochOf("s1"), turn: 3 }] : [], well, auto: true });
    // the session runs on the computer and completes three turns, each synced as it happens
    await c.spec({ session: "s1", chat: r.chat });
    for (const n of [1, 2, 3]) await c.sync.appendTranscript("s1", [{ seq: n, line: `turn ${n}` }]);
    await c.sync.putCheckpoint("s1", { turn: 3, seq: 3, manifest: {}, state: {} });
    assert.deepEqual((await beat(true)).fenced, []);
    // the network drops: nothing is heard for a lapse, and the home takes the session by itself
    r.c.t += LAPSE_MS + 1;
    await r.home.sweep();
    assert.equal(r.resumed.length, 1, "the server took it once, with no person acting");
    assert.deepEqual([r.resumed[0].session, r.resumed[0].epoch, r.resumed[0].reason], ["s1", 2, "offline"]);
    assert.equal((await r.resumed[0].view.checkpoint()).turn, 3, "from the last synced turn");
    assert.deepEqual(await texts(r.resumed[0].view), ["turn 1", "turn 2", "turn 3"], "every turn once, none missing");
    await r.home.sweep();
    assert.equal(r.resumed.length, 1, "taking it again changes nothing");
    // the computer's own late write, from before it was fenced, goes nowhere
    await assert.rejects(c.sync.appendTranscript("s1", [{ seq: 4, line: "turn 4, written on the computer after the server took over" }]), (/** @type {any} */ e) => e.code === "not_found");
    // the server carries on with its own turn while the computer is away
    await r.home.store.appendTranscript({ space: SPACE, hops: [] }, "s1", [{ seq: 4, line: "turn 4 on the server" }]);
    // it flaps: ready for a few beats, gone, ready again: no session comes back
    for (let n = 0; n < 4; n++) { r.c.t += 5000; await beat(true); }
    r.c.t += LAPSE_MS + 1; await beat(true);
    for (let n = 0; n < 4; n++) { r.c.t += 5000; await beat(true); }
    assert.equal(r.home.mayReturn("s1", BOB), false, "a computer that comes and goes gets nothing back");
    assert.equal(r.home.book.get("s1")?.where, "server");
    // it comes back and stays: ready beat after beat past the steady stretch and the cooldown
    for (let n = 0; n < (STEADY_MS + COOLDOWN_MS) / 5000 + 2; n++) { r.c.t += 5000; await beat(true); }
    assert.equal(r.home.book.get("s1")?.offer, "mac", "offered back");
    assert.equal(r.home.mayReturn("s1", BOB), true, "steadily ready, past the cooldown");
    assert.equal(r.home.mayReturn("s1", "per_carol"), false, "only the session's own person");
    // the person writes their next message: the chat goes out again with the server's whole turns, to the computer it left
    const placed = await r.home.adopt({ session: "s1", thread: "s1", chat: r.chat, person: BOB, native: "s1-native", lines: ["turn 5 carried back"], provider: kind, policy: true });
    assert.deepEqual([placed.where, placed.device], ["mac", "dev_laptop"]);
    assert.ok(placed.epoch >= 3);
    const spec = await c.spec({ session: "s1", chat: r.chat });
    assert.equal(spec.seed.provider, kind, "the computer seeds its own agent home in this kind's layout");
    // new turns run on the computer again, at the new epoch; the old epoch stays fenced
    await c.sync.appendTranscript("s1", [{ seq: 6, line: "turn 6 on the computer" }]);
    const raw = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) });
    await assert.rejects(raw.call("lent.appendTranscript", ["s1", [{ seq: 7, line: "from the epoch the server took" }], 2]), (/** @type {any} */ e) => e.code === "conflict");
    const HOME = { space: SPACE, hops: [] };
    const held = (await r.home.store.getTranscript(HOME, "s1", 1, 1_000_000)).map((/** @type {any} */ e) => e.line);
    assert.deepEqual(held, ["turn 1", "turn 2", "turn 3", "turn 4 on the server", "turn 5 carried back", "turn 6 on the computer"], "every turn once, in order, none lost, none repeated");
  });
}
