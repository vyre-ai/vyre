// @ts-check
// Approve and Deny from a notice, on the real registry with the real approvals queue (as test/grouped-approval.test.js builds it). A held send makes a notice with two buttons; each button's route is read the
// way Now reads it and answered by the code the card on Now runs (apps/app/src/real/phone-approve.js), so there is one yes and one no, never a second path from the lock screen.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../core/modules/index.js";
import { Events } from "../kernel/bus.js";
import { open } from "../core/store/index.js";
import { configureYes } from "../lib/one-yes.js";
import { approvalNotices } from "../apps/app/src/native/notices-model.js";
import { cleanNotice } from "../apps/app/src/native/notify-model.ts";
import { actFrom, answerFromNotice } from "../apps/app/src/real/notice-act.js";
import { tempHome, writeModule } from "./helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canon = (/** @type {any} */ o) => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));

async function world(/** @type {import("node:test").TestContext} */ t) {
  globalThis.__sent = [];
  t.after(() => { delete globalThis.__sent; configureYes({ verify: null }); });
  configureYes({ softwareOk: () => true, verify: async ({ op, fields, proof }) => (proof && proof.ok === true && proof.for === canon({ op, fields: canon(fields) }) ? null : "bad_signature") });
  const home = tempHome(t), root = path.join(home, "mods");
  writeModule(root, "mail", { version: "0.1.0", vyre: "1", description: "Sends mail.", does: { tools: [{ name: "mail.send", reach: "anyone", outward: true, summary: "send an email" }] } },
    `export default { async start(ctx) { ctx.tool("mail.send", { callers: ["cli", "mcp", "harness", "module"], input: { type: "object" }, run: async (i) => { (globalThis.__sent ||= []).push(i); return { sent: i.to }; } }); return {}; } };`);
  fs.mkdirSync(path.join(root, "approvals"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "core", "approvals", "module.json"), path.join(root, "approvals", "module.json"));
  fs.writeFileSync(path.join(root, "approvals", "index.js"), `export { default } from ${JSON.stringify(path.join(REPO, "core", "approvals", "index.js"))};`);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, kernel: { proofFrom: (/** @type {any} */ m) => (m.proof ? { presence: m.proof } : undefined) } });
  reg.firstPartyRoots = [root];
  await reg.start(discover([root], { firstPartyRoots: [root] }), { role: "local" });
  t.after(() => db.close());
  assert.equal(reg.modules.get("approvals").state, "running", reg.modules.get("approvals").error);
  return reg;
}

const ASKER = "mcp:agent:kit";
/** The phone's side: the same calls the app makes, as the person's own session; the "key" proves exactly the card it is given. */
const phone = (/** @type {any} */ reg) => ({
  call: async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ o) => {
    const r = await reg.call(tool, input, "cli", o && o.kernelProof ? { proof: o.kernelProof } : {});
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data;
  },
  // the test's stand-in for the key proves the request the card holds (the box's verifier here checks `for` over the held call), as test/grouped-approval.test.js does
  signer: { signPresence: async (/** @type {any} */ req) => {
    const held = (await reg.call("approvals.pending", {}, "cli")).data.approvals.find((/** @type {any} */ c) => c.payload_hash === req.payload_hash);
    return { ok: true, payload_hash: req.payload_hash, for: canon({ op: held.request.op, fields: canon(held.request.fields) }) };
  } },
  header: (/** @type {any} */ proof) => proof,
  person: "p_owner",
});
const hold = async (/** @type {any} */ reg, /** @type {any} */ mail) => { const r = await reg.call("mail.send", mail, ASKER); assert.equal(r.error.code, "held_for_approval", JSON.stringify(r.error)); return r.error; };

const MAIL = { to: "Northwind", subject: "Invoice 1042 is overdue", body: "Please pay this week." };
/** Read a button's route the way Now reads it when the app opens on it. @param {{ route: string }} b */
const opened = (b) => actFrom(Object.fromEntries(new URL("vyre:/" + b.route).searchParams));

test("a held send's notice has Approve and Deny; Approve goes through the card's own path and the mail goes out once", async t => {
  const reg = await world(t);
  const p = phone(reg);
  await hold(reg, MAIL);
  const pending = await p.call("approvals.pending", {});
  const n = approvalNotices(new Set(), pending).notices;
  assert.equal(n.length, 1);
  const shown = cleanNotice(n[0]);
  assert.deepEqual(shown?.actions?.map(a => a.label), ["Approve", "Deny"], "what the lock screen shows");
  const approve = shown?.actions?.find(a => a.id === "approve");
  assert.ok(approve && approve.route.startsWith("/u/now?act=approve&group=gp_"), approve && approve.route);
  const want = opened(approve);
  assert.ok(want && want.group);
  assert.deepEqual(globalThis.__sent, [], "nothing goes before the yes");
  const out = await answerFromNotice(want, pending, p);
  assert.equal(out.kind, "approved", out.say);
  assert.match(out.say, /^Approved: /);
  // the assistant retries with its card, as for the card on Now: it goes, once
  const card = pending.approvals[0];
  const sent = await reg.call("mail.send", MAIL, ASKER, { approval: card.id });
  assert.equal(sent.data && sent.data.sent, "Northwind", JSON.stringify(sent));
  assert.equal((await reg.call("mail.send", MAIL, ASKER, { approval: card.id })).error.code, "approval_refused", "a yes is spent once");
  assert.deepEqual(globalThis.__sent.map((/** @type {any} */ m) => m.to), ["Northwind"]);
  assert.deepEqual(approvalNotices(new Set(), await p.call("approvals.pending", {})).notices, [], "nothing waits now");
});

test("Deny from the notice sends nothing and ends the card; the same button again says it ended", async t => {
  const reg = await world(t);
  const p = phone(reg);
  await hold(reg, { ...MAIL, to: "Oakline" });
  const pending = await p.call("approvals.pending", {});
  const [n] = approvalNotices(new Set(), pending).notices;
  const want = opened(/** @type {any} */ (n.actions?.find(a => a.id === "deny")));
  assert.ok(want);
  const out = await answerFromNotice(want, pending, p);
  assert.equal(out.kind, "denied", out.say);
  const card = pending.approvals[0];
  assert.equal((await reg.call("mail.send", { ...MAIL, to: "Oakline" }, ASKER, { approval: card.id })).error.code, "approval_refused", "the denied call does not go");
  assert.deepEqual(globalThis.__sent, []);
  const again = await answerFromNotice(want, await p.call("approvals.pending", {}), p);
  assert.equal(again.kind, "gone");
  assert.equal(again.say, "That request ended before you answered.");
});

test("a group of three has no buttons; a group that grew after the notice cannot be approved from it", async t => {
  const reg = await world(t);
  const p = phone(reg);
  await hold(reg, { ...MAIL, to: "A" });
  const first = await p.call("approvals.pending", {});
  const [solo] = approvalNotices(new Set(), first).notices;
  const want = opened(/** @type {any} */ (solo.actions?.find(a => a.id === "approve")));
  assert.ok(want);
  for (const to of ["B", "C"]) await hold(reg, { ...MAIL, to });
  const three = await p.call("approvals.pending", {});
  const g = approvalNotices(new Set(), three).notices;
  assert.ok(g.length === 1 && !g[0].actions, "three calls are read on Now, no buttons");
  const late = await answerFromNotice(/** @type {any} */ (want), three, p);
  assert.equal(late.kind, "failed");
  assert.match(late.say, /More calls joined/);
  assert.deepEqual(globalThis.__sent, [], "nothing was signed or sent");
});

test("a route that is not ours, or a button whose card is gone, does nothing", async t => {
  const reg = await world(t);
  const p = phone(reg);
  assert.equal(actFrom({ act: "approve", card: "../../x y" }), null);
  assert.equal(actFrom({ act: "send", card: "ap_1" }), null);
  assert.equal(actFrom({ act: "approve", card: "ap_1", group: "gp_1" }), null);
  assert.equal(actFrom({}), null);
  const out = await answerFromNotice({ act: "approve", group: "gp_nope" }, await p.call("approvals.pending", {}), p);
  assert.equal(out.kind, "gone");
  assert.deepEqual(globalThis.__sent, []);
});
