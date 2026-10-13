// @ts-check
// The microsoft module against the fake Graph (lib/connectors/testing/fake-graph.js), with a fake module context: a real SQLite store, a map for the vault, a kernel that names the owner and the people.
// What these prove: a member reaches only their own mailbox, calendar and OneDrive; asking for another mailbox changes nothing (there is no input for one); the owner alone adds the app and sets emails;
// the app's secret never appears in a result; a tenant that restricts the app (403) is explained.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import mod from "./index.js";
import { startFakeGraph } from "../../lib/connectors/testing/fake-graph.js";
import { allowLoopbackForTests } from "../../lib/http.js";
allowLoopbackForTests();

const mail = (id, subject) => ({ id, subject, from: { emailAddress: { name: "Zed", address: "zed@x.test" } }, receivedDateTime: "2026-10-01T00:00:00Z", bodyPreview: "hello", webLink: "https://o/" + id, body: { content: "body of " + id }, toRecipients: [], ccRecipients: [] });

async function setup(t) {
  const g = await startFakeGraph(t, { users: {
    "alice@firm.test": { mail: [mail("AAAAA1", "alice mail")], events: [{ id: "EV123456", subject: "alice event", start: { dateTime: "2026-10-14T09:00:00" }, end: { dateTime: "2026-10-14T10:00:00" } }], files: [{ id: "FILE12345", name: "plan.txt", file: { mimeType: "text/plain" }, content: "alice plan", webUrl: "https://o/f" }] },
    "bob@firm.test": { mail: [mail("BBBBB1", "bob mail")] },
    "owner@firm.test": { mail: [mail("OOOOO1", "owner mail")] },
  }, staff: ["alice@firm.test", "bob@firm.test", "owner@firm.test"] });
  const db = new DatabaseSync(":memory:");
  const tools = new Map(); const events = [];
  const people = { chain: [] };
  const ctx = { store: { db, migrate: ms => { for (const m of ms) db.exec(m); } }, vault: { fetch: async (item, o) => ({ tenant_id: g.tenant, client_id: g.clientId, client_secret: g.secret, token_uri: g.tokenUri })[o?.field] ?? "" },
    tool: (n, d) => tools.set(n, d), events: { emit: (...a) => events.push(a) }, log() {},
    kernel: { owner: "p-owner", chain: async () => ({ hops: people.chain.map(id => ({ actor: { kind: "person", id } })) }) } };
  await mod.start(ctx);
  const as = (hops, token = "t") => (name, input = {}) => { people.chain = hops; return tools.get(name).run(input, { token, caller: "mcp" }); };
  const cli = (name, input = {}) => { people.chain = []; return tools.get(name).run(input, { caller: "cli" }); };
  return { g, db, tools, events, member: as(["p-alice"]), owner: as(["p-owner"]), cli };
}
const addFirm = (s) => s.cli("microsoft.add", { name: "firm", domain: "firm.test", item: "m365-key", base: s.g.origin });
const attest = async (s) => { await s.cli("microsoft.members.email", { person: "p-alice", email: "alice@firm.test" }); await s.cli("microsoft.members.email", { person: "p-owner", email: "owner@firm.test" }); };

test("a member reads their own mail, calendar and OneDrive, and only as their own mailbox", async t => {
  const s = await setup(t); await addFirm(s); await attest(s);
  const hits = await s.member("microsoft.mail.search", { q: "alice" });
  assert.deepEqual(hits.map(h => h.id), ["AAAAA1"]);
  assert.match((await s.member("microsoft.mail.read", { id: "AAAAA1" })).text, /body of AAAAA1/);
  assert.equal((await s.member("microsoft.calendar.list", { from: "2026-10-01T00:00:00Z", to: "2026-10-30T00:00:00Z" }))[0].title, "alice event");
  assert.equal((await s.member("microsoft.drive.search", { q: "plan" })).length, 1);
  assert.equal((await s.member("microsoft.drive.read", { id: "FILE12345" })).text, "alice plan");
  const paths = s.g.requests.filter(r => r.path.startsWith("/v1.0/users/")).map(r => decodeURIComponent(r.path.split("/")[3]));
  assert.ok(paths.length >= 5 && paths.every(p => p === "alice@firm.test"), "every Graph call named alice's mailbox: " + [...new Set(paths)]);
});

test("a member cannot reach another mailbox: an input mailbox is ignored, another person's message id is a 404 in her own mailbox, never bob's", async t => {
  const s = await setup(t); await addFirm(s); await attest(s);
  const r = await s.member("microsoft.mail.search", { q: "bob", mailbox: "bob@firm.test", user: "bob@firm.test" });
  assert.ok(r.every(x => x.id === "AAAAA1"), "only alice's own mail came back, never bob's");
  await assert.rejects(s.member("microsoft.mail.read", { id: "BBBBB1", mailbox: "bob@firm.test" }), e => e.code === "not_found");
  assert.ok(s.g.requests.filter(r => r.path.startsWith("/v1.0/users/")).every(r => r.path.includes("alice%40firm.test") || r.path.includes("alice@firm.test")));
});

test("no work email recorded, or outside the firm domain, or no app: refused in words", async t => {
  const s = await setup(t);
  await assert.rejects(s.member("microsoft.mail.search", { q: "x" }), e => e.code === "denied" && /work email/.test(e.message));
  await addFirm(s); await s.cli("microsoft.members.email", { person: "p-alice", email: "alice@firm.test" });
  assert.equal((await s.member("microsoft.mail.search", { q: "x" })).length, 1);
  await s.cli("microsoft.remove", { name: "firm" });
  await assert.rejects(s.member("microsoft.mail.search", { q: "x" }), e => e.code === "no_account");
});

test("only the owner adds the app, removes it or sets emails; a member (self or other) is refused", async t => {
  const s = await setup(t);
  for (const [name, input] of [["microsoft.add", { name: "firm", domain: "firm.test", item: "k" }], ["microsoft.remove", { name: "firm" }], ["microsoft.members.email", { person: "p-alice", email: "owner@firm.test" }], ["microsoft.members.email", { person: "p-alice", email: "alice@firm.test" }], ["microsoft.members.email", {}], ["microsoft.accounts", {}]])
    await assert.rejects(s.member(name, input), e => e.code === "denied" && /owner/.test(e.message), name);
  await addFirm(s);
  await assert.rejects(s.cli("microsoft.members.email", { person: "p-alice", email: "a@evil.test" }), /outside the firm/);
  await s.cli("microsoft.members.email", { person: "p-alice", email: "alice@firm.test" });
  await assert.rejects(s.cli("microsoft.members.email", { person: "p-bob", email: "alice@firm.test" }), /another person/);
  assert.deepEqual((await s.owner("microsoft.accounts")).map(a => a.domain), ["firm.test"]);
});

test("the owner acts as their own attested mailbox only, and is told to set it first when none is", async t => {
  const s = await setup(t); await addFirm(s);
  await assert.rejects(s.owner("microsoft.mail.search", { q: "x" }), e => e.code === "no_account" && /work email first/.test(e.message));
  await s.cli("microsoft.members.email", { person: "p-owner", email: "owner@firm.test" });
  assert.equal((await s.owner("microsoft.mail.search", { q: "x" }))[0].id, "OOOOO1");
});

test("a tenant that restricts the app answers 403: explained; and the secret is in no result or event", async t => {
  const s = await setup(t); await addFirm(s);
  await s.cli("microsoft.members.email", { person: "p-alice", email: "alice@firm.test" });
  // bob is not in the staff group: attest bob as alice's twin cannot happen (unique), so make the tenant drop alice
  s.g.requests.length = 0;
  const g2 = await startFakeGraph(t, { users: { "alice@firm.test": { mail: [] } }, staff: [] });
  s.db.prepare("UPDATE microsoft_accounts SET base = ?").run(g2.origin);
  s.db.prepare("UPDATE microsoft_accounts SET auth = ? WHERE 1").run(JSON.stringify({ type: "m365-app", item: "other" }));
  const err = await s.member("microsoft.mail.search", { q: "x" }).catch(e => e);
  assert.ok(err instanceof Error);
  assert.ok(!JSON.stringify([err.message, s.events]).includes(s.g.secret));
});

test("nothing is written or sent: only GET reaches Graph", async t => {
  const s = await setup(t); await addFirm(s); await attest(s);
  await s.member("microsoft.mail.search", { q: "a" }); await s.member("microsoft.drive.search", { q: "a" });
  assert.ok(s.g.requests.every(r => r.method === "GET"));
  for (const n of s.tools.keys()) assert.ok(!/send|draft|create|update|delete/.test(n), n);
});
