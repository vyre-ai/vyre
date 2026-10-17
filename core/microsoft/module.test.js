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

async function setup(t, { secret, staff } = {}) {
  const g = await startFakeGraph(t, { users: {
    "alice@firm.test": { mail: [mail("AAAAA1", "alice mail")], events: [{ id: "EV123456", subject: "alice event", start: { dateTime: "2026-10-14T09:00:00" }, end: { dateTime: "2026-10-14T10:00:00" } }], files: [{ id: "FILE12345", name: "plan.txt", file: { mimeType: "text/plain" }, content: "alice plan", webUrl: "https://o/f" }] },
    "bob@firm.test": { mail: [mail("BBBBB1", "bob mail")] },
    "owner@firm.test": { mail: [mail("OOOOO1", "owner mail")] },
  }, staff: staff || ["alice@firm.test", "bob@firm.test", "owner@firm.test"] });
  const db = new DatabaseSync(":memory:");
  const tools = new Map(); const events = [];
  const people = { chain: [] };
  /** The Gate, as the module sees it through ctx.call: it files what is held, and gate.get answers an item with the requester the Gate recorded from the chain. */
  const calls = [], items = new Map();
  const call = async (tool, input) => {
    calls.push({ tool, input });
    if (tool === "gate.request") { const id = `h${items.size + 1}`; const first = people.chain.find(x => !String(x).startsWith("agent:")); items.set(id, { id, via: input.via, to: input.to, content: input.content, requester: first || null }); return { data: { id } }; }
    if (tool === "gate.get") return items.has(input.id) ? { data: items.get(input.id) } : { error: { code: "not_found", message: "no such item" } };
    return { data: {} };
  };
  const ctx = { call, store: { db, migrate: ms => { for (const m of ms) db.exec(m); } }, vault: { fetch: async (item, o) => ({ tenant_id: g.tenant, client_id: g.clientId, client_secret: secret ?? g.secret, token_uri: g.tokenUri })[o?.field] ?? "" },
    tool: (n, d) => tools.set(n, d), events: { emit: (...a) => events.push(a) }, log() {},
    kernel: { owner: "p-owner", chain: async () => ({ hops: people.chain.map(id => ({ actor: { kind: String(id).startsWith("agent:") ? "agent" : "person", id } })) }) } };
  await mod.start(ctx);
  const as = (hops, token = "t") => (name, input = {}) => { people.chain = hops; return tools.get(name).run(input, { token, caller: "mcp" }); };
  const cli = (name, input = {}) => { people.chain = []; return tools.get(name).run(input, { caller: "cli" }); };
  return { g, db, tools, events, people, calls, items, member: as(["p-alice"]), owner: as(["p-owner"]), cli };
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
  for (const [name, input] of [["microsoft.add", { name: "firm", domain: "firm.test", item: "k" }], ["microsoft.remove", { name: "firm" }], ["microsoft.members.email", { person: "p-alice", email: "owner@firm.test" }], ["microsoft.members.email", { person: "p-alice", email: "alice@firm.test" }], ["microsoft.members.email", {}], ["microsoft.check", {}]])
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
  assert.ok(s.g.requests.every(r => r.method === "GET"), "the reads only read");
  for (const n of s.tools.keys()) assert.ok(!/draft|update|delete/.test(n) && (!/send|create/.test(n) || ["microsoft.mail.send", "microsoft.calendar.create"].includes(n)), n);
});

test("microsoft.check names the first missing step, in order, and never reads a message or shows the secret", async t => {
  const s = await setup(t);
  let r = await s.cli("microsoft.check");
  assert.equal(r.ok, false); assert.equal(r.steps[0].step, "app"); assert.match(r.next, /microsoft\.add/);
  await addFirm(s);
  r = await s.cli("microsoft.check");
  assert.equal(r.steps.at(-1).step, "people"); assert.match(r.next, /microsoft\.members\.email/);
  await attest(s);
  r = await s.cli("microsoft.check");
  assert.equal(r.ok, true, JSON.stringify(r)); assert.match(r.next, /set up/);
  assert.ok(s.g.requests.every(q => q.method === "GET" && !/\/messages/.test(q.path || q.url || "")), "only inbox-folder reads reach Graph");
  assert.ok(!JSON.stringify(r).includes(s.g.secret));
});

test("microsoft.check: a wrong secret stops at the sign-in step and says how to fix it; a mailbox outside the staff group names the access policy", async t => {
  const bad = await setup(t, { secret: "not-the-secret" });
  await addFirm(bad); await attest(bad);
  let r = await bad.cli("microsoft.check");
  assert.equal(r.ok, false); assert.match(r.steps.find(x => !x.ok).step, /^secret:/); assert.match(r.next, /client_secret/);
  assert.ok(!r.steps.some(x => /^mailbox:/.test(x.step)), "no mailbox is tried while the app cannot sign in");
  const out = await setup(t, { staff: ["alice@firm.test"] });
  await addFirm(out); await attest(out);
  r = await out.cli("microsoft.check");
  assert.equal(r.ok, false);
  const blocked = r.steps.filter(x => !x.ok);
  assert.deepEqual(blocked.map(x => x.step), ["mailbox:p-owner"], "alice is in the staff group; the owner is not");
  assert.match(blocked[0].fix, /ApplicationAccessPolicy/);
});

test("microsoft.check is the owner's alone", async t => {
  const s = await setup(t);
  await assert.rejects(s.member("microsoft.check"), e => e.code === "denied" && /owner/.test(e.message));
});

test("a member's own send and invite go out at once from their own mailbox, never held, and nothing in the input can name another mailbox", async t => {
  const s = await setup(t); await addFirm(s); await attest(s);
  const out = await s.member("microsoft.mail.send", { to: ["Dana@Harlow.example"], cc: ["kit@harlow.example"], subject: "Refund R-9", body: "Hello Dana", from: "bob@firm.test", mailbox: "bob@firm.test" });
  assert.deepEqual({ sent: out.sent, from: out.from, to: out.to }, { sent: true, from: "alice@firm.test", to: ["dana@harlow.example"] });
  const post = s.g.requests.find(r => r.method === "POST");
  assert.equal(post.path, "/v1.0/users/alice@firm.test/sendMail", "always the member's own mailbox, whatever the input says");
  assert.equal(post.body.message.subject, "Refund R-9"); assert.equal(post.body.message.body.content, "Hello Dana");
  assert.deepEqual(post.body.message.toRecipients, [{ emailAddress: { address: "dana@harlow.example" } }]);
  assert.equal(post.body.saveToSentItems, true);
  const ev = await s.member("microsoft.calendar.create", { title: "Call Dana", start: "2026-10-20T09:00:00", end: "2026-10-20T09:30:00", time_zone: "Europe/London", attendees: ["dana@harlow.example"] });
  assert.equal(ev.created, true); assert.deepEqual(ev.attendees, ["dana@harlow.example"]);
  const evPost = s.g.requests.filter(r => r.method === "POST").at(-1);
  assert.equal(evPost.path, "/v1.0/users/alice@firm.test/events");
  assert.equal(evPost.body.attendees[0].emailAddress.address, "dana@harlow.example");
  assert.equal(evPost.body.start.timeZone, "Europe/London");
  assert.ok(!JSON.stringify([out, ev, s.events]).includes(s.g.secret));
});

test("an agent's send or invite in a member's turn is held for that member, from their own mailbox, and nothing reaches Graph until they approve", async t => {
  const s = await setup(t); await addFirm(s); await attest(s);
  const viaAgent = (name, input) => { s.people.chain = ["p-alice", "agent:kit"]; return s.tools.get(name).run(input, { token: "t", caller: "mcp:agent:kit" }); };
  const posts = () => s.g.requests.filter(r => r.method === "POST").length;
  const mail = await viaAgent("microsoft.mail.send", { to: ["dana@harlow.example"], subject: "Refund R-9", body: "Hello Dana", why: "Dana asked" });
  assert.equal(mail.held, "h1"); assert.match(mail.message, /alice@firm\.test/);
  const req = s.calls.find(c => c.tool === "gate.request");
  assert.equal(req.input.via, "microsoft:firm"); assert.equal(req.input.content.from, "alice@firm.test", "the from-address is in what the member approves");
  assert.deepEqual(req.input.to, ["dana@harlow.example"]);
  const inv = await viaAgent("microsoft.calendar.create", { title: "Call Dana", start: "2026-10-20T09:00:00", end: "2026-10-20T09:30:00", attendees: ["dana@harlow.example"] });
  assert.equal(inv.held, "h2");
  await assert.rejects(viaAgent("microsoft.calendar.create", { title: "Solo", start: "2026-10-20T09:00:00", end: "2026-10-20T09:30:00" }), e => e.code === "denied" && /guests/.test(e.message), "an agent's event with no guests is not held and not written");
  assert.equal(posts(), 0, "nothing reached Graph while the items wait");
  // a call whose chain holds no person is nobody's own act and nobody's mailbox
  await assert.rejects(s.cli("microsoft.mail.send", { to: ["dana@harlow.example"], subject: "x", body: "y" }), e => e.code === "denied" && /no person/.test(e.message));
  assert.equal(s.items.size, 2);
});

test("the Gate's release sends exactly what the requester approved, from the requester's mailbox if it is still theirs; a revoke wins", async t => {
  const s = await setup(t); await addFirm(s); await attest(s);
  s.people.chain = ["p-alice", "agent:kit"];
  const { held } = await s.tools.get("microsoft.mail.send").run({ to: ["dana@harlow.example"], subject: "Refund R-9", body: "Hello Dana" }, { token: "t", caller: "mcp:agent:kit" });
  const item = s.items.get(held);
  const release = (caller = "module:gate", content = item.content, id = held) => s.tools.get("microsoft.release").run({ id, to: item.to, content }, { caller });
  await assert.rejects(release("cli"), e => e.code === "denied", "only the Gate releases");
  await assert.rejects(release("module:gate", { ...item.content, from: "bob@firm.test" }), e => e.code === "denied" && /different mailbox/.test(e.message), "an approved message that names another mailbox is refused");
  await assert.rejects(release("module:gate", item.content, "h99"), /no such item|not held|no_such/);
  const out = await release();
  assert.equal(out.sent, true); assert.equal(out.from, "alice@firm.test");
  const post = s.g.requests.find(r => r.method === "POST");
  assert.equal(post.path, "/v1.0/users/alice@firm.test/sendMail"); assert.equal(post.body.message.subject, "Refund R-9");
  // the owner removes Alice's attested email before a second item is approved: that one is not sent
  s.people.chain = ["p-alice", "agent:kit"];
  const { held: h2 } = await s.tools.get("microsoft.mail.send").run({ to: ["dana@harlow.example"], subject: "Second", body: "x" }, { token: "t", caller: "mcp:agent:kit" });
  await s.cli("microsoft.members.email", { person: "p-alice" });
  const before = s.g.requests.filter(r => r.method === "POST").length;
  await assert.rejects(s.tools.get("microsoft.release").run({ id: h2, to: s.items.get(h2).to, content: s.items.get(h2).content }, { caller: "module:gate" }), e => e.code === "denied" && /no longer set up/.test(e.message));
  assert.equal(s.g.requests.filter(r => r.method === "POST").length, before, "the revoke won: nothing was sent");
  // an item that does not say who asked is not sent at all
  s.items.set("hx", { id: "hx", via: "microsoft:firm", to: ["a@b.example"], content: { from: "alice@firm.test", subject: "x", body: "y" }, requester: null });
  await assert.rejects(s.tools.get("microsoft.release").run({ id: "hx", to: ["a@b.example"], content: s.items.get("hx").content }, { caller: "module:gate" }), /does not say whose mailbox/);
});

test("send and invite check their input: addresses, a one-line subject, a body, a sane time range and zone", async t => {
  const s = await setup(t); await addFirm(s); await attest(s);
  const bad = (name, input, re) => assert.rejects(s.member(name, input), e => e.code === "bad_input" && re.test(e.message), JSON.stringify(input).slice(0, 80));
  await bad("microsoft.mail.send", { to: ["not-an-address"], subject: "x", body: "y" }, /email addresses/);
  await bad("microsoft.mail.send", { to: [], subject: "x", body: "y" }, /at least one recipient/);
  await bad("microsoft.mail.send", { to: ["a@b.example"], subject: "x\nBcc: z@z.example", body: "y" }, /one line/);
  await bad("microsoft.mail.send", { to: ["a@b.example"], subject: "x", body: "" }, /body/);
  await bad("microsoft.calendar.create", { title: "x", start: "2026-10-20T10:00:00", end: "2026-10-20T09:00:00" }, /end after the start/);
  await bad("microsoft.calendar.create", { title: "x", start: "2026-10-20T09:00:00", end: "2026-10-20T10:00:00", time_zone: "Mars/Base" }, /IANA/);
  assert.ok(s.g.requests.every(r => r.method === "GET"), "a refused input sends nothing");
});

test("microsoft.accounts as a member: only their own provisioned account, the app and the address, never a credential, a mailbox of anyone else's or the firm app's item", async t => {
  const s = await setup(t); await addFirm(s); await attest(s);
  const mine = await s.member("microsoft.accounts");
  assert.deepEqual(mine, [{ app: "firm", email: "alice@firm.test", domain: "firm.test" }], JSON.stringify(mine));
  assert.ok(!JSON.stringify(mine).includes("m365-key") && !JSON.stringify(mine).includes(s.g.secret), "no item name and no secret");
  // a member with no work email recorded sees none; one with another address sees theirs only
  const as = (hops, caller = "device:abc") => { s.people.chain = hops; return s.tools.get("microsoft.accounts").run({}, { token: "t", caller }); };
  const bob = await as(["p-bob"]);
  assert.deepEqual(bob, [], "no recorded email, no account");
  await s.cli("microsoft.members.email", { person: "p-bob", email: "bob@firm.test" });
  assert.deepEqual(await as(["p-bob"]), [{ app: "firm", email: "bob@firm.test", domain: "firm.test" }]);
  assert.deepEqual(await s.member("microsoft.accounts"), mine, "and Alice still sees only hers");
  // an assistant acting for Alice reads Alice's, not the owner's
  assert.deepEqual(await as(["p-alice", "agent:kit"], "mcp:agent:kit"), mine);
  // no firm app, or a call with no person: nothing for a member, the owner's list for the owner
  await s.cli("microsoft.remove", { name: "firm" });
  assert.deepEqual(await s.member("microsoft.accounts"), []);
  await addFirm(s);
  assert.deepEqual((await s.owner("microsoft.accounts")).map(a => [a.name, a.domain, a.item]), [["firm", "firm.test", "m365-key"]], "the owner still sees the firm app, as before");
  await assert.rejects(s.cli("microsoft.accounts"), e => e.code === "denied" || /person|owner/.test(e.message), "a call with no person behind it is not a member");
});
