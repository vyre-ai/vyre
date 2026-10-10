// @ts-check
// The README gif's story, end to end, on a real daemon with the fake model driver and no live calls (SPEC-0.3.0 part 11). Each step names what it needs and fails loudly with the step's number
// the first time two pieces do not connect:
//   1 "@juno get the overdue invoices chased this week" reaches juno's session
//   2 juno hands it to kit (billing) by role; the asker's log gets the hand-off row, then running with kit's session
//   3 kit's steps arrive nested (via) in the asker's log
//   4 kit asks to send three emails; they are held as ONE group
//   5 the pending list shows every field of each
//   6 one group yes with three proofs (the app's own approveGroup); the sends run
//   7 each email is logged as an activity on its matching client
//   8 the closing line (the app's own closingLine)
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { open as openStore } from "../core/store/index.js";
import { paths } from "../core/config/index.js";
import { tempHome, present, writeModule } from "./helpers.js";
import { groupsFrom, approveGroup, closingLine } from "../apps/app/src/real/group-approve.js";
import { boot as _unused } from "../core/team/team-fixture.js";
import { startFakeMail } from "../core/mail/testing/fake-imap.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "core", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);
const canonical = (/** @type {any} */ x) => JSON.stringify(x, Object.keys(x).sort());
const signedPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };
const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 40_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(what); await new Promise(r => setTimeout(r, 100)); } };

const CLIENTS = [
  { name: "Northwind Bakery", email: "ap@northwind.example", invoice: "1042" },
  { name: "Oakline Dental", email: "billing@oakline.example", invoice: "1051" },
  { name: "Brightwell Law", email: "accounts@brightwell.example", invoice: "1060" },
];

/** The firm's Space on a real daemon: clients, the mail credential, a project with a billing teammate, juno's bound session, a mail server that records what reaches it. */
async function world(/** @type {import("node:test").TestContext} */ t) {
  const root = tempHome(t);
  const mods = path.join(root, "modules");
  const sent = /** @type {string[]} */ ([]);
  const outbox = http.createServer((req, res) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => { sent.push(b); res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"m1","threadId":"t1"}'); }); });
  await new Promise(r => outbox.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => outbox.close(() => r(undefined))));
  const log = path.join(root, "claude.log");
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG, VYRE_SESSION_SANDBOX_OFF: process.env.VYRE_SESSION_SANDBOX_OFF };
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_LOG: log, VYRE_SESSION_SANDBOX_OFF: "1" });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", sessions: { install: false }, projectsDir: path.join(root, "projects"), vault: { keystore: "file" },
    comms: { sms: { account: "AC" + "a".repeat(32), from: "+15555550123" } }, gate: { senders: { mail: { type: "gmail", vault: "mail-token", from: "alex@example.com", base: `http://127.0.0.1:${/** @type {any} */ (outbox.address()).port}` } } } }));
  // A stand-in for the mail module (the real one needs a vault account), with the same shape: an outward tool that files the message at the Gate, as mail.send does.
  writeModule(mods, "billing", { version: "0.1.0", shows: { capsule: { "view:chase": { title: "Chase an invoice", root: true, form: "chase", forms: { chase: { title: "Chase", fields: [{ name: "to", label: "To", type: "text", required: true }], submit: { title: "Send", tool: "billing.nested", input: { to: "{to}" }, outward: true } } } } } }, flow: { steps: ["billing.email", "billing.twice", "billing.nested", "billing.uncovered"].map(name => ({ name, label: name, outward: true, inputs: { to: "string", to2: "string" }, outputs: {} })) }, does: { tools: [{ name: "billing.email", reach: "anyone", outward: true, effect: "write", summary: "email a client about an overdue invoice" }, { name: "billing.relay", reach: "anyone", outward: true, effect: "write", summary: "asks the reminder module to send" }, { name: "billing.twice", reach: "anyone", outward: true, effect: "write", summary: "files two sends in one call" }, { name: "billing.nested", reach: "anyone", outward: true, covers: ["reminder.push"], effect: "write", summary: "sends through the reminder module as one act" }, { name: "billing.uncovered", reach: "anyone", outward: true, effect: "write", summary: "sends through the reminder module and says nothing about it" }, { name: "billing.chain", reach: "anyone", outward: true, covers: ["reminder.hop", "courier.send"], effect: "write", summary: "sends through two modules as one act" }, { name: "billing.shallow", reach: "anyone", outward: true, covers: ["reminder.hop"], effect: "write", summary: "names the first hop but not the send behind it" }] }, needs: { tools: ["gate.request", "reminder.send", "reminder.push", "reminder.hop"] } },
    `export default { async start(ctx) { ctx.tool("billing.relay", { callers: ["cli", "mcp", "harness", "module"], input: { type: "object" }, run: async (i) => { const r = await ctx.call("reminder.send", i); return r.data || r; } }); ctx.tool("billing.email", { callers: ["cli", "mcp", "harness", "module"], input: { type: "object" }, run: async (i) => { const r = await ctx.call("gate.request", { kind: "send", via: "mail", to: i.to, content: { subject: i.subject, body: i.body, ...(i.cc ? { cc: i.cc } : {}) }, why: "overdue invoice" }); if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data || r; } }); for (const n of ["billing.nested", "billing.uncovered"]) ctx.tool(n, { callers: ["cli", "mcp", "harness", "module"], input: { type: "object" }, run: async (i) => { const r = await ctx.call("reminder.push", i); if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data || r; } }); for (const n of ["billing.chain", "billing.shallow"]) ctx.tool(n, { callers: ["cli", "mcp", "harness", "module"], input: { type: "object" }, run: async (i) => { const r = await ctx.call("reminder.hop", i); if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data || r; } }); ctx.tool("billing.twice", { callers: ["cli", "mcp", "harness", "module"], input: { type: "object" }, run: async (i) => { const out = []; for (const to of [i.to, i.to2]) { const r = await ctx.call("gate.request", { kind: "send", via: "mail", to, content: { subject: "s", body: "b" }, why: "twice" }); out.push(r.data || r); } return out; } }); return {}; } };`);
  writeModule(mods, "reminder", { version: "0.1.0", does: { tools: [{ name: "reminder.send", reach: "anyone", effect: "write", summary: "send a reminder" }, { name: "reminder.push", reach: "anyone", outward: true, effect: "write", summary: "send a reminder now" }, { name: "reminder.hop", reach: "anyone", outward: true, effect: "write", summary: "hands the send on to the courier" }] }, needs: { tools: ["gate.request", "courier.send"] } },
    `export default { async start(ctx) { ctx.tool("reminder.hop", { callers: ["module"], input: { type: "object" }, run: async (i) => { const r = await ctx.call("courier.send", i); if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data || r; } }); ctx.tool("reminder.push", { callers: ["module"], input: { type: "object" }, run: async (i) => { const r = await ctx.call("gate.request", { kind: "send", via: "mail", to: i.to, content: { subject: "s", body: "b" }, why: "push" }); return r.data || r; } }); ctx.tool("reminder.send", { callers: ["module"], input: { type: "object" }, run: async (i) => { const r = await ctx.call("gate.request", { kind: "send", via: "mail", to: i.to, content: { subject: "s", body: "b" }, why: "reminder" }); return r.data || r; } }); return {}; } };`);
  writeModule(mods, "courier", { version: "0.1.0", does: { tools: [{ name: "courier.send", reach: "anyone", outward: true, effect: "write", summary: "files the send at the Gate" }] }, needs: { tools: ["gate.request"] } },
    `export default { async start(ctx) { ctx.tool("courier.send", { callers: ["module"], input: { type: "object" }, run: async (i) => { const r = await ctx.call("gate.request", { kind: "send", via: "mail", to: i.to, content: { subject: "s", body: "b" }, why: "courier" }); return r.data || r; } }); return {}; } };`);
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: signedPresence(), firstPartyRoots: [mods] });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(chain, {})).token });
  const tool = async (/** @type {string} */ name, /** @type {any} */ input, caller = "cli", extra = {}) => { const r = await call(name, input, { root, caller, timeout: 30_000, ...extra }); if (r.error) throw Object.assign(new Error(`${name}: ${r.error.message || r.error.code}`), { code: r.error.code }); return r.data; };
  const asPerson = async (/** @type {string} */ name, /** @type {any} */ input) => { const r = await d.registry.call(name, input, "cli", await meta()); if (r.error) throw Object.assign(new Error(`${name}: ${r.error.message || r.error.code}`), { code: r.error.code }); return r.data; };
  const step = (/** @type {number} */ n, /** @type {string} */ what) => (/** @type {string} */ why) => `STEP ${n}, ${what}: ${why}`;

  // the Space as the firm has it: the clients, the mail credential the Gate sends with, the project and its billing teammate
  for (const c of CLIENTS) await d.kernel.gateway.records.create(chain, "contact", { name: c.name, email: c.email });
  await asPerson("vault.put", { name: "mail-token", kind: "api-key", fields: { value: "fixture-token-1" } });
  await asPerson("vault.grant", { name: "mail-token", module: "gate" });
  const project = await tool("projects.create", { name: "Harlow Legal" });
  const record = (await until(async () => { const r = await call("work.project.ref", { project: project.slug }, { root, caller: "cli", timeout: 20_000 }); return r.error ? null : r.data; }, "the project's record")).id;
  const kit = await tool("team.add", { project: record, role: "billing", brief: "invoices" });
  const launches = () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const started = await tool("threads.start", { project: project.slug, name: "juno", prompt: "hello there" });
  const launch = await until(() => launches().find(l => l.argv.includes(started.id)), "juno's session to launch");
  const bound = await tool("threads.bind", { session: started.id, pid: launch.pid }, "harness");
  const junoSession = { id: started.id, key: bound.key };
  const framesOf = (/** @type {string} */ session) => { const db = openStore(paths(root).db); try { return db.prepare("SELECT json FROM stream_frames WHERE session = ? ORDER BY cur").all(session).map((/** @type {any} */ r) => JSON.parse(r.json)); } finally { db.close(); } };
  return { root, d, owner, chain, meta, tool, asPerson, step, record, junoSession, started, framesOf, sent, mods };
}

async function story(/** @type {import("node:test").TestContext} */ t) {
  const { root, d, owner, chain, asPerson, step, record, junoSession, started, framesOf, sent, tool } = await world(t);
  // 1: the person's words reach juno's session
  const S1 = step(1, "the person's words reach juno");
  const words = "@juno get the overdue invoices chased this week";
  try { await tool("threads.send", { thread: started.id, text: words }); } catch (e) { assert.fail(S1(/** @type {Error} */ (e).message)); }
  await until(async () => framesOf(started.id).some(f => f.type === "chat.user-message" && /overdue invoices/.test(String(f.data.text))), S1("the words are not in juno's stream"));

  // 2: juno hands it to kit by role. Its team.ask is made through its own bound session, as a model's MCP call is.
  const S2 = step(2, "juno hands it to kit");
  const script = CLIENTS.map(c => `vyre billing.email ${JSON.stringify({ to: c.email, subject: `Invoice ${c.invoice} is overdue`, body: `Hello ${c.name}, invoice ${c.invoice} is now 30 days overdue. Could you pay it this week? Thank you.`, cc: `partner@harlow.example` })}`).join("\n");
  let ask;
  try { ask = await call("team.ask", { to: "billing", project: record, text: script }, { root, caller: "mcp", session: junoSession, timeout: 60_000 }); } catch (e) { assert.fail(S2(/** @type {Error} */ (e).message)); }
  assert.equal(ask.error, undefined, S2(JSON.stringify(ask.error)));
  const request = ask.data.request;
  const rows = await until(async () => { const r = framesOf(started.id).filter(f => f.type === "chat.handoff" && f.data.request === request); return r.length >= 2 ? r : null; }, S2("juno's log has no hand-off row for kit"));
  assert.equal(rows[0].data.state, "queued", S2("the first state is queued"));
  assert.equal(rows[0].data.to.role, "billing", S2("the row names the role"));
  const running = await until(async () => framesOf(started.id).find(f => f.type === "chat.handoff" && f.data.request === request && f.data.thread), S2("the row never names kit's own session"));
  const kitThread = running.data.thread;

  // 3: kit's steps arrive nested in the asker's log (recorded events of kit's session, as the switchboard emits them)
  const S3 = step(3, "kit's steps arrive nested");
  d.events.emit("switchboard", "thread.tool", { id: "tu_1", call: "tu_1", tool: "Read", phase: "started", summary: "Read invoices/overdue.csv" }, { thread: kitThread });
  d.events.emit("switchboard", "thread.tool", { id: "tu_1", call: "tu_1", phase: "done", error: false }, { thread: kitThread });
  const nested = await until(async () => { const f = framesOf(started.id).filter(x => x.data && x.data.via === request); return f.length >= 2 ? f : null; }, S3("no frame of kit's carries via in juno's log"));
  assert.deepEqual(nested.map(f => f.type), ["chat.tool-started", "chat.tool-finished"], S3("the nested frames are not kit's steps"));
  assert.match(String(nested[0].author), /^assistant:billing-/, S3("the step is not kit's"));

  // 4: kit asks to send three emails: held as ONE group
  const S4 = step(4, "the three emails are held as one group");
  const pending = async () => (await asPerson("approvals.pending", {}));
  const held = await until(async () => { const p = await pending(); return p.approvals.filter((/** @type {any} */ a) => a.request && a.request.op === "billing.email").length >= 3 ? p : null; }, S4("kit's calls were not held as cards: " + JSON.stringify(await pending())));
  const group = groupsFrom(held)[0];
  assert.ok(group, S4("the cards are not in a group"));
  assert.equal(group.items.length, 3, S4(`the group holds ${group.items.length} cards, not 3`));
  assert.equal(held.groups.length, 1, S4("more than one group"));

  // 5: every field of each is shown
  const S5 = step(5, "the pending list shows every field of each");
  for (const c of CLIENTS) {
    const item = group.items.find((/** @type {any} */ i) => i.request.fields.to === c.email);
    assert.ok(item, S5(`no card for ${c.email}`));
    const by = Object.fromEntries((item.words || []).map((/** @type {any} */ w) => [w.field, w.text]));
    assert.equal(by.to, c.email, S5("to"));
    assert.match(by.subject, new RegExp(c.invoice), S5("subject"));
    assert.match(by.body, new RegExp(c.name), S5("body"));
    assert.equal(by.cc, "partner@harlow.example", S5("a cc the person did not type is on the card"));
    assert.ok(!item.partial, S5("the card is shown in part"));
  }

  // 6: one group yes, three proofs, signed by the app's own code; the sends run
  const S6 = step(6, "the group yes and the sends");
  const appCall = async (/** @type {string} */ name, /** @type {any} */ input) => asPerson(name, input);
  const signer = { signPresence: async (/** @type {any} */ req) => ({ op: req.op, fields: req.fields, n: `n${Math.random()}`, payload_hash: req.payload_hash, key_id: "k1" }) };
  let answered;
  try { answered = await approveGroup({ group, signer, call: appCall, person: owner }); } catch (e) { assert.fail(S6("the group yes was refused: " + /** @type {Error} */ (e).message)); }
  assert.deepEqual(answered.results.map((/** @type {any} */ r) => r.answered), ["approved", "approved", "approved"], S6(JSON.stringify(answered.results)));
  // kit retries each call with its card, in a second request
  const retries = group.items.map((/** @type {any} */ i) => `vyre billing.email ${JSON.stringify({ ...CLIENTS.map(c => ({ to: c.email, subject: `Invoice ${c.invoice} is overdue`, body: `Hello ${c.name}, invoice ${c.invoice} is now 30 days overdue. Could you pay it this week? Thank you.`, cc: "partner@harlow.example" })).find(m => m.to === i.request.fields.to), approval: i.id })}`).join("\n");
  const again = await call("team.ask", { to: "billing", project: record, text: retries, wait: true }, { root, caller: "cli", timeout: 60_000 });
  assert.equal(again.error, undefined, S6(JSON.stringify(again.error)));
  // the Gate now has the three messages. They must be on their way, not held again.
  const gateItems = await until(async () => { const h = await asPerson("gate.held", {}); const items = Array.isArray(h) ? h : h.items || []; return items; }, S6("the Gate has no answer")).catch(() => []);
  const heldAgain = Array.isArray(gateItems) ? gateItems.length : 0;
  assert.equal(heldAgain, 0, S6(`the group yes did not send them: ${heldAgain} email(s) are held AGAIN at the Gate and wait for a second yes (gate.approve). The outward card's yes and the Gate's hold are two separate approvals for one send.`));
  await until(() => sent.length >= 3, S6(`only ${sent.length} of 3 emails reached the mail server`));

  // 7: each email is logged on its client
  const S7 = step(7, "each email is logged on its client");
  const comms = await until(async () => { const q = await d.kernel.gateway.records.query(chain, "communication", { page: { limit: 20 } }); return q.rows.length >= 3 ? q.rows : null; }, S7("fewer than 3 Communications were filed on the clients"));
  const contacts = (await d.kernel.gateway.records.query(chain, "contact", { page: { limit: 20 } })).rows;
  for (const c of CLIENTS) {
    const contact = contacts.find((/** @type {any} */ r) => r.data.email === c.email);
    assert.ok(contact, S7(`no contact for ${c.name}`));
    assert.ok(comms.some((/** @type {any} */ r) => JSON.stringify(r.data.contacts || []).includes(contact.urn) && new RegExp(c.invoice).test(String(r.data.subject))), S7(`${c.name} has no logged email about invoice ${c.invoice}`));
  }

  // 8: the closing line, from the app's own code
  const S8 = step(8, "the closing line");
  const line = closingLine(answered.results, group, { logged: comms.length >= 3 });
  assert.equal(line, "Sent 3 emails. Each is logged on its client.", S8(`the line is "${line}"; ops ${JSON.stringify(group.items.map((/** @type {any} */ i) => i.op))}`));
}

test("the README gif's story: handed to kit, its steps nested, three emails held as one group, one yes, sent, logged on the clients", { timeout: 300_000 }, async t => {
  await story(t);
});

test("one card covers one send: a call that files two sends gets the first sent and the second held, and a call with no card gets nothing sent", { timeout: 300_000 }, async t => {
  const { d, asPerson, sent } = await world(t);
  const call2 = (/** @type {any} */ input, /** @type {any} */ extra = {}) => d.registry.call("billing.twice", input, "mcp", extra);
  const input = { to: "ap@northwind.example", to2: "billing@oakline.example" };
  // no card: held as a card, nothing reaches the Gate or the mail server
  const first = await call2(input);
  assert.equal(first.error && first.error.code, "held_for_approval", JSON.stringify(first));
  assert.deepEqual((await asPerson("gate.held", {})).items ?? [], []);
  // the person says yes to the card; the retry sends the first and holds the second
  const p = await asPerson("approvals.pending", {});
  const item = groupsFrom(p)[0].items[0];
  const signer = { signPresence: async (/** @type {any} */ req) => ({ op: req.op, fields: req.fields, n: `n${Math.random()}`, payload_hash: req.payload_hash, key_id: "k1" }) };
  const res = await approveGroup({ group: { id: groupsFrom(p)[0].id, line: "", items: [item] }, signer, call: asPerson, person: d.kernel.id.owner });
  assert.equal(res.results[0].answered, "approved");
  const retry = await call2(input, { approval: first.error.approval });
  assert.equal(retry.error, undefined, JSON.stringify(retry.error));
  await until(() => sent.length >= 1, "the first send reached the mail server");
  const held = await asPerson("gate.held", {});
  assert.equal((held.items ?? held).length, 1, "the second send is held at the Gate: one card covers one send");
  assert.equal(sent.length, 1);
});

/** Hold one call as the plain model session `mcp`, approve its card alone with the app's own code, and give back what a retry needs. @param {any} w @param {string} toolName @param {any} input */
async function approved(w, toolName, input, extra = {}) {
  const first = await w.d.registry.call(toolName, input, "mcp", extra);
  assert.equal(first.error && first.error.code, "held_for_approval", JSON.stringify(first));
  const p = await w.asPerson("approvals.pending", {});
  const g = groupsFrom(p).find(x => x.items.some((/** @type {any} */ i) => i.id === first.error.approval));
  const item = g.items.find((/** @type {any} */ i) => i.id === first.error.approval);
  const signer = { signPresence: async (/** @type {any} */ req) => ({ op: req.op, fields: req.fields, n: `n${Math.random()}`, payload_hash: req.payload_hash, key_id: "k1" }) };
  const res = await approveGroup({ group: { id: g.id, line: "", items: [item] }, signer, call: w.asPerson, person: w.owner });
  assert.equal(res.results[0].answered, "approved");
  return first.error.approval;
}
const gateHeld = async (/** @type {any} */ w) => { const h = await w.asPerson("gate.held", {}); return (h.items ?? h).length; };

test("a forged mark does nothing: a covered field in the input, a made-up card id, a client asking the approvals queue, all hold or are refused", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const req = { kind: "send", via: "mail", to: "ap@northwind.example", content: { subject: "s", body: "b" }, why: "forged" };
  // from a module, with a `covered` in the input as if it were the mark; and from a client the same
  for (const [caller, extra] of [["module:billing", {}], ["cli", {}], ["mcp", {}]]) {
    const r = await w.d.registry.call("gate.request", { ...req, covered: { card: "ap_01a11d8e-aad6-4f45-8e02-4b52bed61f9a", tool: "billing.email", input_sha256: "a".repeat(32), asker: "mcp" } }, caller, extra);
    assert.ok(r.error || (r.data && r.data.state === "held"), `${caller}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(w.sent, [], "nothing was sent");
  // the approvals queue answers only the Gate
  for (const who of ["cli", "mcp", "module:billing"]) assert.ok((await w.d.registry.call("approvals.cover", { card: "ap_x", tool: "billing.email", input_sha256: "a".repeat(32), asker: "mcp" }, who, {})).error, `${who} cannot ask`);
});

test("a card for one email does not release another, and it cannot release twice", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const A = { to: "ap@northwind.example", subject: "Invoice 1042", body: "Pay A", cc: "partner@harlow.example" };
  const B = { to: "billing@oakline.example", subject: "Invoice 1051", body: "Pay B", cc: "partner@harlow.example" };
  const card = await approved(w, "billing.email", A);
  // B with A's card: the card is bound to A's input, so the registry refuses it and nothing is filed
  const wrong = await w.d.registry.call("billing.email", B, "mcp", { approval: card });
  assert.equal(wrong.error && wrong.error.code, "approval_refused", JSON.stringify(wrong));
  assert.equal(await gateHeld(w), 0);
  assert.deepEqual(w.sent, []);
  // A with A's card goes out; the same again is refused (the card is spent) and sends nothing more
  const ok = await w.d.registry.call("billing.email", A, "mcp", { approval: card });
  assert.equal(ok.error, undefined, JSON.stringify(ok.error));
  await until(() => w.sent.length === 1, "A reached the mail server");
  const twice = await w.d.registry.call("billing.email", A, "mcp", { approval: card });
  assert.equal(twice.error && twice.error.code, "approval_refused", JSON.stringify(twice));
  assert.equal(w.sent.length, 1);
});

test("a card for one module's tool does not release a send another first-party module files in the same turn", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const input = { to: "ap@northwind.example" };
  const card = await approved(w, "billing.relay", input);
  const r = await w.d.registry.call("billing.relay", input, "mcp", { approval: card });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(await gateHeld(w), 1, "the reminder module's send is held: the card was for billing's tool");
  assert.deepEqual(w.sent, []);
});

test("a tool that names the tool it files as part of the same act rides one yes: one card, one send, no second card; one that names nothing is held again", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const input = { to: "ap@northwind.example" };
  // covered: the nested outward tool is not held a second time, the Gate sends now, and nothing waits
  const card = await approved(w, "billing.nested", input);
  const r = await w.d.registry.call("billing.nested", input, "mcp", { approval: card });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  await until(() => w.sent.length === 1, "the nested send reached the mail server");
  assert.equal(await gateHeld(w), 0, "no second card at the Gate");
  assert.equal((await w.asPerson("approvals.pending", {})).items?.length ?? 0, 0, "no second card in the queue");
  // the card is spent: the same call again is refused and sends nothing more
  const again = await w.d.registry.call("billing.nested", input, "mcp", { approval: card });
  assert.equal(again.error && again.error.code, "approval_refused", JSON.stringify(again));
  assert.equal(w.sent.length, 1);
  // a tool that does not name it: the nested outward tool is held as its own card (nothing was said it was the same act)
  const card2 = await approved(w, "billing.uncovered", input);
  const r2 = await w.d.registry.call("billing.uncovered", input, "mcp", { approval: card2 });
  assert.equal(r2.error && r2.error.code, "held_for_approval", JSON.stringify(r2));
  assert.equal(w.sent.length, 1);
});

test("a card rides two hops down (the tool names each module's send it files), so one approval is exactly one send with no second card; naming only the first hop holds the send behind it", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const input = { to: "ap@northwind.example" };
  const card = await approved(w, "billing.chain", input);
  const r = await w.d.registry.call("billing.chain", input, "mcp", { approval: card });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  await until(() => w.sent.length === 1, "the send two modules down reached the mail server");
  assert.equal(await gateHeld(w), 0, "no second card at the Gate");
  assert.equal((await w.asPerson("approvals.pending", {})).items?.length ?? 0, 0, "no second card in the queue");
  const card2 = await approved(w, "billing.shallow", input);
  const r2 = await w.d.registry.call("billing.shallow", input, "mcp", { approval: card2 });
  assert.equal(r2.error && r2.error.code, "held_for_approval", JSON.stringify(r2));
  assert.equal(w.sent.length, 1, "the send behind an unnamed hop did not go");
});

/** A Flow whose one step calls an outward tool: define it, start it, say yes to its held act as the person, and give the daemon a moment. */
async function flowStep(/** @type {any} */ w, /** @type {string} */ action, /** @type {any} */ input, resource = "vyre://space/billing") {
  const space = w.d.kernel.id.space;
  const host = w.d.registry.deps.flowsHost.get(space);
  const admin = w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: w.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await w.d.kernel.surfaces.open(admin, {})).token });
  const flow = { format: 1, name: `step_${action.replace(/\W/g, "_")}`, label: action, authorship: "human", trigger: { on: "manual" }, steps: [{ id: "go", kind: "call", action, resource, input }] };
  const def = await w.d.registry.call("flows.define", { flow }, "cli", await meta());
  assert.ok(def.data && def.data.ok, JSON.stringify(def));
  await host.flows.tools["flows.approve"](host.personChain(), { id: def.data.id, version: def.data.version, hash: def.data.hash });
  await w.d.registry.call("flows.start", { id: def.data.id }, "cli", await meta());
  // the run must be waiting on its question before the person answers it (an answer in the instant between the question and the wait is a race a person never wins)
  await until(async () => { const r = (await w.d.registry.call("flows.runs", { id: def.data.id }, "cli", await meta())).data; return r && r.length && r[0].state === "waiting"; }, `the Flow run for ${action} to wait on its question`);
  const task = await until(async () => (await w.d.kernel.gateway.ask.list(admin, { state: ["needs_check"] })).find((/** @type {any} */ x) => x.form && x.form.kind === "held_act" && x.form.action === action), `the Flow's held act for ${action}`);
  const row = await w.d.kernel.gateway.ask.get(admin, task.id);
  await w.d.kernel.gateway.ask.decide(admin, task.id, { outcome: "approved", proof: { op: "task.decide", fields: { task: task.id, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: `n${Math.random()}` } });
  await until(async () => { const r = (await w.d.registry.call("flows.runs", { id: def.data.id }, "cli", await meta())).data; return r && r.length && ["done", "failed"].includes(r[0].state) ? r[0] : null; }, `the Flow run for ${action} to finish`);
}

test("a Flow's approved call is one yes: the person's answer to the Flow's own question is the Gate's, so the send goes out and nothing is held again", { timeout: 300_000 }, async t => {
  const w = await world(t);
  await flowStep(w, "billing.email", { to: "ap@northwind.example", subject: "Invoice 1042", body: "Overdue." });
  await until(() => w.sent.length === 1, "the email reached the mail server");
  assert.equal(await gateHeld(w), 0, "nothing waits at the Gate for a second yes");
});

test("a Flow's yes covers one send, and only the sends its tool names: a second send is held, and so is one behind a hop the tool does not name", { timeout: 300_000 }, async t => {
  const w = await world(t);
  await flowStep(w, "billing.twice", { to: "ap@northwind.example", to2: "billing@oakline.example" });
  await until(() => w.sent.length === 1, "the first send went");
  assert.equal(await gateHeld(w), 1, "the second send of the same act waits for its own yes");
  await flowStep(w, "billing.uncovered", { to: "accounts@brightwell.example" });
  assert.equal(w.sent.length, 1, "the send behind an unnamed hop did not go");
  assert.equal(await gateHeld(w), 2);
  await flowStep(w, "billing.nested", { to: "ap@northwind.example" });
  await until(() => w.sent.length === 2, "the nested send the tool names rode the Flow's yes");
  assert.equal(await gateHeld(w), 2);
});

test("a Flow's receipt cannot be made by anyone but the registry, and a receipt made for one call opens no other", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const mine = { card: "flowtask:01a12326-6b9a-43f8-b32b-443ebbfbd155", tool: "billing.email", input_sha256: "a".repeat(32), asker: "module:flows>deck" };
  for (const caller of ["cli", "mcp", "module:billing", "module:flows"]) assert.ok((await w.d.registry.call("approvals.receipt", mine, caller)).error, `${caller} was refused`);
  // a made-up flow mark at the Gate is held: no receipt stands behind it
  const r = await w.d.registry.call("gate.request", { kind: "send", via: "mail", to: "ap@northwind.example", content: { subject: "s", body: "b" }, why: "forged", covered: mine }, "module:billing");
  assert.ok(r.error || (r.data && r.data.state === "held"), JSON.stringify(r));
  assert.equal(w.sent.length, 0);
});

test("a person's confirmed preview in a view is one yes: the words they read are the Gate's yes for the send the tool files, once", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const act = (/** @type {any} */ extra) => w.asPerson("views.act", { module: "billing", command: "chase", action: "submit", form: "chase", fields: { to: "ap@northwind.example" }, ...extra });
  const first = await act({});
  assert.equal(first.kind, "preview", JSON.stringify(first).slice(0, 300));
  assert.equal(w.sent.length, 0, "nothing goes before the person confirms the words");
  const done = await act({ asked: { hash: first.hash, token: first.token } });
  assert.equal(done.kind, "done", JSON.stringify(done).slice(0, 300));
  await until(() => w.sent.length === 1, "the send reached the mail server");
  assert.equal(await gateHeld(w), 0, "nothing waits at the Gate for a second yes");
  // the same confirmation does not send again
  const again = await act({ asked: { hash: first.hash, token: first.token } });
  assert.equal(w.sent.length, 1, JSON.stringify(again).slice(0, 200));
});

test("a text goes out on one yes through the person's own Twilio item: connected from the Vault's catalog, fetched for the one send, nothing held again", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const connected = await w.asPerson("vault.connect", { module: "comms", need: "twilio", fields: { value: "0123456789abcdef0123456789abcdef" } });
  assert.equal(connected.item, "comms-twilio", JSON.stringify(connected).slice(0, 300));
  /** @type {{ url: string, auth: string, body: string }[]} */ const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => { posted.push({ url: String(url), auth: String((init.headers && (init.headers.authorization || init.headers.Authorization)) || (init.headers && init.headers.get && init.headers.get("authorization")) || ""), body: String(init.body || "") }); return new Response(JSON.stringify({ sid: "SM1" }), { status: 201, headers: { "content-type": "application/json" } }); });
  t.after(() => { globalThis.fetch = realFetch; });
  const input = { via: "sms", to: "+15555550199", body: "Your hearing moved to Tuesday." };
  const card = await approved(w, "comms.send", input);
  const r = await w.d.registry.call("comms.send", input, "mcp", { approval: card });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  await until(() => posted.length === 1, "Twilio was asked for the text");
  assert.equal(posted[0].url, `https://api.twilio.com/2010-04-01/Accounts/AC${"a".repeat(32)}/Messages.json`);
  assert.equal(posted[0].auth, `Basic ${Buffer.from(`AC${"a".repeat(32)}:0123456789abcdef0123456789abcdef`).toString("base64")}`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(posted[0].body)), { To: "+15555550199", Body: "Your hearing moved to Tuesday.", From: "+15555550123" });
  assert.equal(await gateHeld(w), 0, "nothing waits at the Gate for a second yes");
});

test("an e-mail from comms.send reaches a real mail account on one yes: the account connected from the Vault's catalog, the held message released to SMTP, nothing held twice", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const fake = await startFakeMail(t, { user: "alex@harlow.example", password: "hunter2-hunter2" });
  const connected = await w.asPerson("vault.connect", { module: "mail", need: "imap", label: "alex", fields: { imap_host: "127.0.0.1", imap_port: String(fake.imap.port), smtp_host: "127.0.0.1", smtp_port: String(fake.smtp.port),
    username: "alex@harlow.example", password: "hunter2-hunter2", from: "alex@harlow.example", security: "tls" } });
  assert.ok(connected.item, JSON.stringify(connected).slice(0, 300));
  // the catalog takes only tls or starttls; the stand-in mail server speaks plain, so the one field is set to that after the connection is made
  await w.asPerson("vault.put", { name: connected.item, kind: "env-set", fields: { imap_host: "127.0.0.1", imap_port: String(fake.imap.port), smtp_host: "127.0.0.1", smtp_port: String(fake.smtp.port), username: "alex@harlow.example", password: "hunter2-hunter2", from: "alex@harlow.example", security: "none" } });
  const accounts = await w.asPerson("mail.accounts", {});
  assert.ok((accounts.accounts || accounts).length >= 1, `the account is there: ${JSON.stringify(accounts).slice(0, 300)}`);
  const input = { via: "email", to: "dana@harlow.test", subject: "Your document is ready to sign", body: "Your document is ready to sign: https://documents.harlow.vyre.run/sign/1/abc" };
  const card = await approved(w, "comms.send", input);
  const r = await w.d.registry.call("comms.send", input, "mcp", { approval: card });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  await until(() => fake.sent.length === 1, "the mail server received the message");
  assert.deepEqual(fake.sent[0].rcpt, ["dana@harlow.test"]);
  const encoded = fake.sent[0].data.split("\r\n\r\n").slice(1).join("").replace(/\s+/g, "");
  assert.equal(Buffer.from(encoded, "base64").toString(), input.body, "the words the person approved are the words that went out");
  assert.equal(await gateHeld(w), 0, "nothing waits at the Gate for a second yes");
  // the same through a Flow: the person's answer to the Flow's own question is the yes, and the second message goes out the same way
  await flowStep(w, "comms.send", { via: "email", to: "jo@harlow.test", subject: "Your signed copy", body: "Thank you for signing." }, "vyre://space/comms");
  await until(() => fake.sent.length === 2, "the Flow's message reached the mail server");
  assert.deepEqual(fake.sent[1].rcpt, ["jo@harlow.test"]);
  assert.equal(await gateHeld(w), 0, "and nothing waits at the Gate after the Flow's yes");
});
