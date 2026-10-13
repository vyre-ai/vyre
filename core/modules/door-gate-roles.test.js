// @ts-check
// The door gate reads the allowed tools PER ROLE (core/modules/door-gate.js, TOOL_GROUPS and GUEST_MAY in door-lists.js) on a REAL daemon with the kernel on: a Member has MEMBER_MAY without mail, calendar and
// computers; a Guest has the smaller GUEST_MAY; a custom role (Member-based) turns on the tool groups it names and no more; a change of role is read at the next call; the owner and admins are served as before.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { MEMBER_MAY, OWNER_ONLY, GUEST_MAY, TOOL_GROUPS, GROUP_OF, PLUMBING, SELF_GATED } from "./door-lists.js";
import { refusal, guestRefusal } from "./door-gate.js";
import { TOOL_IDS } from "../roles/catalogue.js";
import { request, call } from "../daemon/client.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const MEMBER = "per_" + "bcdefghijklmnopqrstuvwxyza";
const MEMBER2 = "per_" + "defghijklmnopqrstuvwxyzabc";
const GUEST = "per_" + "efghijklmnopqrstuvwxyzabcd";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

/** A team server: the owner, two members and a guest, each with a model session token. @param {any} t */
async function rig(t) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner;
  const chain = (/** @type {string} */ p) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s" });
  const set = (/** @type {any} */ m) => d.kernel.gateway.grants.setRole(chain(OWNER), m, { presence: proof() });
  await set({ person: MEMBER, role: "member" });
  await set({ person: MEMBER2, role: "member" });
  await set({ person: GUEST, role: "temp", scope: [`vyre://${d.kernel.id.space}/project/p1`], expires: Date.now() + 86_400_000 });
  const tok = async (/** @type {string} */ p) => (await d.kernel.surfaces.open(chain(p), { agent: "assistant" })).token;
  const tokens = { owner: await tok(OWNER), member: await tok(MEMBER), member2: await tok(MEMBER2), guest: await tok(GUEST) };
  /** @type {(who: keyof typeof tokens, tool: string, input?: any) => Promise<any>} */
  const as = (who, tool, input = {}) => d.registry.call(tool, input, "mcp:agent:assistant", { thread: "t1", agent: "assistant", agentKind: "assistant", token: tokens[who] });
  const owner = async (/** @type {string} */ tool, /** @type {any} */ input) => { const r = await call(tool, input, { root, caller: "cli" }); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  const names = async (/** @type {string} */ token) => new Set(((await request("GET", "/v1/tools", undefined, { root, caller: "cli", headers: { "x-vyre-kernel-session": token } })).data || []).map((/** @type {any} */ x) => x.name));
  return { d, as, owner, names, tokens, root };
}
const met = (/** @type {any} */ r, /** @type {string} */ words) => Boolean(r && r.error && r.error.code === "denied" && r.error.message === words);
const gated = (/** @type {any} */ r, /** @type {string} */ tool) => met(r, refusal(tool)) || met(r, guestRefusal());

test("a Member has no mail, calendar or computers until a role turns them on; her own tools still answer", { timeout: 200_000 }, async t => {
  const { as, owner } = await rig(t);
  for (const tool of ["mail.accounts", "mail.send", "google.calendar.list", "google.calendar.create", "computers.list", "computer.targets", "documents.template.list", "publish.list", "files.search", "chrome.open"]) {
    assert.ok(met(await as("member", tool), refusal(tool)), `${tool}: a Member is refused`);
  }
  for (const tool of ["records.list", "planner.add", "threads.list", "stream.catchup"]) assert.ok(!gated(await as("member", tool), tool), `${tool}: a Member keeps her own tools`);
  assert.ok(!gated(await as("owner", "mail.accounts"), "mail.accounts"), "the owner is served");
  void owner;
});

test("a Guest has the smaller list: sign-in, chat, shared records and files only", { timeout: 200_000 }, async t => {
  const { as } = await rig(t);
  for (const tool of ["records.list", "stream.catchup", "threads.list", "tasks.list", "presence.person.status"]) assert.ok(!gated(await as("guest", tool), tool), `${tool}: a Guest has it`);
  for (const tool of ["agents.create", "flows.start", "memory.facts", "records.create", "spaces.members.list", "files.drive.unshare"]) assert.ok(met(await as("guest", tool), guestRefusal()), `${tool}: a Guest is refused in words that name a next step`);
  for (const tool of ["mail.accounts", "computers.list", "publish.list"]) assert.ok(met(await as("guest", tool), refusal(tool)), `${tool}: a Guest has no group`);
  for (const tool of GUEST_MAY) assert.ok(MEMBER_MAY.has(tool), `${tool} is on a Member's list too`);
  assert.match(guestRefusal(), /Ask the owner or an admin/);
});

test("a custom role turns on exactly the groups it names, for the people who hold it, and no more; a change is read at the next call", { timeout: 300_000 }, async t => {
  const { as, owner } = await rig(t);
  await owner("roles.create", { role: { label: "Mailer", base: "member", can: ["view"], tools: ["mail", "documents"] } });
  await owner("roles.assign", { person: MEMBER, role: "mailer" });
  for (const tool of TOOL_GROUPS.mail.concat(TOOL_GROUPS.documents)) assert.ok(!gated(await as("member", tool), tool), `${tool}: the Mailer has it`);
  for (const tool of [...TOOL_GROUPS.calendar, ...TOOL_GROUPS.computers, ...TOOL_GROUPS.publish, ...TOOL_GROUPS.browser, ...TOOL_GROUPS.files]) assert.ok(met(await as("member", tool), refusal(tool)), `${tool}: not in her groups`);
  // never wider than a Member in what a group does not hold: the set-up tools of the same areas, the owner's other tools
  for (const tool of ["mail.test", "google.accounts", "google.connect", "connectors.connection.list", "settings.set", "spend.raise", "publish.domain.add", "computers.pause", "mcp.servers", "vault.list"]) {
    assert.ok(!(await as("member", tool)).data, `${tool}: a custom role never opens it`);
  }
  assert.ok(met(await as("member", "mail.test"), refusal("mail.test")), "mail.test is set-up, not in the mail group");
  assert.ok(met(await as("member2", "mail.accounts"), refusal("mail.accounts")), "a Member who does not hold the role has none of it");
  // the role is edited: the holder loses mail at her next call
  await owner("roles.update", { id: "mailer", role: { tools: ["documents"] } });
  assert.ok(met(await as("member", "mail.accounts"), refusal("mail.accounts")), "mail is off after the role changed");
  assert.ok(!gated(await as("member", "documents.template.list"), "documents.template.list"), "documents is still on");
  // the person goes back to Member
  await owner("roles.assign", { person: MEMBER, role: "member" });
  assert.ok(met(await as("member", "documents.template.list"), refusal("documents.template.list")), "a plain Member again");
});

test("a member's tool list shows what her role allows: a Guest fewer, a custom role its groups", { timeout: 300_000 }, async t => {
  const { owner, names, tokens } = await rig(t);
  await owner("roles.create", { role: { label: "Mailer", base: "member", can: ["view"], tools: ["mail"] } });
  await owner("roles.assign", { person: MEMBER, role: "mailer" });
  const plain = await names(tokens.member2), mailer = await names(tokens.member), guest = await names(tokens.guest), boss = await names(tokens.owner);
  assert.ok(!plain.has("mail.accounts") && !plain.has("computers.list"), "a plain Member's list has no mail or computers");
  assert.ok(mailer.has("mail.accounts") && mailer.has("mail.send") && !mailer.has("computers.list") && !mailer.has("mail.test"), "the Mailer's list has the mail group only");
  assert.ok(guest.has("records.list") && guest.has("stream.send") && !guest.has("agents.create") && !guest.has("mail.accounts"), "a Guest's list is the smaller one");
  assert.ok(guest.size < plain.size, "a Guest sees fewer tools than a Member");
  assert.ok(boss.has("mail.accounts") && boss.has("computers.list"), "the owner's list is whole");
});

test("the groups: every tool is registered, owner-only, in one group, and no group names the vault, the harness hooks or a Member's own tool; the ids are the roles module's", { timeout: 200_000 }, async t => {
  const { d } = await rig(t);
  assert.deepEqual(Object.keys(TOOL_GROUPS).sort(), [...TOOL_IDS].sort(), "the groups are exactly the tool ids a role can name");
  const all = Object.values(TOOL_GROUPS).flat();
  assert.equal(new Set(all).size, all.length, "no tool is in two groups");
  for (const tool of all) {
    assert.ok(d.registry.tools.has(tool), `${tool} is registered`);
    assert.ok(OWNER_ONLY.has(tool) && !MEMBER_MAY.has(tool) && !PLUMBING.has(tool) && !SELF_GATED.has(tool), `${tool} is on OWNER_ONLY alone`);
    assert.ok(GROUP_OF.get(tool), `${tool} has its group`);
    assert.ok(!tool.startsWith("vault.") && !tool.startsWith("settings.") && !tool.startsWith("spend."), `${tool} is not a vault, settings or spend tool`);
  }
});
