// @ts-check
// `vyre hooks` as a person runs it: the real bin/vyre in a child process, against a box vyred in
// this process in a temp home, with `present` as its verifier (opening a route needs a person) and
// a fake tailscale that answers `status` and `funnel status` for hooks.status. The listener stays
// off, so nothing listens; no route is ever published.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { tempHome, present } from "../../../test/helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");
const HOST = "alex-box.tail0000.ts.net";

/** @returns {Promise<{ code: number, out: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr })));

test("hooks: list, status, open and close, each with --json", async t => {
  const root = tempHome(t);
  // A tailscale that knows only the two questions hooks.status asks.
  const bin = path.join(root, "ts", "tailscale");
  fs.mkdirSync(path.dirname(bin));
  fs.writeFileSync(bin, `#!/usr/bin/env node
const a = process.argv.slice(2).join(" ");
if (a === "status --json") { process.stdout.write(JSON.stringify({ BackendState: "Running", Self: { DNSName: "${HOST}.", CapMap: { funnel: null, https: null } } })); process.exit(0); }
if (a === "funnel status --json") { process.stdout.write("{}"); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
  const prev = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = bin;
  t.after(() => { if (prev === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prev; });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" },
    modules: { disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const vyre = (/** @type {string[]} */ ...args) => run(root, args);

  const empty = await vyre("hooks");
  assert.equal(empty.code, 0, empty.out);
  assert.match(empty.out, /listener off/);
  assert.match(empty.out, /no routes open/);
  const ej = JSON.parse((await vyre("hooks", "--json")).out);
  assert.equal(ej.listening, false);
  assert.deepEqual(ej.routes, []);

  const opened = await vyre("hooks", "open", "northwind-orders", "--scheme", "github", "--secret", "northwind-orders-hook", "--json");
  assert.equal(opened.code, 0, opened.out);
  const oj = JSON.parse(opened.out);
  assert.equal(oj.path, "/hooks/northwind-orders");
  assert.equal(oj.ready, false, "the secret is not in the vault yet");

  const list = await vyre("hooks", "list");
  assert.match(list.out, /\/hooks\/northwind-orders\s+github/);
  const lj = JSON.parse((await vyre("hooks", "list", "--json")).out);
  assert.deepEqual(lj.routes.map(r => r.path), ["/hooks/northwind-orders"]);

  const st = await vyre("hooks", "status");
  assert.equal(st.code, 0, st.out);
  assert.match(st.out, /funnel attribute yes/);
  const sj = JSON.parse((await vyre("hooks", "status", "--json")).out);
  assert.equal(sj.funnel.read, true);
  assert.deepEqual(sj.routes, ["northwind-orders"]);
  assert.equal(sj.urls["northwind-orders"], `https://${HOST}:8443/hooks/northwind-orders`);
  assert.ok(sj.mismatches.length >= 1, "Funnel does not publish the open route yet");

  const closed = JSON.parse((await vyre("hooks", "close", "northwind-orders", "--json")).out);
  assert.match(closed.funnel.close, /tailscale funnel/);
  assert.deepEqual(JSON.parse((await vyre("hooks", "--json")).out).routes, []);

  const bad = await vyre("hooks", "close", "--json");
  assert.equal(bad.code, 2, "a usage mistake");
  assert.equal(JSON.parse(bad.out).error.code, "bad_input");
  assert.match((await vyre("hooks", "close")).out, /vyre hooks \[status/);
  const refused = await vyre("hooks", "open", "Not A Name", "--scheme", "github", "--secret", "x", "--json");
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, "bad_input");
});

test("hooks: on starts the listener on 127.0.0.1, list shows it, off stops it; a verb it does not know prints the usage", async t => {
  const root = tempHome(t);
  // Never the real tailscale: a fake that knows nothing.
  const bin = path.join(root, "ts", "tailscale");
  fs.mkdirSync(path.dirname(bin));
  fs.writeFileSync(bin, "#!/usr/bin/env node\nprocess.exit(1);\n", { mode: 0o755 });
  const prev = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = bin;
  t.after(() => { if (prev === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prev; });
  // Port 0: the listener takes any free port on 127.0.0.1, never a fixed one.
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" },
    hooks: { port: 0 }, modules: { disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const vyre = (/** @type {string[]} */ ...args) => run(root, args);

  const on = await vyre("hooks", "on");
  assert.equal(on.code, 0, on.out);
  assert.match(on.out, /listener on 127\.0\.0\.1:\d+/);
  const lj = JSON.parse((await vyre("hooks", "list", "--json")).out);
  assert.equal(lj.enabled, true);
  assert.equal(lj.listening, true);
  assert.equal(lj.host, "127.0.0.1");
  assert.ok(lj.port > 0, "a real port once listening");
  assert.match((await vyre("hooks", "list")).out, /listener on 127\.0\.0\.1:\d+[\s\S]*no routes open/);

  const off = JSON.parse((await vyre("hooks", "off", "--json")).out);
  assert.equal(off.listening, false);
  assert.equal(off.enabled, false);
  const human = await vyre("hooks", "list");
  assert.match(human.out, /listener off/);

  // A usage mistake: exit 2, the usage line and where to read more.
  const frob = await vyre("hooks", "frob");
  assert.equal(frob.code, 2);
  assert.match(frob.out, /vyre hooks \[status\|on\|off\|open/);
  assert.match(frob.out, /vyre help hooks/);
});
