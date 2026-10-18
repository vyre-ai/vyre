// @ts-check
// Every project has one group chat. work.project.chat finds it or makes it on first use (everyone on the project's team), says who is missing from it and who is in it without being on the team, and
// leaves applying that gap to a member's own device (work.chat.change with the ring). Real daemon, kernel on. Run on a test box, never on a Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start, callerFacts } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { projectChatId } from "./threads.js";
import { holdersOf, createRing, addHolders } from "../../lib/chat-keys.js";
import { newDeviceKey, fingerprint } from "../../lib/keywrap.js";
import { toB64u, fromB64u } from "../../lib/databox.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", CY = "per_" + "defghijklmnopqrstuvwxyzabc", DEE = "per_" + "efghijklmnopqrstuvwxyzabcd";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a project's group chat is made once for its team, its gap is reported, a non-reader and a viewer are handled", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner, SPACE = K.id.space;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const p of [BEN, CY, DEE]) await K.gateway.grants.setRole(ownerChain, { person: p, role: "member" }, { presence: proof() });
  const tok = async (/** @type {string} */ p) => (p === OWNER ? { kernelFacts: callerFacts("cli", {}, {}, K, false, null, { inside: false, outside: true }) } : { token: (await K.surfaces.open(K.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s-" + p.slice(4, 8) }))).token });
  const as = async (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", await tok(who));
  const ok = async (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await as(who, tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  const link = (/** @type {string} */ id) => ({ actor: { kind: "person", id, space: SPACE } });
  const proj = await K.gateway.records.create(ownerChain, "project", { name: "Acme", slug: "acme", status: "active", memory_scope: "project:acme", owner: link(OWNER) });
  const seat = (/** @type {string} */ id, /** @type {string} */ level) => K.gateway.records.create(ownerChain, "team-member", { name: id.slice(4, 8), actor: link(id), kind: "person", level, project: { urn: proj.urn } });
  await seat(BEN, "contributor"); await seat(CY, "viewer");
  await ok(OWNER, "agents.create", { name: "juno", kind: "agent" });

  const dev = newDeviceKey(), agree = toB64u(Uint8Array.from([4, ...fromB64u(dev.publicJwk.x), ...fromB64u(dev.publicJwk.y)]));
  const id = projectChatId(proj.urn), made = createRing(id, holdersOf([{ device: "dev_a", agree }]));
  // end to end: with no ring from a device nothing is made, and the answer names the id to make the ring for
  const need = await ok(OWNER, "work.project.chat", { project: "acme" });
  assert.deepEqual([need.chat, need.needs_ring, need.id], [null, true, id]);
  // the chat_pj_ ids are the project chat's alone: no create path takes one from a caller
  for (const [tool, input] of /** @type {[string, any][]} */ ([["work.chat.create", { title: "x" }], ["work.chat.thread.new", { people: [BEN], title: "x" }], ["work.agent.thread.new", { agent: "juno", title: "x" }], ["work.thread.fork", { thread: "chat_nothing", message: "m1", title: "x" }]])) {
    const r = await as(OWNER, tool, { ...input, id, ring: made.doc });
    assert.equal(r.error?.code, "bad_input", `${tool} refuses a reserved id: ${JSON.stringify(r.error)}`);
  }
  const first = await ok(OWNER, "work.project.chat", { project: "acme", ring: made.doc });
  assert.equal(first.chat, id, "the project's chat has an id the project fixes");
  assert.match(first.chat, /^chat_pj_/);
  assert.deepEqual([...first.people].sort(), [BEN, OWNER].sort(), "everyone on the team who writes: the owner and Ben, not the viewer");
  assert.deepEqual([first.missing, first.extra], [[], []]);
  assert.deepEqual(first.readonly, [CY], "the viewer reads and does not write, so is not in the chat");
  const again = await ok(BEN, "work.project.chat", { project: "acme" });
  assert.equal(again.chat, first.chat, "one chat per project, whoever asks");
  const rows = (await ok(OWNER, "work.chat.list", {})).chats.filter((/** @type {any} */ c) => c.project_chat);
  assert.equal(rows.length, 1, "and one record carries the flag");

  // a new teammate is a gap until a member's device applies it
  await seat(DEE, "contributor");
  const gap = await ok(BEN, "work.project.chat", { project: "acme" });
  assert.deepEqual([gap.missing, gap.extra], [[DEE], []]);
  assert.equal((await as(DEE, "work.chat.get", { chat: first.chat })).error ? "refused" : "read", "refused", "until added, Dee cannot read it");
  // a member's device applies the gap: the kernel's own change with the grown ring, then the gap is gone
  const dd = newDeviceKey();
  const grown = addHolders(made.doc, made.keys, { add: { [fingerprint(dd.publicJwk)]: dd.publicJwk } });
  await ok(BEN, "work.chat.change", { chat: first.chat, add_people: gap.missing, ring: grown });
  const healed = await ok(OWNER, "work.project.chat", { project: "acme" });
  assert.deepEqual([healed.missing, healed.extra, healed.people.includes(DEE)], [[], [], true]);
  assert.ok(!(await as(DEE, "work.chat.get", { chat: first.chat })).error, "Dee reads it now");
  // a person made a viewer is in the chat without writing there, and is reported as extra
  await ok(OWNER, "work.project.level", { project: "acme", person: DEE, level: "viewer" });
  assert.deepEqual((await ok(OWNER, "work.project.chat", { project: "acme" })).extra, [DEE]);
  // someone off the team who cannot read the project is told it is not found
  const cyRead = await as(CY, "work.project.chat", { project: "acme" });
  assert.ok(!cyRead.error, "a viewer may open the project's chat entry");
  assert.deepEqual([cyRead.data.chat, cyRead.data.readonly_for_you], [first.chat, true]);
  assert.equal((await as(BEN, "work.project.chat", { project: "nope" })).error?.code, "not_found");
  assert.ok((await d.registry.call("work.project.chat", { project: "acme" }, "mcp", {})).error, "a call with no person has no project chat");
});
