// @ts-check
// A member's own accounts, end to end, on a REAL daemon with the kernel on: an owner, two members, the real vault (the owner's and each member's own), the real google and mcp modules, a fake Google.
// The owner adds the firm key once and attests each member's work email. What this walks:
//   1 the member connects her own MCP server (mcp.mine.add) and it sits in HER vault: her lent-session config carries it, the other member's and the owner's do not;
//   2 the owner cannot read her token: not through the vault tools, not through mcp.servers, not on disk (the Space's data folder holds no trace of it);
//   3 through the firm key she reaches her own mailbox and no other: every Google call names her address, an owner or other account named in the input is refused, she cannot set her own email or add a key;
//   4 the other member, with no work email recorded, is refused and sees nothing.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { call } from "../daemon/client.js";
import { startFakeGoogle } from "../../lib/connectors/testing/fake-google.js";
import { allowLoopbackForTests } from "../../lib/http.js";
allowLoopbackForTests();

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
process.env.TZ = "UTC";
const ALICE = "per_" + "bcdefghijklmnopqrstuvwxyza", BOB = "per_" + "defghijklmnopqrstuvwxyzabc";
const A_MAIL = "alice@firm.test", B_MAIL = "bob@firm.test", O_MAIL = "owner@firm.test";
const TOKEN = "MEMBER-OWN-MCP-TOKEN-" + Math.random().toString(36).slice(2);
const PW = "a long master password for alice";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

async function rig(t) {
  const fake = await startFakeGoogle(t, { users: [A_MAIL, B_MAIL, O_MAIL] });
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null }, doorScopedGroups: ["mail", "calendar"] });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, SPACE = d.kernel.id.space;
  const chain = p => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s" });
  const set = m => d.kernel.gateway.grants.setRole(chain(OWNER), m, { presence: proof() });
  const owner = async (tool, input = {}) => call(tool, input, { root, caller: "cli" });
  await set({ person: ALICE, role: "member" }); await set({ person: BOB, role: "member" });
  assert.ok(!(await owner("roles.create", { role: { label: "Mailer", base: "member", can: ["view"], tools: ["mail", "calendar"] } })).error);
  await owner("roles.assign", { person: ALICE, role: "mailer" }); await owner("roles.assign", { person: BOB, role: "mailer" });
  const tok = async p => (await d.kernel.surfaces.open(chain(p), {})).token;
  const tokens = { alice: await tok(ALICE), bob: await tok(BOB) };
  /** a member's own surface (her app on a device): the person is the kernel's, the input names nobody */
  const as = (who, tool, input = {}) => d.registry.call(tool, input, "device:abcdefghijklmnop", { token: tokens[who], person: { id: "ps-" + who, kind: "passkey" } });
  return { d, fake, root, owner, as, SPACE, OWNER };
}

/** Every file under a folder, as one string (utf8, lossy), to look for a value that must not be there. */
const diskText = dir => { let out = ""; const walk = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { try { out += fs.readFileSync(f).toString("latin1"); } catch {} } } }; walk(dir); return out; };

test("a member's own MCP server and her own mailbox, and nobody else's", { timeout: 280_000 }, async t => {
  const { d, fake, root, owner, as, SPACE, OWNER } = await rig(t);
  const steps = [];
  const step = (name, ok) => { steps.push([name, ok]); assert.ok(ok, name); };

  // ---- the owner: the firm key, once; the owner's own account; each member's attested work email
  assert.ok(!(await owner("vault.put", { name: "firm-sa", kind: "secret", fields: { value: fake.serviceAccount(O_MAIL) } })).error);
  const gr = await owner("vault.grant", { name: "firm-sa", module: "google" });
  assert.equal(gr.data && gr.data.grant.status, "active", JSON.stringify(gr));
  const added = await owner("google.add", { name: "firm", email: O_MAIL, firm: true, domain: "firm.test", auth: { type: "service-account", item: "firm-sa" }, base: fake.base });
  step("owner adds the firm key", Boolean(added.data) && !added.error);
  assert.ok((await owner("google.add", { name: "mine", email: O_MAIL, auth: { type: "service-account", item: "firm-sa", subject: O_MAIL }, base: fake.base })).data);
  assert.ok((await owner("google.members.email", { person: ALICE, email: A_MAIL })).data, "alice's email attested");
  assert.ok((await owner("google.members.email", { person: OWNER, email: O_MAIL })).data, "the owner's own");

  // ---- 3: through the firm key she reaches her own mailbox only
  const mail = await as("alice", "google.mail.search", { q: "in:inbox" });
  step("alice searches her mail through the firm key", Boolean(mail.data) && !mail.error);
  const subjects = fake.apiCalls().filter(c => c.path.startsWith("/gmail/")).map(c => c.subject);
  step("every Gmail call was made as alice", subjects.length > 0 && subjects.every(s => s === A_MAIL));
  const named = await as("alice", "google.mail.search", { q: "x", account: "mine" });
  step("naming the owner's account in the input is refused", Boolean(named.error) && named.error.code === "no_account");
  const other = await as("alice", "google.mail.search", { q: "x", account: "firm", mailbox: O_MAIL, user: O_MAIL });
  step("a mailbox in the input changes nothing", fake.apiCalls().filter(c => c.path.startsWith("/gmail/")).every(c => c.subject === A_MAIL) && !(other.error && other.error.code === "ok"));
  const list = await as("alice", "google.calendar.next", {});
  step("her calendar is hers" + JSON.stringify(list.error || ""), !list.error && fake.apiCalls().filter(c => c.path.startsWith("/calendar/")).every(c => c.subject === A_MAIL));
  const sent = await as("alice", "google.mail.send", { to: "x@y.test", subject: "s", body: "b" });
  step("a send from the firm mailbox is refused for now", Boolean(sent.error));
  const own = await as("alice", "google.members.email", { person: ALICE, email: O_MAIL });
  step("she cannot set her own work email (or the owner's)", Boolean(own.error) && (await owner("google.members.email", {})).data.find(r => r.person === ALICE).email === A_MAIL);
  const key = await as("alice", "google.add", { name: "k2", email: A_MAIL, firm: true, domain: "firm.test", auth: { type: "service-account", item: "firm-sa" } });
  step("she cannot add a firm key", Boolean(key.error));
  const bobMail = await as("bob", "google.mail.search", { q: "x" });
  step("bob, with no work email recorded, is refused", Boolean(bobMail.error) && /work email/.test(bobMail.error.message));
  const ownerMail = await owner("google.mail.search", { q: "x" });
  step("the owner still reads their own mailbox (the firm key is not in their list)", !ownerMail.error);

  // ---- 1: her own MCP server in her own vault
  const made = await as("alice", "vault.me.account.create", { password: PW });
  step("alice makes her own vault " + JSON.stringify(made.error || ""), Boolean(made.data));
  const add = await as("alice", "mcp.mine.add", { name: "her-mail", type: "http", url: "https://mcp.example.com/mail", headers: { authorization: "Bearer " + TOKEN } });
  step("alice adds her own MCP server " + JSON.stringify(add.error || ""), !add.error && add.data && add.data.name === "her-mail");
  const mine = await as("alice", "mcp.mine.list", {});
  step("she lists it, without the token", !mine.error && mine.data.length === 1 && !JSON.stringify(mine.data).includes(TOKEN));
  const bobMine = await as("bob", "mcp.mine.list", {});
  step("bob has no vault, so sees none of hers (locked or absent, never hers)", !JSON.stringify(bobMine).includes(TOKEN) && !JSON.stringify(bobMine).includes("her-mail"));
  const spec = await d.registry.deps.memberMcpOf({ space: SPACE, person: ALICE });
  step("her lent-session config carries the server and its header", Boolean(spec) && spec.mcpServers["her-mail"].url === "https://mcp.example.com/mail" && spec.mcpServers["her-mail"].headers.authorization === "Bearer " + TOKEN);
  const bobSpec = await d.registry.deps.memberMcpOf({ space: SPACE, person: BOB }).catch(() => null);
  step("bob's config does not", !bobSpec || Object.keys(bobSpec.mcpServers || {}).length === 0);
  const ownerSpec = await d.registry.deps.memberMcpOf({ space: SPACE, person: OWNER }).catch(() => null);
  step("the owner's config does not", !ownerSpec || Object.keys(ownerSpec.mcpServers || {}).length === 0);

  // ---- 2: the owner cannot read her token
  const attempts = [["vault.list", {}], ["vault.get", { name: "her-mail" }], ["vault.me.store.list", {}], ["vault.me.store.get", { key: "mcp/her-mail" }], ["mcp.servers", {}], ["mcp.mine.list", {}]];
  for (const [tool, input] of attempts) {
    const r = await owner(tool, input);
    step(`owner: ${tool} shows nothing of hers`, !JSON.stringify(r).includes(TOKEN) && !JSON.stringify(r).includes("her-mail"));
  }
  await new Promise(r => setTimeout(r, 300));
  step("the Space's data folder holds no trace of the token", !diskText(root).includes(TOKEN));
  t.diagnostic(steps.map(([n, ok]) => `${ok ? "PASS" : "FAIL"} ${n}`).join("\n"));
});
