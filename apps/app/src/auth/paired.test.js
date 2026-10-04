import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { startPaired, pairedStartMessage } from "./paired.ts";

const b64u = (b) => Buffer.from(b).toString("base64url");

test("a paired device signs paired-start over the challenge with its key and trades it for a token", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const calls = [];
  const call = async (tool, input) => {
    calls.push({ tool, input });
    if (tool === "presence.person.pair-challenge") return { data: { challenge: "CH4LL3NG3" } };
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, Buffer.from(input.sig, "base64url"), new TextEncoder().encode(pairedStartMessage("dev1", "CH4LL3NG3")));
    return ok ? { data: { kind: "bearer", id: "ps1", token: "ps1.secret", expires: 9 } } : { error: { code: "denied", message: "this device cannot sign in that way" } };
  };
  const s = await startPaired({ device: "dev1", call, privateKey: pair.privateKey, label: "Vyre on browser" });
  assert.deepEqual(s, { token: "ps1.secret", id: "ps1", expires: 9 });
  assert.deepEqual(calls.map((c) => c.tool), ["presence.person.pair-challenge", "presence.person.start-paired"]);
  assert.equal(Buffer.from(calls[1].input.sig, "base64url").length, 64, "raw r||s, 64 bytes");
  assert.equal(calls[1].input.label, "Vyre on browser");
});

test("no grant: the server's own refusal is the answer", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const call = async (tool) => (tool === "presence.person.pair-challenge" ? { data: { challenge: "random" } } : { error: { code: "denied", message: "this device cannot sign in that way; sign in with its key" } });
  await assert.rejects(startPaired({ device: "dev1", call, privateKey: pair.privateKey }), /cannot sign in/);
  await assert.rejects(startPaired({ device: "dev1", call: async () => ({ error: { message: "offline" } }), privateKey: pair.privateKey }), /offline/);
});

test("a phone signs paired-start with its hardware key through `sign` (raw r||s), not a CryptoKey", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  let signed = null;
  const call = async (tool, input) => tool.endsWith("pair-challenge") ? { data: { challenge: "c1" } } : { data: { token: "t", id: "i", expires: 1 } };
  const sign = async (m) => { signed = new TextDecoder().decode(m); return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, m)); };
  const s = await startPaired({ device: "dev9", call, sign });
  assert.equal(signed, pairedStartMessage("dev9", "c1"));
  assert.equal(signed, "paired-start\ndev9\nc1");
  assert.equal(s.token, "t");
  await assert.rejects(startPaired({ device: "d", call }), /needs the device key/);
});

test("a phone sends esig beside sig, both over paired-start", async () => {
  const sent = [];
  const call = async (tool, input) => { sent.push(input); return tool.endsWith("pair-challenge") ? { data: { challenge: "c2" } } : { data: { token: "t", id: "i", expires: 1 } }; };
  const sig = new Uint8Array(64).fill(1);
  await startPaired({ device: "d", call, sign: async () => sig, signEnclave: async () => sig });
  assert.equal(sent[1].esig, Buffer.from(sig).toString("base64url"));
  assert.equal(sent[1].sig, sent[1].esig);
});
