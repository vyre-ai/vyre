// @ts-check
// A chat is filed only under a project the member owns or is on (work.chat.create -> hub.mayFileChat): being in a project's chat is a way onto its memory, so the chat is not a way onto the project. A name
// that matches no project makes no project for a member. The owner, no project named and her own project are as before. Through the member chat door on a real vyred with the kernel on. SHIM(presence)
// `kernelPresence` accepts any proof, as the other real-daemon suites do. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { createChatService } from "./chat-service.js";
import { holdersOf, createRing } from "../../lib/chat-keys.js";
import { newDeviceKey } from "../../lib/keywrap.js";
import { toB64u, fromB64u } from "../../lib/databox.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const person = (/** @type {string} */ id, /** @type {string} */ space) => ({ actor: { kind: "person", id, space } });

test("a member files a chat only under a project she owns or is on; an unknown name makes no project; the owner and 'no project' are as before", { timeout: 150_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner, SPACE = K.id.space;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const p of [ANA, BEN]) await K.gateway.grants.setRole(ownerChain, { person: p, role: "member" }, { presence: proof() });
  const chainOf = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "relay" });
  const chat = createChatService({ space: SPACE, kernel: K, registry: d.registry });
  const R = K.gateway.records, svc = K.gateway.serviceChain("work");
  const mk = (/** @type {string} */ slug, /** @type {string} */ owner) => R.create(ownerChain, "project", { name: slug, slug, status: "active", memory_scope: `project:${slug}`, owner: person(owner, SPACE) });
  await mk("owners-matter", OWNER); await mk("anas-matter", ANA);
  const count = async (/** @type {string} */ type) => (await R.query(svc, type, { page: { limit: 500 } })).rows.length;
  // a chat the way a device makes it: its id and its key ring (the server makes none for a chat it is asked to start without one)
  const dev = newDeviceKey(), agree = toB64u(Uint8Array.from([4, ...fromB64u(dev.publicJwk.x), ...fromB64u(dev.publicJwk.y)]));
  const body = (/** @type {string} */ project, /** @type {number} */ n) => { const id = `chat_00000000-0000-4000-8000-00000000000${n}`; return { id, ring: createRing(id, holdersOf([{ device: "dev_a", agree }])).doc, title: `chat ${n}`, ...(project ? { project } : {}) }; };
  const words = async (/** @type {Promise<any>} */ p) => { try { await p; return ""; } catch (e) { return `${/** @type {any} */ (e).code}: ${/** @type {any} */ (e).message}`; } };

  const projects0 = await count("project"), chats0 = await count("chat-record");
  // the owner's project, which she is not on: refused, and nothing was made
  assert.match(await words(chat.create(chainOf(ANA), body("owners-matter", 1))), /not_allowed.*not on the project owners-matter.*Ask the project's owner/s, "a member cannot file a chat under the owner's project");
  // a name that matches no project: no project made for her
  assert.match(await words(chat.create(chainOf(ANA), body("made-up-matter", 2))), /not_found.*Start the project first/s, "an unknown name makes no project");
  assert.equal(await count("project"), projects0, "no project row was made");
  assert.equal(await count("chat-record"), chats0, "and no chat row");
  // her own project, no project, and (once the owner puts her on its team) the owner's project
  assert.ok((await chat.create(chainOf(ANA), body("anas-matter", 3))).chat, "her own project");
  assert.ok((await chat.create(chainOf(ANA), body("", 4))).chat, "no project: her chat as before");
  const owners = (await R.query(svc, "project", { filter: { field: "slug", op: "eq", value: "owners-matter" }, page: { limit: 1 } })).rows[0];
  await R.create(ownerChain, "team-member", { name: "ana", actor: person(ANA, SPACE), kind: "person", project: { urn: owners.urn } });
  assert.ok((await chat.create(chainOf(ANA), body("owners-matter", 5))).chat, "on the team: the owner's project");
  // Ben is not on anything of hers
  assert.match(await words(chat.create(chainOf(BEN), body("anas-matter", 6))), /not_allowed/, "another member's project");
  // the owner files anywhere, and a new name still makes a project for the owner (as before)
  assert.ok((await chat.create(ownerChain, body("anas-matter", 7))).chat, "the owner, any project");

  // MOVING a chat is filing it too: into the owner's project (by short name or by record address) refused and nothing changes; into her own, allowed; the owner moves any chat as before
  // work.chat.move is a registry tool a person's own session calls (not on the member door): through a session token of that person
  const move = async (/** @type {string} */ person, /** @type {string} */ chatId, /** @type {string} */ project) => {
    const token = (await K.surfaces.open(person === OWNER ? ownerChain : chainOf(person), {})).token;
    return d.registry.call("work.chat.move", { chat: chatId, project }, "cli", { token });
  };
  const mover = await chat.create(chainOf(ANA), body("", 8));
  const projectOf = async (/** @type {string} */ chatId) => (await R.query(svc, "chat-record", { filter: { field: "chat", op: "eq", value: chatId }, page: { limit: 1 } })).rows[0].data.project.urn;
  const before = await projectOf(mover.chat);
  const byName = await move(ANA, mover.chat, "owners-matter");
  assert.match(JSON.stringify(byName.error || {}), /not on the project owners-matter/, "moving into the owner's project by name is refused: " + JSON.stringify(byName).slice(0, 200));
  const byUrn = await move(ANA, mover.chat, owners.urn);
  assert.match(JSON.stringify(byUrn.error || {}), /not on the project/, "and by record address");
  assert.equal(await projectOf(mover.chat), before, "the chat stayed where it was");
  const own = await move(ANA, mover.chat, "anas-matter");
  assert.ok(!own.error, "into her own project: " + JSON.stringify(own.error));
  assert.notEqual(await projectOf(mover.chat), before, "and it moved");
  const ownerChat = await chat.create(ownerChain, body("", 9));
  const byOwner = await move(OWNER, ownerChat.chat, "anas-matter");
  assert.ok(!byOwner.error, "the owner moves a chat into any project: " + JSON.stringify(byOwner.error));
});
