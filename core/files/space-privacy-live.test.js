// A chat's files in Drive search, on a real kernel-on daemon with the real work module: the chats come from the kernel the way `work.chat.list` gets them (the chat records the caller may read, kept where the kernel's chat read says they are in it), and every folder is read
// under the caller's own chain. A person in the chat finds its file names; a member who is not in it, though they see the chat exist in the list, finds nothing.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present, kernelCaller } from "../../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("Drive search on a real daemon: a participant finds a chat's file by name, a member outside the chat finds nothing, and the list a chat module gives is only where to look", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", sessions: { install: false } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const grants = d.kernel.gateway.grants;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" });
  const BOB = "per_" + "b".repeat(26), CAROL = "per_" + "c".repeat(26);
  for (const [p, n] of [[BOB, 2], [CAROL, 3]]) await grants.setRole(ownerChain, { person: p, role: "member" }, { presence: { op: "x", fields: {}, n } });
  const as = async (/** @type {string} */ person, /** @type {string} */ id) => ({ token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${id}`, person, path: "direct", session: `s-${id}` }), {})).token });
  const ownerCall = kernelCaller(d, root);
  const call = async (/** @type {any} */ who, /** @type {string} */ tool, /** @type {any} */ input) => (who === "owner" ? ownerCall(tool, input) : d.registry.call(tool, input, "cli", who));
  const B = await as(BOB, "b"), C = await as(CAROL, "c");

  const made = await call("owner", "work.chat.create", { title: "Docket check", people: [BOB] });
  assert.ok(made.data, JSON.stringify(made.error));
  const chat = made.data.chat;
  const row = (await call(B, "work.chat.list", {})).data.chats.find((/** @type {any} */ r) => r.chat === chat);
  assert.equal(row.open, true);
  assert.match(row.location, new RegExp(`^Projects/[^/]+/chat/${chat}/$`), "the row says where the chat lives");
  // a file in the chat's folder, written by a participant under their own chain
  const file = `${row.location}retainer-notes.txt`;
  await d.kernel.gateway.drive.put(ownerChain, file, new TextEncoder().encode("the SSN is 123"));

  const search = async (/** @type {any} */ who, /** @type {string} */ q) => { const r = await call(who, "files.drive.space.search", { q }); assert.ok(r.data, `${q}: ${JSON.stringify(r.error)}`); return r.data.results; };
  assert.deepEqual((await search(B, "retainer-notes")).map((/** @type {any} */ x) => [x.path, x.chat]), [[file, chat]], "a participant finds it, and the hit names its chat");
  assert.deepEqual((await search("owner", "retainer-notes")).map((/** @type {any} */ x) => x.path), [file], "the owner who made the chat is in it");
  const outsider = (await call(C, "work.chat.list", {})).data.chats.find((/** @type {any} */ r) => r.chat === chat);
  assert.ok(outsider && outsider.open === undefined, "a member outside the chat sees that it exists, not that it is theirs");
  assert.deepEqual(await search(C, "retainer-notes"), [], "and finds none of its files, by the exact name");
  assert.deepEqual(await search(C, chat), [], "nor by its id");
  assert.equal(JSON.stringify(await search(B, "retainer")).includes("SSN"), false, "names only");
  // leaving the chat ends it on the next call
  await grants.chats.change(ownerChain, chat, { remove_people: [BOB] });
  assert.deepEqual(await search(B, "retainer-notes"), [], "removed from the chat: nothing");
});
