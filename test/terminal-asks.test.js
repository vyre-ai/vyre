// @ts-check
// Option A (the user's go, 2 Oct 2026): reviewer-2's Tier 1 tools need a proof from the person's hand when the call comes from a
// terminal (socket label cli or local), one proof per call and no window afterwards. A caller that already holds a session (the
// Deck, the Capsule, mobile) is not asked.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { inputHash } from "../core/presence/index.js";
import { TERMINAL_ASKS } from "../core/presence/index.js";
import * as config from "../core/config/index.js";
import { request, setPresenceHandler } from "../core/daemon/client.js";
import { callAsPerson } from "../core/cli/presence.js";

const deviceKey = presence => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { id } = presence.enroll({ kind: "device", name: "test key", public_key: publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 });
  return (tool, input) => {
    const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
    return { method: "device", key: id, ts, nonce, sig };
  };
};

test("terminal asks: a Tier 1 tool from a terminal needs a proof for that call; the Deck and other tools are not asked", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const sign = deviceKey(d.registry.deps.presence);
  const call = (tool, input, caller, meta = {}) => d.registry.call(tool, input, caller, meta);

  // The Deck path: no terminal ask in the call, no prompt.
  assert.equal((await call("agents.create", { name: "deckmade" }, "deck")).error, undefined);

  // The terminal: refused until a proof, and the refusal says it is the terminal's to answer.
  const bare = await call("agents.create", { name: "termmade" }, "cli", { terminalAsk: true });
  assert.equal(bare.error?.code, "presence_required", JSON.stringify(bare));
  assert.equal(bare.error.terminal, true);
  assert.ok(Array.isArray(bare.error.methods) && bare.error.methods.length > 0);
  assert.equal((await call("agents.list", {}, "cli")).error, undefined);
  // A proof is for that call's input only.
  const wrong = await call("agents.create", { name: "other" }, "cli", { terminalAsk: true, proof: sign("agents.create", { name: "termmade" }) });
  assert.equal(wrong.error?.code, "presence_required", JSON.stringify(wrong));
  const ok = await call("agents.create", { name: "termmade" }, "cli", { terminalAsk: true, proof: sign("agents.create", { name: "termmade" }) });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  // No standing window: the next call asks again.
  const next = await call("agents.create", { name: "again" }, "cli", { terminalAsk: true });
  assert.equal(next.error?.code, "presence_required", JSON.stringify(next));
  // A tool that is not on the list is not asked from a terminal.
  assert.equal((await call("agents.list", {}, "local", { terminalAsk: true })).error, undefined);
});

test("terminal asks: settings.set asks from a terminal only for a key that loosens a guard", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const listed = (await d.registry.call("settings.schema", {}, "cli")).data;
  const rows = listed?.keys || [];
  const loose = rows.find(r => r.security === "loosens" || r.confirm);
  const plain = rows.find(r => !(r.security === "loosens" || r.confirm) && r.type === "bool" && r.levels?.includes("account"));
  assert.ok(loose && plain, `settings with and without a loosening: ${rows.length} rows: ${JSON.stringify(listed).slice(0, 200)}`);
  const asked = await d.registry.call("settings.set", { key: loose.key, value: loose.default === true ? false : true }, "cli", { terminalAsk: true });
  assert.equal(asked.error?.code, "presence_required", JSON.stringify(asked));
  const free = await d.registry.call("settings.set", { key: plain.key, value: plain.default === true ? false : true }, "cli", { terminalAsk: true });
  assert.notEqual(free.error?.code, "presence_required", JSON.stringify(free));
  const preview = await d.registry.call("settings.set", { key: loose.key, value: true, preview: true }, "cli", { terminalAsk: true });
  assert.notEqual(preview.error?.code, "presence_required", "a preview writes nothing");
});

test("terminal asks: the list is exactly the Tier 1 tools", () => {
  assert.equal(TERMINAL_ASKS.size, 59);
  for (const n of ["agents.create", "spend.raise", "vault.relay", "update.apply", "threads.shell", "term.open"]) assert.ok(TERMINAL_ASKS.has(n), n);
  for (const n of ["sync.delete", "files.send", "memory.correct", "voice.speak", "agents.list"]) assert.ok(!TERMINAL_ASKS.has(n), `${n} is a lower tier`);
});

test("terminal asks: the CLI asks the person once, at its terminal, and retries that call with the proof", async t => {
  const root = tempHome(t);
  const socket = config.paths(root).socket;
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", c => { body += c; });
    req.on("end", () => {
      const proof = req.headers["x-vyre-presence"];
      seen.push(`${req.url} ${proof ? "proof" : "bare"}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/presence/challenge") return res.end(JSON.stringify({ data: { challenge: "c1" } }));
      res.end(JSON.stringify(proof ? { data: { ran: true } } : { error: { code: "presence_required", terminal: true, message: "needs you", methods: ["tty"] } }));
    });
  });
  await new Promise(r => server.listen(socket, r));
  t.after(() => { server.close(); setPresenceHandler(null); });
  let prompts = 0;
  const io = { openTty: () => 9, ttyName: () => "ttys001", prompt: async () => { prompts++; return "code123"; }, print: () => {}, close: () => {} };
  setPresenceHandler((tool, input, opts) => callAsPerson(tool, input, { root: opts.root, io }));
  const r = await request("POST", "/v1/tools/agents.create", { name: "x" }, { root });
  assert.deepEqual(r, { data: { ran: true } });
  assert.equal(prompts, 1, "one prompt");
  assert.deepEqual(seen.filter(s => s.startsWith("/v1/tools/")).map(s => s.split(" ")[1]), ["bare", "bare", "proof"]);
  // A refusal that is not a terminal ask is handed back untouched, with no prompt.
  setPresenceHandler(() => { throw new Error("must not prompt"); });
  server.removeAllListeners("request");
  server.on("request", (req, res) => { req.resume(); res.end(JSON.stringify({ error: { code: "presence_required", message: "gate", methods: ["tty"] } })); });
  assert.equal((await request("POST", "/v1/tools/gate.approve", {}, { root })).error.code, "presence_required");
});
