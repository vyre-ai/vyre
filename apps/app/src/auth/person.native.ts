// The person session on the phone (ADR 0027 section 3a): the same protocol as person.web.ts
// (person.ts has it), with the key in hardware instead of WebCrypto, which Hermes lacks.
//
//   key       vyre.person, an EC P-256 key in the Android Keystore (StrongBox where present) or
//             the iOS Secure Enclave (modules/vyre-signer); it signs every request's x-vyre-proof
//             and the token trade itself
//   human     vyre.human, a second key that signs only after a strong biometric. Its public JWK
//             goes to /v1/person/token as `human`; the box enrolls it as a presence key and
//             answers its id (`data.human.key`), kept in the secure store beside the token.
//             HUMAN_ONLY calls carry `x-vyre-presence: device key=<id> ...` signed by it (DER, as
//             the module returns it) and `x-vyre-presence-keep: 1`; the session the box answers
//             with (`x-vyre-presence-session`, read in box.native.ts) covers the SESSIONABLE calls
//             after it for 30 minutes with no prompt (person.ts devicePresence)
//   token     per box, in expo-secure-store (Keychain, Keystore-wrapped prefs)
//   hop       the system's authentication browser (expo-web-browser openAuthSessionAsync); the
//             box returns to vyre://person/signin?code=..., which is traded at once, with no Origin
//
// The request proof is P1363 (derToP1363 converts the module's DER); the presence proof is DER.

import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import * as Keys from "../../modules/vyre-signer";
import {
  derToP1363,
  devicePresence,
  fromB64url,
  jwkFromXY,
  keyIdFromXY,
  memorySlot,
  personSession,
  pkce,
  toolOf,
  type DevicePresence,
  type PersonSession,
  type Signer,
  type Slot,
} from "./person.ts";

/**
 * Where the box sends the person back: presence.person.start with `return=vyre://person/signin`
 * makes a code bound to the native app (no Origin; the trade is signed instead) and redirects to
 * `vyre://person/signin?code=...`. Settable for an https App Link, which the box treats as a web
 * app of that origin (then the trade names that Origin).
 */
export const NATIVE_RETURN = "vyre://person/signin";
let returnUrl = NATIVE_RETURN;

export function configureSignIn(o: { returnUrl?: string }): void {
  if (o.returnUrl) returnUrl = o.returnUrl;
}

/** A sign-in started this recently is not started again on its own, so a failed hop cannot loop. */
const QUIET_MS = 30_000;

const nonce = () => Keys.randomBytes(16);

/** A Signer over one of the module's keys: public half from ensureKey, DER signatures as P1363. */
export function keySigner(alias: Keys.Alias, prompt?: string): Signer {
  return {
    publicJwk: async () => {
      const { x, y } = await Keys.ensureKey(alias);
      return jwkFromXY(x, y);
    },
    sign: async (message) => derToP1363(fromB64url(await Keys.sign(alias, message, prompt ? { prompt } : {}))),
  };
}

/** A Slot in the secure store, or in memory when the store refuses (then the person signs in again next launch). */
function secureSlot(name: string): Slot<string> {
  const mem = memorySlot<string>();
  const opts = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
  return {
    async load() {
      try {
        return (await SecureStore.getItemAsync(name, opts)) ?? (await mem.load());
      } catch {
        return mem.load();
      }
    },
    async save(v) {
      await mem.save(v);
      try {
        if (v === null) await SecureStore.deleteItemAsync(name, opts);
        else await SecureStore.setItemAsync(name, v, opts);
      } catch {}
    },
  };
}

/** Secure-store keys take letters, digits, ".", "-" and "_". */
const slotName = (what: string, origin: string) => `vyre.person.${what}.` + origin.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]/g, "_");

let pending: { box: string; verifier: string; at: number; code: string | null } | null = null;

/** The code in a return URL, or null. */
function codeIn(url: string): string | null {
  const m = /[?&]code=([^&#]*)/.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]) || null;
  } catch {
    return null;
  }
}

/**
 * Open the box's sign-in page in the system's authentication browser. Resolves with the code the
 * box returned, or "" when the person closed the browser or no code came back.
 */
export async function openSignIn(url: string): Promise<string> {
  const r = await WebBrowser.openAuthSessionAsync(url, returnUrl);
  return r.type === "success" ? (codeIn(r.url) ?? "") : "";
}

/**
 * Start the hop to `box` and wait for it to come back. Returns false, without opening, when a hop
 * for this box started in the last 30 s, unless forced; true once the browser has closed.
 */
export async function startSignIn(box: string, o: { force?: boolean } = {}): Promise<boolean> {
  if (!o.force && pending && pending.box === box && Date.now() - pending.at < QUIET_MS) return false;
  const { verifier, challenge } = await pkce(Keys.randomBytes(32));
  pending = { box, verifier, at: Date.now(), code: null };
  const code = await openSignIn(`${box}/person/signin?cc=${challenge}&return=${encodeURIComponent(returnUrl)}`);
  if (pending?.verifier === verifier) pending.code = code || null;
  return true;
}

/** Trade the code the hop brought back. True when a token was stored. */
export async function finishSignIn(box: string, person: PersonSession): Promise<boolean> {
  const p = pending;
  if (!p || p.box !== box || !p.code || !p.verifier) return false;
  const code = p.code;
  p.code = null;
  const r = await person.exchange(code, p.verifier);
  // Keep the timestamp on failure so the next 401 does not bounce straight back to the box.
  pending = r.ok ? null : { ...p, verifier: "" };
  return r.ok;
}

/** The person session with the phone's presence on it (box.native.ts hands it the session header). */
export type NativePerson = PersonSession & { presence: DevicePresence };

/**
 * The person session for `box` on this phone. `onSignIn` hears every request for one; the hop
 * runs from here too, and `onSignedIn` hears when it stored a token.
 * @param o.human enroll the biometric key at sign-in and prove HUMAN_ONLY calls with it (default true)
 */
export function nativePerson(
  box: string,
  onSignIn?: () => void,
  o: { human?: boolean; onSignedIn?: (ok: boolean) => void; path?: () => string } = {},
): NativePerson {
  const origin = new URL(box).origin;
  const human = keySigner(Keys.HUMAN);
  const useHuman = o.human !== false;
  /** The biometric key's presence key id on this box. */
  const humanKey = secureSlot(slotName("human", origin));

  const presence = devicePresence({
    keyId: () => humanKey.load(),
    sign: (message, tool) => Keys.sign(Keys.HUMAN, message, { prompt: `Confirm ${tool} on your box` }),
    nonce: () => Keys.randomBytes(16),
    store: secureSlot(slotName("presence", origin)),
    path: o.path,
    failed: (e) => {
      // The enrolled biometrics changed: the key is gone for good. A new one is made and enrolled
      // at the next sign-in; until then the box asks for its passkey.
      if ((e as { code?: string }).code !== "ERR_KEY_INVALIDATED") return;
      void Keys.deleteKey(Keys.HUMAN).catch(() => {});
      void humanKey.save(null);
    },
    lost: () => void humanKey.save(null),
  });

  // The native code sends no Origin (the box refuses one on it). An https App Link return is a
  // web app to the box, traded under that origin, so name it there.
  const doFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/^https:\/\//.test(returnUrl) && /\/v1\/person\/token$/.test(url)) {
      const headers = { ...(init?.headers as Record<string, string> | undefined), origin: new URL(returnUrl).origin };
      return fetch(input, { ...init, headers });
    }
    return fetch(input, init);
  };

  const session: PersonSession = personSession({
    box: origin,
    stores: { token: secureSlot(slotName("token", origin)) },
    signer: keySigner(Keys.PERSON),
    nonce,
    fetch: doFetch,
    signTrade: true,
    // The biometric key's public half rides along; a phone with no biometrics signs in without it.
    trade: async () => {
      if (!useHuman) return {};
      try {
        return { human: await human.publicJwk() };
      } catch {
        return {};
      }
    },
    async traded(data) {
      const h = data.human as { key?: unknown; error?: unknown } | undefined;
      if (!h || typeof h !== "object") return;
      if (typeof h.key === "string" && h.key) return humanKey.save(h.key);
      // Signed in again with the same key: the box has it already, under its fingerprint.
      if (typeof h.error === "string" && /already enrolled/.test(h.error)) {
        const { x, y } = await Keys.ensureKey(Keys.HUMAN);
        await humanKey.save(keyIdFromXY(x, y));
      }
    },
    async more(method, url, body): Promise<Record<string, string>> {
      const tool = toolOf(url);
      if (!useHuman || method !== "POST" || !tool) return {};
      return presence.headers(tool, body);
    },
    answered(method, url, body, r) {
      const tool = toolOf(url);
      return useHuman && method === "POST" && tool ? presence.answered(tool, body, r) : false;
    },
    signIn: () => {
      onSignIn?.();
      void (async () => {
        if (!(await startSignIn(origin))) return;
        o.onSignedIn?.(await finishSignIn(origin, session));
      })().catch(() => o.onSignedIn?.(false));
    },
  });
  return {
    ...session,
    presence,
    async end() {
      await presence.forget();
      await session.end();
    },
  };
}

/** The name person.web.ts uses, so a caller written for either platform reads the same. */
export const webPerson = nativePerson;
