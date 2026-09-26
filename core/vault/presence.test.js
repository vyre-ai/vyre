// @ts-check
// Presence declarations (ADR 0006, section 3): every tool that hands out, writes, moves or
// unlocks a value declares `presence` with a summary that names items and destinations and
// never a value. The module is started against a recording ctx, so the declarations are read
// straight off what index.js registers; a tool that loses its declaration fails here.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import mod from "./index.js";
import { encodeTicket } from "./relay.js";

export const NEEDS_PRESENCE = [
  "vault.put", "vault.delete", "vault.import", "vault.grant", "vault.approve", "vault.inject", "vault.totp",
  "vault.backup", "vault.restore", "vault.pass.create", "vault.pass.accept", "vault.offboard", "vault.unlock",
  "vault.unlock-passphrase", "vault.device.code", "vault.device.unlock",
];
/** Taking access away, reading names and asking for pending things never needs a person. */
const NO_PRESENCE = ["vault.list", "vault.revoke", "vault.pending", "vault.audit", "vault.lock", "vault.identity",
  "vault.pass.list", "vault.pass.revoke", "vault.devices", "vault.device.revoke"];

/** Start the vault module against a ctx that records every tool definition. */
export async function recorded(t, extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-presence-"));
  const db = open(path.join(tmp, "vyre.db"));
  /** @type {Map<string, any>} */
  const tools = new Map();
  const events = [], logs = [];
  const ctx = {
    store: { db, migrate: steps => migrate(db, "vault", steps) },
    paths: { vault: path.join(tmp, "vault") },
    config: { name: "test-box", vault: { keystore: "file", ...extra } },
    events: { emit: (type, p) => events.push({ type, p }) },
    log: m => logs.push(m),
    tool: (name, def) => tools.set(name, def),
  };
  const running = await mod.start(ctx);
  t.after(async () => { await running.stop(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const run = (name, input, caller = "cli") => tools.get(name).run(input, { caller });
  return { tmp, db, tools, events, logs, run };
}

test("presence: every value-out or access-giving tool declares it, with a summary", async t => {
  const { tools } = await recorded(t);
  for (const n of NEEDS_PRESENCE) {
    assert.ok(tools.has(n), `${n} is registered`);
    const p = tools.get(n).presence;
    assert.ok(p, `${n} declares presence`);
    assert.equal(typeof p.summary, "function", `${n} has a summary`);
  }
  for (const n of NO_PRESENCE) assert.ok(!tools.get(n)?.presence, `${n} needs no person`);
  // vault.release is internal (modules only) and exempt; everything else registered is listed above.
  const known = new Set([...NEEDS_PRESENCE, ...NO_PRESENCE, "vault.release", "vault.generate", "vault.match", "vault.relay"]);
  for (const n of tools.keys()) assert.ok(known.has(n) || tools.get(n).presence, `${n} is new: decide whether it needs presence`);
});

test("presence: summaries name items and destinations and never a value, and never throw", async t => {
  const { tools, run } = await recorded(t);
  const canary = `fixture-canary-${crypto.randomBytes(12).toString("hex")}`;
  const sum = (n, input) => tools.get(n).presence.summary(input);

  assert.equal(await sum("vault.put", { name: "billing-key", kind: "api-key", value: canary }), `Add api-key "billing-key" in the vault`);
  await run("vault.put", { name: "billing-key", kind: "api-key", value: canary });
  assert.equal(await sum("vault.put", { name: "billing-key", value: canary }), `Replace api-key "billing-key" in the vault`);
  assert.match(await sum("vault.inject", { items: [{ name: "billing-key", env: "BILLING_KEY" }] }), /"billing-key" as BILLING_KEY into a program's environment/);
  assert.match(await sum("vault.backup", { file: "/tmp/acme.vyre", passphrase: canary }), /Write a sealed backup of 1 items to \/tmp\/acme.vyre/);
  assert.match(await sum("vault.grant", { name: "billing-key", module: "mail" }), /Let mail use "billing-key"/);
  assert.match(await sum("vault.pass.create", { holder: "Dana", items: ["billing-key"], expires: "2026-10-01" }), /Share "billing-key" with Dana, relayed, until 2026-10-01/);
  assert.match(await sum("vault.totp", { name: "billing-key" }), /one-time code for "billing-key"/);
  assert.match(await sum("vault.device.code", { name: "laptop chrome" }), /Pair a new browser \(laptop chrome\)/);
  assert.match(await sum("vault.device.unlock", { device: "d_none" }), /Unlock autofill in a paired browser/);
  const ticket = encodeTicket({ pass: "p_x", owner: "alex", relay: "https://relay.acme.test", ownerSign: "k", holder: "dana", items: ["stripe-key"], mode: "relayed", expires: null });
  assert.match(await sum("vault.pass.accept", { ticket }), /Accept a relayed pass from alex holding "stripe-key"/);
  // A malformed input falls back to the generic words rather than printing the input.
  assert.equal(await sum("vault.pass.accept", { ticket: canary }), "Accept a pass someone sent");
  for (const n of NEEDS_PRESENCE) {
    const s = await sum(n, { name: "billing-key", value: canary, passphrase: canary, fields: { value: canary }, ticket: canary, items: [{ name: "billing-key" }] });
    assert.equal(typeof s, "string");
    assert.ok(s.length > 0 && !s.includes(canary), `${n}: ${s}`);
  }
});

test("generate from mcp only creates a new name", async t => {
  const { run } = await recorded(t);
  await run("vault.put", { name: "site-login", kind: "login", fields: { username: "alex@example.com", password: "fixture-old" } });
  await assert.rejects(async () => run("vault.generate", { name: "site-login" }, "mcp"), /may only generate into a new name/);
  assert.equal((await run("vault.generate", { name: "fresh-secret" }, "mcp")).stored, "fresh-secret");
  // A person still rotates a login's password with it.
  assert.equal((await run("vault.generate", { name: "site-login" }, "cli")).stored, "site-login");
});
