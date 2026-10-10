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

// ---- a site's server (team/contracts/builder.md): asked for by its deployment's id, from a folder the daemon writes
const IMG = "sha256:" + "a".repeat(64), DEP = "dep_0123456789abcdef", SPC = "spc_abcdefghijkl";
const published = (/** @type {any} */ over = {}) => ({ name: "northwind", version: "0.0.3", vyre: "1", "x-publish": { deployment: DEP, secrets: ["GREETING_PHRASE"], public: true },
  app: { image: IMG, port: 8080, volumes: [{ name: "data", path: "/data" }], health: { path: "/", ok: [200, 404], startS: 60 }, limits: { memoryMb: 512, cpus: 0.5, pids: 256 }, readOnly: true, open: true }, ...over });

test("a site's server: up writes the folder root takes (settings and secrets, nothing else of ours), asks `pub-up <deployment>` and removes the folder; stop and down are pub-stop and pub-down", async () => {
  const dirs2 = mk(); const home = path.join(dirs2.state, "..", "home"); fs.mkdirSync(home);
  fs.writeFileSync(path.join(dirs2.state, "subnets"), "app:northwind 172.31.7.0/24\n");
  /** @type {any} */ let folder = null;
  const root = fakeRoot(dirs2, undefined, text => {
    if (text === `pub-up ${DEP}`) {
      const dir = path.join(home, "publish", SPC, "servers", DEP);
      folder = { request: fs.readFileSync(path.join(dir, "request"), "utf8"), secrets: fs.readdirSync(path.join(dir, "secrets")), secret: fs.readFileSync(path.join(dir, "secrets", "GREETING_PHRASE"), "utf8"), mode: fs.statSync(path.join(dir, "secrets", "GREETING_PHRASE")).mode & 0o777, top: fs.readdirSync(dir).sort() };
    }
  });
  const d = createHelperDriver({ ...dirs2, home, pollMs: 5, interfaces: () => nets });
  const up = await d.up(/** @type {any} */ ({ space: "spc_x", manifest: published(), secrets: { GREETING_PHRASE: "hello there" }, publishSpace: SPC }));
  assert.deepEqual(root.seen, [`pub-up ${DEP}`]);
  assert.equal(up.origin, "http://vyre-app-northwind:8080");
  assert.equal(up.outputs, null, "a server has no setup hand-over");
  assert.equal(up.hookHost, "172.31.7.2");
  assert.equal(folder.request, "name=northwind\nversion=3\nport=8080\nmem=512\ncpus=0.5\npids=256\nhealth_path=/\nhealth_ok=200+404\nhealth_start=60\nsecrets=GREETING_PHRASE\n");
  assert.deepEqual([folder.top, folder.secrets, folder.secret, folder.mode], [["request", "secrets"], ["GREETING_PHRASE"], "hello there", 0o600]);
  assert.ok(!fs.existsSync(path.join(home, "publish", SPC, "servers", DEP)), "the folder is removed once root has answered");
  await d.stop({ manifest: published() });
  await d.down({ manifest: published() });
  assert.deepEqual(root.seen.slice(1), [`pub-stop ${DEP}`, `pub-down ${DEP}`]);
  await assert.rejects(() => d.down({ manifest: published() }, { data: true }), /deleted from the server itself/);
  root.stop();
  // a root that refuses leaves nothing of ours behind
  const bad = mk(); fs.writeFileSync(path.join(bad.state, "subnets"), "app:northwind 172.31.7.0/24\n");
  const refusing = fakeRoot(bad, { state: "failed", message: "the secret GREETING_PHRASE was not given" });
  const d2 = createHelperDriver({ ...bad, home, pollMs: 5, interfaces: () => nets });
  await assert.rejects(() => d2.up(/** @type {any} */ ({ space: "spc_x", manifest: published(), secrets: { GREETING_PHRASE: "x" }, publishSpace: SPC })), /was not given/);
  refusing.stop();
  assert.ok(!fs.existsSync(path.join(home, "publish", SPC, "servers", DEP)));
  // a catalog app is still asked for by its module name
  const cat = mk(); fs.writeFileSync(path.join(cat.state, "subnets"), "app:documents 172.31.7.0/24\n");
  const r3 = fakeRoot(cat);
  await createHelperDriver({ ...cat, home, pollMs: 5, interfaces: () => nets }).up({ space: "spc_x", manifest: documents });
  r3.stop();
  assert.deepEqual(r3.seen, ["app-up documents"]);
});
