// @ts-check
// The phone opens the person's sealed Personal records: a laptop writes (it holds the IMK), the phone reads with its own agree key through the spaces.storage tools, and each sees the other's writes. The fake
// server below is spaces.storage.* as the box answers it: names, base64 bytes, a sha256, compare-and-set. It stores what it is given and no key.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 as sha256Bytes } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { newKey, newDeviceKey, wrapForDevice, fingerprint, ecdhFrom } from "../../../../lib/keywrap.js";
import { fromB64, toB64, utf8 } from "../../../../lib/databox.js";
import { createSealedStore, openSealedStore, sealedPrefixes, PERSONAL_TYPES } from "../../../../kernel/store/sealed.js";
import { RemoteBackend } from "../../../../core/memory/identity/remote-backend.js";
import { spacesTransport } from "../../../../core/memory/identity/spaces-transport.js";
import { asTransportCall, identityKey, openPersonalStore } from "./personal-store.js";

const REMINDER = { name: "reminder", label: "Reminder", fields: [{ name: "text", kind: "text", label: "Text" }, { name: "due_at", kind: "number", label: "Due" }, { name: "done", kind: "boolean", label: "Done" }] };
const ID1 = "0190c3f2-1111-4abc-8def-000000000001", ID2 = "0190c3f2-1111-4abc-8def-000000000002";
const sha = (/** @type {Uint8Array} */ b) => bytesToHex(sha256Bytes(b));

/** spaces.storage.* over a Map, as the box answers them. */
function fakeServer() {
  /** @type {Map<string, Uint8Array>} */ const files = new Map();
  /** @type {string[]} */ const calls = [];
  /** @type {(tool: string, input?: any) => Promise<any>} */
  const tool = async (name, i = {}) => {
    calls.push(name);
    if (i.space !== "spc_team") throw Object.assign(new Error("no such space"), { code: "not_found" });
    if (name === "spaces.storage.list") {
      const base = String(i.prefix).replace(/\/$/, "") + "/";
      const entries = [...files].filter(([n]) => n.startsWith(base) && !n.slice(base.length).includes("/")).map(([n, b]) => ({ name: n, sha: sha(b), size: b.length }));
      return { names: entries.map((e) => e.name), entries };
    }
    if (name === "spaces.storage.get") { const b = files.get(i.name); return b ? { data: toB64(b), sha256: sha(b) } : null; }
    if (name === "spaces.storage.put-if") {
      const b = files.get(i.name), now = b ? sha(b) : null;
      if (now !== (i.expected ?? null)) return { ok: false };
      files.set(i.name, fromB64(i.data)); return { ok: true };
    }
    if (name === "spaces.storage.put") { files.set(i.name, fromB64(i.data)); return { ok: true }; }
    if (name === "spaces.storage.delete") { if (i.expected !== undefined && i.expected !== null && files.has(i.name) && sha(/** @type {Uint8Array} */ (files.get(i.name))) !== i.expected) return { ok: false }; files.delete(i.name); return { ok: true }; }
    throw Object.assign(new Error(`no tool ${name}`), { code: "no_such_tool" });
  };
  return { files, calls, tool };
}

/** The laptop: holds the IMK, wraps it to the phone's agree key in the identity home's manifest, and writes the first records. */
async function laptopWrites(server, imk, phoneKey, identity = "per_alex") {
  const fp = fingerprint(phoneKey.publicJwk);
  const wrapped = wrapForDevice(imk, phoneKey.publicJwk, `vyre-identity-home/${identity}/wrap:${fp}`);
  server.files.set(`identity/${identity}/manifest.json`, utf8(JSON.stringify({ v: 1, id: identity, rev: 1, wraps: [{ kind: "device", fp, wrapped }], objects: {} })));
  const transport = spacesTransport(asTransportCall(server.tool), "spc_team");
  const backend = new RemoteBackend(transport, { prefixes: sealedPrefixes(identity) });
  const laptop = await openSealedStore({ backend, identity, imk, create: true, allow: PERSONAL_TYPES, device: "laptop" });
  await laptop.store.define({ add_types: [REMINDER] });
  await laptop.store.create("reminder", ID1, { text: "Call the dentist about Dana Reyes", due_at: 1000, done: false });
  return laptop;
}

test("phone: the identity key opens with this device's agree key and nobody else's; a missing wrap or home says why", async () => {
  const server = fakeServer(), imk = newKey(), phone = newDeviceKey();
  await laptopWrites(server, imk, phone);
  const transport = spacesTransport(asTransportCall(server.tool), "spc_team");
  const agree = { holder: fingerprint(phone.publicJwk), ecdh: ecdhFrom(phone.privateJwk) };
  assert.equal(Buffer.from(await identityKey(transport, "per_alex", agree)).toString("hex"), Buffer.from(imk).toString("hex"));
  const stranger = newDeviceKey();
  await assert.rejects(() => identityKey(transport, "per_alex", { holder: fingerprint(stranger.publicJwk), ecdh: ecdhFrom(stranger.privateJwk) }), { code: "unknown_key" });
  await assert.rejects(() => identityKey(transport, "per_nobody", agree), { code: "not_found" });
});

test("phone: reads what the laptop wrote, writes a reminder the laptop then sees, and the server holds ciphertext only", async () => {
  const server = fakeServer(), imk = newKey(), phoneKey = newDeviceKey();
  const laptop = await laptopWrites(server, imk, phoneKey);
  const phone = await openPersonalStore({ call: server.tool, space: "spc_team", identity: "per_alex", agree: { holder: fingerprint(phoneKey.publicJwk), ecdh: ecdhFrom(phoneKey.privateJwk) }, device: "phone" });
  const first = await phone.store.get("reminder", ID1);
  assert.equal(first.fields?.text ?? first.text, "Call the dentist about Dana Reyes");
  await phone.store.create("reminder", ID2, { text: "Pick up the keys", due_at: 2000, done: false });
  const seen = await laptop.store.get("reminder", ID2);
  assert.equal(seen.fields?.text ?? seen.text, "Pick up the keys", "the laptop sees the phone's write");
  const everything = [...server.files.entries()].map(([n, b]) => n + Buffer.from(b).toString("utf8")).join("\n");
  assert.ok(!everything.includes("dentist") && !everything.includes("keys") && !everything.includes("Dana"), "nothing readable on the server");
  phone.lock();
  await assert.rejects(() => phone.store.get("reminder", ID1), { code: "unavailable" });
});
