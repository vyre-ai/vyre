// vyre://keycheck, in a build made with EXPO_PUBLIC_VYRE_KEYCHECK=1 only (the hosted simulator job ios-keycheck): makes or finds this phone's identity key, signs with it, checks the
// WebCrypto shim and the presence key, and writes what it saw on screen and to the log as KEYCHECK lines. A release build renders nothing.
import { useEffect, useState } from "react";
import { ScrollView, Text } from "react-native";
import { ed25519 } from "@noble/curves/ed25519";
import { generateDeviceKey } from "../src/identity/keys.js";
import { sealRecord, openRecord } from "../src/identity/seal.js";
import { loadIdentity, saveIdentity } from "../src/identity/store";
import { keyStorage, presenceKey, signPresence } from "../src/keys";
import { fromB64url, payloadHash } from "../modules/vyre-signer/presence-proof.js";

const ON = process.env.EXPO_PUBLIC_VYRE_KEYCHECK === "1";
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function run(withPresence: boolean, say: (l: string) => void) {
  const step = async (name: string, f: () => Promise<string>) => {
    try { say(`${name}: ${await f()}`); } catch (e) { say(`${name}: FAILED ${(e as { code?: string }).code ?? ""} ${(e as Error).message}`); }
  };
  await step("sha256(abc)", async () => { const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"))); return hex(d).startsWith("ba7816bf8f01cfea") ? "ok" : `WRONG ${hex(d)}`; });
  await step("seal roundtrip", async () => { const s = await sealRecord("keycheck", { a: 1 }); const o = await openRecord("keycheck", s); return JSON.stringify(o) === '{"a":1}' ? "ok" : `WRONG ${JSON.stringify(o)}`; });
  let pub = "";
  await step("identity", async () => {
    const had = await loadIdentity();
    if (had) { pub = had.key.publicKey; return `FOUND existing pub=${pub} software=${had.key.software}`; }
    const key = await generateDeviceKey();
    await saveIdentity({ name: "keycheck", id: "per_keycheck", eid: key.eid, ops: [], pin: { id: "per_keycheck", seq: 0, head: "x" }, key });
    pub = key.publicKey;
    return `CREATED pub=${pub} software=${key.software}`;
  });
  await step("sign and verify", async () => {
    const id = await loadIdentity();
    if (!id) throw new Error("no identity after save");
    const m = new TextEncoder().encode("keycheck message");
    const sig = await id.key.sign(m);
    const ok = ed25519.verify(sig, m, fromB64url(id.key.publicKey));
    return `${ok ? "ok" : "BAD"} pub=${id.key.publicKey} same=${id.key.publicKey === pub}`;
  });
  await step("key storage", async () => JSON.stringify(await keyStorage()));
  await step("presence key", async () => { const k = await presenceKey(); return `key_id=${k.key_id} storage=${k.storage} spki=${k.spki.slice(0, 24)}...`; });
  if (withPresence) {
    await step("presence proof", async () => {
      const fields = { device: "keycheck" };
      const p = await signPresence({ op: "grant.signin", space: "spc_keycheck", fields, payload_hash: payloadHash("grant.signin", "spc_keycheck", fields), prompt: "Key check", person: "per_keycheck" });
      return `signed key_id=${p.key_id} sig=${p.signature.slice(0, 16)}... len=${p.signature.length} assertion=${p.assertion ? "yes" : "none"}`;
    });
  }
}

export default function KeyCheck() {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (!ON) return;
    const say = (l: string) => { console.log(`KEYCHECK ${l}`); setLines((x) => [...x, l]); };
    void run(true, say).then(() => say("done"));
  }, []);
  if (!ON) return null;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#fff" }} contentContainerStyle={{ padding: 16, paddingTop: 80 }}>
      <Text style={{ fontSize: 18, fontWeight: "600", marginBottom: 8 }}>KEYCHECK</Text>
      {lines.map((l, i) => <Text key={i} style={{ fontSize: 11, marginBottom: 4 }}>{l}</Text>)}
    </ScrollView>
  );
}
