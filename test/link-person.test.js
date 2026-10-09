// @ts-check
// A Mac's person session on its box (core/link/mac.js link.signin, core/presence/person.js): the
// Mac's command line and Capsule answer asks on the box only after the person signs the Mac in on
// the box's own page, and only for the person's own callers. Both vyreds are real, and the box's
// tailnet goes through its real router.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
process.env.VYRE_SEAL_SOFTWARE = "1"; // device-key proofs on a development-kind daemon (the release rule is in test/presence-strength.test.js)
import assert from "node:assert/strict";
import http from "node:http";
import { pair, OWNER, MAC } from "./link-harness.js";
import crypto from "node:crypto";
import { HUMAN_ONLY, inputHash } from "../core/presence/index.js";
import { signedIn } from "../core/cli/commands/link.js";

/**
 * Every human-only tool asks. A device proof is checked for real against the key enrolled for it
 * (the Mac's Secure Enclave key, here a software stand-in); anything else counts as proved, so what
 * is refused below is about the session.
 */
const enrolled = new Map();
const proving = {
  // pairing the Mac is the harness's own step (its yes is walked in test/one-yes-floor.test.js); this test is about the person session
  required: (tool, def) => tool !== "link.pair.approve" && (HUMAN_ONLY.has(tool) || Boolean(def && def.presence)),
  verify: async ({ tool, input, proof }) => {
    if (!proof || proof.method !== "device") return { ok: true, method: "passkey", keyId: "k1" };
    const pub = enrolled.get(proof.key);
    const msg = Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${proof.ts}\n${proof.nonce}`);
    let good = false;
    try { good = Boolean(pub) && crypto.verify("sha256", msg, { key: pub, dsaEncoding: "der" }, Buffer.from(String(proof.sig), "base64url")); } catch {}
    return good ? { ok: true, method: "device", keyId: proof.key } : { ok: false, message: "the device signature does not check out" };
  },
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  enroll(k) { const id = `se${enrolled.size + 1}`; enrolled.set(id, crypto.createPublicKey({ key: Buffer.from(k.public_key, "base64url"), format: "der", type: "spki" })); return { id, kind: k.kind, name: k.name }; },
};

/** The Mac's Secure Enclave, stood in for by a software P-256 key: it asks nobody, and counts signatures. */
function softEnclave() {
  const keys = new Map();
  const e = { signed: 0,
    create: async () => { const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }); const handle = crypto.randomBytes(8).toString("hex"); keys.set(handle, privateKey);
      return { handle, spki: publicKey.export({ format: "der", type: "spki" }).toString("base64url") }; },
    sign: async (handle, message) => { e.signed++; return crypto.sign("sha256", message, { key: keys.get(handle), dsaEncoding: "der" }).toString("base64url"); } };
  return e;
}

const get = url => new Promise((resolve, reject) => {
  http.get(url, { agent: false }, res => { let b = ""; res.setEncoding("utf8"); res.on("data", c => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); }).on("error", reject);
});

test("link: a Mac answers on the box only once the person signs it in, and only for the person's callers", async t => {
  const enclave = softEnclave();
  const s = await pair(t, { router: true, boxPresence: proving, macSeam: { secureEnclave: enclave, yesWaitMs: 400, yesPollMs: 20 } });

  // Not signed in: the person's action never rides the link, whoever asks.
  const before = await s.macCall("link.call", { tool: "agents.create", input: { name: "kit" } });
  assert.equal(before.error && before.error.code, "person_session_required", JSON.stringify(before));

  // Sign in: the Mac gives the address of the box's page, with a PKCE challenge and its loopback.
  const started = await s.macCall("link.signin");
  assert.ok(!started.error, JSON.stringify(started.error));
  const url = new URL(started.data.url);
  assert.equal(url.pathname, "/person/signin");
  const cc = String(url.searchParams.get("cc"));
  const back = String(url.searchParams.get("return"));
  assert.match(back, /^http:\/\/127\.0\.0\.1:\d+\/cb\/[\w-]{16,}$/);
  assert.equal((await s.macCall("link.signin", {}, "mcp")).error.code, "denied", "a model cannot start it");

  // The page, in the person's browser on the Mac: the passkey, then the code goes to the loopback.
  const page = await s.boxCall("presence.person.start", { cc, return: back }, `tailnet:${OWNER}`, { peer: MAC });
  assert.ok(!page.error, JSON.stringify(page.error));
  assert.match(page.data.redirect, /^http:\/\/127\.0\.0\.1:\d+\/cb\/[\w-]+\?code=/);
  // Another loopback path is not a sign-in address.
  assert.equal((await s.boxCall("presence.person.start", { cc, return: "http://127.0.0.1:9/elsewhere" }, `tailnet:${OWNER}`, { peer: MAC })).error.code, "denied");
  // `vyre link signin` at a terminal waits on the Mac's event stream for this.
  const waiting = signedIn(Date.now() + 10_000, { root: s.macRoot });
  const landed = await get(page.data.redirect);
  assert.equal(landed.status, 200, landed.body);
  const signed = (await s.macCall("link.status")).data.signedIn;
  assert.ok(signed);
  assert.equal(await waiting, signed.expires, "the waiting command hears the sign-in");
  assert.equal(await signedIn(Date.now() + 300, { root: s.macRoot, before: signed.expires }), null, "the session it already had is not a new sign-in");
  assert.equal(await signedIn(Date.now() + 5_000, { root: s.macRoot }), signed.expires, "a sign-in that landed before the stream opened still counts");
  await assert.rejects(get(page.data.redirect), /ECONNREFUSED|hang up/, "the loopback closes after one use");

  // Signed in: the person's terminal and Capsule reach the box's person-only tools.
  const made = await s.macCall("link.call", { tool: "agents.create", input: { name: "kit" } }, "cli");
  assert.ok(!made.error, JSON.stringify(made.error));
  assert.ok((await s.boxCall("agents.list")).data.some(a => a.name === "kit"));
  // A model or a module on the Mac never carries the session, nor an agent riding a person's
  // transport ("cli:agent:kit" reads as "cli" by its first word alone).
  for (const caller of ["mcp", "mcp:agent:kit", "anonymous", "module:planner", "cli:agent:kit", "cli agent:kit", "capsule:agent:juno", "deck:thread:t1", "cli:agent:"]) {
    const r = await s.macCall("link.call", { tool: "agents.update", input: { name: "kit", description: "x" } }, caller);
    // A model label is refused by link.call's own callers list (group D HD-3); the rest reach the box and are refused there.
    const refusedHere = ["mcp", "mcp:agent:kit", "anonymous"].includes(caller);
    assert.equal(r.error && r.error.code, refusedHere ? "denied" : "person_session_required", caller);
  }
  // A moment (presence.code adds a device): the Mac makes no device-key proof any more (0.3.1). The box names what must be approved, the Mac asks a card as its signed-in person and waits for the owner's phone.
  assert.equal((await s.macCall("link.status")).data.signedIn.touchId, true);
  const opened = await s.macCall("link.call", { tool: "presence.code", input: {} }, "cli");
  assert.equal(opened.error?.code, "presence_required", JSON.stringify(opened));
  assert.match(opened.error.message, /nobody approved it in time/);
  assert.equal(enclave.signed, 0, "no Touch ID signature rides the call");
  assert.ok((await s.boxCall("approvals.pending", {})).data.approvals.some(a => a.moment === "pair" && a.request.op === "presence.code"), "the card is waiting on the owner's phone");
  // Never for a model or a module: no signature is even asked for.
  assert.equal((await s.macCall("link.call", { tool: "presence.code", input: {} }, "mcp")).error.code, "denied");
  assert.equal((await s.macCall("link.call", { tool: "presence.code", input: {} }, "cli:agent:kit")).error.code, "person_session_required");
  assert.equal(enclave.signed, 0);
  // The box lists the Mac's session, pinned to the Mac's node.
  const list = (await s.boxCall("presence.person.sessions")).data.sessions;
  assert.deepEqual(list.map(x => [x.kind, x.node]), [["bearer", MAC.stableId]]);

  // Signing out ends it on the box too.
  assert.equal((await s.macCall("link.signout")).data.signedOut, true);
  assert.equal((await s.boxCall("presence.person.sessions")).data.sessions.length, 0);
  assert.equal((await s.macCall("link.call", { tool: "agents.create", input: { name: "juno" } })).error.code, "person_session_required");
});
