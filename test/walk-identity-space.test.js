// @ts-check
// Steps 2 and 3 of the end-to-end walk on a REAL vyred (core/daemon start, a real socket, the callers the daemon itself decides) against the stand-in names directory
// (scripts/standin-directory.mjs, a real process on loopback): claim an identity, create a space, resolve both by name. Then BR-1 on the same daemon with the kernel on:
// every unprivileged caller label naming a real member is refused by every bridges tool, and the member's own verified call works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });

test("walk steps 2 and 3 on a real vyred against the stand-in directory, and BR-1 on the same daemon", async t => {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });

  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "walk-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` },
    modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const lines = /** @type {string[]} */ ([]);
  const d = await start({ root, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const as = (/** @type {string} */ caller) => (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller });
  const deck = as("deck");
  const status = d.registry.status ? d.registry.status() : null;
  void status;

  // Step 2: claim an identity. The recovery code comes back once.
  const made = await deck("spaces.identity.create", { name: "alex" });
  assert.ok(!made.error, JSON.stringify(made.error));
  assert.match(made.data.recoveryCode, /^[a-z2-7-]{32}$/);
  assert.equal(made.data.name, "alex.vyre.run");
  const alexId = made.data.id;
  const res = await deck("spaces.identity.resolve", { name: "alex" });
  assert.ok(!res.error, JSON.stringify(res.error));
  assert.deepEqual([res.data.kind, res.data.id, res.data.entries], ["person", alexId, 2]);
  assert.match(res.data.words, /^\w+ \w+ \w+ \w+$/);

  // Step 3: create a space on this computer, then read it back and resolve its name.
  const sp = await deck("spaces.create", { name: "harlow", displayName: "Harlow Legal", home: { kind: "this-computer", confirmed: true } });
  assert.ok(!sp.error, JSON.stringify(sp.error));
  assert.equal(sp.data.status, "done", JSON.stringify(sp.data));
  const got = await deck("spaces.get", { space: "harlow" });
  assert.ok(!got.error, JSON.stringify(got.error));
  assert.deepEqual([got.data.name, got.data.role, got.data.owners], ["harlow.vyre.run", "owner", 1]);
  const rs = await deck("spaces.identity.resolve", { name: "harlow" });
  assert.ok(!rs.error, JSON.stringify(rs.error));
  assert.deepEqual([rs.data.kind, rs.data.entries, rs.data.label], ["space", 1, "Harlow Legal"]);

  // BR-1 on this real daemon: each unprivileged label names the real member (alex) to every bridges tool and is refused; alex's own deck call works.
  const space = sp.data.space;
  const inputs = {
    "bridges.list": { person: alexId, space },
    "bridges.get": { person: alexId, bridge: "br_x", space },
    "bridges.view.read": { person: alexId, share: "br_x", space },
    "bridges.resolve": { person: alexId, space, urn: `vyre://${space}/client/c1` },
    "bridges.copy": { person: alexId, urn: `vyre://${space}/client/c1`, toSpace: space },
    "bridges.continue": { person: alexId, fromSpace: space, toSpace: space, summaryRefs: [`vyre://${space}/matter/m1`] },
    "bridges.merge.links": { person: alexId },
    "bridges.kit.plan": { person: alexId, space, kit: {} },
  };
  for (const label of ["cli", "mcp", "mcp:thread:fake", "tailnet-guest:mallory@example.com", "anonymous", "harness"]) {
    for (const [tool, input] of Object.entries(inputs)) {
      const r = await as(label)(tool, input);
      assert.ok(r.error, `${tool} as ${label} must be refused, got ${JSON.stringify(r.data).slice(0, 120)}`);
      assert.ok(!JSON.stringify(r).includes("Harlow Legal"), `${tool} as ${label} leaked`);
    }
  }
  const own = await deck("bridges.merge.links", { person: alexId });
  assert.ok(!own.error, JSON.stringify(own.error));
  assert.ok(own.data.some((/** @type {any} */ l) => l.space === space), "the member's own verified call sees their space");
  const wrong = await deck("bridges.merge.links", { person: "per_" + "z".repeat(26) });
  assert.equal(wrong.error?.code, "bad_input", "naming someone else through the person's own surface is refused");
});
