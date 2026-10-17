// @ts-check
// A headless Vyre app: the code the Mac, Windows and phone windows run, driven without a window. Every rule here is the app's own module, imported, not copied:
//   identity           apps/app/src/identity/claim.js (claimIdentity), keys.js (the device key; a software key store here, since there is no keychain on a runner)
//   the first name     site/setup/reserve.js (the page's own answer parser) against the directory's POST /v1/ids/reserve, then claim.js finishes it with the code
//   add a server       apps/app/src/real/add-server.js (createAddServer) with screens/install/first-run.js installLine, and relay/client/setup.js + setupchannel.js
//   pairing            relay/client/serverpair.js pairServer, with the arguments apps/app/src/real/pairing.ts directSessionFor gives it (that function is TypeScript glued to the
//                      phone's modules, so Node cannot import it; its call into pairServer is repeated in pairWithServer below and must be kept in step)
//   a tool call        apps/app/src/auth/paired.ts startPaired over relay/client/client.js connect, as the app's openPairedSession does
// The person's clicks are the only thing replaced: pasting the code, choosing Records, saying the four words match.
import { createECDH } from "node:crypto";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { payloadHash, proofBytes, chainCtx } from "../../../kernel/seal/wire.js";
import { presenceKeyId } from "../../../lib/presence-key-id.js";
import { claimIdentity } from "../../../apps/app/src/identity/claim.js";
import { claimServerSpace } from "../../../apps/app/src/identity/claim-space.js";
import { createAddServer } from "../../../apps/app/src/real/add-server.js";
import { withCoreProof } from "../../../apps/app/src/real/core-proof.js";
import { installLine } from "../../../apps/app/screens/install/first-run.js";
import { startPaired } from "../../../apps/app/src/auth/paired.ts";
import { proofWith } from "../../../apps/app/src/auth/person.ts";
import { reserveAnswer, nameOf, looksLikeName } from "../../../site/setup/reserve.js";
import * as setupClient from "../../../relay/client/setup.js";
import { connectSetup } from "../../../relay/client/setupchannel.js";
import { openChannel, request, connect } from "../../../relay/client/client.js";
import { webCrypto } from "../../../relay/client/webcrypto.js";
import { nodeCrypto, fileKeyStore } from "../../../relay/client/nodecrypto.js";
import { utf8 } from "../../../relay/client/bytes.js";
import { pairServer } from "../../../relay/client/serverpair.js";
import { openInvite, callTeam } from "../../../apps/app/src/real/join-team.js";
import { kernelWire } from "../../../apps/app/src/real/kernel-wire.js";
import { createTeamInvite, listTeamInvites } from "../../../apps/app/src/real/team-invite.js";
import { openServerPeer } from "../../../relay/client/peerclient.js";
import { WORDS } from "../../../relay/client/words.js";

const b64u = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("base64url");
const until = async (/** @type {() => any} */ fn, ms = 30_000, what = "the app") => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 40)); } throw new Error(`timed out waiting for ${what}`); };
/** The name offered to the server: no control characters (apps/app/src/real/pairing.ts plainName). */
const plainName = (/** @type {string} */ n) => String(n).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/ {2,}/g, " ").trim().slice(0, 64);

/**
 * @param {{ label: string, dir: string, directory: string, relay: string, stretch?: { memoryKiB: number, passes: number }, about?: { kind: "app" | "web" }, capsule?: boolean }} o
 * `directory` is the names directory's base (a stand-in), `relay` the relay's ws address, `dir` this app's own folder for its relay keys.
 */
export function createApp(o) {
  fs.mkdirSync(o.dir, { recursive: true });
  // what this app says it is at the relay: the Mac and Windows windows and the phone apps all say "app" (pair-fix-3: a web hello left a typed-code pairing with no person session)
  const about = o.about || { kind: /** @type {const} */ ("app") };
  const stretch = o.stretch || { memoryKiB: 64, passes: 1 };
  /** @type {any} */ let me = null;
  /** @type {any} */ let pairing = null;
  /** @type {any} */ let session = null;
  const keyStore = fileKeyStore(path.join(o.dir, "relay-device-key.json"));
  const relayCrypto = nodeCrypto();
  // the key this device reports at pairing and signs its session start with (a browser's person key, ES256); software, since a runner has no secure chip
  const personKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const presenceKey = { public_key: personKey.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "software" };
  // This app's own presence key as a signer of the person's yes (the shape kernel/seal/testing.js signer gives): the key it handed to the server at pairing, which a development-build server enrolled as software.
  const presenceSigner = (() => {
    const spki = personKey.publicKey.export({ type: "spki", format: "der" });
    const key_id = presenceKeyId(spki), signerKind = "software";
    return { key_id, enrolment: (/** @type {string} */ person) => ({ person, key_id, signer: signerKind, spki: spki.toString("base64") }),
      proof(/** @type {any} */ ch, /** @type {string} */ op, /** @type {object} */ fields, { life = 60_000, extra = {} } = {}) {
      const issued = Date.now();
      const p = { ...extra, signer: signerKind, key_id, payload_hash: payloadHash(op, ch.space, fields), decision: op, chain_hash: chainCtx(ch).chain_hash, issued_at: issued, expires_at: issued + life, nonce: crypto.randomBytes(8).toString("base64url") };
      return { ...p, signature: crypto.sign("sha256", proofBytes(p), { key: personKey.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
    } };
  })();
  // The yes a call may need (lib/one-yes.js): the server answers presence_required with the exact act to sign (`sign`: op, space, fields), and the device sends the call again with its signed yes in
  // x-vyre-yes (apps/app/src/real/box.ts). A runner has no secure chip, so the world hands in a development signer where the server takes one (setYes); with none, the call fails as it does for a
  // device that cannot give a yes.
  /** @type {null | ((sign: { op: string, space: string, fields: Record<string, any> }) => Promise<string>)} */ let yesWith = null;
  const signPerson = async (/** @type {Uint8Array} */ m) => new Uint8Array(crypto.sign("sha256", Buffer.from(m), { key: personKey.privateKey, dsaEncoding: "ieee-p1363" }));

  /** Step 1, on vyre.run/setup: type a name, get the reservation code. The page's own parser reads the directory's answer. @param {string} text */
  async function reserve(text) {
    const name = nameOf(text);
    if (!looksLikeName(name)) throw new Error(`"${text}" is not a name`);
    // One try more on a refused or reset connection, on a fresh connection: the walk before this one (a whole server install and teardown) can leave the pooled keep-alive socket to the stand-in directory dead,
    // and the CI run that read "fetch failed" here had a directory that answered every other request.
    const post = () => fetch(`${o.directory}/v1/ids/reserve`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ name }) });
    const res = await post().catch(async (/** @type {any} */ e) => { await new Promise(r => setTimeout(r, 1500)); return post().catch(() => { throw new Error(`fetch ${o.directory}: ${e.message} (${e.cause && (e.cause.code || e.cause.message)})`); }); });
    const body = await res.json().catch(() => null);
    if (!(res.status === 200 && body && body.data && typeof body.data.code === "string")) throw Object.assign(new Error(`the directory answered ${res.status} ${JSON.stringify(body).slice(0, 160)}`), { code: "reserve" });
    // what the setup page does with that answer; kept apart so a page that rejects a code the directory made is its own finding and the walk can go on with the code
    return { name, code: String(body.data.code), expires: Number(body.data.expires) || 0, page: reserveAnswer(res.status, body) };
  }

  /** Step 2, in the app: paste the code; the app makes the identity key here and finishes the claim with it. @param {{ name: string, code: string }} a */
  async function becomeYourself(a) {
    // the device's key-agreement point, as the app's device has one (a chat with several people is sealed to each device's point; a person whose device lists none cannot be put in a chat)
    const agreeKey = createECDH("prime256v1"); agreeKey.generateKeys();
    const made = await claimIdentity({ name: a.name, code: a.code, base: o.directory, forceSoftware: true, params: stretch, deviceLabel: o.label, agree: agreeKey.getPublicKey().toString("base64url") });
    me = made;
    return { id: made.id, name: made.name, recoveryCode: made.recoveryCode };
  }

  /** Pair with a server's long code the way the app's directSessionFor does: this identity's key signs for the pairing, so nobody answers at the server. @param {string} qr */
  async function pairWithServer(qr, ctx) {
    if (!me) throw new Error("this app has no identity yet");
    /** @type {string[]} */ const words = [];
    pairing = await pairServer({
      payload: qr, owner: { id: me.id, name: plainName(me.name), vyre: me.name, pin: me.pin },
      signIdentity: async (/** @type {Uint8Array} */ m) => ({ eid: me.key.eid, sig: b64u(await me.key.sign(m)) }),
      name: o.label, crypto: relayCrypto, keyStore, presenceKey: await withCoreProof(presenceKey, { pageKey: ctx && ctx.pageKey, name: o.label, enclave: o.capsule ? presenceKey.public_key : null }), about, pollMs: 100, deviceKind: "computer", keyStorage: "software",
      onWords: w => { words.push(w); },
    });
    pairing.words = words;
    return pairing;
  }

  /** "Add a server": the app makes the install line; the caller runs it; the server adopts this identity and the app pairs without a four-word step. @param {{ onChange?: (s: any) => void }} [h] */
  function addServer(h = {}) {
    if (!me) throw new Error("this app has no identity yet");
    const flow = createAddServer({
      client: /** @type {any} */ (setupClient), relay: o.relay,
      identity: async () => ({ id: me.id }),
      connect: async ({ offer, key, secret }) => connectSetup({ openChannel, request, setupHello: setupClient.setupHello, webCrypto, utf8 }, { offer, key, secret }),
      pair: async (qr, ctx) => { await pairWithServer(qr, ctx); },
      autoPair: true,
      pollMs: 100, ...(h.onChange ? { onChange: h.onChange } : {}),
    });
    return flow;
  }

  /** The signed-in session on the paired server: pair-challenge, sign with the device key, trade for a token (the app's openPairedSession). */
  async function openSession() {
    if (!pairing) throw new Error("this app is not paired with a server");
    const conn = connect({ relay: pairing.relay, route: pairing.route, box: pairing.box, name: o.label, crypto: relayCrypto, keyStore });
    const call = async (/** @type {string} */ tool, /** @type {Record<string, unknown>} */ input, /** @type {Record<string, string>} */ headers = {}) => {
      const r = await conn.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
      return /** @type {any} */ (await r.json().catch(() => ({})));
    };
    const s = await startPaired({ device: pairing.device, call, sign: signPerson, label: o.label });
    session = { conn, call, token: s.token };
    return s;
  }

  /** The app's link dropped (the box restarted): a NEW connection to the same box, with the session token it already holds. This is what the app does on reconnecting; it does not sign in again while its session is live. */
  async function reconnect() {
    if (!pairing || !session) throw new Error("this app has no session to keep");
    const conn = connect({ relay: pairing.relay, route: pairing.route, box: pairing.box, name: o.label, crypto: relayCrypto, keyStore });
    const call = async (/** @type {string} */ tool, /** @type {Record<string, unknown>} */ input, /** @type {Record<string, string>} */ headers = {}) => {
      const r = await conn.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
      return /** @type {any} */ (await r.json().catch(() => ({})));
    };
    session = { conn, call, token: session.token };
  }

  /** The same sign-in as openSession over a caller's own transport (a direct connection, no relay). @param {(tool: string, input: any, headers?: Record<string, string>) => Promise<any>} call */
  async function startDirect(call) {
    if (!pairing) throw new Error("this app is not paired with a server");
    const s = await startPaired({ device: pairing.device, call, sign: signPerson, label: o.label });
    return { token: Boolean(s && s.token) };
  }

  /** One tool call on the paired server, as this device's signed-in session. @param {string} tool @param {Record<string, unknown>} [input] */
  async function callTool(tool, input = {}) {
    if (!session) await openSession();
    const url = `/v1/tools/${tool}`, body = JSON.stringify(input);
    let yes = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      // every request carries the token and a proof signed by the same key (apps/app/src/auth/person.ts proofWith), plus this device's presence proof when the call needs a person
      const proof = await proofWith(async m => signPerson(new TextEncoder().encode(m)), { method: "POST", url, body });
      const res = await session.conn.fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Vyre ${session.token}`, "x-vyre-proof": proof, ...(yes ? { "x-vyre-yes": yes } : {}) }, body });
      const r = /** @type {any} */ (await res.json().catch(() => ({})));
      if (r && r.error) {
        if (r.error.code === "presence_required" && r.error.sign && yesWith && !yes) { yes = await yesWith(r.error.sign); continue; }
        throw Object.assign(new Error(`${tool}: ${r.error.message || r.error.code}`), { code: r.error.code, ...(r.error.sign ? { sign: r.error.sign } : {}) });
      }
      return r ? r.data : null;
    }
    throw new Error(`${tool}: the server kept asking for a yes`);
  }

  /**
   * The owner's side of a team invite, as the app does it (apps/app/src/real/team-invite.js over kernel-wire.js on the paired peer stream): the server holds no identity, so the home's kernel asks THIS
   * app's key for its yes. `signPresence` is that key (the walk hands in the development sealing process's software signer; a release server wants a hardware key).
   * @param {{ space: string, name: string, to: string, signPresence: (card: any) => Promise<any> }} a
   */
  async function makeTeamInvite(a) {
    if (!me || !pairing) throw new Error("this app has no identity or no server yet");
    const conn = connect({ relay: pairing.relay, route: pairing.route, box: pairing.box, name: o.label, crypto: relayCrypto, keyStore });
    const peer = await openServerPeer(conn);
    const wire = kernelWire(peer, a.space, { person: me.id, signPresence: a.signPresence });
    const dir = { wire, fetch: globalThis.fetch.bind(globalThis), base: o.directory };
    const made = await createTeamInvite(dir, { space: a.space, name: a.name, role: "member", to: a.to });
    const rows = await listTeamInvites(dir);
    return { ...made, rows, close() { try { peer.close(); } catch { /* closed */ } try { conn.close(); } catch { /* closed */ } } };
  }

  /**
   * "Join a team": paste the invite; this identity has no server of its own and joins through the team's server (apps/app/src/real/join-team.js openInvite, accept, callTeam), the same code team-join.ts
   * gives the app. `signPresence` and `presenceKey` are this app's yes key (the walk hands in a development software signer).
   * @param {{ link: string, signPresence: (req: any) => Promise<any>, presenceKey: (invite: string) => Promise<any> }} a
   */
  async function joinTeam(a) {
    if (!me) throw new Error("this app has no identity yet");
    const rows = new Map();
    const deps = {
      who: { id: me.id, name: me.name, eid: me.key.eid, sign: (/** @type {Uint8Array} */ m) => me.key.sign(m) },
      fetch: globalThis.fetch.bind(globalThis), base: o.directory, connect, openServerPeer, crypto: relayCrypto, words: WORDS,
      signPresence: a.signPresence, presenceKey: a.presenceKey,
      store: { get: async (/** @type {string} */ k) => rows.get(k), put: async (/** @type {string} */ k, /** @type {any} */ v) => { rows.set(k, v); } },
    };
    const inv = await openInvite(deps, a.link);
    try {
      const joined = await inv.accept();
      return { joined, card: inv.card, call: (/** @type {string} */ call, /** @type {any[]} */ args, /** @type {{ timeoutMs?: number }} */ opt) => callTeam(deps, joined.space, call, args, opt) };
    } finally { inv.close(); }
  }

  /** A team space on the server this app is paired with: the app's claimServerSpace, with the server hosting it (spaces.host-here) and the names directory holding its record. @param {string} name */
  async function createTeamSpace(name) {
    if (!me || !pairing) throw new Error("this app has no identity or no server yet");
    return claimServerSpace({
      identity: { id: me.id, name: me.name, eid: me.key.eid, ops: me.ops, key: me.key }, name, displayName: name, base: o.directory,
      route: { relay: pairing.relay, route: pairing.route, box: pairing.box },
      host: a => callTool("spaces.host-here", { ...a }), retire: space => callTool("spaces.retire", { space }),
    });
  }

  /** The server's OWN Space made the team's (the app's nameServerOwnSpace, apps/app/src/real/claim-space.ts): spaces.name-here, the directory record for the existing id, spaces.name-here { done }. @param {string} name */
  async function nameOwnSpace(name) {
    if (!me || !pairing) throw new Error("this app has no identity or no server yet");
    const claimed = await claimServerSpace({
      identity: { id: me.id, name: me.name, eid: me.key.eid, ops: me.ops, key: me.key }, name, displayName: name, base: o.directory,
      route: { relay: pairing.relay, route: pairing.route, box: pairing.box },
      host: a => callTool("spaces.name-here", { ...a }),
    });
    await callTool("spaces.name-here", { name: claimed.label, done: true });
    return claimed;
  }

  return {
    nameOwnSpace, label: o.label, joinTeam, makeTeamInvite, createTeamSpace,
    get presenceSigner() { return presenceSigner; }, get identity() { return me; }, get pairing() { return pairing; }, get session() { return session; },
    setYes(f) { yesWith = f; }, reserve, becomeYourself, addServer, pairWithServer, openSession, reconnect, startDirect, callTool, installLine, until, claimServerSpace,
    close() { try { session && session.conn.close(); } catch { /* closed */ } },
  };
}
