// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { idDirectory, memorySeen } from "../../../../lib/identity/directory.js";
import { claimIdentity } from "./claim.js";
import { claimServerSpace } from "./claim-space.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FAST = { memoryKiB: 64, passes: 2 };
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });
async function standIn(t) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(REPO, "scripts/standin-directory.mjs"), "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  return `http://127.0.0.1:${port}`;
}

test("a device with no box makes a space on a server: the server hosts it, the device signs the chain and the record, and the Node client reads both back", { timeout: 60_000 }, async t => {
  const base = await standIn(t);
  const me = await claimIdentity({ name: "boxless", password: "four words in a row", deviceLabel: "Alex's phone", base, params: FAST });
  const identity = { id: me.id, name: "boxless", eid: me.eid, ops: me.ops, key: me.key };
  const ROOT = Buffer.alloc(32, 7).toString("base64url");
  const ROUTE = { relay: "https://relay.example", route: "rt-srv", box: "bx-srv" };
  const calls = [];
  const made = await claimServerSpace({ identity, name: "Harlow", displayName: "Harlow Legal", base, route: ROUTE, host: async a => { calls.push(["host", a]); return { space: "spc_" + "abcdefghijkl", rootPublic: ROOT }; }, retire: async s => { calls.push(["retire", s]); } });
  assert.deepEqual(calls, [["host", { name: "harlow" }]], "the server was asked once, nothing was retired");
  assert.equal(made.name, "harlow.vyre.run");
  const dir = idDirectory({ base, seen: memorySeen() });
  const r = await dir.resolve("harlow", { resolve: async id => (id === me.id ? me.ops : null) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.kind, "space");
  assert.deepEqual([r.payload.id, r.payload.label, r.payload.ownerName, r.payload.home.kind], ["spc_abcdefghijkl", "Harlow Legal", "boxless", "server"]);
  assert.deepEqual(r.payload.route, ROUTE, "the record carries the home's route");
  assert.equal(r.payload.rootPublic, ROOT, "the record carries the server's key from host-here");
  assert.equal(made.rootPublic, ROOT);
  assert.equal(made.rootKey, undefined, "the app holds no space key");
  assert.deepEqual(r.state.entries.map(e => [e.kind, e.subject]), [["owner", me.id]], "this person is the space's first owner");
  // a name that is taken: nothing is claimed and the hosted space is taken back
  const again = [];
  await assert.rejects(claimServerSpace({ identity, name: "harlow", base, host: async () => ({ space: "spc_" + "mnopqrstuvwx", rootPublic: ROOT }), retire: async s => again.push(s) }), e => e.code !== undefined);
  assert.deepEqual(again, ["spc_mnopqrstuvwx"]);
  // a server that gives no key (too old to prove anything): nothing is claimed and the hosted space is taken back
  const old = [];
  await assert.rejects(claimServerSpace({ identity, name: "oldsrv", base, host: async () => ({ space: "spc_" + "yzabcdefghij" }), retire: async s => old.push(s) }), e => e.code === "server_too_old");
  assert.deepEqual(old, ["spc_yzabcdefghij"]);
  // a server that answers with no id: nothing is claimed
  await assert.rejects(claimServerSpace({ identity, name: "other", base, host: async () => ({}) }), e => e.code === "server_refused");
  assert.equal((await dir.check("other")).status, "ok");
});
