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

async function story(/** @type {import("node:test").TestContext} */ t, /** @type {{ approveGate: boolean }} */ o) {
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
    gate: { senders: { mail: { type: "gmail", vault: "mail-token", from: "alex@example.com", base: `http://127.0.0.1:${/** @type {any} */ (outbox.address()).port}` } } } }));
  // A stand-in for the mail module (the real one needs a vault account), with the same shape: an outward tool that files the message at the Gate, as mail.send does.
  writeModule(mods, "billing", { version: "0.1.0", does: { tools: [{ name: "billing.email", reach: "anyone", outward: true, effect: "write", summary: "email a client about an overdue invoice" }] }, needs: { tools: ["gate.request"] } },
    `export default { async start(ctx) { ctx.tool("billing.email", { callers: ["cli", "mcp", "harness", "module"], input: { type: "object" }, run: async (i) => { const r = await ctx.call("gate.request", { kind: "send", via: "mail", to: i.to, content: { subject: i.subject, body: i.body, ...(i.cc ? { cc: i.cc } : {}) }, why: "overdue invoice" }); if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data || r; } }); return {}; } };`);
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
  if (!o.approveGate) {
    assert.equal(heldAgain, 0, S6(`the group yes did not send them: ${heldAgain} email(s) are held AGAIN at the Gate and wait for a second yes (gate.approve). The outward card's yes and the Gate's hold are two separate approvals for one send.`));
    await until(() => sent.length >= 3, S6(`only ${sent.length} of 3 emails reached the mail server`));
  } else {
    // with the Gate items approved too (what the person is asked for today), the story carries on
    const h = await asPerson("gate.held", {});
    const items = Array.isArray(h) ? h : h.items || [];
    assert.equal(items.length, 3, S6(`the Gate holds ${items.length} items, not 3`));
    for (const it of items) await asPerson("gate.approve", { id: it.id });
    await until(() => sent.length >= 3, S6(`only ${sent.length} of 3 emails reached the mail server after gate.approve`));
  }

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
  assert.equal(closingLine(answered.results, group, { logged: comms.length >= 3 }), "Sent 3 emails. Each is logged on its client.", S8("the line is not the gif's"));
}

test("the README gif's story: handed to kit, its steps nested, three emails held as one group, one yes, sent, logged on the clients", { timeout: 300_000 }, async t => {
  await story(t, { approveGate: false });
});

test("the same story with the Gate's own approval given too: what follows the sends works", { timeout: 300_000 }, async t => {
  await story(t, { approveGate: true });
});
