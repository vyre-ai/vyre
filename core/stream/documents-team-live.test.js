// @ts-check
// Documents in a TEAM chat (G25 crossSpace): the model's documents.template.list, .get and .generate run in the chat's Space as the member who spoke.
// (World as team-chat-live.test.js: a shared chat in a TEAM Space on a real vyred (kernel on, fake claude as a real child process): a member says something through the member door (core/work/chat-service.js) and the assistant answers in
// that chat, as a turn that belongs to the team's chat: the chat's record and its people are the team Space's kernel's, the turn is asked for the member who spoke, and nothing of it is written into the
// home's own chats. Stand-in, labelled: SHIM(presence) `kernelPresence` accepts any proof for the owner's grants acts, as the other real-daemon suites do.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "../sessions/testing/boot.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const OWNER = "per_" + "abcdefghijklmnopqrstuvwxyz", ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 30_000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await f(); if (last) return last; } catch (e) { last = e; } await sleep(100); } throw new Error(`timed out waiting for ${what}: ${last && /** @type {any} */ (last).message || ""}`); };

/** @param {any} t */
async function world(t) {
  /** @type {string[]} */ const lines = [];
  const w = await boot(t, { driver: "cli", kernel: true, log: (/** @type {any} */ m) => { lines.push(String(m)); } });
  /** @type {any} */ (w).lines = lines;
  const d = w.d;
  const firm = await d.kernel.spaces.host({ owner: OWNER, name: "Harlow Legal" });
  const owner = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN]) await firm.gateway.grants.setRole(owner, { person, role: "member" }, { presence: proof() });
  const assistant = { kind: "agent", id: "assistant", space: firm.space };
  await firm.gateway.grants.addActor(owner, assistant, { presence: proof() }).catch(() => {});
  const svc = /** @type {any} */ (d.registry.modules.get("work")).handle.peerService({ space: firm.space, kernel: firm.kernel, registry: d.registry });
  const chainOf = (/** @type {string} */ person) => firm.kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  return { w, d, firm, svc, as: (/** @type {string} */ person, /** @type {string} */ call, input = {}) => svc[call](chainOf(person), input) };
}


import { docx } from "../documents/testing/docx.js";

test("a model's documents tools in a team turn run in the team Space as the member: its templates are listed and read, a document is made in its Drive, and the home's Drive is not touched", { timeout: 200_000 }, async t => {
  const { w, as, firm } = await world(t);
  const lines = /** @type {string[]} */ (/** @type {any} */ (w).lines);
  const owner = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const ana = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${ANA.slice(4, 8)}`, person: ANA, path: "relay" });
  await firm.kernel.drive.put(owner, "Templates/Team letter.docx", new Uint8Array(docx(["Dear {client}, welcome to the team."])));
  const made = await as(ANA, "create", { title: "Team documents", people: [BEN], agents: ["assistant"] });
  await as(ANA, "reply-mode", { chat: made.chat, mode: "every" });
  const assistantSaid = async () => ((await as(BEN, "catchup", { chat: made.chat })).messages || []).filter((/** @type {any} */ m) => /^assistant:/.test(String(m.author))).map((/** @type {any} */ m) => String(m.text));
  const waitFor = async (/** @type {RegExp} */ re, /** @type {string} */ what) => { let said = /** @type {string[]} */ ([]); await until(async () => { said = await assistantSaid(); return said.some(x => re.test(x)); }, what).catch(e => { throw new Error(`${e.message} :: ${said.join(" | ").slice(0, 500)} :: ${lines.filter(l => /documents|stream|threads/.test(l)).slice(-6).join(" | ")}`); }); return said.find(x => re.test(x)) || ""; };
  await as(ANA, "send", { chat: made.chat, text: "vyre documents.template.list {}" });
  const listed = await waitFor(/Team letter/, "the template list, from the team Space");
  assert.ok(/Team letter/.test(listed), listed.slice(0, 300));
  await as(ANA, "send", { chat: made.chat, text: 'vyre documents.template.get {"name":"Team letter"}' });
  assert.match(await waitFor(/"client"|client/, "the template's placeholders"), /client/);
  await as(ANA, "send", { chat: made.chat, text: 'vyre documents.generate {"template":"Team letter","values":{"client":"Dana"},"name":"Welcome Dana"}' });
  const gen = await waitFor(/Documents\/general\/welcome-dana-[0-9a-f]{8}\.docx|not_in_team_space|denied/, "the generated document");
  assert.match(gen, /Documents\/general\/welcome-dana-[0-9a-f]{8}\.docx/, gen.slice(0, 300));
  const path = /Documents\/general\/welcome-dana-[0-9a-f]{8}\.docx/.exec(gen)?.[0] || "";
  await firm.gateway.drive.get(ana, path);
  await assert.rejects(() => w.d.kernel.gateway.drive.get(w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-home", person: w.d.kernel.id.owner, path: "direct", session: "s" }), path), "the home's own Drive has no such document");
});
