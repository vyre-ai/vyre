// @ts-check
// A headless Vyre app: the code the Mac, Windows and phone windows run, driven without a window. Every rule here is the app's own module, imported, not copied:
//   identity           apps/app/src/identity/claim.js (claimIdentity), keys.js (the device key; a software key store here, since there is no keychain on a runner)
//   the first name     site/setup/reserve.js (the page's own answer parser) against the directory's POST /v1/ids/reserve, then claim.js finishes it with the code
//   add a server       apps/app/src/real/add-server.js (createAddServer) with screens/install/first-run.js installLine, and relay/client/setup.js + setupchannel.js
//   pairing            relay/client/serverpair.js pairServer, with the arguments apps/app/src/real/pairing.ts directSessionFor gives it (that function is TypeScript glued to the
//                      phone's modules, so Node cannot import it; its call into pairServer is repeated in pairWithServer below and must be kept in step)
//   a tool call        apps/app/src/auth/paired.ts startPaired over relay/client/client.js connect, as the app's openPairedSession does
// The person's clicks are the only thing replaced: pasting the code, choosing Records, saying the four words match.
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { claimIdentity } from "../../../apps/app/src/identity/claim.js";
import { claimServerSpace } from "../../../apps/app/src/identity/claim-space.js";
import { generateDeviceKey } from "../../../apps/app/src/identity/keys.js";
import { createAddServer } from "../../../apps/app/src/real/add-server.js";
import { withCoreProof } from "../../../apps/app/src/real/core-proof.js";
import { installLine } from "../../../apps/app/screens/install/first-run.js";
import { startPaired } from "../../../apps/app/src/auth/paired.ts";
import { proofWith, devicePresence, keyIdFromXY } from "../../../apps/app/src/auth/person.ts";
import { reserveAnswer, nameOf, looksLikeName } from "../../../site/setup/reserve.js";
import * as setupClient from "../../../relay/client/setup.js";
import { connectSetup } from "../../../relay/client/setupchannel.js";
import { openChannel, request, connect } from "../../../relay/client/client.js";
import { webCrypto } from "../../../relay/client/webcrypto.js";
import { nodeCrypto, fileKeyStore } from "../../../relay/client/nodecrypto.js";
import { utf8 } from "../../../relay/client/bytes.js";
import { pairServer } from "../../../relay/client/serverpair.js";
import { addThisDevice } from "../../../relay/client/phonepair.js";
import { joinWithCode } from "../../../relay/client/join.js";
import { addDeviceCore } from "../../../apps/app/src/identity/add-device-core.js";
import { phoneAsk, added } from "../../../apps/app/screens/devices/real.js";
import * as C from "../../../kernel/identity/chain.js";
import { enrolDevice } from "../../../apps/app/src/identity/enrol-device.js";

const b64u = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("base64url");
const until = async (/** @type {() => any} */ fn, ms = 30_000, what = "the app") => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 40)); } throw new Error(`timed out waiting for ${what}`); };
/** The name offered to the server: no control characters (apps/app/src/real/pairing.ts plainName). */
const plainName = (/** @type {string} */ n) => String(n).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/ {2,}/g, " ").trim().slice(0, 64);

/**
 * @param {{ label: string, dir: string, directory: string, relay: string, stretch?: { memoryKiB: number, passes: number }, about?: { kind: "app" | "web" } }} o
 * `directory` is the names directory's base (a stand-in), `relay` the relay's ws address, `dir` this app's own folder for its relay keys.
 */
export function createApp(o) {
  fs.mkdirSync(o.dir, { recursive: true });
  // what this app says it is at the relay: the Mac and Windows windows are web pages (api/relay.web.ts), the phone apps are native (api/relay.native.ts)
  const about = o.about || { kind: /** @type {const} */ ("web") };
  const stretch = o.stretch || { memoryKiB: 64, passes: 1 };
  /** @type {any} */ let me = null;
  /** @type {any} */ let pairing = null;
  /** @type {any} */ let session = null;
  let lastWords = "";
  const keyStore = fileKeyStore(path.join(o.dir, "relay-device-key.json"));
  const relayCrypto = nodeCrypto();
  // the key this device reports at pairing and signs its session start with (a browser's person key, ES256); software, since a runner has no secure chip
  const personKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const presenceKey = { public_key: personKey.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 };
  // This device's presence key is the key it reported at pairing: the owner's yes enrolled it, and its id is its fingerprint (what the phone's devicePresence does with its biometric key).
  const jwk = personKey.publicKey.export({ format: "jwk" });
  const presence = devicePresence({
    keyId: async () => keyIdFromXY(String(jwk.x), String(jwk.y)),
    sign: async (/** @type {string} */ message) => crypto.sign("sha256", Buffer.from(message), { key: personKey.privateKey }).toString("base64url"),
    nonce: () => crypto.randomBytes(16).toString("base64url"),
  });
  const signPerson = async (/** @type {Uint8Array} */ m) => new Uint8Array(crypto.sign("sha256", Buffer.from(m), { key: personKey.privateKey, dsaEncoding: "ieee-p1363" }));

  /** Step 1, on vyre.run/setup: type a name, get the reservation code. The page's own parser reads the directory's answer. @param {string} text */
  async function reserve(text) {
    const name = nameOf(text);
    if (!looksLikeName(name)) throw new Error(`"${text}" is not a name`);
    const res = await fetch(`${o.directory}/v1/ids/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const body = await res.json().catch(() => null);
    if (!(res.status === 200 && body && body.data && typeof body.data.code === "string")) throw Object.assign(new Error(`the directory answered ${res.status} ${JSON.stringify(body).slice(0, 160)}`), { code: "reserve" });
    // what the setup page does with that answer; kept apart so a page that rejects a code the directory made is its own finding and the walk can go on with the code
    return { name, code: String(body.data.code), expires: Number(body.data.expires) || 0, page: reserveAnswer(res.status, body) };
  }

  /** Step 2, in the app: paste the code; the app makes the identity key here and finishes the claim with it. @param {{ name: string, code: string }} a */
  async function becomeYourself(a) {
    const made = await claimIdentity({ name: a.name, code: a.code, base: o.directory, forceSoftware: true, params: stretch, deviceLabel: o.label });
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
      name: o.label, crypto: relayCrypto, keyStore, presenceKey: await withCoreProof(presenceKey, { pageKey: ctx && ctx.pageKey, name: o.label }), about, pollMs: 100, deviceKind: "computer", keyStorage: "software",
      onWords: w => { words.push(w); lastWords = w; },
    });
    pairing.words = words;
    return pairing;
  }

  /**
   * Pair a server from its own terminal by the typed code it shows (WINK-...): the code runs through the relay, this app shows its ack, the person types the ack at the server (`typedAck`),
   * and the pairing finishes with this identity's proof. The app's call is relay/client/join.js joinWithCode with the server options TypeCode.tsx gives it.
   * @param {{ input: string, typedAck: (ack: string) => Promise<void> }} a
   */
  async function pairByTypedCode(a) {
    if (!me) throw new Error("this app has no identity yet");
    /** @type {any[]} */ const states = [];
    let acked = false;
    const joining = joinWithCode({ relay: o.relay, input: a.input, name: o.label, pollMs: 100, finishPollMs: 100, waitMs: 30_000,
      onState: s => { states.push(s); if (s.state === "ack" && !acked) { acked = true; void a.typedAck(String(s.code)).catch(() => {}); } },
      pairOptions: { crypto: relayCrypto, keyStore, about, presenceKey },
      server: { owner: { id: me.id, name: plainName(me.name), vyre: me.name, pin: me.pin }, signIdentity: async (/** @type {Uint8Array} */ m) => ({ eid: me.key.eid, sig: b64u(await me.key.sign(m)) }), deviceKind: "computer", keyStorage: "software", crypto: relayCrypto, keyStore } });
    const r = /** @type {any} */ (await joining);
    if (!r.ok) throw Object.assign(new Error(`the typed code did not pair: ${r.reason}${r.message ? " (" + r.message + ")" : ""}`), { code: r.code || r.reason });
    pairing = { ...r.paired, owner: r.done && r.done.owner, session: r.done ? r.done.session : undefined, relay: r.paired.relay || o.relay };
    return pairing;
  }

  /** "Add a server": the app makes the install line; the caller runs it; the app finds the server, shows four words, and (once told they match) pairs. @param {{ onChange?: (s: any) => void }} [h] */
  function addServer(h = {}) {
    if (!me) throw new Error("this app has no identity yet");
    const flow = createAddServer({
      client: /** @type {any} */ (setupClient), relay: o.relay,
      identity: async () => ({ id: me.id }),
      connect: async ({ offer, key, secret }) => connectSetup({ openChannel, request, setupHello: setupClient.setupHello, webCrypto, utf8 }, { offer, key, secret }),
      pair: async (qr, ctx) => { await pairWithServer(qr, ctx); },
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

  /** One tool call on the paired server, as this device's signed-in session. @param {string} tool @param {Record<string, unknown>} [input] */
  async function callTool(tool, input = {}) {
    if (!session) await openSession();
    const url = `/v1/tools/${tool}`, body = JSON.stringify(input);
    for (let attempt = 0; attempt < 3; attempt++) {
      // every request carries the token and a proof signed by the same key (apps/app/src/auth/person.ts proofWith), plus this device's presence proof when the call needs a person
      const proof = await proofWith(async m => signPerson(new TextEncoder().encode(m)), { method: "POST", url, body });
      const res = await session.conn.fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Vyre ${session.token}`, "x-vyre-proof": proof, ...(await presence.headers(tool, body)) }, body });
      await presence.keep(res.headers && res.headers.get && res.headers.get("x-vyre-presence-session"));
      const r = /** @type {any} */ (await res.json().catch(() => ({})));
      if (r && r.error) {
        if (presence.answered(tool, body, r)) continue;
        throw Object.assign(new Error(`${tool}: ${r.error.message || r.error.code}`), { code: r.error.code });
      }
      presence.answered(tool, body, r || {});
      return r ? r.data : null;
    }
    throw new Error(`${tool}: the server kept asking for presence`);
  }

  /** The computer's side of "Add a device": show the code (wink.phone.open), and when the new device asks, say yes to the three words it shows. Resolves when the owner has answered. */
  async function showDeviceCode() {
    const opened = await callTool("wink.phone.open", {});
    if (!opened || !opened.qr) throw new Error("the server gave no code for the new device");
    return { qr: String(opened.qr), code: opened.code || null };
  }
  /** Wait for the new device to ask. Resolves what the server said (`raw`) and what the app's own reading of it (screens/devices/real.js phoneAsk) makes of it (`seen`). @param {{ timeoutMs?: number }} [a] */
  async function answerDevice(a = {}) {
    let last = null;
    try {
      const raw = await until(async () => { last = await callTool("wink.phone.pairing", {}); return last && last.asking ? last : null; }, a.timeoutMs || 30_000, "the new device to ask");
      return { raw, seen: phoneAsk(raw) };
    } catch (e) { throw new Error(`${/** @type {Error} */ (e).message}; the server last said ${JSON.stringify(last).slice(0, 200)}`); }
  }
  /** Say yes to the words the new device shows: by typing them (the app's own way, phoneAnswerSession) or, when the server gave sets to pick from, by picking the set that holds them. @param {string[]} words @param {any} [raw] */
  async function sayYes(words, raw) {
    const typed = await callTool("wink.phone.pair.answer", { yes: true, words: words.join(" ") });
    if (added(typed)) return typed;
    const pick = raw && Array.isArray(raw.choices) ? raw.choices.indexOf(words.join(" ")) + 1 : 0;
    if (pick > 0) { const r = await callTool("wink.phone.pair.answer", { yes: true, pick }); if (added(r)) return r; }
    throw new Error("the server did not add the device: " + JSON.stringify(typed).slice(0, 120));
  }

  /**
   * Serve the pending device enrolment: the server could not put the new device's key on the name's list (the key lives in this app), so this app signs the list change, sends it to the directory and tells
   * the server. apps/app/src/real/enrol-phone.ts serveEnrol does this on the phone and the computer; that file is TypeScript on the app's box client, so its steps are repeated here around the app's own
   * enrolDevice (identity/enrol-device.js) and must be kept in step with it. Resolves true when a request was served.
   * @param {{ timeoutMs?: number }} [a]
   */
  async function serveEnrol(a = {}) {
    const ask = /** @type {any} */ (await until(async () => { const r = await callTool("wink.phone.pairing", {}); return r && r.enrol ? r : null; }, a.timeoutMs || 20_000, "the server to ask this app to add the device"));
    const e = ask.enrol;
    const tell = (/** @type {boolean} */ ok, /** @type {string} */ reason, /** @type {any} */ identity) => callTool("wink.phone.enrolled", { device: e.device, ok, ...(reason ? { reason } : {}), ...(identity ? { identity } : {}) });
    try {
      const done = await enrolDevice({ name: me.name, eid: me.key.eid, pin: me.pin, base: o.directory, sign: (/** @type {Uint8Array} */ m) => me.key.sign(m), entry: e.entry });
      me = { ...me, ops: done.ops, pin: done.pin };
      await tell(true, "", { id: me.id, vyre: me.name });
    } catch (err) { await tell(false, String(/** @type {Error} */ (err).message || "The device could not be added to your name."), null); throw err; }
    return true;
  }

  /** This (new, name-less) device joins the name held by another device: the app's addDeviceCore with the relay's phonepair as its pairing. @param {{ payload: string, onWords?: (w: string) => void }} a */
  async function addThisDeviceToName(a) {
    let kept = null;
    return addDeviceCore({
      held: async () => Boolean(me),
      makeKey: async () => (kept = await generateDeviceKey({ forceSoftware: true })),
      pair: async ({ key, onWords }) => addThisDevice({ payload: a.payload, key, name: o.label, crypto: relayCrypto, keyStore, presenceKey, about, pollMs: 100, onWords: w => { if (a.onWords) a.onWords(w); if (onWords) onWords(w); } }),
      readList: async name => {
        const res = await fetch(`${o.directory}/v1/ids/resolve?name=${encodeURIComponent(name)}`, { headers: { accept: "application/json" } });
        const json = await res.json().catch(() => null);
        const ops = json && json.data && Array.isArray(json.data.ops) ? json.data.ops : [];
        try { const st = await C.verifyChain(ops, { now: Date.now() + C.SKEW_MS }); return { ops, id: st.id, eids: st.entries.map((/** @type {any} */ e) => e.eid), pin: C.pinOf(st) }; } catch { return null; }
      },
      save: async i => { me = { ...i, name: i.name, key: kept }; },
      keepPairing: async p => { pairing = { ...p, relay: p.relay }; },
    }, { deviceLabel: o.label, ...(a.onWords ? { onWords: a.onWords } : {}) });
  }

  /**
   * "Join a team": paste the invite, run on the org's server with no server of your own (spec 0.3.0 part 10, 2b). There is no app module for this yet that an identity with no server can use:
   * previewInvite and acceptInvite (apps/app/src/real/install.ts) call spaces.invites.preview and spaces.invites.accept on THIS person's own server, which this person does not have.
   * @param {{ link: string }} a
   */
  async function joinTeam(a) {
    void a;
    throw Object.assign(new Error("no app code joins a team from an identity with no server of its own: the join path (real/install.ts previewInvite/acceptInvite) calls the person's own box, and there is none (spec 0.3.0 part 10, Join a team)"), { code: "not_built" });
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

  return {
    label: o.label, serveEnrol, joinTeam, createTeamSpace, lastWords: () => lastWords, pairByTypedCode, showDeviceCode, answerDevice, sayYes, addThisDeviceToName,
    get identity() { return me; }, get pairing() { return pairing; }, get session() { return session; },
    reserve, becomeYourself, addServer, pairWithServer, openSession, callTool, installLine, until, claimServerSpace,
    close() { try { session && session.conn.close(); } catch { /* closed */ } },
  };
}
