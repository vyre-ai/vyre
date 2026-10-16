// @ts-check
// A chat with more than one person runs on the space's server, through the real daemon: a chat of one person that runs on that person's computer, a two-person add through work.chat.change. The chat says one line, the
// computer hands the chat over (here a stand-in that answers the home's ask the way a lender does), and only then is the person added; the person sees the chat; the chat is never placed on a computer again. A chat
// working in a folder of the computer takes no one.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present, kernelCaller } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { until, FAKE } from "../sessions/testing/boot.js";
import { createRing, addHolders } from "../../lib/chat-keys.js";
import { newDeviceKey, fingerprint } from "../../lib/keywrap.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

const sealed = () => { const d = newDeviceKey(), id = `chat_${crypto.randomUUID()}`; const made = createRing(id, { [fingerprint(d.publicJwk)]: d.publicJwk }); return { id, ring: made.doc, keys: made.keys }; };

test("adding a person to a chat that runs on a computer: one line, the chat moves to the server, then the person is added and sees it; a folder chat takes no one", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  asOwner(d, root);
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner, space = d.kernel.id.space;
  const grants = d.kernel.gateway.grants;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" });
  const CAROL = "per_" + "c".repeat(26);
  await grants.setRole(ownerChain, { person: CAROL, role: "member" }, { presence: { op: "x", fields: {}, n: 3 } });
  const as = async (/** @type {string} */ person, /** @type {string} */ id) => ({ token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${id}`, person, path: "direct", session: `s-${id}` }), {})).token });
  const ownerCall = kernelCaller(d, root);
  const call = async (/** @type {any} */ who, /** @type {string} */ tool, /** @type {any} */ input) => (who === "owner" ? ownerCall(tool, input) : d.registry.call(tool, input, "cli", who));
  const C = await as(CAROL, "c");

  // a chat of one person, with a run that finished
  const mk = sealed();
  const made = await call("owner", "work.chat.create", { title: "Docket check", people: [], id: mk.id, ring: mk.ring });
  assert.ok(made.data, JSON.stringify(made.error));
  const chat = made.data.chat;
  const run = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck", chat, asker: owner }, "module:stream");
  assert.ok(run.data, JSON.stringify(run.error));
  const thread = run.data.id;
  const get = async () => (await d.registry.call("threads.get", { thread, limit: 200 }, "cli")).data;
  await until(async () => (await get()).events.some((/** @type {any} */ e) => e.type === "thread.finished"), "the turn");

  // that run is on the owner's computer, as the home's book says
  const home = /** @type {any} */ (d.registry.deps).lentHome(space);
  assert.ok(home, "this daemon is the home of its space");
  home.book.lend({ session: thread, chat, person: owner, device: "dev_office_mac", key: null });
  assert.equal(home.book.get(thread).where, "mac");

  // the stand-in for the computer: it answers the home's ask the way a lender does, handing the chat over; it notes who was in the chat at that moment
  /** @type {string[] | null} */ let peopleAtMove = null;
  const lender = setInterval(() => {
    const row = home.book.get(thread);
    if (row && row.where === "mac" && row.ask && row.ask.do === "release") {
      peopleAtMove = [...grants.chats.read(ownerChain, chat).people];
      void home.takeOver(thread, "you");
    }
  }, 25);
  t.after(() => clearInterval(lender));

  const cd = newDeviceKey();
  const added = await call("owner", "work.chat.change", { chat, add_people: [CAROL], ring: addHolders(mk.ring, mk.keys, { add: { [fingerprint(cd.publicJwk)]: cd.publicJwk } }) });
  clearInterval(lender);
  assert.ok(added.data, JSON.stringify(added.error));
  assert.deepEqual([...added.data.people].sort(), [owner, CAROL].sort());
  assert.deepEqual(peopleAtMove, [owner], "the chat moved to the server while she was not yet in it");
  assert.equal(home.book.get(thread).where, "server", "the chat runs on the server");
  const lines = (await get()).events.filter((/** @type {any} */ e) => e.type === "thread.text" && /moves to the server so/.test(JSON.stringify(e.payload)));
  assert.equal(lines.length, 1, "one line in the chat");
  assert.match(JSON.stringify(lines[0].payload), /This chat moves to the server so .+ can join\./);
  const seen = (await call(C, "work.chat.list", {})).data.chats.find((/** @type {any} */ r) => r.chat === chat);
  assert.ok(seen, "she sees the chat");
  // a chat with more than one person is never placed on a computer again
  assert.deepEqual(home.placeNew({ session: "s_new", chat, person: owner }), { where: "box" });
  await assert.rejects(Promise.resolve(home.adopt({ session: thread, thread, chat, person: owner, native: "n", lines: ["x"] })), (/** @type {any} */ e) => e.code === "conflict");

  // a chat working in a folder of the computer stays there and takes no one
  const mk2 = sealed();
  const folderChat = (await call("owner", "work.chat.create", { title: "Folder chat", people: [], id: mk2.id, ring: mk2.ring })).data.chat;
  home.book.lend({ session: "s_folder", chat: folderChat, person: owner, device: "dev_office_mac", key: null, folder: "fld_0123456789ab" });
  const refused = await call("owner", "work.chat.change", { chat: folderChat, add_people: [CAROL], ring: addHolders(mk2.ring, mk2.keys, { add: { [fingerprint(cd.publicJwk)]: cd.publicJwk } }) });
  assert.ok(refused.error && /folder on your computer/.test(refused.error.message), JSON.stringify(refused));
  assert.deepEqual([...grants.chats.read(ownerChain, folderChat).people], [owner], "nobody was added");
  assert.equal(home.book.get("s_folder").where, "mac");
});
