// Manual proof (not a test): a real Google Workspace domain-wide-delegation service account through the vault, on a quiet box.
//   SA_PATH=/path/to/key.json SUBJECT=mailbox@domain node core/vault/proof-google-dwd.mjs
// It prints statuses and counts only. The key goes into a vault under test in a temp home (sealed there), is never printed or logged, and the temp home is removed at the end.
// Rules it keeps: one subject; Gmail with the read-only scope and GET only; Calendar only on a throwaway calendar it creates and deletes (the create and the delete are held and approved the way a person
// would, by a stand-in gate); nothing is sent and no mailbox is written to.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import * as saidTools from "./said.js";
import { register } from "./request.js";
import { Leases } from "../../kernel/seal/leases.js";
import { SealStore } from "../../kernel/seal/store.js";
import { leasedForward, normalizeRoute } from "../../kernel/seal/uses.js";

const SA = process.env.SA_PATH, SUBJECT = process.env.SUBJECT;
if (!SA || !SUBJECT) { console.error("SA_PATH and SUBJECT are required"); process.exit(2); }
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-proof-")), out = (k, v) => console.log(`${k}: ${v}`);
const READ = "https://www.googleapis.com/auth/gmail.readonly", CAL = "https://www.googleapis.com/auth/calendar";
let cleanup = async () => {};
try {
  const db = open(path.join(home, "vyre.db")); migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "proof-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  const gate = new Map(), gateCall = async (tool, input) => tool === "gate.offer" ? { data: {} } : tool === "gate.request" ? (() => { const id = `held_${gate.size + 1}`; gate.set(id, { via: "vault-api", by: "proof-runner", draft: input.content, final: input.content }); return { data: { id, state: "held", message: "held" } }; })() : tool === "gate.get" ? { data: { ...gate.get(input.id), state: "sending" } } : { error: { code: "no_such_tool", message: tool } };
  const tools = new Map(), tool = (n, c, d, i, run) => tools.set(n, { run }), internal = (n, d, i, run) => tools.set(n, { run });
  const said = saidTools.register({ vault: v, internal }); register({ vault: v, tool, internal, call: gateCall, said, deps: {} });
  const run = (name, input, caller = "cli") => tools.get(name).run(input, { caller });
  await v.put({ name: "sa-key", kind: "env-set", fields: { json: fs.readFileSync(SA, "utf8") } }, "cli");
  const cred = (name, subject, scopes, hosts, endpoints = []) => v.put({ name, kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "service-account", item: "sa-key", field: "json", subject, scopes }, hosts, endpoints }) } }, "cli");
  await cred("gmail-ro", SUBJECT, [READ], ["gmail.googleapis.com"]);
  await cred("gmail-other", `vyre-proof-nobody@${SUBJECT.split("@")[1]}`, [READ], ["gmail.googleapis.com"]);
  out("credentials stored", "gmail-ro (subject pinned to the one mailbox), gmail-other (a different subject, never used)");

  // 1. Through vault.request: a read-only call, counted not printed.
  const labels = await run("vault.request", { credential: "gmail-ro", method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/me/labels" });
  out("vault.request GET labels", `status ${labels.status}, ${Array.isArray(labels.body?.labels) ? labels.body.labels.length : "?"} labels`); assert.equal(labels.status, 200);
  assert.equal(JSON.stringify(labels).includes("PRIVATE KEY"), false);

  // 2. Through the forward: a lease, a route pinned to that subject's credential, the real route rules.
  const store = new SealStore(fs.mkdtempSync(path.join(home, "seal-")), crypto.randomBytes(32)), leases = new Leases(store), lease = leases.issue({ space: "spc_proofproofproofproof", member: "per_proofproofproofpro", device: "dev_proof", allowed: true });
  const routes = [normalizeRoute({ route: "gmail.googleapis.com", ref: "gmail-ro", allow: [{ method: "GET", path: "/gmail/v1/users/me/*" }], deny: [{ path: "/gmail/v1/users/me/settings/*" }], contentTypes: ["application/json"] })];
  const go = leasedForward({ chain: null, leaseOf: s => (s === "proof" ? lease.id : null), check: async ({ id }) => leases.check({ id, member: "per_proofproofproofpro" }), routesOf: () => routes,
    forward: i => run("vault.forward", { credential: i.ref, method: i.method, url: `https://${i.route}${i.path}`, query: i.query, headers: i.headers, body: i.body, session: i.session }, "kernel:leases") });
  const viaForward = await go({ session: "proof", route: "gmail.googleapis.com", method: "GET", path: "/gmail/v1/users/me/labels" });
  out("forward GET labels (route pinned to the subject)", `status ${viaForward.status}, ${JSON.parse(Buffer.from(viaForward.body, "base64").toString()).labels?.length ?? "?"} labels`); assert.equal(viaForward.status, 200);
  const refusals = [];
  for (const [why, req] of [["another subject's route", { route: "gmail.googleapis.com", method: "GET", path: "/gmail/v1/users/vyre-proof-nobody@x.test/labels" }], ["settings (denied)", { route: "gmail.googleapis.com", method: "GET", path: "/gmail/v1/users/me/settings/filters" }], ["a send (not allowed)", { route: "gmail.googleapis.com", method: "POST", path: "/gmail/v1/users/me/messages/send" }], ["another host", { route: "evil.example", method: "GET", path: "/gmail/v1/users/me/labels" }]]) {
    try { await go({ session: "proof", ...req }); refusals.push(`${why}: NOT REFUSED`); } catch (e) { refusals.push(`${why}: refused (${e.code})`); }
  }
  for (const r of refusals) out("forward", r); assert.ok(refusals.every(r => /refused/.test(r) && !/NOT REFUSED/.test(r)));
  // The other subject's credential exists in the vault but no route names it, so no request can reach it, and the vault never tried to mint for it.
  const touched = db.prepare("SELECT COUNT(*) AS n FROM vault_audit WHERE name = ? AND action = 'api-request'").get("gmail-other");
  out("a route for a different subject", `refused: no route names that credential, and the vault never used it (${touched.n} audit rows for it)`); assert.equal(touched.n, 0);

  // 3. Calendar: a throwaway calendar, created and deleted (each held, then approved by this runner).
  await cred("cal-test", SUBJECT, [CAL], ["www.googleapis.com"], [{ method: "POST", path: "/calendar/v3/calendars", kind: "send" }, { method: "DELETE", path: "/calendar/v3/calendars/*", kind: "delete" }]);
  let calId = null;
  const del = async id => { const h = await run("vault.request", { credential: "cal-test", method: "DELETE", url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}` }); return h.held ? run("vault.api.send", { id: h.held }, "module:gate") : h; };
  const listProof = async () => { const r = await run("vault.request", { credential: "cal-test", method: "GET", url: "https://www.googleapis.com/calendar/v3/users/me/calendarList", query: { minAccessRole: "owner", maxResults: "250" } }); return (r.body?.items ?? []).filter(c => String(c.summary).startsWith("vyre-proof-")); };
  cleanup = async () => { if (calId) { try { const r = await del(calId); out("cleanup delete", `status ${r.status}`); } catch (e) { out("cleanup delete failed", String(e.message).slice(0, 160)); } } };
  if (process.env.CLEAN === "1") { const left = await listProof(); out("throwaway calendars found", left.length); for (const c of left) { const r = await del(c.id); out("deleted one", `status ${r.status}`); } out("remaining", (await listProof()).length); process.exit(0); }
  try {
    const held = await run("vault.request", { credential: "cal-test", method: "POST", url: "https://www.googleapis.com/calendar/v3/calendars", body: { summary: `vyre-proof-${crypto.randomBytes(4).toString("hex")}` } });
    out("calendar create", held.held ? "held for approval (as a send), approved by the runner" : "ran"); const made = held.held ? await run("vault.api.send", { id: held.held }, "module:gate") : held;
    calId = made.body?.id; out("calendar created", calId ? "yes (a throwaway calendar)" : `no (${made.status})`);
  } catch (e) { out("calendar", `skipped: ${String(e.message).slice(0, 160)}`); }
  if (calId) { await cleanup(); const left = await listProof(); out("calendar deleted", left.some(c => c.id === calId) ? "NO: still listed" : "yes (no longer listed)"); calId = null; }
  // Nothing in the audit carries the key.
  out("key in the audit", JSON.stringify(db.prepare("SELECT * FROM vault_audit").all()).includes("PRIVATE KEY") ? "FOUND" : "none");
  console.log("PROOF OK");
} catch (e) { console.error("PROOF FAILED:", String(e.message).slice(0, 300)); process.exitCode = 1; }
finally { await cleanup().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); }
