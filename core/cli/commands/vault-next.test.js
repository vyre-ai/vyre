// @ts-check
// The vault's newer verbs as a person runs them: the real bin/vyre in a child process, against a
// vyred started here in a temp home with presence stubbed. import of a project with --rewrite,
// run, codes, sweep, health, remind, history and revert, agent logins and uses, rotate --how,
// needs and connect, and voice key through vault.connect.
// Every value is made at run time; none may appear in any output.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { call } from "../../daemon/client.js";
import { tempHome, present, writeModule } from "../../../test/helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");
const hex = n => crypto.randomBytes(n).toString("hex");

/** @returns {Promise<{ code: number, out: string }>} */
const run = (root, args, cwd) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1" }, timeout: 60_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr })));

test("vault cli: import --rewrite, run, codes, sweep, health, history, agent logins, uses", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file", reminders: false },
    modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const vyre = (...args) => run(root, args);
  const tool = (name, input = {}) => call(name, input, { root, caller: "cli" });
  const values = [];
  const v = s => (values.push(s), s);

  // A project with a .env: preview, then import and rewrite.
  const proj = path.join(root, "harlow-intake");
  fs.mkdirSync(proj);
  const key = v(["sk", "proj", hex(24)].join("-"));
  fs.writeFileSync(path.join(proj, ".env"), `PORT=3000\nOPENAI_API_KEY=${key}\n`);
  const pre = await vyre("vault", "import", proj, "--preview");
  assert.equal(pre.code, 0, pre.out);
  assert.match(pre.out, /harlow-intake\.env/);
  assert.match(pre.out, /OPENAI_API_KEY\s+api-key openai/);
  assert.match(pre.out, /stays in the file: PORT/);
  const imp = await vyre("vault", "import", proj, "--rewrite");
  assert.equal(imp.code, 0, imp.out);
  assert.match(imp.out, /rewritten .*\.env/);
  assert.equal(fs.readFileSync(path.join(proj, ".env"), "utf8"), "PORT=3000\nOPENAI_API_KEY=vault://harlow-intake.env/OPENAI_API_KEY\n");
  // `vyre run` reads ./.env's reference; the child prints whether it got the value, not the value.
  const ran = await run(root, ["run", "--", process.execPath, "-e", `process.stdout.write(process.env.OPENAI_API_KEY === ${JSON.stringify(key)} ? "same" : "different")`], proj);
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.out, /same/);

  // Codes: an otpauth link comes in, and the list shows current and next.
  const seed = v("JBSWY3DPEHPK3PXP" + "A".repeat(0));
  const imported = await vyre("vault", "codes", "import", `otpauth://totp/Northwind:kit?secret=${seed}&issuer=Northwind`);
  assert.equal(imported.code, 0, imported.out);
  assert.match(imported.out, /added northwind-kit/);
  const codes = await vyre("vault", "codes");
  assert.match(codes.out, /northwind-kit\s+\d{3} \d{3}\s+next \d{6} · \d+s/);

  // Sweep: the key is still in a script.
  fs.writeFileSync(path.join(proj, "deploy.sh"), `curl -H "Authorization: Bearer ${key}" https://api.openai.test\n`);
  const sw = await vyre("vault", "sweep", proj);
  assert.equal(sw.code, 0, sw.out);
  assert.match(sw.out, /deploy\.sh:1\s+harlow-intake\.env from the vault/);

  // Health and history, revert.
  const pw = v(hex(10));
  await tool("vault.put", { name: "harlow-portal", kind: "login", fields: { username: "juno", password: pw } });
  await tool("vault.put", { name: "northwind-orders", kind: "login", fields: { username: "kit", password: pw } });
  const h = await vyre("vault", "health");
  assert.match(h.out, /reused/);
  assert.match(h.out, /harlow-portal.*northwind-orders|northwind-orders.*harlow-portal/);
  await tool("vault.put", { name: "northwind-orders", kind: "login", fields: { username: "kit", password: v(hex(10)) } });
  const hist = await vyre("vault", "history", "northwind-orders");
  assert.match(hist.out, /v2\s+current.*password/);
  const rev = await vyre("vault", "revert", "northwind-orders", "1");
  assert.equal(rev.code, 0, rev.out);
  assert.match(rev.out, /version 1 is back/);

  // Agent logins and the use log.
  await tool("vault.put", { name: "northwind-admin", kind: "login", url: "https://app.northwind.test", fields: { username: "orders-bot", password: v(hex(10)) } });
  // an agent exists before a login is lent to it: the grant is the agent's, by its stable id
  assert.equal((await vyre("agents", "create", "kit")).code, 0);
  const g = await vyre("vault", "agent", "grant", "kit", "northwind-admin", "https://app.northwind.test", "--expires", "7d");
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /kit signs in to https:\/\/app\.northwind\.test as northwind-admin/);
  const gs = await vyre("vault", "agent", "grants");
  const id = (/(gr_[A-Za-z0-9_-]+)/.exec(gs.out) || [])[1];
  assert.ok(id, gs.out);
  assert.match((await vyre("vault", "agent", "revoke", id)).out, /revoked/);
  const uses = await vyre("vault", "uses", "--since", "1d");
  assert.equal(uses.code, 0, uses.out);

  // How an item rotates.
  await tool("vault.put", { name: "alex-github", kind: "pat", value: v(["ghp", hex(18)].join("_")), details: { provider: "github" } });
  const how = await vyre("vault", "rotate", "alex-github", "--how");
  assert.match(how.out, /github, by hand:/);

  const all = [pre, imp, ran, imported, codes, sw, h, hist, rev, g, gs, uses, how].map(r => r.out).join("\n");
  for (const x of values) assert.ok(!all.includes(x), "a value reached the terminal");
});

/** bin/vyre with stdin piped in, for the prompts. @returns {Promise<{ code: number, out: string }>} */
const piped = (root, args, stdin) => new Promise(resolve => {
  const p = execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 60_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr }));
  p.stdin?.end(stdin);
});

test("vault cli: needs, connect (a key, a mailbox, a key file) and voice key, never echoing a value", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-mac", transcripts: [], vault: { keystore: "file", reminders: false },
    modules: { enable: ["voice"], disable: ["recall", "memory", "learn", "capsule", "hands", "screen"] } }));
  writeModule(path.join(root, "modules"), "harlow", { does: { tools: [] }, needs: { credentials: [
    { id: "mail", kind: "env-set", provider: "imap-smtp", purpose: "the intake mailbox" },
    { id: "drive", kind: "cloud", provider: "google-dwd", purpose: "case files" },
  ] } }, "export default { async start() { return {}; } };");
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const tool = (name, input = {}) => call(name, input, { root, caller: "cli" });
  const values = [];
  const v = s => (values.push(s), s);

  const before = await piped(root, ["vault", "needs"], "");
  assert.equal(before.code, 0, before.out);
  assert.match(before.out, /voice · speech not ready \(one of deepgram, openai, elevenlabs\)/);
  assert.match(before.out, /deepgram\s+missing\s+deepgram · push-to-talk/);
  assert.match(before.out, /mail\s+missing\s+imap-smtp · the intake mailbox/);

  // `vyre vault connect voice` picks the group's first member and asks for the key, hidden.
  const dg = v(hex(20));
  const c = await piped(root, ["vault", "connect", "voice"], dg + "\n");
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /stored voice-deepgram-key · deepgram, granted to voice/);
  assert.match(c.out, /get it at https:\/\/console\.deepgram\.com/);
  assert.equal((await tool("voice.status")).data.key, true);

  // `vyre voice key openai` stores and grants directly (voice.js's own key(), not vault.connect).
  const oa = v("sk-" + hex(24));
  const vk = await piped(root, ["voice", "key", "openai"], oa + "\n");
  assert.equal(vk.code, 0, vk.out);
  assert.match(vk.out, /stored voice-openai-key · granted to voice/);
  const item = (await tool("vault.list", { filter: "voice-openai-key" })).data.items[0];
  assert.equal(item.kind, "api-key"); assert.deepEqual(item.grants, [{ module: "voice" }]);
  const wrong = await piped(root, ["voice", "key", "elevenlabs"], v("sk-ant-" + hex(16)) + "\n");
  assert.equal(wrong.code, 0, wrong.out);

  // A mailbox: one line per field, in the catalog's order.
  const pw = v(hex(12));
  const mail = await piped(root, ["vault", "connect", "harlow", "mail", "--label", "juno at Harlow Legal"],
    ["imap.harlow.test", "993", "smtp.harlow.test", "465", "juno", pw, "", "tls"].join("\n") + "\n");
  assert.equal(mail.code, 0, mail.out);
  assert.match(mail.out, /stored harlow-mail · imap-smtp, granted to harlow/);

  // A key file, by path, with the subject asked for after it.
  const pk = v(hex(40));
  const file = path.join(root, "harlow-sa.json");
  fs.writeFileSync(file, JSON.stringify({ type: "service_account", client_email: "files@harlow-legal.iam.gserviceaccount.test", private_key: "-----BEGIN " + `PRIVATE KEY-----\n${pk}\n-----END ` + "PRIVATE KEY-----\n" }));
  const sa = await piped(root, ["vault", "connect", "harlow", "drive", "--file", file], "alex@harlow.test\n\n");
  assert.equal(sa.code, 0, sa.out);
  assert.match(sa.out, /stored harlow-drive · google-dwd, granted to harlow/);
  const bad = await piped(root, ["vault", "connect", "harlow", "nope"], "");
  assert.equal(bad.code, 1); assert.match(bad.out, /declares no need nope/);

  const after = await piped(root, ["vault", "needs", "harlow"], "");
  assert.match(after.out, /mail\s+ready/); assert.match(after.out, /drive\s+ready/);
  const json = await piped(root, ["vault", "needs", "voice", "--json"], "");
  const parsed = JSON.parse(json.out.trim().split("\n").at(-1));
  assert.equal(parsed.data.groups[0].ready, true);

  // Connections: every key above is one, granted to the Capsule and chat; a person grants more.
  const conns = await piped(root, ["vault", "connections"], "");
  assert.equal(conns.code, 0, conns.out);
  assert.match(conns.out, /juno at Harlow Legal .*imap-smtp · password/);
  assert.match(conns.out, /can send_mail, read_mail · capsule, chat/);
  const speech = await piped(root, ["vault", "connections", "--can", "speech"], "");
  assert.match(speech.out, /Deepgram for voice/); assert.doesNotMatch(speech.out, /harlow-mail/);
  const id = (await tool("vault.connections.list", { capability: "send_mail" })).data.connections.find(x => x.ref === "harlow-mail").id;
  const g = await piped(root, ["vault", "connections", "grant", id, "agents"], "");
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /granted juno at Harlow Legal · capsule, chat, agents/);
  const agents = await piped(root, ["vault", "connections", "--surface", "agents"], "");
  assert.match(agents.out, /juno at Harlow Legal/); assert.doesNotMatch(agents.out, /Deepgram for voice/);
  const r = await piped(root, ["vault", "connections", "revoke", id, "chat"], "");
  assert.match(r.out, /revoked juno at Harlow Legal · capsule, agents/);
  const sy = await piped(root, ["vault", "connections", "sync"], "");
  assert.equal(sy.code, 0, sy.out); assert.match(sy.out, /synced · 0 added/);
  const nope = await piped(root, ["vault", "connections", "grant", id, "everyone"], "");
  assert.equal(nope.code, 1); assert.match(nope.out, /surface must be one of capsule, chat, agents, phone/);
  const usage = await piped(root, ["vault", "connections", "grant", id], "");
  assert.equal(usage.code, 1); assert.match(usage.out, /vyre vault connections grant <id> <surface>/);

  const all = [before, c, vk, wrong, mail, sa, bad, after, json, conns, speech, g, agents, r, sy].map(r => r.out).join("\n");
  for (const x of values) assert.ok(!all.includes(x), "a value reached the terminal");
});
