// The person session on the phone (ADR 0027 section 3a): the same protocol as person.web.ts
// (person.ts has it), with the key in hardware instead of WebCrypto, which Hermes lacks.
//
//   key     vyre.person, an EC P-256 key in the Android Keystore (StrongBox where present) or
//           the iOS Secure Enclave (modules/vyre-signer); it signs every request's x-vyre-proof
//   human   vyre.human, a second key that signs only with a strong biometric; HUMAN_ONLY calls
//           (person.ts HUMAN_ONLY) also carry `x-vyre-human: t n sig` signed by it, and its public
//           JWK goes to /v1/person/token as `human` beside `key`
//   token   per box, in expo-secure-store (Keychain, Keystore-wrapped prefs)
//   hop     the system's authentication browser (expo-web-browser openAuthSessionAsync); the box
//           returns to RETURN_URL with ?code=, which is traded at once
//
// The native signature is DER; derToP1363 turns it into the raw r||s the box verifies.

import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import * as Keys from "../../modules/vyre-signer";
import {
  derToP1363,
  fromB64url,
  HUMAN_ONLY,
  jwkFromXY,
  memorySlot,
  personSession,
  pkce,
  proofWith,
  toolOf,
  type PersonSession,
  type Signer,
  type Slot,
} from "./person.ts";

/**
 * Where the box sends the person back. The app's own scheme by default; the box today accepts
 * only an https origin in its network.origins (or a loopback /cb/ address), so this is settable
 * until the box and the app agree on the phone's return (an App Link / universal link, or a
 * custom scheme the box allows).
 */
let returnUrl = "vyre://person/signin";

export function configureSignIn(o: { returnUrl?: string }): void {
  if (o.returnUrl) returnUrl = o.returnUrl;
}

/** A sign-in started this recently is not started again on its own, so a failed hop cannot loop. */
const QUIET_MS = 30_000;
/** After the person closes the biometric prompt, the same call does not ask again for this long. */
const DECLINED_MS = 60_000;

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
const slotName = (origin: string) => "vyre.person.token." + origin.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]/g, "_");

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

/**
 * The person session for `box` on this phone. `onSignIn` hears every request for one; the hop
 * runs from here too, and `onSignedIn` hears when it stored a token.
 * @param o.human sign HUMAN_ONLY calls with the biometric key as well (default true)
 */
export function nativePerson(
  box: string,
  onSignIn?: () => void,
  o: { human?: boolean; onSignedIn?: (ok: boolean) => void } = {},
): PersonSession {
  const origin = new URL(box).origin;
  const human = keySigner(Keys.HUMAN, "Confirm it is you");
  const useHuman = o.human !== false;
  /** Calls whose biometric prompt the person closed, by body, with when. */
  const declined = new Map<string, number>();

  // The box checks that the code is traded by the app it was issued to (the Origin of the
  // return). A phone's fetch sends no Origin, so name it when the return is an https address.
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
    stores: { token: secureSlot(slotName(origin)) },
    signer: keySigner(Keys.PERSON),
    nonce,
    fetch: doFetch,
    // The biometric key's public half rides along; a phone with no biometrics signs in without it.
    trade: async () => {
      if (!useHuman) return {};
      try {
        return { human: await human.publicJwk() };
      } catch {
        return {};
      }
    },
    async more(method, url, body): Promise<Record<string, string>> {
      const tool = toolOf(url);
      if (!useHuman || !tool || !HUMAN_ONLY.has(tool)) return {};
      const id = `${tool}\n${body}`;
      const at = declined.get(id);
      if (at && Date.now() - at < DECLINED_MS) return {};
      try {
        return { "x-vyre-human": await proofWith(human.sign, { method, url, body, nonce: nonce() }) };
      } catch (e) {
        // Closed, no biometrics, or a retired key: the call goes without it and the box asks for
        // presence the usual way. Never thrown: a throw here would stall the outbox.
        declined.set(id, Date.now());
        if ((e as { code?: string }).code === "ERR_KEY_INVALIDATED") void Keys.deleteKey(Keys.HUMAN).catch(() => {});
        return {};
      }
    },
    signIn: () => {
      onSignIn?.();
      void (async () => {
        if (!(await startSignIn(origin))) return;
        o.onSignedIn?.(await finishSignIn(origin, session));
      })().catch(() => o.onSignedIn?.(false));
    },
  });
  return session;
}

/** The name person.web.ts uses, so a caller written for either platform reads the same. */
export const webPerson = nativePerson;
