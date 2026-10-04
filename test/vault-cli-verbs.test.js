// @ts-check
// The `vyre vault` verbs no other test runs, against real vyreds in temp homes: `ls`, `pending`
// and `approve` for a grant an agent asked for, `revoke`, `share` (a pass said the 1Password
// way), `move` into a shared vault, `kit` and `migrate-key`. Each has its happy path, one
// refusal, and --json where it is a read. The last test runs the writes against the REAL
// presence verifier with no terminal: each is refused with exit 3, asking for a person.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { upPresent, tempHome } from "./helpers.js";
import { call } from "../core/daemon/client.js";
import { start } from "../core/daemon/index.js";
import { Presence } from "../core/presence/index.js";
import { SCRATCH } from "./scratch.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "vyre");
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

/** Run `vyre` with piped stdin; `detached` gives it no controlling terminal, as the model's Bash. */
function vyre(home, args, input, { detached = false } = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { detached, env: { ...process.env, VYRE_HOME: home, NO_COLOR: "1" } });
    let out = "", err = "";
    p.stdout.on("data", c => { out += c; });
    p.stderr.on("data", c => { err += c; });
    p.on("close", code => resolve({ code, out, err, all: out + err }));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

function home(t, config) {
  const h = fs.mkdtempSync(path.join(SCRATCH, "vyre-test-"));
  if (path.resolve(h) === path.resolve(os.homedir(), ".vyre")) throw new Error("a test tried to use the real ~/.vyre");
  fs.writeFileSync(path.join(h, "config.json"), JSON.stringify(config));
  t.after(async () => { await vyre(h, ["down"]); fs.rmSync(h, { recursive: true, force: true }); });
  return h;
}

/** --json prints exactly one line on stdout, and it parses. */
function one(r) {
  const lines = r.out.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON line, got: ${r.all}`);
  return JSON.parse(lines[0]);
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let body = ""; res.on("data", c => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body })); }).on("error", reject);
  });
}

test("vault verbs: an agent's grant waits in pending, approve allows it, ls shows it, revoke takes it back", async t => {
  const h = home(t, { name: "owner-box", vault: { keystore: "file" } });
  assert.equal((await upPresent(h)).code, 0);
  assert.equal((await vyre(h, ["vault", "put", "api-token", "--kind", "api-key"], fake("token"))).code, 0);

  assert.match((await vyre(h, ["vault", "pending"])).out, /nothing waiting for approval/);
  assert.deepEqual(one(await vyre(h, ["vault", "pending", "--json"])).data.grants, []);

  // An agent (the mcp caller) asks; the grant waits for a person.
  const asked = await call("vault.grant", { name: "api-token", module: "gate" }, { root: h, caller: "mcp" });
  assert.equal(asked.data?.grant?.status, "pending", JSON.stringify(asked));
  const id = asked.data.grant.id;
  const shown = await vyre(h, ["vault", "pending"]);
  assert.equal(shown.code, 0, shown.all);
  assert.match(shown.out, new RegExp(`${id}\\s+grant api-token to gate`));
  assert.match(shown.out, /vyre vault approve <id>/);
  const pend = one(await vyre(h, ["vault", "pending", "--json"])).data;
  assert.deepEqual(pend.grants.map(g => [g.id, g.name, g.module, g.status]), [[id, "api-token", "gate", "pending"]]);
  assert.doesNotMatch((await vyre(h, ["vault", "ls"])).out, /granted to gate/, "a pending grant is not a grant yet");

  // approve: bad input first, then the real id.
  const bare = await vyre(h, ["vault", "approve"]);
  assert.equal(bare.code, 1);
  assert.match(bare.all, /vyre vault approve <id>/);
  const ghost = await vyre(h, ["vault", "approve", "g_nothing", "--json"]);
  assert.equal(ghost.code, 1, ghost.all);
  assert.match(one(ghost).error.message, /nothing pending with id g_nothing/);
  const ok = await vyre(h, ["vault", "approve", id]);
  assert.equal(ok.code, 0, ok.all);
  assert.match(ok.out, /approved api-token to gate/);
  assert.match((await vyre(h, ["vault", "pending"])).out, /nothing waiting for approval/);

  // ls is list: the same words, the same --json.
  const ls = await vyre(h, ["vault", "ls"]);
  assert.match(ls.out, /api-token\s+api-key/);
  assert.match(ls.out, /granted to gate/);
  assert.deepEqual(one(await vyre(h, ["vault", "ls", "--json"])), one(await vyre(h, ["vault", "list", "--json"])));

  // revoke: needs both words; takes it back; a second time says there was nothing to take.
  const half = await vyre(h, ["vault", "revoke", "api-token"]);
  assert.equal(half.code, 1);
  assert.match(half.all, /vyre vault revoke <name> <module>/);
  const rv = await vyre(h, ["vault", "revoke", "api-token", "gate"]);
  assert.equal(rv.code, 0, rv.all);
  assert.match(rv.out, /revoked api-token from gate/);
  assert.doesNotMatch((await vyre(h, ["vault", "ls"])).out, /granted to/);
  assert.match((await vyre(h, ["vault", "revoke", "api-token", "gate"])).out, /gate had no grant of api-token/);
});

test("vault verbs: share is pass create with --with; move puts an item in a shared vault", async t => {
  const owner = home(t, { name: "owner-box", vault: { keystore: "file", relay: { host: "127.0.0.1", port: 0 } } });
  const mate = home(t, { name: "kit-box", vault: { keystore: "file" } });
  assert.equal((await upPresent(owner)).code, 0);
  assert.equal((await upPresent(mate)).code, 0);
  const token = fake("token");
  await vyre(owner, ["vault", "put", "api-token", "--kind", "api-key", "--host", "https://api.example.com"], token);
  await vyre(owner, ["vault", "put", "db-password"], fake("db"));

  const noWith = await vyre(owner, ["vault", "share", "api-token"]);
  assert.equal(noWith.code, 1);
  assert.match(noWith.all, /vyre vault share <item\.\.\.> --with <person>/);
  const noCard = await vyre(owner, ["vault", "share", "api-token", "--with", "kit"]);
  assert.equal(noCard.code, 1, noCard.all);
  assert.match(noCard.all, /no card for kit/);

  const card = (await vyre(mate, ["vault", "card"])).out.split("\n").find(l => l.startsWith("vyre-card:v2:"));
  assert.ok(card, "the teammate has no card");
  const shared = await vyre(owner, ["vault", "share", "api-token", "--with", "kit", "--card", card, "--note", "for the billing sync"]);
  assert.equal(shared.code, 0, shared.all);
  const ticket = shared.out.split("\n").find(l => l.startsWith("vyre-pass:v2:"));
  assert.ok(ticket, shared.out);
  assert.ok(!shared.all.includes(token));
  const passes = one(await vyre(owner, ["vault", "pass", "list", "--json"])).data.passes;
  assert.deepEqual(passes.map(p => [p.holder, p.items, p.mode]), [["kit", ["api-token"], "relayed"]]);
  assert.match((await vyre(mate, ["vault", "pass", "accept", ticket])).out, /accepted relayed pass from owner-box: api-token/);

  // move: a shared vault first, then the item into it; it leaves the local vault.
  assert.equal((await vyre(owner, ["vault", "vaults", "create", "harlow-legal"])).code, 0);
  const usage = await vyre(owner, ["vault", "move", "db-password"]);
  assert.equal(usage.code, 1);
  assert.match(usage.all, /vyre vault move <item> <vault>/);
  const ghost = await vyre(owner, ["vault", "move", "ghost", "harlow-legal", "--json"]);
  assert.equal(ghost.code, 1, ghost.all);
  assert.ok(one(ghost).error);
  const moved = await vyre(owner, ["vault", "move", "db-password", "harlow-legal"]);
  assert.equal(moved.code, 0, moved.all);
  assert.match(moved.out, /moved db-password → harlow-legal\/db-password/);
  const names = one(await vyre(owner, ["vault", "ls", "--json"])).data.items.map(i => i.name).sort();
  assert.deepEqual(names, ["api-token", "harlow-legal/db-password"]);
  const again = await vyre(owner, ["vault", "move", "harlow-legal/db-password", "harlow-legal"]);
  assert.equal(again.code, 1);
  assert.match(again.all, /already in a shared vault/);
});

test("vault verbs: kit needs a Secret Key, then gives a one-load page; migrate-key on a key file has nothing to move", async t => {
  const h = home(t, { name: "owner-box", vault: { keystore: "file" } });
  assert.equal((await upPresent(h)).code, 0);

  const none = await vyre(h, ["vault", "kit"]);
  assert.equal(none.code, 1, none.all);
  assert.match(none.all, /no Secret Key yet/);
  assert.match(one(await vyre(h, ["vault", "kit", "--json"])).error.message, /no Secret Key yet/);

  const made = await vyre(h, ["vault", "account", "create"], "a long fixture password\n");
  assert.equal(made.code, 0, made.all);
  const sk = /Secret Key\s+(V2-\S+)/.exec(made.out)?.[1];
  assert.ok(sk, made.out);
  const kit = await vyre(h, ["vault", "kit"]);
  assert.equal(kit.code, 0, kit.all);
  assert.match(kit.out, /recovery kit · one load, gone by/);
  const url = /^\s+(http\S+)$/m.exec(kit.out)?.[1];
  assert.ok(url, kit.out);
  assert.ok(!kit.all.includes(sk), "the kit command prints the address, never the Secret Key");
  const page = /** @type {any} */ (await get(url));
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(sk));
  const second = /** @type {any} */ (await get(url).catch(() => ({ status: 0 })));
  assert.notEqual(second.status, 200, "a second load gets nothing");
  const j = one(await vyre(h, ["vault", "kit", "--json"])).data;
  assert.deepEqual(Object.keys(j).sort(), ["expires", "url"]);

  const mk = await vyre(h, ["vault", "migrate-key"]);
  assert.equal(mk.code, 0, mk.all);
  assert.match(mk.out, /done · vault key already fine, Secret Key already fine/);
  assert.deepEqual(one(await vyre(h, ["vault", "migrate-key", "--json"])).data, { key: false, secretKey: false });
  assert.match((await vyre(h, ["vault", "audit", "--limit", "50"])).out, /migrate-key/);
});

test("vault verbs: with the real verifier and no terminal, approve, share, move, kit and migrate-key exit 3", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "owner-box", transcripts: [], vault: { keystore: "file" } }));
  const d = await start({ root, log: () => {}, person: async () => null, presence: deps => new Presence({ ...deps,
    touchid: { available: async () => false, authenticate: async () => ({ ok: false, reason: "unavailable" }) },
    who: async () => ["ttys007"], statTty: () => ({ uid: process.getuid?.() ?? 0, isCharacterDevice: () => true }),
    writeTty: () => {} }) });
  t.after(() => d.stop());
  // Reads and taking access away never ask for a person, so the setup goes straight in.
  const created = await call("vault.vaults.create", { name: "harlow-legal" }, { root, caller: "cli" });
  assert.ok(created.data, JSON.stringify(created));

  const cases = [
    ["vault", "approve", "g_fixture"],
    ["vault", "share", "api-token", "--with", "kit", "--card", "vyre-card:v2:e30"],
    ["vault", "move", "api-token", "harlow-legal"],
    ["vault", "kit"],
    ["vault", "migrate-key"],
  ];
  for (const args of cases) {
    const r = await vyre(root, args, undefined, { detached: true });
    assert.equal(r.code, 3, `vyre ${args.join(" ")}: ${r.all}`);
    assert.match(r.all, /needs a person at a terminal/, `vyre ${args.join(" ")}: ${r.all}`);
  }
  // --json says the same as one line, with the same exit code.
  const j = await vyre(root, ["vault", "migrate-key", "--json"], undefined, { detached: true });
  assert.equal(j.code, 3);
  assert.equal(one(j).error.code, "no_terminal");
  // pending and revoke are not gated: they answer without a person.
  assert.equal((await vyre(root, ["vault", "pending", "--json"], undefined, { detached: true })).code, 0);
  assert.equal((await vyre(root, ["vault", "revoke", "nothing-yet", "gate"], undefined, { detached: true })).code, 0);
});

test("vault verbs: vyre commands lists every word run() dispatches on, as a verb or an alias, and no other", async t => {
  const { HANDLED } = await import("../core/cli/commands/vault.js");
  const h = tempHome(t);
  const r = /** @type {any} */ (await vyre(h, ["commands", "vault", "--json"]));
  assert.equal(r.code, 0, r.all);
  const c = JSON.parse(r.out).commands[0];
  const words = c.verbs.flatMap(v => [v.verb, ...(v.aliases || [])]);
  assert.deepEqual([...words].sort(), [...HANDLED].sort());
  for (const v of c.verbs) assert.ok(c.usage.includes(v.verb), `the usage line names ${v.verb}`);
  assert.equal(c.verbs.find(v => v.verb === "totp").live, true);
  assert.deepEqual(c.verbs.find(v => v.verb === "git-credential").args, [{ name: "choice", required: true, choices: ["get", "store", "erase"] }]);
  assert.ok(c.verbs.find(v => v.verb === "put").flags.some(f => f.name === "stdin"));
});

test("vault verbs --view: kit is a qr frame; a secret without --stdin is a prompt frame, exit 2, and stdin is not read", async t => {
  const h = home(t, { name: "owner-box", vault: { keystore: "file" } });
  assert.equal((await upPresent(h)).code, 0);
  const frames = r => r.out.trim().split("\n").map(l => JSON.parse(l));

  // account create under --view: a prompt naming --stdin, even with a password waiting on stdin.
  const asked = await vyre(h, ["vault", "account", "create", "--view"], "a long fixture password\n");
  assert.equal(asked.code, 2, asked.all);
  const p = frames(asked)[0];
  assert.deepEqual([p.view.kind, p.view.name, p.view.secret], ["prompt", "secret", true]);
  assert.deepEqual(p.view.args, ["vault", "account", "create", "--stdin"]);
  assert.ok(!JSON.parse((await vyre(h, ["vault", "account", "status", "--json"])).out).data.account, "nothing was created");
  // With --stdin the password comes piped in.
  const made = await vyre(h, ["vault", "account", "create", "--view", "--stdin"], "a long fixture password\n");
  assert.equal(made.code, 0, made.all);

  const kit = await vyre(h, ["vault", "kit", "--view"]);
  assert.equal(kit.code, 0, kit.all);
  const f = frames(kit);
  assert.deepEqual([f[0].cmd, f[0].view.kind], ["vault kit", "qr"]);
  assert.equal(f[0].view.text, f[0].data.data.url, "the address is the frame's text; data is what --json prints");
  assert.match(f[0].view.caption, /recovery kit/);
  assert.deepEqual(f.at(-1), { v: 1, done: true, exit: 0 });

  const put = await vyre(h, ["vault", "put", fake("view"), "--view"], "a-fixture-value-that-must-not-be-read");
  assert.equal(put.code, 2, put.all);
  assert.match(frames(put)[0].view.label, /The value of fixture-view-/);
  const listed = frames(await vyre(h, ["vault", "ls", "--view"]));
  assert.deepEqual([listed[0].view.kind, listed[0].view.columns[0].key], ["table", "name"]);
  assert.ok(!listed[0].data.data.items.some(it => /^fixture-view-/.test(it.name)), "the prompt stored nothing");
});
