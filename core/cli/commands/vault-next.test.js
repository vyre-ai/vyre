// @ts-check
// The vault's newer verbs as a person runs them: the real bin/vyre in a child process, against a
// vyred started here in a temp home with presence stubbed. import of a project with --rewrite,
// run, codes, sweep, health, remind, history and revert, agent logins and uses, rotate --how.
// Every value is made at run time; none may appear in any output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { call } from "../../daemon/client.js";
import { tempHome, present } from "../../../test/helpers.js";

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
  assert.match(h.out, /harlow-portal\s+login\s+.*reused/);
  await tool("vault.put", { name: "northwind-orders", kind: "login", fields: { username: "kit", password: v(hex(10)) } });
  const hist = await vyre("vault", "history", "northwind-orders");
  assert.match(hist.out, /v2 .* password .*current/);
  const rev = await vyre("vault", "revert", "northwind-orders", "1");
  assert.equal(rev.code, 0, rev.out);
  assert.match(rev.out, /version 1 is back/);

  // Agent logins and the use log.
  await tool("vault.put", { name: "northwind-admin", kind: "login", url: "https://app.northwind.test", fields: { username: "orders-bot", password: v(hex(10)) } });
  const g = await vyre("vault", "agent", "grant", "kit", "northwind-admin", "https://app.northwind.test", "--expires", "7d");
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /kit signs in to https:\/\/app\.northwind\.test as northwind-admin/);
  const gs = await vyre("vault", "agent", "grants");
  const id = (/(ag_[A-Za-z0-9_-]+)/.exec(gs.out) || [])[1];
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
