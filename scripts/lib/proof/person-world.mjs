// @ts-check
// A world with a real person, for every proof that needs the owner's yes: design's run-switch walk, release's journeys, chat's start-a-chat step, Publish.
//
//   const pw = await personWorld({ name: "alex", kind: "daemon" });      // or kind: "box" (a development-build installer box; Linux with Docker, VYRE_JOURNEY_BOX=1)
//   await pw.call("spaces.devices.list");                                  // a tool call as the person, over the app's paired session; a call that asks for the person's yes gets it
//   const r = await pw.yesFor(sign);                                       // the proof header for an act the server asked to be confirmed (what the phone's key signs)
//   await pw.close();
//
// What it builds: the repo's own names Worker and relay stand-ins, one person with an identity under the chosen Vyre name, the app's own modules driven headless, and a REAL server that person has added
// and adopted the way the app's Add a server does: `daemon` is a real vyred in this process with a development sealing process that took the owner's stand-in key before pairing; `box` is the real installer's
// box built as a DEVELOPMENT build (VYRE_DEV_SIGN=unsigned) whose sealer takes the stand-in key through the product's own identity and presence calls (spaces.identity.entry.add, spaces.presence.begin and
// recover). What this cannot cover: the release signature and a hardware key (a packaged build ignores every developer switch, kernel/devbuild.js). Throwaway machines only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun } from "./run.mjs";
import { bringUp } from "../../journeys/lib/world.mjs";

/**
 * @param {{ name?: string, kind?: "daemon" | "box" | "local", store?: "plain" | "records", out?: string, run?: ReturnType<typeof createRun> }} [o]
 */
export async function personWorld(o = {}) {
  if (o.kind === "local") return localWorld(o);
  const kind = o.kind || "daemon";
  const out = o.out || fs.mkdtempSync(path.join(os.tmpdir(), "person-world-"));
  const run = o.run || createRun({ out });
  const w = await bringUp({ run, out, kind, store: o.store || "plain", ...(kind === "box" ? { devBuild: true } : {}), ...(o.name ? { person: o.name } : {}) });
  if (!w.ready) { await w.stop().catch(() => {}); throw new Error(`the ${kind} world did not come up: ${run.results.filter(r => r.ok === false).map(r => `${r.name}: ${r.why || ""}`).join(" | ").slice(0, 500)}`); }
  const personId = w.mac.identity.id;
  const srv = w.srv;
  if (kind === "box") await enrolStandIn(w);
  return {
    world: w, run, out, kind, person: w.person, personId, server: srv,
    /** A tool call as the person; a call the server answers presence_required to is retried with the person's yes (the stand-in key signs exactly what the card shows). @param {string} tool @param {any} [input] */
    call: (tool, input = {}) => w.call(tool, input),
    /** The proof header (base64url) for an act the server asked to be confirmed. @param {{ op: string, space: string, fields: Record<string, any> }} sign */
    yesFor: sign => srv.yesFor(personId)(sign),
    /** The server's own operator terminal (the machine's console), for what no paired person does. @param {string} tool @param {any} [input] */
    operator: (tool, input = {}) => w.operator(tool, input),
    mac: w.mac,
    close: () => w.stop(),
  };
}

/** A development-build box: the stand-in owner key goes on the identity list, then into the box's sealer, through the product's own calls (trust's route). @param {any} w */
async function enrolStandIn(w) {
  const sg = w.srv.ownerSigner;
  assert.ok(sg, "the box server has an owner signer (a development-build box)");
  const spki = sg.enrolment.spki;
  await w.call("spaces.identity.entry.add", { kind: "device", publicKey: Buffer.from(spki, "base64").toString("base64url"), label: "stand-in owner key" });
  const begun = await w.call("spaces.presence.begin", { key_id: sg.enrolment.key_id, spki });
  await w.call("spaces.presence.recover", { key_id: sg.enrolment.key_id, spki, signer: "software", token: begun.token });
}

/**
 * `local`: ONE real vyred in this process that is the person's own computer (what the Mac runs): a Vyre name made on it (spaces.identity.create), a home Space on this computer, a development sealing
 * process that took the owner's stand-in key, and the person's session. This is the world for what the local app does on its own daemon, such as the "Run on this computer" switch. No server, no relay.
 * @param {{ name?: string, out?: string }} o
 */
async function localWorld(o) {
  const { start } = await import("../../../core/daemon/index.js");
  const { startSealer } = await import("../../../kernel/seal/client.js");
  const seal = await import("../../../kernel/seal/testing.js");
  const { startStandins } = await import("./standins.mjs");
  const out = o.out || fs.mkdtempSync(path.join(os.tmpdir(), "person-world-"));
  const root = path.join(out, ".vyre");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const ins = await startStandins({ out });
  const name = o.name || `local${Math.random().toString(36).slice(2, 7)}`;
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", name, transcripts: [], vault: { keystore: "file" }, network: { name, directory: ins.names }, names: { directory: ins.names }, relay: { enabled: false, url: ins.relay }, modules: { disable: ["names", "onboard"] }, store: "sqlite" }));
  const saved = { VYRE_HOME: process.env.VYRE_HOME, VYRE_STORE: process.env.VYRE_STORE, VYRE_SEAL_DEV: process.env.VYRE_SEAL_DEV, VYRE_KERNEL_PATH_RULE: process.env.VYRE_KERNEL_PATH_RULE };
  process.env.VYRE_HOME = root; process.env.VYRE_STORE = "sqlite"; process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
  const sealer = startSealer({ dir: path.join(out, "seal"), timeoutMs: 8000, dev: true, unattested: true });
  const presence = { required: () => false, verify: async () => ({ ok: true, method: "test" }), capsulePin: () => null, challenge: async () => ({ error: { code: "bad_input", message: "presence is not checked here" } }) };
  const d = await start({ presence, root, log: () => {}, kernel: true, kernelSealer: sealer });
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const owner = () => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-person", person: d.kernel.id.owner, path: "direct", session: "s" });
  // A call that asks for the person's yes is answered with it: the daemon's development presence seam takes the proof the way the server's operator terminal gives it (the same seam as the daemon world).
  /** @type {any} */ let ownerSigner = null;
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    const token = (await d.kernel.surfaces.open(owner(), {})).token;
    let r = await d.registry.call(tool, input, "cli", { token });
    if (r.error && r.error.code === "presence_required" && r.error.sign) {
      // the person's yes: the stand-in key signs exactly the act the daemon says it wants confirmed (what the phone's key would sign)
      const sign = r.error.sign;
      const yes = Buffer.from(JSON.stringify(ownerSigner.proof({ space: sign.space, hops: [{ actor: { kind: "person", id: d.kernel.id.owner, space: sign.space } }] }, sign.op, sign.fields))).toString("base64url");
      r = await d.registry.call(tool, input, "cli", { token, yes });
    }
    if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code });
    return r.data;
  };
  // the name is reserved at the directory the way vyre.run/setup does, then made on this computer with the code
  const rsv = await (await fetch(`${ins.names}/v1/ids/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).json();
  const code = rsv && rsv.data && rsv.data.code;
  assert.ok(code, `the directory gave no reservation code: ${JSON.stringify(rsv).slice(0, 200)}`);
  const made = await call("spaces.identity.create", { name, code });
  const personId = String((made && (made.id || made.identity || d.kernel.id.owner)) || d.kernel.id.owner);
  ownerSigner = seal.signer(d.kernel.id.owner);
  await seal.enrolDevice(sealer, ownerSigner);
  await call("spaces.create", { name: "home", home: { kind: "this-computer", confirmed: true } });
  return {
    world: null, run: null, out, kind: "local", person: name, personId, server: d, daemon: d, ownerSigner,
    call,
    /** The proof header for an act the daemon asked to be confirmed. @param {{ op: string, space: string, fields: Record<string, any> }} sign */
    yesFor: async sign => Buffer.from(JSON.stringify(ownerSigner.proof({ space: sign.space, hops: [{ actor: { kind: "person", id: d.kernel.id.owner, space: sign.space } }] }, sign.op, sign.fields))).toString("base64url"),
    operator: call, mac: null,
    close: async () => { try { await d.stop(); } finally { restore(); await sealer.close().catch(() => {}); await ins.stop().catch(() => {}); } },
  };
}
