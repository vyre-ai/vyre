// @ts-check
// The phone apps' test world, used as an app would use it: over plain HTTP, no caller header,
// JSON bodies, a device key made here and enrolled with a one-time code, and a Gate approval
// signed with it. The world runs as its own process, as the apps' test runs start it.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inputHash } from "../../core/presence/index.js";

const WORLD = path.join(path.dirname(fileURLToPath(import.meta.url)), "world.js");

/** Start the world on a free port and wait for its URL. */
async function world(t) {
  const p = spawn(process.execPath, [WORLD, "0"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stderr.on("data", c => (out += c));
  const exited = new Promise(r => p.on("exit", r));
  t.after(async () => { if (p.exitCode === null) { p.kill("SIGTERM"); await exited; } });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the world did not start: " + out)), 30_000);
    p.stdout.on("data", c => {
      out += c;
      const m = /mobile world: (http:\/\/127\.0\.0\.1:\d+)\/ +\(home (.+)\)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ base: m[1], home: m[2] }); }
    });
    p.on("exit", code => reject(new Error(`the world exited ${code}: ${out}`)));
  });
  const post = async (route, body = {}, headers = {}) => {
    const r = await fetch(url.base + route, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const tool = (name, input = {}, headers = {}) => post(`/v1/tools/${name}`, input, headers);
  return { ...url, post, tool, proc: p, exited };
}

/** The phone's device key, and the header it signs one call with. */
function deviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const header = (id, tool, input) => {
    const ts = Date.now(), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
    return { "x-vyre-presence": `device key=${id} ts=${ts} nonce=${nonce} sig=${sig}` };
  };
  return { pub, header };
}

test("mobile world: a phone enrolls with a code and gets a Gate approval past presence, over plain HTTP", { timeout: 90_000 }, async t => {
  const w = await world(t);
  assert.ok(fs.existsSync(w.home), "the home exists while the world runs");

  // Every request looks like alex's phone on the tailnet.
  const who = await w.tool("presence.keys");
  assert.equal(who.status, 200, JSON.stringify(who.body));
  const tools = await (await fetch(w.base + "/v1/tools")).json();
  assert.ok(tools.data.some(x => x.name === "gate.approve"), "the phone sees gate.approve");
  assert.ok(!tools.data.some(x => x.name === "memory.correct"), "and not memory.correct");

  // As the names listener does: a POST that is not JSON, or from another site, is refused.
  const form = await fetch(w.base + "/v1/tools/gate.held", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(form.status, 403);
  assert.equal((await w.tool("gate.held", {}, { origin: "https://evil.example.com" })).status, 403);

  const projects = await w.tool("projects.list");
  assert.deepEqual(projects.body.data.projects.map(p => p.name).sort(), ["Harlow Legal", "Northwind Bakery"]);
  const held = await w.tool("gate.held");
  assert.equal(held.body.data.length, 2, JSON.stringify(held.body));

  // Enroll the phone's key with a one-time code, the way /onboard/device does on a box with no passkey.
  const code = await w.post("/__test/code");
  assert.match(code.body.data.code, /^[A-Z2-9]{8}$/);
  const k = deviceKey();
  const enroll = await w.tool("presence.enroll", { kind: "device", name: "alex-phone", public_key: k.pub, alg: -7 }, { "x-vyre-presence": `code code=${code.body.data.code}` });
  assert.equal(enroll.status, 200, JSON.stringify(enroll.body));
  const keyId = enroll.body.data.id;

  const item = held.body.data.find(x => x.via === "mail");
  const bare = await w.tool("gate.approve", { id: item.id });
  assert.equal(bare.body.error.code, "presence_required");
  assert.ok(bare.body.error.methods.includes("device"));
  const approved = await w.tool("gate.approve", { id: item.id }, k.header(keyId, "gate.approve", { id: item.id }));
  assert.notEqual(approved.body.error?.code, "presence_required", JSON.stringify(approved.body));
  assert.notEqual(approved.body.error?.code, "denied", JSON.stringify(approved.body));
  // The world's senders are fake servers on 127.0.0.1, so the approval really sends, to them.
  assert.equal(approved.body.data.state, "sent", JSON.stringify(approved.body));
  const out = await w.post("/__test/outbox");
  assert.equal(out.body.data.length, 1);
  assert.match(Buffer.from(JSON.parse(out.body.data[0].body).raw, "base64url").toString(), /Subject: Q3 report/);
  assert.ok(!held.body.data.some(x => /example\.com/.test(JSON.stringify(x.to)) && x.via === "billing"), "the billing item points at the local fake host");

  // More to look at: another held item, and a permission question from a running thread.
  const hold = await w.post("/__test/hold");
  assert.equal(hold.status, 200, JSON.stringify(hold.body));
  assert.ok((await w.tool("gate.held")).body.data.some(x => x.id === hold.body.data.id));
  const ask = await w.post("/__test/ask");
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  const asks = await w.tool("threads.asks");
  assert.ok(asks.body.data.some(a => a.id === ask.body.data.ask), JSON.stringify(asks.body));

  w.proc.kill("SIGTERM");
  await w.exited;
  assert.equal(fs.existsSync(w.home), false, "the home is removed on exit");
});
