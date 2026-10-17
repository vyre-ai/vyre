// @ts-check
// The positive path of "Create a space" in a page with no daemon, with nothing faked that matters: a real relay and a real names directory (the stand-ins every proof uses), a real server (a vyred in this process,
// started the way the installer leaves one, with the line's one-time code), the real setup channel and the real pairing (relay/client/serverpair.js, the call the app's own pairing makes), and the real directory claim.
// NOT exercised here: the owner's signed proof. The server's own tools are called as its operator (server.operator, the lenient stand-in presence), so `spaces.name-here` skips the owner-only check the real path makes.
// That check is held by test/one-space-name.test.js (a member and the owner's assistant are refused with `forbidden`). This file proves the positive half only.
// It proves that onboard.space.poll says online:true only after a really paired server, and that the directory then holds the space's name. It runs the whole sequence in one process, so a stall shows as the stage it
// stops at (the poll's own answer), not as a screen that never changes.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHost } from "./host-core.js";
import { startStandins } from "../../../../scripts/lib/proof/standins.mjs";
import { startDaemonServer } from "../../../../scripts/lib/proof/server-daemon.mjs";
import { mintPairCode } from "../../../../relay/client/pair-install.js";
import * as setupClient from "../../../../relay/client/setup.js";
import { connectSetup } from "../../../../relay/client/setupchannel.js";
import { openChannel, request, connect as relayConnect } from "../../../../relay/client/client.js";
import { openServerPeer } from "../../../../relay/client/peerclient.js";
import { webCrypto } from "../../../../relay/client/webcrypto.js";
import { nodeCrypto, fileKeyStore } from "../../../../relay/client/nodecrypto.js";
import { utf8 } from "../../../../relay/client/bytes.js";
import { pairServer } from "../../../../relay/client/serverpair.js";
import { claimServerSpace } from "../identity/claim-space.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_TEST_SELF_RESERVE = "1";

const FAST = { memoryKiB: 64, passes: 2 };
const PASSWORD = "correct horse battery staple";
const b64u = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("base64url");
const until = async (/** @type {() => Promise<any>} */ fn, ms, what) => { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await fn(); if (last) return last; await new Promise((r) => setTimeout(r, 200)); } throw new Error(`${what} did not happen in ${ms / 1000} s`); };
const memoryStore = () => { let kept = null; return { load: async () => (kept ? structuredClone(kept) : null), save: async (k) => { kept = structuredClone(k); } }; };

test("a really paired server makes the poll say online, and the directory then holds the space's name", { timeout: 300_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-pair-"));
  const ins = await startStandins({ out: path.join(dir, "standins") });
  t.after(() => ins.stop());
  const keyStore = fileKeyStore(path.join(dir, "relay-device-key.json"));
  const relayCrypto = nodeCrypto();
  /** @type {any} */ let server = null;
  t.after(async () => { try { if (peer) peer.close(); } catch { /* closed */ } if (server) await server.stop(); });
  /** The server's own tools, as its operator (the paired owner's signed session is the same registry behind the relay). */
  // (Operator calls: see the header; the owner-only refusal is test/one-space-name.test.js.)
  // Until the app has paired, the server's operator; after, the paired device itself over the peer wire, which is how the app reaches its server (the server runs each call as this device's paired session, whose person is the owner).
  /** @type {any} */ let peer = null;
  const onServer = async (/** @type {string} */ name, /** @type {any} */ input) => (peer ? peer.call(name, input) : server.operator(name, input));

  /** @type {any} */ const ports = {
    client: setupClient,
    relay: ins.relay,
    mintPairCode, createSetupKey: setupClient.createSetupKey, setupFingerprint: setupClient.setupFingerprint,
    connect: async (/** @type {any} */ { offer, key, secret }) => connectSetup({ openChannel, request, setupHello: setupClient.setupHello, webCrypto, utf8 }, { offer, key, secret }),
    // The app's own pairing call (apps/app/src/real/pairing.ts directSessionFor into relay/client/serverpair.js), with this identity's key signing for it.
    pair: async (/** @type {string} */ qr, /** @type {any} */ _ctx, /** @type {any} */ who) => {
      const personKey = (await import("node:crypto")).generateKeyPairSync("ec", { namedCurve: "P-256" });
      const presenceKey = { public_key: personKey.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "software" };
      const paired = /** @type {any} */ (await pairServer({
        payload: qr, owner: { id: who.id, name: who.name, vyre: who.name, pin: who.pin },
        signIdentity: async (/** @type {Uint8Array} */ m) => ({ eid: who.key.eid, sig: b64u(await who.key.sign(m)) }),
        name: "Host test", crypto: relayCrypto, keyStore, presenceKey, about: { kind: "web" }, pollMs: 100, deviceKind: "computer", keyStorage: "software",
      }));
      // The paired session, as the app's openPairedSession makes it: the challenge the server gave this device, signed by the key reported at pairing, then the peer wire the app's calls travel on.
      const conn = relayConnect({ relay: paired.relay || ins.relay, route: paired.route, box: paired.box, name: "Host test", crypto: relayCrypto, keyStore, about: { kind: "web" } });
      const channel = async (/** @type {string} */ tool, /** @type {any} */ input) => (await (await conn.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).json());
      const ask = await channel("presence.person.pair-challenge", {});
      const nodeSign = (await import("node:crypto")).sign;
      const sig = nodeSign("sha256", Buffer.from(`paired-start\n${paired.device}\n${ask.data && ask.data.challenge}`), { key: personKey.privateKey, dsaEncoding: "ieee-p1363" });
      const started = await channel("presence.person.start-paired", { sig: b64u(sig) });
      if (!(started.data && started.data.token)) throw new Error(`the paired session did not start: ${JSON.stringify(started.error || started)}`);
      peer = await openServerPeer(conn);
      return { box: typeof paired.box === "string" ? paired.box : b64u(paired.box), route: paired.route, relay: paired.relay || ins.relay, name: paired.name || "" };
    },
    claim: async (/** @type {any} */ who, /** @type {any} */ o) => {
      const made = await claimServerSpace({
        identity: { id: who.id, name: who.name, eid: who.eid, ops: who.ops, key: who.key }, name: o.name, base: ins.names, route: o.route,
        host: async ({ name }) => onServer("spaces.name-here", { name }),
      });
      await onServer("spaces.name-here", { name: made.label || o.name, done: true });
      return made.space;
    },
    call: async (/** @type {string} */ name, /** @type {any} */ input) => onServer(name, input),
    forget: async () => {},
  };

  const host = createHost({ store: memoryStore(), directory: ins.names, kdf: FAST, space: { load: async () => ports }, pollMs: 100, version: null });
  const made = await host.call("onboard.person.create", { username: "alextest", password: PASSWORD, confirm: PASSWORD });
  const label = "alextest-space";
  const open = await host.call("onboard.space.open", { kind: "linux", name: label });
  const code = /VYRE_CODE=([A-Za-z0-9_-]+)/.exec(open.command)?.[1];
  assert.ok(code && code.length === 239, "the line carries the one-time install code");

  // Before any server answers, the page says it is still waiting: online only ever follows a pairing.
  const early = await host.call("onboard.space.poll", { id: open.id });
  assert.equal(early.online, false);
  assert.ok(!early.failed, JSON.stringify(early));

  // The real server, started with the line's code, redeems it at boot and posts its offer at the relay.
  server = await startDaemonServer({ dir: path.join(dir, "server"), code, relay: ins.relayForServer, directory: ins.namesForServer, store: "plain", ownerId: made.id });
  /** @type {string[]} */ const seen = [];
  const polled = await until(async () => {
    const r = await host.call("onboard.space.poll", { id: open.id });
    seen.push(r.online ? "online" : r.failed ? `failed ${r.code}: ${r.message}` : r.connecting ? "connecting" : "waiting");
    if (r.failed) throw new Error(`the poll failed at stage "${r.code}": ${r.message} (trail: ${[...new Set(seen)].join(" > ")})`);
    return r.online ? r : null;
  }, 240_000, `the poll saying online (trail: ${[...new Set(seen)].join(" > ")}; server log tail: ${server.logs.slice(-6).join(" | ")})`);

  assert.equal(polled.online, true);
  assert.match(String(polled.space), /^spc_[a-z2-7]{12}$/);
  assert.equal(polled.server.address, `https://${label}.vyre.run`);
  // The server really belongs to this identity now.
  // (No tool names the owner to an operator: the kernel's own log line does.)
  const claimed = [...server.logs.join("\n").matchAll(/the owner is now the claimed identity (per_[a-z2-7]+)/g)].map((m) => m[1]);
  assert.equal(claimed[claimed.length - 1], made.id);
  // And the directory holds the space's name, signed by this identity: the address a sign-in from another device resolves.
  const res = await fetch(`${ins.names}/v1/ids/resolve?name=${label}`);
  const body = /** @type {any} */ (await res.json());
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.data.kind, "space");
  assert.equal(body.data.id, polled.space);
  // The person's own list in the directory (what GitHub sign-in reads) has the space too: the call was made as the identity's signed act.
  const list = await host.call("onboard.space.list", {});
  assert.deepEqual(list.spaces.map((s) => [s.name, s.role]), [[label, "owner"]]);
});
