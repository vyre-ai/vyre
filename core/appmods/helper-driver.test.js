// @ts-check
// The daemon's side of the host helper for an app module: it asks `app-up|app-stop|app-down <module>` and nothing else, finds the app's address from the subnet root listed, and reads root's one-time
// hand-over. The root half is box/vyre (test/space-helper-apps.test.js); here root is a few lines that answer the spool.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { createHelperDriver, inSubnet, subnetsOf, readHandoff } from "./helper-driver.js";

const documents = JSON.parse(fs.readFileSync(new URL("./catalog/documents.json", import.meta.url), "utf8"));
const dirs = [];
process.on("exit", () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const mk = () => { const root = fs.mkdtempSync(path.join(SCRATCH, "hd-")); dirs.push(root); const spool = path.join(root, "spool"), state = path.join(root, "state"); fs.mkdirSync(spool); fs.mkdirSync(state); return { spool, state }; };
/** Root's side: answer every request ok (or as told) and run `after` on each. */
function fakeRoot({ spool, state }, answer = { state: "ok", message: "done" }, after = () => {}) {
  const seen = [];
  const t = setInterval(() => {
    for (const f of fs.readdirSync(spool).filter(x => x.startsWith("req-"))) {
      const text = fs.readFileSync(path.join(spool, f), "utf8"); fs.rmSync(path.join(spool, f));
      const id = f.slice(4); seen.push(text.trim()); after(text.trim());
      fs.writeFileSync(path.join(state, `status-${id}`), JSON.stringify({ id, ...answer, at: 2 }));
    }
  }, 5);
  return { seen, stop: () => clearInterval(t) };
}
const nets = { lo: [{ family: "IPv4", address: "127.0.0.1" }], eth0: [{ family: "IPv4", address: "172.17.0.2" }], eth1: [{ family: "IPv4", address: "172.31.7.2" }] };

test("the hook port is the catalog's; a manifest without one does not run through the host helper", () => {
  const d = createHelperDriver(mk());
  assert.equal(d.hookPortFor(documents), 43001);
  assert.throws(() => d.hookPortFor({ name: "x", app: {} }), /no hook port/);
});

test("up asks `app-up <module>` and nothing else, then finds the daemon's address on the app's network and reads root's hand-over", async () => {
  const dirs2 = mk();
  fs.writeFileSync(path.join(dirs2.state, "subnets"), "harlow 172.30.4.0/24\napp:documents 172.31.7.0/24\n");
  const root = fakeRoot(dirs2, undefined, () => fs.writeFileSync(path.join(dirs2.state, "app-documents-secrets"), "hook_token=" + "a".repeat(64) + "\napi_token=tok_x\nlogin_password=pw_y\n"));
  const d = createHelperDriver({ ...dirs2, pollMs: 5, interfaces: () => nets });
  const up = await d.up({ space: "spc_x", manifest: documents });
  root.stop();
  assert.deepEqual(root.seen, ["app-up documents"]);
  assert.equal(up.origin, "http://vyre-app-documents:3000");
  assert.equal(up.hookHost, "172.31.7.2", "the hook listener binds the address on the app's network, not the wildcard");
  assert.deepEqual(up.outputs, { hook_token: "a".repeat(64), api_token: "tok_x", login_password: "pw_y" });
});

test("a later start has no hand-over; a refusal is root's own message; a vyre container with no address on the app's network is a plain failure", async () => {
  const d1 = mk();
  fs.writeFileSync(path.join(d1.state, "subnets"), "app:documents 172.31.7.0/24\n");
  const r1 = fakeRoot(d1);
  assert.equal((await createHelperDriver({ ...d1, pollMs: 5, interfaces: () => nets }).up({ space: "s", manifest: documents })).outputs, null);
  r1.stop();
  const d2 = mk();
  const r2 = fakeRoot(d2, { state: "failed", message: "the app did not become healthy" });
  await assert.rejects(() => createHelperDriver({ ...d2, pollMs: 5, interfaces: () => nets }).up({ space: "s", manifest: documents }), /could not app-up this app: the app did not become healthy/);
  r2.stop();
  const d3 = mk();
  const r3 = fakeRoot(d3);
  await assert.rejects(() => createHelperDriver({ ...d3, pollMs: 5, interfaces: () => nets }).up({ space: "s", manifest: documents }), /no address on documents's network/);
  r3.stop();
});

test("stop and down are `app-stop` and `app-down`; the daemon runs nothing in the app and cannot delete its data", async () => {
  const dd = mk();
  const root = fakeRoot(dd);
  const d = createHelperDriver({ ...dd, pollMs: 5 });
  await d.stop({ manifest: documents });
  await d.down({ manifest: documents });
  root.stop();
  assert.deepEqual(root.seen, ["app-stop documents", "app-down documents"]);
  await assert.rejects(() => d.down({ manifest: documents }, { data: true }), /deleted from the server itself/);
  await assert.rejects(() => d.exec(), /host runs the app's setup/);
  assert.match(await d.logs({ manifest: documents }), /sudo docker logs vyre-app-documents/);
  assert.deepEqual(root.seen.length, 2, "the refused ones asked nothing");
});

test("status is the app's health path through the network the daemon is joined to", async () => {
  const d = createHelperDriver({ ...mk(), fetchImpl: async () => ({ status: 302 }) });
  assert.equal((await d.status({ manifest: documents })).state, "running");
  assert.equal((await createHelperDriver({ ...mk(), fetchImpl: async () => ({ status: 500 }) }).status({ manifest: documents })).state, "stopped");
  assert.equal((await createHelperDriver({ ...mk(), fetchImpl: async () => { throw new Error("no"); } }).status({ manifest: documents })).state, "stopped");
});

test("address and file helpers: a subnet match is exact, a hand-over line outside the short alphabet is dropped", () => {
  assert.equal(inSubnet("172.31.7.2", "172.31.7.0/24"), true);
  assert.equal(inSubnet("172.31.8.2", "172.31.7.0/24"), false);
  assert.equal(inSubnet("10.0.0.1", "10.0.0.0/8"), true);
  assert.equal(inSubnet("not an ip", "10.0.0.0/8"), false);
  assert.equal(inSubnet("172.31.7.2", "172.31.7.0/99"), false);
  const d = mk();
  assert.equal(readHandoff(d.state, "documents"), null);
  fs.writeFileSync(path.join(d.state, "app-documents-secrets"), "a=ok_1\nB=bad\nc=has space\nd=" + "x".repeat(301) + "\ne=fine.2\n");
  assert.deepEqual(readHandoff(d.state, "documents"), { a: "ok_1", e: "fine.2" });
  assert.deepEqual(subnetsOf(d.state, "documents"), []);
});
