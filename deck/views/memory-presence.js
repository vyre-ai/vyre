// @ts-check
// Proving a person is there from the Deck, with a passkey (docs/adr/0004-presence.md, on the
// security branch). A prototype inside Memory: the deck teammate lifts it into deck/js once a
// second view calls it.
//
//   withPresence(tool, input, { summary, command }) resolves to the tool's data, or rejects.
//
// 1. Call the tool. Anything but `presence_required` is the answer (or the error) as it is.
// 2. When vyred refuses for want of a person and lists `passkey` among its methods, POST
//    /v1/presence/challenge { tool, input, method: "passkey" }. It answers
//    { data: { challenge, webauthn: { challenge, rpId, allowCredentials, userVerification, timeout } } }.
// 3. Show the sheet with the summary. Only a click on Confirm calls navigator.credentials.get,
//    so the browser sees a user gesture.
// 4. Retry the same call, same input (the proof is bound to its hash), with
//    x-vyre-presence: passkey id=<challenge> cred=<id> ad=<authenticatorData> cd=<clientDataJSON> sig=<signature>
//    every value base64url.
//
// It rejects with a PresenceError whose `state` says why: "cancelled" (the person said no, or
// dismissed the passkey prompt; nothing changed), "no_passkey" (none enrolled, or this browser
// cannot make one; the sheet says to enroll in Settings or use the terminal), "expired" or
// "refused" (vyred did not accept the proof; the sheet shows its words). Other errors are
// ApiError-shaped ({ code, message, tool, module, missing }) as api.js's call() rejects with.
//
// This file mirrors api.js's request (POST /v1/tools/<name>, x-vyre-caller: deck) instead of
// importing it, because api.js keeps its headers private and drops the refusal's `methods`. A
// tool vyred does not have still goes through api.js's call(), so fixtures keep working.

import { h } from "../js/dom.js";

// ---- base64url ---------------------------------------------------------------------------------

/** Bytes (ArrayBuffer, a typed array or a DataView) to unpadded base64url. */
export function b64uEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url (or base64, padded or not) to bytes. Throws on anything else. */
export function b64uDecode(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_\-+/]*={0,2}$/.test(s)) throw new Error("not base64url");
  const b = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- the wire ----------------------------------------------------------------------------------

/**
 * vyred's WebAuthn options to what navigator.credentials.get takes: the challenge and each
 * allowed credential id as bytes.
 * @param {{ challenge: string, rpId: string, allowCredentials?: { type?: string, id: string }[], userVerification?: string, timeout?: number }} w
 */
export function publicKeyOptions(w) {
  if (!w || typeof w.challenge !== "string" || typeof w.rpId !== "string") throw new Error("vyred sent no WebAuthn options");
  return {
    challenge: b64uDecode(w.challenge),
    rpId: w.rpId,
    userVerification: w.userVerification || "required",
    ...(w.timeout ? { timeout: w.timeout } : {}),
    allowCredentials: (w.allowCredentials || []).map(c => ({ type: c.type || "public-key", id: b64uDecode(c.id) })),
  };
}

const TOKEN = /^[A-Za-z0-9_-]+$/;

/**
 * The x-vyre-presence header for a passkey assertion, as core/presence/index.js parses it.
 * @param {string} challenge the challenge id vyred returned (not the WebAuthn challenge bytes)
 * @param {{ rawId: ArrayBuffer, response: { authenticatorData: ArrayBuffer, clientDataJSON: ArrayBuffer, signature: ArrayBuffer } }} cred
 */
export function passkeyHeader(challenge, cred) {
  if (!TOKEN.test(String(challenge))) throw new Error("the challenge id is not a token");
  const r = cred && cred.response;
  if (!r || !cred.rawId || !r.authenticatorData || !r.clientDataJSON || !r.signature) throw new Error("the passkey did not return an assertion");
  const f = { id: String(challenge), cred: b64uEncode(cred.rawId), ad: b64uEncode(r.authenticatorData), cd: b64uEncode(r.clientDataJSON), sig: b64uEncode(r.signature) };
  return "passkey " + Object.entries(f).map(([k, v]) => `${k}=${v}`).join(" ");
}

const MODULE = { threads: "switchboard", agents: "switchboard", onboard: "box", gate: "gate", learn: "learning" };

/** An error shaped like api.js's ApiError, so a view handles both alike. */
export class ToolError extends Error {
  /** @param {string} code @param {string} message @param {string} tool @param {string[]} [methods] */
  constructor(code, message, tool, methods) {
    super(message);
    this.code = code;
    this.tool = tool;
    this.module = MODULE[tool.split(".")[0]] || tool.split(".")[0];
    this.missing = code === "no_such_tool" || code === "offline";
    this.methods = methods || [];
  }
}

/** Why a presence flow ended without the tool running. */
export class PresenceError extends Error {
  /** @param {"cancelled"|"no_passkey"|"expired"|"refused"} state @param {string} message @param {string} tool */
  constructor(state, message, tool) {
    super(message);
    this.state = state;
    this.code = "presence_" + state;
    this.tool = tool;
    this.module = MODULE[tool.split(".")[0]] || tool.split(".")[0];
    this.missing = false;
  }
}

/**
 * POST to vyred. Resolves to { data } or { error: { code, message, methods? } }; never throws.
 * @param {typeof fetch} f @param {string} path @param {any} body @param {Record<string, string>} [extra]
 */
async function post(f, path, body, extra = {}) {
  let res, b;
  try {
    res = await f(path, { method: "POST", headers: { "content-type": "application/json", "x-vyre-caller": "deck", ...extra }, body: JSON.stringify(body) });
    b = await res.json().catch(() => null);
  } catch { return { error: { code: "offline", message: "vyred did not answer" } }; }
  if (b && "data" in b && !b.error) return { data: b.data };
  return { error: { code: b?.error?.code || "http_" + res.status, message: b?.error?.message || res.statusText || "", methods: b?.error?.methods } };
}

/** Whether a refusal is about time: the challenge went (2 minutes, or used once already). */
export const isExpired = msg => /expired|no such passkey challenge/i.test(String(msg || ""));

/** A browser that can make a passkey assertion at all. */
const canPasskey = creds => !!creds && typeof creds.get === "function";

// ---- the flow ----------------------------------------------------------------------------------

/**
 * @typedef {{ state: "ask"|"working"|"no_passkey"|"expired"|"refused", summary: string, text?: string, command?: string,
 *   confirm?: () => void, retry?: () => void, cancel: () => void }} SheetView
 * @typedef {{ show: (v: SheetView) => void, close: () => void }} Sheet
 */

/**
 * Call a tool, proving presence with a passkey when vyred asks for it.
 * @param {string} tool
 * @param {Record<string, any>} input
 * @param {{ summary?: string, command?: string, fetch?: typeof fetch, credentials?: any, sheet?: Sheet,
 *   fallback?: (tool: string, input: any) => Promise<any> }} [o]
 *   summary: what the person sees before proving ("Accept lesson … · block · everywhere").
 *   command: the terminal alternative, shown when there is no passkey ("vyre learn accept 7").
 *   fetch, credentials, sheet, fallback: for tests; the browser's own by default.
 */
export async function withPresence(tool, input = {}, o = {}) {
  const f = o.fetch || ((/** @type {any} */ u, /** @type {any} */ init) => fetch(u, init));
  const creds = "credentials" in o ? o.credentials : globalThis.navigator?.credentials;
  const summary = o.summary || `${tool} ${JSON.stringify(input).slice(0, 120)}`;
  const command = o.command || `vyre call ${tool}`;
  const path = "/v1/tools/" + encodeURIComponent(tool);

  const first = await post(f, path, input);
  if (first.data !== undefined) return first.data;
  const e = first.error;
  if (e.code !== "presence_required") {
    // A tool this vyred does not have: api.js answers from fixtures when they are on.
    if (e.code === "no_such_tool" || e.code === "offline") {
      const fb = o.fallback || (async (t, i) => (await import("../js/api.js")).call(t, i));
      return fb(tool, input);
    }
    throw new ToolError(e.code, e.message, tool, e.methods);
  }

  const sheet = o.sheet || presenceSheet();
  const noPasskey = (text) => new Promise((_, reject) => {
    sheet.show({ state: "no_passkey", summary, command, text,
      cancel: () => { sheet.close(); reject(new PresenceError("no_passkey", text || "No passkey is enrolled.", tool)); } });
  });
  const methods = Array.isArray(e.methods) ? e.methods : [];
  if (!methods.includes("passkey")) return noPasskey();
  if (!canPasskey(creds)) return noPasskey("This browser cannot use a passkey.");

  return new Promise((resolve, reject) => {
    let done = false;
    let ch = /** @type {any} */ (null);
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const end = (/** @type {any} */ err, /** @type {any} */ data) => {
      if (done) return;
      done = true;
      try { abort?.abort(); } catch {}
      sheet.close();
      if (err) reject(err); else resolve(data);
    };
    const cancel = (/** @type {"cancelled"|"expired"|"refused"} */ state = "cancelled", msg = "Cancelled. Nothing changed.") => end(new PresenceError(state, msg, tool));
    const fail = (/** @type {"expired"|"refused"} */ state, text) => {
      sheet.show({ state, summary, text, retry: state === "expired" ? start : undefined, cancel: () => cancel(state, text) });
    };

    async function start() {
      sheet.show({ state: "working", summary, text: "Asking vyred for a challenge.", cancel: () => cancel() });
      const c = await post(f, "/v1/presence/challenge", { tool, input, method: "passkey" });
      if (done) return;
      if (c.error) {
        if (/no passkey is enrolled/i.test(c.error.message)) {
          done = true;
          noPasskey().catch(reject);
          return;
        }
        return fail("refused", c.error.message || "vyred would not start a passkey challenge.");
      }
      ch = c.data;
      let opts;
      try { opts = publicKeyOptions(ch && ch.webauthn); } catch (err) { return fail("refused", /** @type {Error} */ (err).message); }
      sheet.show({ state: "ask", summary, confirm: () => confirm(opts), cancel: () => cancel() });
    }

    async function confirm(opts) {
      sheet.show({ state: "working", summary, text: "Waiting for your passkey.", cancel: () => cancel() });
      let cred;
      try {
        // Called straight from the click, before any other await, so the browser sees the gesture.
        cred = await creds.get({ publicKey: opts, ...(abort ? { signal: abort.signal } : {}) });
      } catch (err) {
        // NotAllowedError is both "the person cancelled" and "it timed out"; either way nothing ran.
        const name = /** @type {any} */ (err)?.name;
        if (name === "NotAllowedError" || name === "AbortError") return cancel();
        return fail("refused", String(/** @type {any} */ (err)?.message || err));
      }
      if (done) return;
      if (!cred) return cancel();
      let header;
      try { header = passkeyHeader(ch.challenge, cred); } catch (err) { return fail("refused", /** @type {Error} */ (err).message); }
      sheet.show({ state: "working", summary, text: "Checking.", cancel: () => cancel() });
      const r = await post(f, path, input, { "x-vyre-presence": header });
      if (done) return;
      if (r.data !== undefined) return end(null, r.data);
      if (r.error.code === "presence_required") return fail(isExpired(r.error.message) ? "expired" : "refused", r.error.message);
      end(new ToolError(r.error.code, r.error.message, tool, r.error.methods));
    }

    start().catch(err => end(err));
  });
}

// ---- the sheet ---------------------------------------------------------------------------------

/** This module's stylesheet, added once. */
let styled = false;
function style() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  document.head.append(h("link", { rel: "stylesheet", href: "/css/views/memory-presence.css" }));
}

const TITLE = { ask: "Needs you in person", working: "Needs you in person", no_passkey: "No passkey on this Deck", expired: "That took too long", refused: "Not accepted" };

/**
 * The presence sheet: a dialog centred on a desktop, a sheet from the bottom on a phone. One at a
 * time; show() repaints it for the next state. Escape and the backdrop cancel.
 * @returns {Sheet}
 */
export function presenceSheet() {
  style();
  /** @type {HTMLElement|null} */
  let back = null;
  /** @type {Element|null} */
  let before = null;
  let current = /** @type {SheetView|null} */ (null);
  const onKey = (/** @type {KeyboardEvent} */ e) => { if (e.key === "Escape" && current) { e.preventDefault(); e.stopPropagation(); current.cancel(); } };
  return {
    show(v) {
      current = v;
      if (!back) {
        before = document.activeElement;
        back = h("div", { class: "mp-back", onclick: (/** @type {MouseEvent} */ e) => { if (e.target === back && current) current.cancel(); } });
        document.body.append(back);
        document.addEventListener("keydown", onKey, true);
      }
      const busy = v.state === "working";
      const primary = v.confirm ? h("button", { type: "button", class: "btn btn-primary mp-go", onclick: v.confirm }, "Confirm with passkey")
        : v.retry ? h("button", { type: "button", class: "btn btn-primary mp-go", onclick: v.retry }, "Try again") : null;
      const cancelWord = v.state === "ask" || busy ? "Cancel" : "Close";
      const body = v.state === "no_passkey" ? [
        h("p", { class: "mp-text" }, v.text ? v.text + " " : "", "Enroll a passkey in Settings, then try again. Or do it in a terminal:"),
        h("p", { class: "mp-cmd" }, h("code", null, v.command || ""))]
        : v.state === "ask" ? [h("p", { class: "mp-text muted" }, "Your device will ask for your fingerprint, face or PIN. Nothing changes until it does.")]
        : [h("p", { class: busy ? "mp-text muted" : "mp-text mp-err", role: busy ? "status" : "alert" }, v.text || "")];
      back.replaceChildren(h("div", { class: "mp-sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "mp-title", "data-state": v.state, "aria-busy": String(busy) },
        h("div", { class: "mp-grip", "aria-hidden": "true" }),
        h("div", { class: "mp-head" }, h("span", { class: "dot " + (v.state === "ask" || busy ? "signal" : "beacon"), "aria-hidden": "true" }), h("h2", { class: "lbl", id: "mp-title" }, TITLE[v.state])),
        h("p", { class: "mp-summary" }, v.summary),
        body,
        h("div", { class: "mp-act" }, primary, h("button", { type: "button", class: "btn btn-ghost mp-cancel", onclick: () => v.cancel() }, cancelWord))));
      /** @type {HTMLElement|null} */ (back.querySelector(busy ? ".mp-cancel" : ".mp-go, .mp-cancel"))?.focus();
    },
    close() {
      current = null;
      document.removeEventListener("keydown", onKey, true);
      back?.remove();
      back = null;
      if (before && /** @type {any} */ (before).isConnected) /** @type {HTMLElement} */ (before).focus?.();
      before = null;
    },
  };
}
