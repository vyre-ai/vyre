// @ts-check
// `vyre signin`, the daemon half: the command line asks, the phone approves with a proof over { ask, pin_hash }, the terminal gets a person session made for exactly that terminal. A real daemon with the
// kernel on, the terminal login key stubbed (the daemon's `person` seam), the kernel's presence verifier a fake that binds op and fields. A test box, never a Mac.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { canonical } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

/** One call over the daemon's socket, as the CLI makes it, with an optional session cookie. */
const over = (/** @type {string} */ socket, /** @type {string} */ tool, /** @type {any} */ input, /** @type {string | null} */ cookie, /** @type {Record<string, string>} */ extra = {}) => new Promise(resolve => {
  const body = JSON.stringify(input || {});
  const req = http.request({ socketPath: socket, path: `/v1/tools/${tool}`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-vyre-caller": "cli", ...(cookie ? { cookie: `__Host-vyre_person=${cookie}` } : {}), ...extra } }, res => { let t = ""; res.on("data", c => { t += c; }); res.on("end", () => resolve(JSON.parse(t || "{}"))); });
  req.end(body);
});

test("signin: ask from a terminal, the phone approves with a proof over the card's hash, the terminal gets a session that works for that terminal only; a no, a wrong proof and a model's shell change nothing", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  let terminal = "tty-a#100";
  const used = new Set();
  const seen = /** @type {any[]} */ ([]);
  const kernelPresence = { check: async (/** @type {any} */ i) => { seen.push({ op: i.op, fields: i.fields, proof: i.proof, chain: Boolean(i.chain) }); return check(i); } };
  const check = async (/** @type {any} */ i) => (i.chain && i.proof && i.proof.op === i.op && canonical(i.proof.fields) === canonical(i.fields) && !used.has(i.proof.n) && (used.add(i.proof.n), true) ? null : "wrong_payload");
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence, person: async () => (terminal ? { key: terminal, tty: null } : null) });
  t.after(() => d.stop());
  const sock = d.paths.socket;
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta = {}) => d.registry.call(tool, input, caller, meta);
  // a call with no login terminal (a model's shell) is refused
  const none = await call("signin.ask", {}, "cli", {});
  if (none.error?.code === "no_such_tool") assert.fail(JSON.stringify(d.registry.status().find(m => m.name === "approvals")));
  assert.equal(none.error?.code, "no_terminal");
  const asked = await call("signin.ask", {}, "cli", { terminal: { key: terminal } });
  assert.ok(asked.data?.id, JSON.stringify(asked));
  const id = asked.data.id;
  const [card] = (await call("signin.pending", {}, "deck", {})).data.approvals;
  assert.equal(card.id, id); assert.equal(card.op, "grant.signin"); assert.deepEqual(Object.keys(card.fields).sort(), ["ask", "pin_hash"]); assert.ok(!JSON.stringify(card).includes(terminal), "the terminal's key is not on the card");
  // a no without the person's session, and a proof for another payload, change nothing
  const ign = await call("signin.answer", { id, approve: false }, "deck", {});
  assert.equal(ign.data?.answered, "ignored", JSON.stringify(ign));
  assert.equal((await call("signin.answer", { id, approve: true }, "deck", { kernel_proof: { op: "grant.signin", fields: { ask: id, pin_hash: "other" }, n: 1 } })).error?.code, "needs_presence");
  assert.equal((await call("signin.answer", { id, approve: true }, "deck", {})).error?.code, "needs_presence");
  assert.deepEqual((await call("signin.status", { id }, "cli", { terminal: { key: terminal } })).data, { state: "waiting" });
  // another terminal reads nothing
  assert.deepEqual((await call("signin.status", { id }, "cli", { terminal: { key: "tty-b#200" } })).data, { state: "none" });
  // the phone approves
  const proof = { op: "grant.signin", fields: { ask: id, pin_hash: card.fields.pin_hash }, n: 2 };
  const ok = await call("signin.answer", { id, approve: true }, "deck", { kernel_proof: proof });
  assert.equal(ok.data?.answered, "approved", JSON.stringify(ok) + JSON.stringify(seen.at(-1)));
  const done = (await call("signin.status", { id }, "cli", { terminal: { key: terminal } })).data;
  assert.equal(done.state, "approved"); assert.match(done.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual((await call("signin.status", { id }, "cli", { terminal: { key: terminal } })).data, { state: "none" }, "the token is handed over once");
  // over the real socket: the cookie works for this terminal, and only this one
  assert.deepEqual((await over(sock, "signin.out", {}, null)).data, { out: false }, "no cookie, no session");
  assert.deepEqual((await over(sock, "signin.out", {}, "garbage.token")).data, { out: false }, "a cookie that is no session is no session");
  terminal = "tty-b#200";
  const other = await over(sock, "signin.out", {}, done.token);
  assert.ok(!other.data || other.data.out === false, "the token is no use at another terminal: " + JSON.stringify(other));
  terminal = "";
  const shell = await over(sock, "signin.out", {}, done.token);
  assert.ok(!shell.data || shell.data.out === false, "a shell with no login terminal gets no session: " + JSON.stringify(shell));
  terminal = "tty-a#100";
  assert.deepEqual((await over(sock, "signin.out", {}, done.token)).data, { out: true }, "the right terminal ends its own session");
  const gone = await over(sock, "signin.out", {}, done.token);
  assert.ok(gone.error || (gone.data && gone.data.out === false), "after sign out the token is dead: " + JSON.stringify(gone));
});
