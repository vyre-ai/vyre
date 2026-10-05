// The real PairingSession: the box's own wink tools behind the one interface the pairing screens already use.
//  - serverSession: this app adds a SERVER or storage device. wink.pair.server with the code the server printed, then wink.pair.status
//    until the three words show; the person says yes AT THE SERVER, so confirm() only waits for `done`.
//  - phoneAnswerSession: this device shows a code for a phone or computer (wink.phone.open); when it asks (wink.phone.pairing) the person
//    types the three words the new device shows and wink.phone.pair.answer checks them. No set of three is offered, so nothing is a pick.
// The box is imported on first use so the pure parts stay runnable in Node.

import type { PairingSession } from "../api/pairing-session";
import type { WinkCode } from "../api/wink-code";
import { added, pairPhase, payloadOf, targetsOf } from "../../screens/devices/real.js";

const box = () => import("./box");
const POLL_MS = 2000;
const BOX_WAIT_MS = 4000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Target = { id: string; kind: "identity" | "space"; label?: string };

export function serverSession(code: Extract<WinkCode, { ok: true }>, target?: Target): PairingSession {
  // A device that has claimed an identity but has no box of its own (the install order: identity first, then the server) pairs the server itself, over the relay.
  let direct: PairingSession | null = null;
  let stopped = false;
  let words: [string, string, string] = ["", "", ""];
  let pairing = "";
  let finished = false;
  /** Poll until the screen has something to do, or the pairing is over. */
  const until = async (want: "words" | "done"): Promise<void> => {
    const { tool } = await box();
    for (;;) {
      if (stopped) throw new Error("rejected");
      const p = pairPhase(await tool("wink.pair.status", { pairing }));
      if (p.phase === "fail") throw new Error(p.say);
      if (p.phase === "done") { finished = true; return; }
      if (p.phase === "words") { words = p.words!; if (want === "words") return; }
      await sleep(POLL_MS);
    }
  };
  return {
    kind: "watch",
    async ready() {
      const { tool, BoxError } = await box();
      if (!direct && code.kind === "ticket" && !(await boxReachable(tool, BoxError))) {
        const mine = await directSessionFor(code);
        if (mine) { direct = mine; await mine.ready!(); return; }
      }
      if (direct) return direct.ready!();
      let t = target;
      if (!t) {
        const first = targetsOf(await tool("wink.pair.targets"))[0];
        if (!first) throw new BoxError("no_target", "There is no identity here to pair to.");
        t = { id: first.id, kind: first.kind, label: first.label };
      }
      // The claimed Vyre name goes with the pairing so a server that has never seen the person can show it once the directory confirms it (windows, 5 Oct). Only a label, never a key.
      const me = await tool<{ exists?: boolean; label?: string }>("spaces.identity.status").catch(() => null);
      const vyre = me?.exists && typeof me.label === "string" && me.label ? me.label : "";
      const r = await tool<{ pairing: string }>("wink.pair.server", { payload: payloadOf(code), target: { id: t.id, kind: t.kind }, kind: "server", ...(vyre ? { owner: { vyre } } : {}) });
      pairing = r.pairing;
      await until("words");
    },
    words: () => (direct ? direct.words() : words),
    choices: () => [],
    answer: async () => false,
    async confirm() { if (direct) return direct.confirm(); if (!finished) await until("done"); },
    reject() { stopped = true; if (direct) direct.reject(); },
  };
}

/** The computer's side of adding a phone: the three words typed from the phone are the answer. */
export function phoneAnswerSession(words: [string, string, string]): PairingSession {
  let over = false;
  return {
    kind: "answer",
    words: () => words,
    choices: () => [],
    async answer(given) {
      const { tool } = await box();
      const ok = added(await tool("wink.phone.pair.answer", { yes: true, words: given.join(" ") }));
      over = true;
      return ok;
    },
    confirm: () => (over ? Promise.resolve() : Promise.reject(new Error("rejected"))),
    reject() { void box().then(({ tool }) => tool("wink.phone.pair.answer", { yes: false })).catch(() => {}); },
  };
}

/** Can this app reach a box of its own right now? Only a success, or a refusal in the box's own words, says there is one; no answer, a page that is not a box, or a failed read says there is none. */
async function boxReachable(tool: (name: string, input?: Record<string, unknown>) => Promise<unknown>, BoxError: new (code: string, message: string) => Error & { code: string }): Promise<boolean> {
  // The box client retries an unreachable box for a long while; a device with no box must not wait on that, so no answer in a few seconds is "no box".
  const gone = Symbol("no answer");
  try { const r = await Promise.race([tool("wink.pair.targets"), new Promise((res) => setTimeout(() => res(gone), BOX_WAIT_MS))]); return r !== gone; } catch (e) {
    return e instanceof BoxError && !["offline", "unreachable", "bad_response", "error", "timeout"].includes(e.code);
  }
}

/**
 * The server pairing for a device with no box: this identity's key signs for it, the relay client pairs, and the three words show here while the person at the server says yes.
 * Null when this device has no identity of its own yet (the caller then falls back to the box's tools and says what is missing).
 */
async function directSessionFor(code: Extract<WinkCode, { ok: true; kind: "ticket" }>): Promise<PairingSession | null> {
  // Loaded when needed: only Metro resolves the relay-client alias, so a Node test that reads the pairing session does not import it.
  const { pairServer } = await import("@vyre/relay-client/serverpair.js");
  const { loadIdentity } = await import("../identity/store");
  const mine = await loadIdentity();
  if (!mine) return null;
  const { relayCrypto, relayKeyStore, about, deviceName, savePairing, loadPairing, presenceKey } = await import("../api/relay");
  // A person who already has a box (a saved pairing) never takes this path, so a slow box cannot make a scan offer their identity to another server (reviewer-3 PD-D). The press on
  // Continue under "Pair this server to <name>?" (the install page) is the person's yes before anything is redeemed.
  if (await loadPairing()) return null;
  const { connect, disconnect } = await import("../api/box");
  // A phone whose Secure Enclave key (iPhone) or Android Keystore key (StrongBox or the TEE) stands behind Face ID or the fingerprint (a software key does not count) answers as hardware; the chain entry's `enclave` is what the server checks it against.
  const { hasKeys, keyStorage, signListChange } = await import("../keys");
  const kind = (await keyStorage()).presence;
  const phoneKeys = (await hasKeys()).presence && (kind === "secure-enclave" || kind === "keystore");
  let words: [string, string, string] = ["", "", ""];
  let wake: () => void = () => {};
  const seen = new Promise<void>((r) => { wake = r; });
  let failed: Error | null = null;
  const abort = new AbortController();
  // The relay client does the pairing (relay/client/serverpair.js): redeem the code, show the words, the person at the server picks the same words, the server records this identity as its owner.
  const run = pairServer({
    // The pin (head and length of this identity's chain) is what a release server checks the proof against; without it a release server refuses (no_pin).
    payload: textOf(code), owner: { id: mine.id, name: plainName(mine.name), vyre: mine.name, pin: mine.pin },
    // the identity's proof is sent in the first adopt call, made from this pairing's own box and device (reviewer-3 PD-B). A phone with its Secure Enclave key adds `esig` over the same
    // message (the ticket tag is in it) behind Face ID: sig and esig come from one signListChange, so Face ID is asked once, and a release server accepts only that pair (PI-1).
    signIdentity: async (m: Uint8Array) => {
      if (!phoneKeys) return { eid: mine.key.eid, sig: toB64u(await mine.key.sign(m)) };
      const { sig, esig } = await signListChange(m, "Pair this server to your Vyre name");
      return { eid: mine.key.eid, sig: toB64u(sig), esig: toB64u(esig) };
    }, name: deviceName(),
    crypto: relayCrypto(), keyStore: relayKeyStore(), about, presenceKey: await presenceKey(), signal: abort.signal,
    // what this device is, honestly: the server records it as the owner's device of this kind and makes its paired session grant at the person's pick (tailnet, wink-rc1)
    deviceKind: phoneKeys ? "phone" : "web", keyStorage: phoneKeys ? "hardware" : "software",
    onWords: (w) => { const p = w.split(" "); if (p.length === 3) { words = [p[0], p[1], p[2]]; wake(); } },
  });
  run.catch((e: Error) => { failed = e; wake(); });
  return {
    kind: "watch",
    async ready() { await seen; if (failed) throw failed; },
    words: () => words,
    choices: () => [],
    answer: async () => false,
    async confirm() {
      const r = await run;
      // paired but the server made no session for this device (pairServer says session:false): say so in a code the install page words (no_session), pairing stays saved
      const noSession = (r as { session?: boolean }).session === false;
      await savePairing({ relay: r.relay, route: r.route, box: r.box, name: r.name, device: r.device, presence: null } as never);
      // The server made this device's one-use grant at the yes: sign in over the channel and keep the token, so the owner's next calls (spaces.create, Now) carry a person session.
      if (noSession) { const { usePeer } = await import("./peer"); usePeer(false); throw Object.assign(new Error("Paired, but this device has no sign-in with the server yet."), { code: "no_session" }); }
      // From now on this device reaches the server over the peer wire (src/real/peer.ts); the paired session is opened first, as the server asks.
      (await import("./peer")).usePeer(true);
      await openPairedSession(r).catch((e: Error) => { throw new Error(`Paired, but this browser could not sign in to the server: ${e.message}`); });
      // The connection made while there was no pairing (the box check) is stale: drop it so the next call goes over the relay to this server.
      await disconnect();
      await connect().catch(() => {});
    },
    reject() { abort.abort(); },
  };
}

/** The long code as the text pairServer reads (vyre://wink/2?t=...&r=...). */
const textOf = (code: Extract<WinkCode, { ok: true; kind: "ticket" }>) => `vyre://wink/2?t=${code.ticket}&r=${encodeURIComponent(code.relay)}`;

/** The name offered to the server: no control or bidi characters (the server cleans it too; this does not rely on that). */
export const plainName = (n: string): string => String(n).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 64);

const toB64u = (b: Uint8Array): string => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };

/**
 * A device with no box of its own was just paired by a typed code: keep the pairing, mark the server as the way it reaches its box, open its paired person session (presence.person.start-paired, signed with
 * the presence key it reported at pairing) and reconnect over the relay, so the next call carries the session.
 */
export async function afterPaired(r: { relay: string; route: string; box: string; device: string; name: string }): Promise<void> {
  const { savePairing } = await import("../api/relay");
  await savePairing({ relay: r.relay, route: r.route, box: r.box, name: r.name, device: r.device, presence: null } as never);
  (await import("./peer")).usePeer(true);
  // A browser the owner has not trusted yet cannot start its session: the pairing stays, the session starts (renewSession) once the owner trusts it, and Devices says so.
  await openPairedSession(r).catch(() => {});
  const { disconnect, connect } = await import("../api/box");
  await disconnect().catch(() => {});
  await connect().catch(() => {});
}

/** After the yes: this device's person session (presence.person.pair-challenge, then start-paired), kept for the box so every request carries it. */
async function openPairedSession(r: { relay: string; route: string; box: string; device: string; name: string }): Promise<void> {
  const { startPaired, channelCall } = await import("../auth/paired");
  const { pairedKey } = await import("../auth/paired-key");
  const { relayCrypto, relayKeyStore, about, deviceName } = await import("../api/relay");
  const ch = await channelCall({ relay: r.relay, route: r.route, box: r.box, name: deviceName() }, { crypto: relayCrypto(), keyStore: relayKeyStore(), about });
  try {
    const key = await pairedKey();
    const s = await startPaired({ device: r.device, call: ch.call, sign: key.sign, signEnclave: key.signEnclave, label: deviceName() });
    await key.keep(r.route, s.token);
  } finally { ch.close(); }
}
