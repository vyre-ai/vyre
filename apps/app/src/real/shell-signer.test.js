import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as nodeSign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { b64u } from "../../../../kernel/identity/chain.js";
import { payloadHash } from "./payload-hash.js";
import { proofBytes, fromB64url, keyIdOf, spkiFromXY } from "../../modules/vyre-signer/presence-proof.js";
import { shellSigner } from "./shell-signer.ts";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
function installTpmShell() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const prompts = [];
  globalThis.window = { __vyreShell: { kind: "windows", identity: {
    enclavePublic: async () => b64u(point),
    enclaveSign: async (m, prompt) => { prompts.push(prompt); const sig = nodeSign("sha256", Buffer.from(m, "base64url"), { key: pair.privateKey, dsaEncoding: "ieee-p1363" }); const s = BigInt("0x" + sig.subarray(32).toString("hex")); return b64u(Buffer.concat([sig.subarray(0, 32), Buffer.from((N - s).toString(16).padStart(64, "0"), "hex")])); },
  } } };
  return { pair, point, prompts };
}

test("with no hardware key there is no signer", async (t) => {
  delete globalThis.window; t.after(() => delete globalThis.window);
  assert.equal(await shellSigner(), null);
  globalThis.window = { __vyreShell: { kind: "windows", identity: { public: async () => "x", sign: async () => "x" } } };
  assert.equal(await shellSigner(), null, "an identity key alone is not a yes moment key");
});

test("a card whose fields hash to its payload_hash is signed by the hardware key, with the person's prompt, in the low-s form", async (t) => {
  const k = installTpmShell(); t.after(() => delete globalThis.window);
  const fields = { device: "Sam's PC", role: "member" };
  const card = { op: "grant.pair_device", space: "home", fields, payload_hash: payloadHash("grant.pair_device", "home", fields), person: "per_abcdefghijklmnopqrstuvwxyz", prompt: "Approve Sam's PC" };
  const s = await shellSigner();
  const proof = await s.signPresence(card);
  assert.equal(proof.payload_hash, card.payload_hash);
  assert.equal(proof.decision, "grant.pair_device");
  assert.deepEqual(k.prompts, ["Approve Sam's PC"]);
  const sig = Buffer.from(proof.signature, "base64url");
  assert.equal(sig.length, 64);
  assert.ok(BigInt("0x" + sig.subarray(32).toString("hex")) <= N / 2n, "low s");
  const { signature, ...body } = proof;
  assert.ok(verify("sha256", Buffer.from(proofBytes(body)), { key: k.pair.publicKey, dsaEncoding: "ieee-p1363" }, sig));
  const jwk = k.pair.publicKey.export({ format: "jwk" });
  assert.equal(proof.key_id, keyIdOf(spkiFromXY(fromB64url(jwk.x), fromB64url(jwk.y))), "the key id is the enclave key's");
});

test("a card whose fields do not match its hash is refused before the key is asked", async (t) => {
  const k = installTpmShell(); t.after(() => delete globalThis.window);
  const s = await shellSigner();
  await assert.rejects(s.signPresence({ op: "grant.pair_device", space: "home", fields: { device: "other" }, payload_hash: payloadHash("grant.pair_device", "home", { device: "Sam's PC" }), person: "per_x" }), (e) => e.code === "ERR_PAYLOAD_MISMATCH");
  assert.deepEqual(k.prompts, [], "no prompt for a card that does not match");
});

test("the Windows app says the plain line where lending would be, and approvals use the shell signer on a computer", () => {
  const sh = readFileSync(new URL("../shell/shell.ts", import.meta.url), "utf8");
  assert.match(sh, /WINDOWS_LATER = "Lending this computer comes in a later update\."/);
  assert.match(readFileSync(new URL("../../screens/devices/WinkLend.tsx", import.meta.url), "utf8"), /if \(isWindowsShell\(\)\) return/);
  const pa = readFileSync(new URL("../../screens/shell/PhoneApprovals.tsx", import.meta.url), "utf8");
  assert.match(pa, /\(await phoneSigner\(\)\) \?\? \(await shellSigner\(\)\)/);
});
