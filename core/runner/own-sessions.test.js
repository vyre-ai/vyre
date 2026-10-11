// @ts-check
// A computer runs only its own person's sessions, and nobody else reaches them (the product ruling of 10 Oct, G02). Bob's session runs on Bob's computer; Carol is another member of the same Space with her own computer. Every way
// in the home offers is tried as Carol and answers "not found" or places nothing: the lender's calls (pipe, http, preview, stop, release, files), the home's own (preview bridge, placement, adoption), and a spawn
// asked for in Bob's session by anyone but Bob.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import { rig, BOB, CAROL } from "./testing/lent-rig.js";

const SESSION = "s_own_1";
// only the refusals that mean "this is not yours": a malformed call or an unrelated conflict must not pass for one
const refused = (/** @type {any} */ e) => ["not_found", "not_allowed"].includes(e && e.code);

test("another member reaches nothing of a session that runs on a person's own computer, by any call the home offers", { timeout: 60_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const r = await rig(t);
  const bob = r.as(BOB, "dev_laptop");
  await bob.vault.lease(); await r.home.status(r.bob, { device_key: "KEY_LAPTOP" }); await bob.beat({ sessions: [], well: true });
  const proc = r.home.spawn({ session: SESSION, person: BOB, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
  await bob.beat({ sessions: [], well: true }); await bob.spec({ session: SESSION });
  assert.equal(r.home.book.get(SESSION)?.person, BOB);
  t.after(() => { try { proc.kill(); } catch { /* gone */ } });

  // the same calls are answered for Bob (so the refusals below are about whose session it is, not about a malformed call)
  await bob.pipe({ session: SESSION, up: [], ack: 0, wait_ms: 0 });
  await bob.preview({ session: SESSION, replies: [], wait_ms: 0 });
  // the calls that carry the definition, the history, the files and the checkpoint answer for Bob (so the refusals below are about whose session it is)
  const spec = await bob.spec({ session: SESSION });
  assert.ok(spec && spec.epoch >= 1, "Bob gets his session's definition");
  await bob.sync.appendTranscript(SESSION, [{ seq: 1, line: "{\"n\":1}" }]);
  await bob.sync.putFile(SESSION, "files/a.txt", Buffer.from("bob's"));
  assert.equal((await bob.sync.getTranscript(SESSION, 1, 10)).length, 1);
  assert.equal(Buffer.from(await bob.sync.getFile(SESSION, "files/a.txt", 1)).toString(), "bob's");
  await bob.sync.putCheckpoint(SESSION, { turn: 1, seq: 1, manifest: {}, state: {} }).catch(() => {});
  assert.ok(await bob.whoami(), "Bob is known");
  // Carol, with her own computer, calls every lender entry for Bob's session
  const carol = r.as(CAROL, "dev_carol");
  await assert.rejects(carol.pipe({ session: SESSION, up: [], ack: 0, wait_ms: 0 }), refused, "pipe");
  await assert.rejects(carol.http({ session: SESSION, method: "GET", path: "/v1/tools/threads.list", body: "", caller: "x" }), refused, "tool door");
  await assert.rejects(carol.preview({ session: SESSION, replies: [], wait_ms: 0 }), refused, "preview");
  await assert.rejects(carol.stop(SESSION), refused, "stop");
  await assert.rejects(carol.release({ session: SESSION, reason: "you" }), refused, "release");
  await assert.rejects(carol.sync.getCheckpoint(SESSION), refused, "checkpoint");
  await assert.rejects(carol.sync.appendTranscript(SESSION, [{ seq: 1, line: "x" }]), refused, "transcript");
  await assert.rejects(carol.spec({ session: SESSION }), refused, "the definition of Bob's session (lent.start)");
  await assert.rejects(carol.sync.getTranscript(SESSION, 1, 10), refused, "Bob's history");
  await assert.rejects(carol.sync.putFile(SESSION, "files/a.txt", Buffer.from("carol's")), refused, "a file into Bob's session");
  await assert.rejects(carol.sync.getFile(SESSION, "files/a.txt", 1), refused, "Bob's file");
  await assert.rejects(carol.sync.putCheckpoint(SESSION, { turn: 1, seq: 1, manifest: {}, state: {} }), refused, "a checkpoint of Bob's session");
  { const before = JSON.stringify(r.home.book.get(SESSION)); await carol.beat({ sessions: [{ session: SESSION, epoch: 1 }], well: true }).catch(() => {}); assert.equal(JSON.stringify(r.home.book.get(SESSION)), before, "a beat of Carol's that names Bob's session changes nothing of his"); }
  // and the home's own entries, asked for Carol
  await assert.rejects(r.home.openPreview({ session: SESSION, port: 4311, person: CAROL }), refused, "preview bridge");
  assert.equal(r.home.placeNew({ session: SESSION, person: CAROL }).where, "box", "placing Bob's session for Carol places nothing");
  await assert.rejects(r.home.adopt({ session: SESSION, thread: SESSION, person: CAROL, native: "n", lines: ["x"] }), refused, "adopt");
  const spawned = r.home.spawn({ session: SESSION, person: CAROL, command: process.execPath, args: ["-e", ""] });
  const state = await new Promise(res => { spawned.once("error", (/** @type {any} */ e) => res(e && e.code)); spawned.once("spawn", () => res("started")); setTimeout(() => res("never"), 2500); });
  assert.notEqual(state, "started", "a spawn of Bob's session for Carol never starts on a computer: " + state);
  // Bob's session is still Bob's, on his computer
  const row = r.home.book.get(SESSION);
  assert.deepEqual([row?.person, row?.where, row?.device], [BOB, "mac", "dev_laptop"]);
});

test("a chat that came back from a computer goes out again with the server's whole turns after what the home holds, and the computer seeds from those alone", { timeout: 60_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const r = await rig(t);
  const bob = r.as(BOB, "dev_laptop");
  await bob.vault.lease(); await r.home.status(r.bob, { device_key: "KEY_LAPTOP" }); await bob.beat({ sessions: [], well: true });
  // the first stay on the computer left what its program printed in the home's store (not the provider's session file), and the chat came back to the server
  const proc = r.home.spawn({ session: SESSION, person: BOB, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
  t.after(() => { try { proc.kill(); } catch { /* gone */ } });
  await bob.beat({ sessions: [], well: true }); await bob.spec({ session: SESSION });
  await bob.sync.appendTranscript(SESSION, [{ seq: 1, line: "{\"stream\":1}" }, { seq: 2, line: "{\"stream\":2}" }]);
  r.home.book.toServer(SESSION, "you");
  const server = ["{\"type\":\"user\",\"n\":1}", "{\"type\":\"assistant\",\"n\":2}", "{\"type\":\"user\",\"n\":3}"];
  const had = 2;
  await r.home.adopt({ session: SESSION, thread: SESSION, chat: "chat_o", person: BOB, native: SESSION, lines: server });
  const all = await r.home.view(SESSION).transcript(1, 1_000_000);
  assert.equal(all.length, had + server.length, "the server's turns go in after what the home held; nothing is refused for being shorter");
  const spec = await bob.spec({ session: SESSION });
  assert.deepEqual([spec.seed && spec.seed.count, spec.seed && spec.seed.from], [server.length, had + 1], "the computer seeds from the server's turns alone");
});
