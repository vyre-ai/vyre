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
