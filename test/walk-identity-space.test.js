// @ts-check
// Steps 2 and 3 of the end-to-end walk on a REAL vyred (core/daemon start, a real socket, the callers the daemon itself decides) against the stand-in names directory
// (scripts/standin-directory.mjs, a real process on loopback): claim an identity, create a space, resolve both by name. Then BR-1 on the same daemon with the kernel on:
// every unprivileged caller label naming a real member is refused by every bridges tool, and the member's own verified call works.
import "../scripts/mac-test-guard.mjs";
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
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });

  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "walk-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` },
    modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  // a command line is a person only through `vyre signin` (SI-1b); this walk has no phone, so it uses the development stand-in file (a hand-made file in a development build)
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "walk\n");
  const lines = /** @type {string[]} */ ([]);
  const d = await start({ root, kernel: true, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const as = (/** @type {string} */ caller) => (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller });
  const deck = as("deck");
  const status = d.registry.status ? d.registry.status() : null;
  void status;

  // Step 2: claim an identity. The recovery code comes back once.
  const made = await deck("spaces.identity.create", { name: "alex" });
  assert.ok(!made.error, JSON.stringify(made.error) + " " + lines.filter(l => /spaces|fail/i.test(l)).join(" ; ").slice(0, 1500));
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
  const got = await as("cli")("spaces.get", { space: "harlow" }); // a terminal is the person through the stand-in; the deck label is not a terminal
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
  for (const label of ["mcp", "mcp:thread:fake", "tailnet-guest:mallory@example.com", "anonymous", "harness", "tailnet:bob@example.com", "mcp:agent:kit", "device:web0000000000001", "device:setup000000000002", "device:neverpaired00003"]) {
    for (const [tool, input] of Object.entries(inputs)) {
      const r = await as(label)(tool, input);
      assert.ok(r.error, `${tool} as ${label} must be refused, got ${String(JSON.stringify(r)).slice(0, 200)}`);
      assert.ok(!JSON.stringify(r).includes("Harlow Legal"), `${tool} as ${label} leaked`);
    }
  }
  // cli is the person's own surface on their own computer (the socket is owner-only): it IS the member, so its own call works and naming anyone else is refused.
  const ownCli = await as("cli")("bridges.merge.links", { person: alexId });
  assert.ok(!ownCli.error, JSON.stringify(ownCli.error));
  for (const [tool, input] of Object.entries(inputs)) {
    const r = await as("cli")(tool, { ...input, person: "per_" + "z".repeat(26) });
    assert.ok(r.error, `${tool} as cli naming another person must be refused`);
  }
  // The Deck's own label is the person only with a signed-in person session (v0.3: person-only by default): a socket call that merely says "deck" is refused, and the person's own surfaces are the
  // terminal (cli, above) and the paired app device (below), each of which carries the person's verified facts.
  // (a bare deck label's answer depends on whether the host can verify the Capsule, so it is not pinned here)
  assert.ok(ownCli.data.some((/** @type {any} */ l) => l.space === space), "the member's own verified call sees their space");
  // BR-2 through the daemon's own device path: the home's relay row decides what a `device:<id>` is (PH-1), and the call carries only the facts that gives. A web browser (trusted or not),
  // a setup page, a removed device and an id never paired get no facts, so no person chain, and every bridges tool refuses them; the owner's paired app device works.
  const ins = d.registry.deps.db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, ?, 'p', 1, ?, ?, ?)");
  const ids = { app: "aaaaaaaaaaaaaaaa", web: "bbbbbbbbbbbbbbbb", webTrusted: "bbbbbbbbbbbbbbbc", setup: "cccccccccccccccc", gone: "dddddddddddddddd", never: "eeeeeeeeeeeeeeee" };
  ins.run(ids.app, "phone", "app", 0, null); ins.run(ids.web, "browser", "web", 0, null); ins.run(ids.webTrusted, "browser", "web", 1, null); ins.run(ids.setup, "setup page", "setup", 0, null); ins.run(ids.gone, "old", "app", 0, 5);
  const { callerFacts } = await import("../core/daemon/index.js");
  // The app signs in before it calls anything of the person's (the router sets meta.person from the cookie or the signed token): `signedIn` is that sign-in. Refused devices are tried both ways.
  const viaDevice = async (/** @type {string} */ id, /** @type {string} */ tool, /** @type {any} */ input, signedIn = false) => {
    const info = await d.registry.call("relay.device.info", { id }, "module:vyred");
    // the daemon's own device row is the relay's row plus the person Wink's record names (core/daemon/index.js); the home's own owner is who a device of this home was confirmed by
    const row = info.data ? { ...info.data, person: d.kernel.id.owner } : null;
    const facts = callerFacts(`device:${id}`, { caller: `device:${id}` }, {}, d.kernel, false, row);
    return d.registry.call(tool, input, `device:${id}`, { ...(facts ? { kernelFacts: facts } : {}), ...(signedIn ? { person: { id: alexId, kind: "cookie" } } : {}) });
  };
  for (const id of [ids.web, ids.webTrusted, ids.setup, ids.gone, ids.never]) {
    for (const [tool, input] of Object.entries(inputs)) {
      for (const signedIn of [false, true]) {
        const r = await viaDevice(id, tool, input, signedIn);
        assert.ok(r.error, `${tool} as device ${id} (signed in: ${signedIn}) must be refused, got ${String(JSON.stringify(r)).slice(0, 200)}`);
        assert.ok(!JSON.stringify(r).includes("Harlow Legal"), `${tool} as device ${id} leaked`);
      }
    }
  }
  assert.equal((await viaDevice(ids.app, "bridges.merge.links", { person: alexId })).error?.code, "person_session_required", "an app device that has not signed in gets nothing from its label");
  const appLinks = await viaDevice(ids.app, "bridges.merge.links", { person: alexId }, true);
  assert.ok(!appLinks.error, JSON.stringify(appLinks.error));
  assert.ok(appLinks.data.some((/** @type {any} */ l) => l.space === space), "the owner's paired app device sees their space");
  const wrong = await as("cli")("bridges.merge.links", { person: "per_" + "z".repeat(26) });
  assert.equal(wrong.error?.code, "bad_input", "naming someone else through the person's own surface is refused");
});
