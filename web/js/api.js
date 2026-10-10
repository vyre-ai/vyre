// @ts-check
// The one way the Deck reaches vyred: POST /v1/tools/<name> and the SSE stream. Nothing else in
// the Deck calls fetch.
//
// Fixtures. Tools that other workstreams have not merged yet (threads.*, agents.*, onboard.*,
// vault.*, learn.*, gate.*) are answered from web/fixtures/<module>.json, but only when fixtures
// are switched on (?fixtures=1 once, remembered for the tab; ?fixtures=0 turns them off) and only
// when the live tool is missing. Live always wins. With fixtures off, a missing tool is an
// ApiError with missing: true, and the view says which module is not running.
//
// A fixture entry is the tool's data, or one of:
//   { "$by": "<input key>", "cases": { "<value>": data, "*": data } }   chosen by an input field
//   { "$seq": [data, data, ...] }                                         the next one per call, then the last
// and any string "$ago:<n><s|m|h|d>" becomes that long before now, in ms, so fixture times stay fresh.
//
// Resilience (docs/adr/0029-resilience.md) comes from core/resilience, imported as
// ../../core/resilience/*.js: in a browser that is /core/resilience/*.js, which vyred serves
// (core/daemon), and in Node the repo's own files, so there is one copy.

import { follow } from "../../core/resilience/stream.js";
import { open, cursorStore, cacheStore, lifecycle, idbStore } from "../../core/resilience/web.js";
import { outbox } from "../../core/resilience/outbox.js";
import { backoff } from "../../core/resilience/backoff.js";
import { callStart, lagMs } from "./trace.js";

const store = (() => { try { return window.sessionStorage; } catch { return null; } })();
const q = new URLSearchParams(location.search);
if (q.has("fixtures")) { try { store?.setItem("vyre.fixtures", q.get("fixtures") === "0" ? "0" : "1"); } catch {} }
export const fixturesOn = (() => { try { return store?.getItem("vyre.fixtures") === "1"; } catch { return false; } })();

/** Tools answered from fixtures this page load, so the shell can say so. */
export const fromFixtures = new Set();

/** Tools are named for what they do; some live in a module of another name. */
const MODULE = { threads: "switchboard", agents: "switchboard", onboard: "box", gate: "gate", learn: "learn" }; // internal-word: the module id, compared in code and never drawn

export class ApiError extends Error {
  /** @param {string} code @param {string} message @param {string} tool @param {Record<string, any>} [detail] the whole error body vyred sent, for fields beyond code/message (e.g. presence_required's `methods`) */
  constructor(code, message, tool, detail) {
    super(message);
    this.code = code;
    this.tool = tool;
    this.module = MODULE[tool.split(".")[0]] || tool.split(".")[0];
    this.missing = code === "no_such_tool" || code === "offline";
    if (detail) this.detail = detail;
  }
}

/** Whether the box answered the last call or the event stream, for the shell's offline line. */
export let reachable = true;
/** @param {boolean} ok */
function reach(ok) {
  if (ok === reachable) return;
  reachable = ok;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("deck:reach", { detail: ok }));
}

/** Extra headers for every call (the onboarding token). */
const headers = {};
export function setHeader(name, value) { if (value) headers[name] = value; else delete headers[name]; }

/**
 * Call a tool. Resolves to its data; rejects with an ApiError.
 * @param {string} name e.g. "projects.list"
 * @param {Record<string, any>} [input]
 * @param {{ presence?: boolean | "asked", keepalive?: boolean, key?: string, write?: boolean, share?: boolean, ifPresent?: boolean }} [opts] ifPresent: skip the call when the box lists no such tool. share: true lets identical calls in flight at once share one request (the rail, the view and the avatars all read projects.list). presence: true proves a
 *   A tool that needs the person's yes (pairing or widening reach, a vault secret, a send: lib/one-yes.js) answers presence_required with the exact request; the Deck then asks a card (approvals.ask),
 *   shows "approve it in Vyre on your phone" (window event `deck:yes-wait`), waits for the phone's yes and calls again with the approved card (x-vyre-approval). `presence` no longer changes what is
 *   sent first: the box decides what needs a yes. Signing in (presence.person.start) is the one call that still carries a passkey proof. keepalive: the request outlives the page (a
 *   report sent as the app goes to the background). key: the Idempotency-Key this write carries (ADR 0029, R2); write: true makes a fresh one. One key per call, so the retry after a sign-in
 *   and the retry with a card reuse it, and the box runs the write once. Reads carry none: the box keeps every keyed answer for a day, and a read has nothing to repeat.
 */
export async function call(name, input = {}, opts = {}) {
  // `ifPresent`: a tool this box may not have is asked about once (GET /v1/tools) and never called when it is absent, so a missing module is a quiet
  // answer, not a failed request in the console on every page (#56).
  if (opts.ifPresent && !(await hasTool(name))) throw new ApiError("no_such_tool", `your server has no ${name}`, name);
  if (opts.write && !opts.key) opts = { ...opts, key: newKey() };
  // The same read asked for twice at once (the rail, the view and the avatars all want projects.list) is one request: they share its answer.
  // Only a caller that says `share: true` joins one (a read whose answer may be a moment old for the other), and a write clears them all, so a
  // read asked for after a change never gets an answer from before it.
  if (opts.write || opts.key) inflight.clear();
  if (opts.share && !opts.write && !opts.key && !opts.presence && !opts.keepalive) {
    const k = name + "\n" + JSON.stringify(input);
    let p = inflight.get(k);
    if (!p) { p = callOnce(name, input, opts).finally(() => inflight.delete(k)); inflight.set(k, p); }
    return p;
  }
  return callOnce(name, input, opts);
}

/** @type {Map<string, Promise<any>>} */
const inflight = new Map();

/** @type {Promise<Set<string>|null>|null} */
let toolsAsked = null;
/** Whether this box lists the tool. One GET /v1/tools for the page's life; an answer that cannot be read counts as "yes", so a call is still tried. @param {string} name */
export async function hasTool(name) {
  toolsAsked ||= (async () => {
    try {
      const res = await fetch("/v1/tools", { headers: { "x-vyre-caller": "deck", ...headers } });
      const body = await res.json().catch(() => null);
      const list = Array.isArray(body?.data) ? body.data : null;
      return list ? new Set(list.map((/** @type {any} */ t) => String(t?.name ?? t))) : null;
    } catch { return null; }
  })();
  const set = await toolsAsked;
  return !set || set.has(name);
}

/** @param {string} name @param {Record<string, any>} input @param {any} opts */
async function callOnce(name, input, opts) {
  // The person session (tailnet): a box that wants one answers person_session_required. With a
  // handler set (js/person.js, from app.js), it asks the person to sign in on this device, and
  // the call is retried exactly once after that; a refused sign-in rejects as before. No handler:
  // the error goes to the caller, as it always did. presence.person.* never waits on a sign-in,
  // since signing in is one of them.
  try { return await once(name, input, opts); } catch (e) {
    if (!personHandler || /** @type {any} */ (e)?.code !== "person_session_required" || name.startsWith("presence.person.")) throw e;
    await personHandler(/** @type {ApiError} */ (e));
    return once(name, input, opts);
  }
}

/** @type {((e: ApiError) => Promise<unknown>) | null} */
let personHandler = null;
/** Who answers person_session_required: resolve to retry the call once, reject to fail it. null: nobody.
 * @param {((e: ApiError) => Promise<unknown>) | null} fn */
export function setPersonHandler(fn) { personHandler = fn || null; }

/** A fresh Idempotency-Key. crypto.randomUUID needs a secure context; getRandomValues does not.
 * @returns {string} */
export function newKey() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return [...c.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** One call, as call() makes it, without the person-session retry.
 * @param {string} name @param {Record<string, any>} input @param {{ presence?: boolean | "asked", keepalive?: boolean, key?: string }} opts */
async function once(name, input, opts) {
  const key = opts.key ? { "idempotency-key": opts.key } : {};
  // Signing in is authentication, not a yes: the passkey proof is made first, as it always was.
  if (name === "presence.person.start" && opts.presence) return post(name, input, { ...key, "x-vyre-presence": await presenceProof(name, input) });
  try { return await post(name, input, key, opts.keepalive); } catch (e) {
    const d = /** @type {any} */ (e)?.detail;
    if (/** @type {any} */ (e)?.code !== "presence_required" || !d || !d.moment || !d.request) throw e;
    return withYes(name, input, key, d);
  }
}

/** Tools whose yes may be reused for five minutes by this device (lib/one-yes.js REUSE_OPS). */
const REUSE = new Set(["vault.reveal", "vault.copy", "vault.totp"]);
const YES_WAIT_MS = 5 * 60_000;

/**
 * The yes for a moment the box refused: ask a card for exactly the request the box named, confirm it on this computer when it can (Touch ID), else let the person know it waits on their phone, poll until it is answered, and call again with the card.
 * @param {string} name @param {Record<string, any>} input @param {Record<string, string>} key @param {{ moment: string, request: any }} refused
 */
async function withYes(name, input, key, refused) {
  const card = await post("approvals.ask", { moment: refused.moment, request: refused.request, ...(REUSE.has(name) ? { reuse: true } : {}) }, {});
  const id = String(card.id);
  const tell = (/** @type {string} */ state) => { if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("deck:yes-wait", { detail: { id, state, tool: name, line: String(card.line || "") } })); };
  tell("waiting");
  try {
    // On the person's own computer (a Mac), Touch ID gives the yes at once; anywhere else this refuses and the card waits for the phone.
    const here = await post("approvals.local-yes", { id }, {}).catch(() => null);
    if (here && here.answered === "approved") return await post(name, input, { ...key, "x-vyre-approval": id });
    const end = Date.now() + YES_WAIT_MS;
    while (Date.now() < end) {
      await new Promise(r => setTimeout(r, yesPollMs));
      const st = await post("approvals.status", { id }, {});
      if (st.state === "approved") return await post(name, input, { ...key, "x-vyre-approval": id });
      if (st.state !== "waiting") throw new ApiError("presence_required", "That was not approved.", name);
    }
    throw new ApiError("presence_required", "Nobody approved it in time. Ask again.", name);
  } finally { tell("done"); }
}
let yesPollMs = 1500;
/** Test seam: how often a waiting card is looked at. @param {number} ms */
export function setYesPollMs(ms) { yesPollMs = ms; }

/** One POST to a tool, with any presence headers; resolves to the data or rejects with an ApiError.
 * @param {string} name @param {Record<string, any>} input @param {Record<string, string>} extra @param {boolean} [keepalive] */
async function post(name, input, extra, keepalive) {
  const done = callStart(name);
  let res, body;
  try {
    if (lagMs) await new Promise(r => setTimeout(r, lagMs)); // ?trace=1&lag=<ms>: a far-away server, for measuring
    res = await fetch("/v1/tools/" + encodeURIComponent(name), {
      method: "POST", headers: { "content-type": "application/json", "x-vyre-caller": "deck", ...extra, ...headers },
      body: JSON.stringify(input), ...(keepalive ? { keepalive: true } : {}),
    });
    body = await res.json().catch(() => null);
  } catch {
    done(false);
    reach(false);
    return fallback(name, input, new ApiError("offline", "Your server did not answer", name));
  }
  done(!!body && "data" in body && !body.error);
  // The service worker answers a read it kept with offline: true; the box itself was not reached.
  reach(!body?.offline);
  // The box answered while the stream is still backing off (its sockets were cut, the network
  // never went offline): reconnect now, not at the next wait.
  if (!body?.offline && streamState?.state === "reconnecting") kick();
  if (body && "data" in body && !body.error) {
    return body.data;
  }
  const err = new ApiError(body?.error?.code || "http_" + res.status, body?.error?.message || res.statusText, name, body?.error);
  // The one signal for a removed phone: the box's own answer to any contact from a device it no
  // longer knows. Only that exact code on a 4xx; a network error or a 5xx never counts.
  if (err.code === "device_removed" && res.status >= 400 && res.status < 500 && secureOrigin()) for (const fn of [...removedSubs]) { try { fn(); } catch {} }
  if (err.missing || res.status === 404) return fallback(name, input, err);
  throw err;
}

/** The answer is the box's own only over TLS to its address (a valid certificate for the box's name), or on this machine's own loopback: never plain http over a network. */
const secureOrigin = () => { const l = globalThis.location; return !l || l.protocol === "https:" || l.hostname === "localhost" || l.hostname === "127.0.0.1"; };

/** @type {Set<() => void>} */
const removedSubs = new Set();
/** Hear the box say `device_removed` to this phone (js/wipe.js wipes on it). Returns a stop. @param {() => void} fn */
export function onDeviceRemoved(fn) { removedSubs.add(fn); return () => { removedSubs.delete(fn); }; }

// ---- signing in with a passkey (ADR 0004) -----------------------------------------------------
// The one place a passkey is still asked for: presence.person.start. The dance: POST /v1/presence/challenge gets WebAuthn options bound to this tool and
// input (hashed as canonical JSON), navigator.credentials.get asks the person (Touch ID, Face
// ID, a security key), then the tool call itself carries the signed proof as x-vyre-presence.

const b64url = buf => btoa(String.fromCharCode(.../** @type {any} */ (new Uint8Array(buf)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));

/** Can this browser make a passkey proof at all? */
export const canProve = () => typeof window !== "undefined" && !!/** @type {any} */ (window).PublicKeyCredential && !!navigator.credentials;

/**
 * A tool call authenticated by a one-time enrollment code (`vyre presence code`, typed on the
 * box), for `presence.enroll` when adding a first passkey: the normal passkey proof isn't
 * available yet, so a code stands in for it once. Resolves to the data; throws an ApiError.
 * `method` "grant" sends tailnet's one-time enrolment grant instead of a typed code (core/presence: the first owner passkey, rp_id-bound).
 * @param {string} name @param {Record<string, any>} input @param {string} code @param {"code"|"grant"} [method]
 */
export async function callWithCode(name, input, code, method = "code") {
  let res, body;
  try {
    res = await fetch("/v1/tools/" + encodeURIComponent(name), {
      method: "POST", headers: { "content-type": "application/json", "x-vyre-caller": "deck", "x-vyre-presence": `${method} ${method}=${code}` },
      body: JSON.stringify(input),
    });
    body = await res.json().catch(() => null);
  } catch { throw new ApiError("offline", "Your server did not answer", name); }
  if (body && "data" in body && !body.error) return body.data;
  throw new ApiError(body?.error?.code || "http_" + res.status, body?.error?.message || res.statusText, name, body?.error);
}

/** Sign this device out: POST /v1/person/end, which clears the person session cookie. Resolves
 * true when the box said yes; false when it did not (an old box has no such path). */
export async function endPerson() {
  try {
    const res = await fetch("/v1/person/end", { method: "POST", credentials: "same-origin", headers: { "x-vyre-caller": "deck", ...headers } });
    return res.ok;
  } catch { return false; }
}

/**
 * Sign in on this device with a passkey (presence.person.start {}): the box sets the person
 * session cookie. Fires window "deck:person". Call it from a tap. js/person.js wraps it in the
 * sheet; web/person/signin/signin.js calls it directly.
 * @returns {Promise<{ kind: string, id: string, expires: number }>}
 */
export async function signIn() {
  const r = await call("presence.person.start", {}, { presence: true });
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("deck:person", { detail: r || null }));
  return r;
}

/**
 * A one-time sign-in code for another place (the hosted app's hop, or `vyre link signin`'s
 * loopback return): presence.person.start with that input, proved by a passkey bound to it.
 * Resolves to { code, expires, redirect }. web/person/signin/signin.js uses it (team e2e).
 * @param {{ cc?: string, return?: string, label?: string }} opts
 */
export async function personCode(opts = {}) {
  /** @type {Record<string, string>} */
  const input = {};
  for (const k of /** @type {const} */ (["cc", "return", "label"])) if (typeof opts[k] === "string" && opts[k]) input[k] = opts[k];
  return call("presence.person.start", input, { presence: true });
}

/** @param {string} tool @param {Record<string, any>} input @returns {Promise<string>} the x-vyre-presence header value */
async function presenceProof(tool, input) {
  if (!canProve()) throw new ApiError("no_passkey", "This browser cannot use a passkey. Open the Deck in Safari or Chrome over your tailnet.", tool);
  let ch;
  try {
    const res = await fetch("/v1/presence/challenge", { method: "POST", headers: { "content-type": "application/json", "x-vyre-caller": "deck", ...headers },
      body: JSON.stringify({ tool, input, method: "passkey" }) });
    ch = await res.json().catch(() => null);
  } catch { throw new ApiError("offline", "Your server did not answer.", tool); }
  if (!ch || ch.error || !ch.data?.webauthn) throw new ApiError(ch?.error?.code || "denied", ch?.error?.message || "Your server did not offer a passkey challenge.", tool, ch?.error);
  const w = ch.data.webauthn;
  /** @type {any} */ let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: {
      challenge: unb64url(w.challenge), rpId: w.rpId, userVerification: w.userVerification || "required", timeout: w.timeout,
      allowCredentials: (w.allowCredentials || []).map((/** @type {any} */ c) => ({ type: "public-key", id: unb64url(c.id) })),
    } });
  } catch (e) {
    throw new ApiError("cancelled", /** @type {any} */ (e).name === "NotAllowedError" ? "The passkey was cancelled or timed out." : `The passkey did not work: ${/** @type {any} */ (e).message}`, tool);
  }
  if (!cred) throw new ApiError("cancelled", "The passkey was cancelled.", tool);
  const r = cred.response;
  return `passkey id=${ch.data.challenge} cred=${b64url(cred.rawId)} ad=${b64url(r.authenticatorData)} cd=${b64url(r.clientDataJSON)} sig=${b64url(r.signature)}`;
}

// ---- the outbox (ADR 0029, R2): the person's writes survive a lost box ------------------------
// Sends, answers, discards, todos and notes go through queue(): into an outbox kept in IndexedDB,
// with one Idempotency-Key, and delivered in order. The view shows the write as sending at once
// (it awaits queue()). A write the box cannot take yet (offline, restarting, a 5xx) stays in the
// outbox and goes again, with the same key, when the stream is back, the page is in front again or
// the network changes, and at most once a minute otherwise; queue() resolves then. A refusal on
// its merits (a 4xx: already answered, bad input) rejects with the ApiError, as call() does, and
// is never tried again. A write that needs a passkey (presence: true) is never queued: the proof
// is bound to the moment, so it goes now or fails now.

/** The owner's own acts: they go without a proof and ask for one only if the box insists. */
const ASKED = new Set(["threads.answer", "gate.reject"]);
/** This page's writes: the presence each asked for, and who hears that it is waiting. */
const modes = new Map(), waits = new Map();
/** @type {Promise<Awaited<ReturnType<typeof outbox>>> | null} */
let outboxReady = null;

function getOutbox() {
  return outboxReady ??= outbox({
    store: idbStore(BOX),
    call: async (tool, input, key) => {
      try { return { data: await call(tool, input, { key, presence: modes.get(key) ?? (ASKED.has(tool) ? "asked" : undefined) }) }; }
      catch (e) {
        const err = /** @type {any} */ (e);
        // Not now: the box was not reached (post's "offline"), it is restarting (its 503), or
        // something in front of it answered 5xx without a word from the box.
        if (err?.code === "offline" || err?.code === "restarting") return { error: { code: err.code, message: String(err.message || "") } };
        if (/^http_5\d\d$/.test(String(err?.code))) return { error: { code: "unreachable", message: String(err.message || "") } };
        // Anything else is the box's answer on the merits, never tried again: under its own code a
        // tool's "timeout" (a Mac that did not answer) would read as "not now" to the outbox, and a
        // presence_required would park it until someone proves presence.
        return { error: { code: "refused:" + String(err?.code || "failed"), message: String(err?.message || err), apiError: err } };
      }
    },
    onChange: ({ pending }) => {
      for (const e of pending) if (e.state === "waiting" && waits.has(e.key)) { const f = waits.get(e.key); waits.delete(e.key); try { f(); } catch {} }
    },
    newKey,
    backoff: backoff({ min: 60_000 }),
  });
}

/**
 * A write the person makes, through the outbox. Resolves to its data once the box has it;
 * rejects with an ApiError when the box refuses it (never retried).
 * @param {string} name @param {Record<string, any>} [input]
 * @param {{ presence?: boolean | "asked", onWait?: () => void }} [opts] presence false: never a passkey, even
 *   for a tool that asks for one on a refusal (threads.answer); the refusal goes to the caller. onWait: called once if the
 *   first try did not reach the box and the write waits in the outbox, so a view can let the
 *   person go on (the composer takes the next message).
 * @returns {Promise<any>}
 */
export async function queue(name, input = {}, { presence, onWait } = {}) {
  if (presence === true) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw new ApiError("offline", "Your server did not answer", name);
    return call(name, input, { presence: true, write: true });
  }
  const box = await getOutbox();
  const key = newKey();
  if (presence !== undefined) modes.set(key, presence);
  if (onWait) waits.set(key, onWait);
  const { answered } = await box.add(name, input, { key });
  const r = /** @type {any} */ (await answered);
  modes.delete(key); waits.delete(key);
  if (!r.error) return r.data;
  throw r.error.apiError instanceof ApiError ? r.error.apiError : new ApiError(r.error.code, r.error.message, name, r.error);
}

/** queue(), resolving to { data } or { error } like attempt().
 * @param {string} name @param {Record<string, any>} [input] @param {Parameters<typeof queue>[2]} [opts] */
export async function queued(name, input = {}, opts = {}) {
  try { return { data: await queue(name, input, opts) }; } catch (error) { return { error }; }
}

/** Call, but resolve to { data } or { error } so a view can render either without try/catch. */
export async function attempt(name, input = {}, opts = {}) {
  try { return { data: await call(name, input, opts) }; } catch (error) { return { error }; }
}

/**
 * The one byte transfer the Deck makes outside call(): a body PUT to a same-origin ticketed path
 * (e.g. what glass.files.upload returns), with progress. Moved here from the old Glass transfer module
 * so js/api.js stays the only place that talks to vyred.
 * @param {string} path a same-origin ticketed put path
 * @param {Blob} body
 * @param {(sent: number, total: number) => void} [progress]
 * @returns {{ done: Promise<any>, abort: () => void }}
 */
export function upload(path, body, progress) {
  const x = new XMLHttpRequest();
  const done = new Promise((resolve, reject) => {
    if (!path.startsWith("/")) { reject(Object.assign(new Error("the upload path is not on your server"), { code: "bad_path" })); return; }
    x.open("PUT", path);
    x.setRequestHeader("content-type", "application/octet-stream");
    x.setRequestHeader("x-vyre-caller", "deck");
    x.upload.onprogress = e => progress?.(e.loaded, e.lengthComputable ? e.total : body.size);
    x.onload = () => {
      let b = null;
      try { b = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300 && !b?.error) resolve(b?.data ?? b);
      else reject(Object.assign(new Error(b?.error?.message || x.statusText || `your server answered ${x.status}`), { code: b?.error?.code || `http_${x.status}` }));
    };
    x.onerror = () => reject(Object.assign(new Error("the upload did not reach your server"), { code: "offline" }));
    x.onabort = () => reject(Object.assign(new Error("upload cancelled"), { code: "aborted" }));
    x.send(body);
  });
  return { done, abort: () => x.abort() };
}

const fixtureFiles = new Map();
const seqs = new Map();

async function fallback(name, input, err) {
  err.missing = true;
  if (!fixturesOn) throw err;
  const mod = name.split(".")[0];
  if (!fixtureFiles.has(mod)) fixtureFiles.set(mod, fetch(`/fixtures/${mod}.json`).then(r => (r.ok ? r.json() : {})).catch(() => ({})));
  const file = await fixtureFiles.get(mod);
  if (!(name in file)) throw err;
  fromFixtures.add(name);
  window.dispatchEvent(new CustomEvent("deck:fixture", { detail: name }));
  return fresh(structuredClone(pick(name, file[name], input)));
}

const UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
function fresh(v) {
  if (typeof v === "string") { const m = /^\$ago:(\d+)([smhd])$/.exec(v); return m ? Date.now() - Number(m[1]) * UNIT[m[2]] : v; }
  if (Array.isArray(v)) return v.map(fresh);
  if (v && typeof v === "object") { for (const k of Object.keys(v)) v[k] = fresh(v[k]); }
  return v;
}

function pick(name, entry, input) {
  if (entry && typeof entry === "object" && "$by" in entry) {
    const v = input[entry.$by];
    // A case may itself be a $seq (or another $by), so one action can step while others stay put.
    return pick(name, entry.cases[v] ?? entry.cases["*"] ?? null, input);
  }
  if (entry && typeof entry === "object" && "$seq" in entry) {
    const i = seqs.get(name) || 0;
    seqs.set(name, i + 1);
    return entry.$seq[Math.min(i, entry.$seq.length - 1)];
  }
  return entry;
}

/** vyred's module list (GET /v1/modules), or [] when it does not answer. */
export async function modules() {
  try { const r = await fetch("/v1/modules"); const b = await r.json(); return b.data || []; } catch { return []; }
}

// One event stream for the whole Deck, shared by every view (docs/adr/0029-resilience.md, R1, R3).
// core/resilience's follow() holds it: views load their state through tools and then follow
// events, so the first connection starts at the newest event (since=latest); from then on every
// reconnect resumes from the cursor, drops doubles, treats 45 s of silence as a dead stream and
// backs off 2 s to 60 s. lifecycle() closes it while the page is hidden and reconnects at once
// when it is back, online again or restored from the back/forward cache. One path: this page's own
// origin. The cursor is also kept (cursorStore) so the snapshot cache can say what it is current to.
/** @type {ReturnType<typeof follow> | null} */
let stream = null;
/** @type {(() => void) | null} */
let unwire = null;
const subs = new Set();
/** The stream's last state, for the shell's Reconnecting pill (js/reconnect.js). */
/** @type {import("../../core/resilience/stream.js").StreamState | null} */
export let streamState = null;
/** Per box, for the stores: this page's own origin. */
const BOX = (() => { try { return location.host || "deck"; } catch { return "deck"; } })();

/**
 * Listen to vyred's events. type is "thread.text", "thread.*" or "*". Returns an unsubscribe.
 * @param {string} type
 * @param {(e: { id: number, at: number, type: string, source: string, project: string|null, thread: string|null, payload: any }) => void} fn
 */
export function on(type, fn) {
  const sub = { type, fn };
  subs.add(sub);
  // Only in a browser: every one the Deck supports has EventSource, and Node (the tests) does not,
  // so a test that imports a view never opens a stream by accident.
  if (!stream && typeof EventSource !== "undefined") startStream();
  return () => { subs.delete(sub); };
}

/** @type {Set<(why: "reconnect"|"reset", from?: number) => void>} */
const resumeSubs = new Set();
let wasOpen = false;

/**
 * Hear the stream come back after a drop ("reconnect"), or vyred say its log is behind this page's
 * cursor ("reset", with the id it follows from when it says one): reload what may have been
 * missed through tools. Returns an unsubscribe. (The shape chat's session view uses.)
 * @param {(why: "reconnect"|"reset", from?: number) => void} fn
 */
export function onResume(fn) {
  resumeSubs.add(fn);
  return () => { resumeSubs.delete(fn); };
}

/** @param {"reconnect"|"reset"} why @param {number} [from] */
function resumed(why, from) {
  for (const fn of resumeSubs) { try { fn(why, from); } catch (err) { console.error(err); } }
}

function startStream() {
  const cursor = cursorStore(BOX);
  stream = follow({
    paths: [location.origin], open,
    // Short first waits (250 ms, 500 ms, 1 s, then doubling to 60 s): a box back within a few
    // seconds is followed again within one of them (native-core's budget 8: caught up in 1 s).
    backoff: backoff({ min: 250, max: 60_000 }),
    // The onboarding session rides as a header now: fetch can send one, EventSource could not.
    headers: { "x-vyre-caller": "deck", ...headers },
    onEvent: deliver,
    // The box's log is behind this cursor (its store was reset): the views reload through tools.
    onReset: (/** @type {any} */ r) => { resumed("reset", typeof r === "number" ? r : Number(r?.id ?? r?.from) || undefined); if (typeof window !== "undefined") window.dispatchEvent(new Event("deck:navigate")); },
    onState: s => {
      if (s.state === "open") { if (wasOpen) resumed("reconnect"); wasOpen = true; }
      streamState = s;
      // Back: the outbox goes now, not at its next minute.
      if (s.state === "open") { reach(true); void outboxReady?.then(o => o.kick()); }
      else if (s.state === "reconnecting") reach(false);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("deck:stream", { detail: s }));
    },
    save: n => cursor.save(n),
  });
  // A write left in the outbox by the last visit goes as soon as the page is up.
  getOutbox();
  unwire = lifecycle(stream, { outbox: { kick: () => { void outboxReady?.then(o => o.kick()); } } });
}

/**
 * What each view last showed, per box (web.js cacheStore, ADR 0029 R3), so the phone opens from it
 * offline: get(key) is { value, at, cursor } or null; set(key, value) keeps it with the stream's
 * cursor. Lists only (Now's needs, Agents), never transcripts or anything held at the Gate.
 */
export const snapshot = (() => {
  /** @type {ReturnType<typeof cacheStore> | null} */ let s = null;
  const store = () => (s ??= cacheStore(BOX));
  return {
    /** @param {string} key */
    get: key => store().get(key),
    /** @param {string} key @param {any} value */
    set: (key, value) => store().set(key, value, { cursor: stream?.cursor ?? null }),
  };
})();

/** Reconnect now (the pill's Retry): a no-op while the page is hidden or before any view listens. */
export function kick() { stream?.kick(); }

/** Close the stream for good (a test's end; a sign-out). The next on() opens a new one. */
export function stopEvents() { stream?.stop(); unwire?.(); stream = null; unwire = null; }

/** Hand one event to the listeners, as the stream does (tests feed events through it by hand).
 * @param {{ id: number, type: string }} e */
export function hear(e) { deliver(e); }

/** Tell onResume's listeners the stream came back or was reset, as the stream does (tests).
 * @param {"reconnect"|"reset"} why @param {number} [from] */
export function heardResume(why, from) { resumed(why, from); }

/** @param {{ id: number, type: string }} e */
function deliver(e) {
  for (const s of subs) {
    const t = s.type;
    if (t === "*" || t === e.type || (t.endsWith(".*") && e.type.startsWith(t.slice(0, -1)))) {
      try { s.fn(/** @type {any} */ (e)); } catch (err) { console.error(err); }
    }
  }
}
