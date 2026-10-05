// @ts-check
// The install flow against the real box: pure mappings from what spaces.* answers to what the screens show, and from the screen's state to
// what spaces.setup.save keeps. No React, no calls: the screen calls the box (src/real/box.ts) and hands the answers here.

import { MIN_NAME, SETUP_STEPS, slug } from "./flow.js";

import { spaceName as spaceNameOf } from "../../src/state/space-name.js";

/** spaces.identity.status: the person's name on this device, or null when none is claimed yet. @param {any} s */
export function identityFrom(s) {
  if (!s || s.exists !== true) return null;
  const label = typeof s.label === "string" && s.label ? s.label : String(s.name ?? "").replace(/\.vyre\.run$/, "");
  return { id: String(s.id ?? ""), label, address: String(s.name ?? `${label}.vyre.run`) };
}

/**
 * Whether a name can be claimed, from the directory's answer to spaces.identity.resolve: a name that resolves is taken, `not_found` is free,
 * anything else (offline, a refusal) is unknown and says so instead of guessing.
 * @param {{ ok: true } | { ok: false, code: string }} answer
 * @returns {"free"|"taken"|"unknown"}
 */
export function nameAnswer(answer) {
  if (answer.ok) return "taken";
  return answer.code === "not_found" ? "free" : "unknown";
}

/**
 * The directory's answer to GET /v1/ids/resolve?name=, as nameAnswer's input: a chain back is a name taken, `not_found` a free one,
 * anything else (a limit, an outage, a body that is not JSON) is unknown. Only the status and code are read; the chain is not trusted here.
 * @param {number} status @param {any} body @returns {{ ok: true } | { ok: false, code: string }}
 */
export function directoryAnswer(status, body) {
  if (status === 200 && body && body.data && typeof body.data === "object") return { ok: /** @type {true} */ (true) };
  const code = body && body.error && typeof body.error.code === "string" ? body.error.code : "unknown";
  return { ok: /** @type {false} */ (false), code: status === 404 && code === "not_found" ? "not_found" : code };
}

/**
 * The state under a name field when the directory decides. `remote` is null while the check has not come back.
 * @param {string} raw @param {"free"|"taken"|"unknown"|null} remote @param {string[]} [also] names this person already holds
 * @returns {{ slug: string, state: "empty"|"short"|"checking"|"taken"|"unknown"|"ok", address: string }}
 */
export function nameStatusReal(raw, remote, also = []) {
  const s = slug(raw);
  const address = s ? `${s}.vyre.run` : "";
  if (!s) return { slug: s, state: "empty", address };
  if (s.length < MIN_NAME) return { slug: s, state: "short", address };
  if (also.map(slug).includes(s)) return { slug: s, state: "taken", address };
  if (remote === null) return { slug: s, state: "checking", address };
  if (remote === "taken") return { slug: s, state: "taken", address };
  if (remote === "unknown") return { slug: s, state: "unknown", address };
  return { slug: s, state: "ok", address };
}

/** The words under the name field for the states the directory adds. @param {ReturnType<typeof nameStatusReal>} st @param {boolean} space */
export function nameNoteReal(st, space) {
  if (st.state === "checking") return "Checking the name.";
  if (st.state === "unknown") return "Cannot check this name right now. Try again.";
  if (st.state === "taken") return `${st.address} is taken.${space ? " People and spaces share names." : ""}`;
  if (st.state === "short") return "Use at least three letters.";
  if (st.state === "ok") return `${st.address} is yours to take.`;
  return "";
}

/** The input of spaces.create. @param {{ slug: string, name: string, where: "server"|"vps"|"here" }} o */
export function createInput(o) {
  const home = o.where === "here" ? { kind: "this-computer", confirmed: true } : { kind: o.where };
  return { name: o.slug, displayName: o.name, home };
}

/**
 * spaces.create or spaces.resume answered: done, or something the person has to see. A step that failed is `failed` with the box's words.
 * @param {any} r
 * @returns {{ state: "done"|"running"|"asking"|"failed", id: string, address: string, say: string }}
 */
export function createdFrom(r) {
  const id = String(r?.spaceId ?? r?.id ?? "");
  const address = String(r?.domain ?? "");
  const st = String(r?.status ?? "");
  if (st === "done") return { state: "done", id, address, say: "" };
  if (st === "failed" || st === "cancelled") return { state: "failed", id, address, say: String(r?.failed?.reason ?? r?.message ?? r?.error ?? "Setting up the space did not finish.") };
  if (st === "needs-input" || st === "asking" || r?.ask) return { state: "asking", id, address, say: String(r?.message ?? r?.ask?.message ?? "The space needs an answer to carry on.") };
  return { state: "running", id, address, say: "" };
}

/**
 * What spaces.setup.save keeps, from the screen's state. No secret, code or key: only these fields.
 * @param {{ step: string, name: string, addr: string | null, look: string, where: string, connectors: string[], kit: string | null, who?: string }} s
 */
export function setupFrom(s) {
  return { step: s.step, name: s.name, address: s.addr, look: s.look, where: s.where, picks: { connectors: s.connectors, kit: s.kit, ...(s.who ? { who: s.who } : {}) } };
}

/** Steps whose arrival is written to the box. */
export const savesAt = (/** @type {string} */ step) => SETUP_STEPS.includes(step);

/**
 * Spaces (spaces.list rows) with setup unfinished, for "Setup in progress on your <device>". `here` is true when this device began it, which the
 * screen knows from the progress it kept itself (the box names the device but the app does not know its own device id).
 * @param {any[]} list @param {string | null} hereSpace the space this device is setting up, if any
 */
export function setupElsewhere(list, hereSpace) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && r.setup && typeof r.setup === "object" && r.id !== hereSpace)
    .map((r) => ({ space: String(r.id), spaceName: spaceNameOf(r), device: String(r.setup.device?.name || "device"), setup: r.setup }));
}

/** What a claimed setup (spaces.setup.claim) puts back on the screen. @param {any} a */
export function applyClaim(a) {
  const s = a?.setup;
  if (!s) return null;
  return {
    space: String(a.space),
    step: String(s.step),
    name: String(s.name ?? ""),
    addr: s.address ? String(s.address).replace(/\.vyre\.run$/, "") : null,
    look: String(s.look ?? "amber"),
    where: s.where === "vps" || s.where === "here" ? s.where : "server",
    connectors: Array.isArray(s.picks?.connectors) ? s.picks.connectors.map(String) : [],
    kit: s.picks?.kit ? String(s.picks.kit) : null,
    who: ["team", "client", "personal"].includes(s.picks?.who) ? String(s.picks.who) : "team",
  };
}

/**
 * spaces.invites.preview, as the invite card shows it. Real answer: { space: "harlow.vyre.run", label: "Harlow Legal", role, role_label,
 * sees: { scope: [], expires }, valid_until, fingerprint, fingerprint_words, button }. The older object form of `space` is read too.
 * @param {any} p @param {string} link
 */
export function inviteFrom(p, link) {
  const sp = p?.space;
  const addr = typeof sp === "string" ? sp : String(sp?.label ?? sp?.name ?? sp?.id ?? "");
  const display = String(p?.label ?? sp?.displayName ?? (typeof sp === "string" ? sp.replace(/\.vyre\.run$/, "") : addr));
  const role = String(p?.role ?? "member");
  const Role = String(p?.role_label ?? role.charAt(0).toUpperCase() + role.slice(1));
  const scope = Array.isArray(p?.sees?.scope) ? p.sees.scope.map(String) : [];
  const until = Number(p?.sees?.expires) || 0;
  const sees = typeof p?.sees === "string" ? p.sees : scope.length ? `${scope.join(", ")}${until ? `, until ${new Date(until).toISOString().slice(0, 10)}` : ""}` : `What the ${Role} role sees in ${display}.`;
  return {
    space: display, address: addr ? (addr.includes(".") ? addr : `${addr}.vyre.run`) : "", from: String(p?.from?.name ?? p?.issuer?.name ?? ""), role: Role, link,
    roleLine: String(p?.role_line ?? ""), sees, status: String(p?.status ?? "pending"), words: String(p?.fingerprint_words ?? ""),
  };
}

/**
 * What the done page says is still pending after the picks (UX-20): a Kit asked for waits for a yes in Now; connectors are never connected by setup, each asks
 * for its own sign-in. Nothing is claimed as done that is not.
 * @param {{ kit: { id: string, label: string } | null, kitResult: { ok: boolean, text: string } | null, connectors: string[] }} o
 * @returns {string[]}
 */
export function pendingLines(o) {
  /** @type {string[]} */ const out = [];
  if (o.kit && o.kitResult?.ok) out.push(`${o.kit.label} is waiting for your yes in Now. Nothing is installed until you approve it.`);
  else if (o.kit) out.push(`${o.kit.label} was not asked for${o.kitResult?.text ? `: ${o.kitResult.text}` : ""}. Install it later from Kits.`);
  if (o.connectors.length) out.push(`Not connected yet: ${o.connectors.join(", ")}. Each one asks for its own sign-in when you set it up.`);
  return out;
}
