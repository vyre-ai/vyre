// @ts-check
// A MEMBER's AI session on the server reaches the vault only through its own thread socket, which stamps the session's own token on every call (core/daemon/threadsock.js): the owner's vault is refused
// for that token, a token the client forges is dropped, and a call with the token gone (the session ended) is refused before the registry. A real daemon. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { start } from "../core/daemon/index.js";
import { openThreadSocket } from "../core/daemon/threadsock.js";
import { tempHome, present } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";
import { MEMBER_REFUSAL } from "../core/vault/member-gate.js";

const realManifest = JSON.parse(fs.readFileSync(new URL("../core/switchboard/module.json", import.meta.url), "utf8"));
const BOB = "per_" + "b".repeat(26);

/** A client process that makes one call on the socket and prints the answer. */
function client(socket, tool, input, headers = {}) {
  const js = `import http from "node:http";
const data = JSON.stringify(${JSON.stringify(input)});
const req = http.request({ socketPath: ${JSON.stringify(socket)}, path: "/v1/tools/${tool}", method: "POST",
  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...${JSON.stringify(headers)} } }, res => {
  let out = ""; res.on("data", c => (out += c)); res.on("end", () => { process.stdout.write(JSON.stringify({ status: res.statusCode, body: JSON.parse(out) })); });
});
req.end(data);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", js], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", d => (out += d));
  return { pid: /** @type {number} */ (child.pid), done: new Promise(r => child.on("exit", () => r(JSON.parse(out || "{}")))) };
}

test("a member's session: its thread socket stamps the member's token, the owner's vault refuses it, a forged token is dropped, and an ended session is refused before the registry", { timeout: 200_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", vault: { keystore: "file" }, transcripts: [], modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev-" + person.slice(4, 10), person, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(chainOf(owner), { person: BOB, role: "member" }, { presence: { method: "stand-in" } });
  const ownerTok = async () => ({ token: (await d.kernel.surfaces.open(chainOf(owner), {})).token });
  assert.ok(!(await d.registry.call("vault.put", { name: "owner-secret", kind: "secret", fields: { value: "S3cr3t-owner-value-Zq81vXr2" } }, "cli", await ownerTok())).error);
  const ctx = d.registry.context(realManifest);
  const chat = await d.kernel.gateway.grants.chats.create(chainOf(BOB), {});
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vtg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  /** @type {number[]} */ const inThread = [];
  // the member's turn: the asker is the member, as a chat turn of theirs makes it
  const ks = await ctx.kernelSession({ thread: "t1", agent: null, rec: { chat: chat.id }, chat: chat.id, asker: BOB });
  const sock = await openThreadSocket({ handler: ctx.handler, thread: "t1", agent: null, dir, kernelToken: ks.token, pids: async () => ({ pids: inThread }) });
  t.after(() => sock.close());
  const call = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ headers = {}) => { const c = client(sock.path, tool, input, headers); inThread.push(c.pid); return c.done; };
  for (const [tool, input] of [["vault.list", {}], ["vault.item", { name: "owner-secret" }], ["vault.reveal", { name: "owner-secret" }]]) {
    const r = await call(tool, input);
    assert.ok(r.body && r.body.error, `${tool}: refused for the member's session: ${JSON.stringify(r)}`);
    assert.ok(!JSON.stringify(r).includes('"owner-secret"'), `${tool}: names nothing of the owner's items`);
    if (tool === "vault.list") assert.deepEqual([r.status >= 400, r.body.error.message], [true, MEMBER_REFUSAL], "the owner's-vault words");
  }
  // a token the client sends of its own is dropped: the session's own is stamped, so it is still the member's chain
  const forged = await call("vault.list", {}, { "x-vyre-kernel-session": "forged.token", "x-vyre-caller": "cli" });
  assert.equal(forged.body.error.message, MEMBER_REFUSAL);
  // the session ends: the socket refuses before any tool runs
  await ks.end();
  const gone = await call("vault.list", {});
  assert.equal(gone.status, 401);
  assert.equal(gone.body.error.code, "no_session");
});
