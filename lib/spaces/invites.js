// @ts-check
// lib/spaces/invites.js: join links for a Space, signed by the Space's root key. Pure library with injected
// signer, clock, randomness, invite store, event emitter and the Space's membership service.
// Source: team/0.3/DESIGN-spaces-first.md sections 1b and 4 (join link `https://harlow.vyre.run/join/<token>`).
//
// Token   = base64url(compact JSON payload) + "." + base64url(Ed25519 signature)
// Signed  = "vyre-invite-v1\n" + <the payload base64url text>   (domain separated; the exact transmitted bytes)
// Payload = { v:1, id, space (vyre name), sid (space id), role, scope?, expires? (temp end), uses, iat, ttl }
// Accept  = the joiner signs "vyre-invite-accept-v1\n<inviteId>\n<spaceName>\n<personId>" with their person key.

import { createPublicKey, verify as edVerify } from "node:crypto";
import { randomBytes } from "node:crypto";
import { ROLE_IDS } from "../../kernel/contracts/index.js";
import {
  SpacesError, DEFAULT_POLICY, canAssign, abilitiesOf, isExpired, isValidScopeEntry, urnWithin, validateGrant, systemActor,
} from "./members.js";

/** @typedef {import("../../kernel/contracts/roles.js").RoleId} RoleId */

export const INVITE_TAG = "vyre-invite-v1";
export const ACCEPT_TAG = "vyre-invite-accept-v1";
const DAY = 24 * 60 * 60 * 1000;
export const INVITE_DEFAULTS = Object.freeze({ ttl: 7 * DAY, maxTtl: 30 * DAY, maxUses: 100, skewMs: 5 * 60 * 1000 });
const MAX_TOKEN = 4096;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vyre\.run$/;

/** @param {string} code @param {string} message @returns {never} */
const fail = (code, message) => { throw new SpacesError(code, message); };

const b64u = (/** @type {Uint8Array | Buffer | string} */ x) => Buffer.from(x).toString("base64url");
const B64U_RE = /^[A-Za-z0-9_-]+$/;
const fromB64u = (/** @type {string} */ s) => { if (typeof s !== "string" || !B64U_RE.test(s)) throw new Error("bad base64url"); return Buffer.from(s, "base64url"); };

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** Accept a raw 32-byte Ed25519 key or an SPKI DER key, as bytes, a Buffer, or base64url text. */
function ed25519Key(/** @type {any} */ k) {
  let buf = typeof k === "string" ? fromB64u(k) : Buffer.from(k);
  if (buf.length === 32) buf = Buffer.concat([SPKI_ED25519_PREFIX, buf]);
  return createPublicKey({ key: buf, format: "der", type: "spki" });
}
function edCheck(/** @type {any} */ publicKey, /** @type {Buffer | string} */ data, /** @type {string} */ sigB64u) {
  try {
    const sig = fromB64u(sigB64u);
    if (sig.length !== 64) return false;
    return edVerify(null, Buffer.from(data), ed25519Key(publicKey), sig);
  } catch { return false; }
}

const bytesToSign = (/** @type {string} */ payloadB64) => Buffer.from(`${INVITE_TAG}\n${payloadB64}`);
export const acceptMessage = (/** @type {string} */ id, /** @type {string} */ spaceName, /** @type {string} */ personId) =>
  Buffer.from(`${ACCEPT_TAG}\n${id}\n${spaceName}\n${personId}`);

/** @param {string} token @returns {{ payload: any, payloadB64: string, sig: string } | null} */
function splitToken(token) {
  if (typeof token !== "string" || token.length > MAX_TOKEN || token.length < 10) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !B64U_RE.test(parts[0]) || !B64U_RE.test(parts[1])) return null;
  try {
    const payload = JSON.parse(fromB64u(parts[0]).toString("utf8"));
    return payload && typeof payload === "object" ? { payload, payloadB64: parts[0], sig: parts[1] } : null;
  } catch { return null; }
}

/** Strict payload shape. */
function payloadOk(/** @type {any} */ p) {
  if (!p || p.v !== 1) return false;
  if (typeof p.id !== "string" || !/^inv_[A-Za-z0-9_-]{8,64}$/.test(p.id)) return false;
  if (typeof p.space !== "string" || !NAME_RE.test(p.space)) return false;
  if (typeof p.sid !== "string" || !p.sid) return false;
  if (!ROLE_IDS.includes(p.role) || p.role === "owner") return false;
  if (!Number.isInteger(p.uses) || p.uses < 1 || p.uses > INVITE_DEFAULTS.maxUses) return false;
  if (!Number.isFinite(p.iat) || !Number.isFinite(p.ttl) || p.ttl <= 0) return false;
  if (p.scope !== undefined && !(Array.isArray(p.scope) && p.scope.length > 0 && p.scope.every(isValidScopeEntry))) return false;
  if (p.expires !== undefined && !Number.isFinite(p.expires)) return false;
  if (p.to !== undefined && !/^per_[a-z2-7]{26}$/.test(p.to)) return false;
  // The space's list as the inviter saw it (its identity id, the position and the hash of its last op) and a fingerprint of its root key: the joiner starts PINNED.
  if (p.chain !== undefined && !(p.chain && /^spc_[a-z2-7]{26}$/.test(p.chain.id) && Number.isInteger(p.chain.seq) && p.chain.seq >= 0 && /^[0-9a-f]{64}$/.test(p.chain.head))) return false;
  if (p.rk !== undefined && !/^[0-9a-f]{32}$/.test(p.rk)) return false;
  return true;
}

/** Whether `creator` may create an invite for this role and scope. Throws a typed error if not. */
export function authorizeInvite(/** @type {any} */ creator, /** @type {any} */ inv, /** @type {number} */ now,
  /** @type {{ managersInvite?: boolean, projectsOf?: (person: string) => readonly string[] | Promise<readonly string[]> }} */ opts = {}) {
  return (async () => {
    if (!creator || abilitiesOf(creator, now).length === 0) fail("forbidden", "You are not an active member of this space.");
    if (!ROLE_IDS.includes(inv.role)) fail("bad_input", "Unknown role.");
    if (inv.role === "owner") fail("forbidden", "An owner is never invited by link. An owner adds another owner with their approval on their device.");
    if (creator.role === "owner") return;
    if (creator.role === "admin") {
      if (!canAssign("admin", inv.role)) fail("forbidden", "Only an owner can invite an admin.");
      return;
    }
    if (creator.role === "manager") {
      if (!opts.managersInvite) fail("forbidden", "This space does not let managers invite people.");
      if (inv.role !== "member" && inv.role !== "temp") fail("forbidden", "A manager can invite members and temp guests only.");
      const mine = (opts.projectsOf ? await opts.projectsOf(creator.person) : []) || [];
      const sc = inv.scope || [];
      if (sc.length === 0) fail("forbidden", "A manager's invite must name projects the manager runs.");
      if (!sc.every((/** @type {string} */ s) => mine.some(p => urnWithin(s, p)))) fail("forbidden", "A manager can invite people only into their own projects.");
      return;
    }
    fail("forbidden", "Your role cannot invite people.");
  })();
}

/** In-memory invite store. `update(id, fn)` runs `fn` on the stored record exclusively and stores its result:
 *  a persistent store must give the same guarantee (one writer at a time per id, e.g. a transaction). */
export function memoryInviteStore() {
  /** @type {Map<string, any>} */
  const m = new Map();
  const copy = (/** @type {any} */ r) => (r ? structuredClone(r) : undefined);
  return {
    get(/** @type {string} */ id) { return copy(m.get(id)); },
    put(/** @type {any} */ rec) { m.set(rec.id, structuredClone(rec)); },
    list() { return [...m.values()].map(copy); },
    /** @param {string} id @param {(rec: any) => any} fn */
    update(id, fn) {
      const cur = m.get(id);
      if (!cur) return undefined;
      const next = fn(structuredClone(cur));
      m.set(id, structuredClone(next));
      return copy(next);
    },
  };
}

/** Only these hosts make a join link: `<label>.vyre.run`, or an own-domain alias the caller lists. Rejects anything else. */
export function parseJoinLink(/** @type {string} */ link, /** @type {{ aliases?: string[] | Record<string, string> }} */ opts = {}) {
  let u;
  try { u = new URL(String(link)); } catch { fail("bad_input", "That is not a link."); }
  if (u.protocol !== "https:") fail("bad_input", "A join link must start with https.");
  if (u.username || u.password) fail("bad_input", "A join link never carries a login.");
  if (u.port) fail("bad_input", "A join link does not use a port.");
  if (u.search || u.hash) fail("bad_input", "A join link has nothing after the path.");
  const host = u.hostname.toLowerCase();
  const aliases = opts.aliases || [];
  const aliasMap = Array.isArray(aliases) ? Object.fromEntries(aliases.map(a => [String(a).toLowerCase(), undefined])) : Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k.toLowerCase(), v]));
  const isAlias = Object.prototype.hasOwnProperty.call(aliasMap, host);
  if (!isAlias && !NAME_RE.test(host)) fail("bad_input", "That address is not a Vyre space.");
  const m = /^\/join\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(u.pathname);
  if (!m || m[1].length > MAX_TOKEN) fail("bad_input", "That is not a join link.");
  return { host, name: isAlias ? aliasMap[host] : host, alias: isAlias, token: m[1] };
}

const WORDS = Object.freeze({
  forged: "This invite could not be verified. Ask for a new one.",
  wrong_space: "This invite is for a different space than the one it points to.",
  expired: "This invite has expired. Ask for a new one.",
  revoked: "This invite was cancelled. Ask for a new one.",
  used_up: "This invite has already been used. Ask for a new one.",
  bad_input: "That is not a valid invite.",
});
const err = (/** @type {keyof typeof WORDS} */ code) => ({ ok: /** @type {const} */ (false), code, message: WORDS[code] });

/**
 * What a person sees BEFORE joining. Verifies the signature against the root key pinned for that space name.
 * Returns `{ ok: true, card }` or `{ ok: false, code, message }`; the card holds nothing beyond space, role, what they will see and the button.
 * @param {string} token
 * @param {{
 *   resolveSpace: (name: string) => any,
 *   now?: number,
 *   expectName?: string,
 *   store?: { get(id: string): any },
 * }} o
 */
export async function previewInvite(token, o) {
  const now = typeof o.now === "number" ? o.now : Date.now();
  const sp = splitToken(token);
  if (!sp || !payloadOk(sp.payload)) return err("bad_input");
  const p = sp.payload;
  if (o.expectName && o.expectName.toLowerCase() !== p.space) return err("wrong_space");
  let ident;
  try { ident = await o.resolveSpace(p.space); } catch { ident = null; }
  if (!ident || ident.name !== p.space || ident.id !== p.sid) return err("wrong_space");
  // The link carries the fingerprint of the space's root key as the inviter saw it: a different key under the same name is a forgery.
  if (p.rk && ident.rk !== p.rk) return err("forged");
  const pub = ident.root_public_key || ident.root_key;
  if (!pub || !edCheck(pub, bytesToSign(sp.payloadB64), sp.sig)) return err("forged");
  const until = p.iat + p.ttl;
  if (now >= until || (p.expires !== undefined && p.expires <= now)) return err("expired");
  if (p.iat > now + INVITE_DEFAULTS.skewMs) return err("forged");
  if (o.store) {
    const rec = await o.store.get(p.id);
    if (rec && rec.status === "revoked") return err("revoked");
    if (rec && (rec.status === "used" || rec.used >= rec.uses)) return err("used_up");
  }
  const label = ident.label || p.space.replace(/\.vyre\.run$/, "");
  const roleLabel = (ident.displayNames && ident.displayNames[p.role]) || p.role[0].toUpperCase() + p.role.slice(1);
  return {
    ok: /** @type {const} */ (true),
    card: Object.freeze({
      space: p.space,
      label,
      role: p.role,
      role_label: roleLabel,
      sees: Object.freeze({ scope: Object.freeze(p.scope ? [...p.scope] : []), expires: p.expires ?? null }),
      valid_until: until,
      fingerprint: p.rk ?? null,
      button: `Join ${label}`,
    }),
  };
}

/**
 * The invite service for one Space (the home side).
 * @param {{
 *   space: { id: string, name: string, aliases?: readonly string[] },
 *   signer: { keyId?: string, publicKey: any, sign: (bytes: Buffer) => Promise<Uint8Array | Buffer> | Uint8Array | Buffer },
 *   members: ReturnType<typeof import("./members.js").createMembers>,
 *   store: ReturnType<typeof memoryInviteStore>,
 *   now: () => number,
 *   random?: (n: number) => Uint8Array | Buffer,
 *   emit?: (type: string, payload: Record<string, any>) => any,
 *   policy?: { managersInvite?: boolean, maxTempMs?: number, maxTtl?: number },
 *   projectsOf?: (person: string) => readonly string[] | Promise<readonly string[]>,
 *   personIdFromKey?: (publicKey: any) => string,
 *   verifyPersonProof?: (person: any, message: Buffer, proof: string) => boolean | Promise<boolean>,
 * }} deps
 * A person joins as an IDENTITY: `person` is `{ id, publicKey }` for a bare key, or `{ id, ops, by }` for an identity chain, whose acceptance
 * is checked by `verifyPersonProof` (any current device or code entry on the list may sign). An invite made `to` an identity only that id may accept.
 */
export function createInvites(deps) {
  const { space, signer, members, store, now } = deps;
  if (!space || !signer || !members || !store || typeof now !== "function") fail("bad_input", "createInvites needs a space, a signer, members, a store and a clock.");
  const random = deps.random || ((/** @type {number} */ n) => randomBytes(n));
  const emit = deps.emit || (() => {});
  const policy = { ...DEFAULT_POLICY, ...members.policy, ...(deps.policy || {}) };
  const maxTtl = deps.policy?.maxTtl ?? INVITE_DEFAULTS.maxTtl;
  const aliases = (space.aliases || []).map(a => a.toLowerCase());

  let chain = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const locked = fn => { const r = chain.then(fn); chain = r.then(() => {}, () => {}); return r; };

  const pub = (/** @type {any} */ r) => {
    const { status, ...rest } = r;
    return { ...rest, status: effectiveStatus(r, now()) };
  };
  function effectiveStatus(/** @type {any} */ r, /** @type {number} */ t) {
    if (r.status === "revoked" || r.status === "used") return r.status;
    if (r.status === "expired" || t >= r.iat + r.ttl || (r.expires !== undefined && r.expires <= t)) return "expired";
    return "active";
  }

  /** @param {{ creator: any, role: RoleId, scope?: string[], expires?: number, uses?: number, ttl?: number, alias?: string, to?: string, chain?: { id: string, seq: number, head: string }, rk?: string }} a */
  async function createInvite(a) {
    const t = now();
    const creator = typeof a.creator === "string" ? await members.get(a.creator) : a.creator;
    if (!creator) fail("not_a_member", "That person is not a member of this space.");
    // Re-read the stored record so a stale copy cannot carry authority.
    const live = await members.get(creator.person);
    if (!live) fail("not_a_member", "That person is not a member of this space.");
    const role = a.role;
    if (!ROLE_IDS.includes(role)) fail("bad_input", "Unknown role.");
    const uses = a.uses === undefined ? 1 : a.uses;
    if (!Number.isInteger(uses) || uses < 1 || uses > INVITE_DEFAULTS.maxUses) fail("bad_input", `An invite can be used 1 to ${INVITE_DEFAULTS.maxUses} times.`);
    const ttl = a.ttl === undefined ? INVITE_DEFAULTS.ttl : a.ttl;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > maxTtl) fail("bad_input", "The link lifetime is out of range for this space.");
    await authorizeInvite(live, { role, scope: a.scope }, t, { managersInvite: policy.managersInvite, projectsOf: deps.projectsOf });
    if (role === "temp") {
      validateGrant("temp", a.scope, a.expires, t, /** @type {any} */ (policy));
    } else {
      if (a.expires !== undefined && a.expires !== null) fail("bad_scope", "Only a temp invite has an end date.");
      const sc = a.scope;
      const hasScope = Array.isArray(sc) && sc.length > 0;
      if (sc !== undefined && sc !== null && !Array.isArray(sc)) fail("bad_scope", "Projects must be a list.");
      if (hasScope && (role !== "member" || !sc.every(isValidScopeEntry))) fail("bad_scope", "Only a temp or member invite names projects.");
    }
    let host = space.name;
    if (a.alias !== undefined) {
      if (!aliases.includes(String(a.alias).toLowerCase())) fail("bad_input", "That address is not an alias of this space.");
      host = String(a.alias).toLowerCase();
    }
    if (a.to !== undefined && !/^per_[a-z2-7]{26}$/.test(String(a.to))) fail("bad_input", "An invite goes to a person's id.");
    const id = `inv_${b64u(random(12))}`;
    /** @type {any} */
    const payload = { v: 1, id, space: space.name, sid: space.id, role };
    if (a.scope && a.scope.length) payload.scope = [...new Set(a.scope)];
    if (role === "temp") payload.expires = a.expires;
    if (a.to) payload.to = a.to;
    if (a.chain) payload.chain = { id: a.chain.id, seq: a.chain.seq, head: a.chain.head };
    if (a.rk) payload.rk = a.rk;
    if ((a.chain && !payloadOk({ v: 1, id: "inv_aaaaaaaa", space: space.name, sid: space.id, role: "member", uses: 1, iat: 1, ttl: 1, chain: payload.chain })) || (a.rk && !/^[0-9a-f]{32}$/.test(a.rk))) fail("bad_input", "The space's list position or key fingerprint is malformed.");
    payload.uses = uses; payload.iat = t; payload.ttl = ttl;
    const payloadB64 = b64u(JSON.stringify(payload));
    const sig = b64u(await signer.sign(bytesToSign(payloadB64)));
    const token = `${payloadB64}.${sig}`;
    await store.put({
      id, space: space.name, sid: space.id, role, scope: payload.scope, expires: payload.expires, uses, used: 0,
      iat: t, ttl, created_by: live.person, created_by_role: live.role, status: "active", accepted_by: [],
    });
    await emit("invite.created", { space: space.id, invite: id, role, by: live.person, at: t, uses, ...(payload.expires ? { expires: payload.expires } : {}) });
    return { id, token, link: `https://${host}/join/${token}` };
  }

  /** @param {{ token: string, person: { id: string, publicKey?: any, ops?: any[], by?: string }, proof: string, now?: number }} a */
  async function acceptInvite(a) {
    const t = typeof a.now === "number" ? a.now : now();
    const sp = splitToken(a.token);
    if (!sp || !payloadOk(sp.payload)) fail("bad_input", WORDS.bad_input);
    const p = sp.payload;
    if (p.space !== space.name || p.sid !== space.id) fail("wrong_space", WORDS.wrong_space);
    if (!edCheck(signer.publicKey, bytesToSign(sp.payloadB64), sp.sig)) fail("forged", WORDS.forged);
    if (p.iat > t + INVITE_DEFAULTS.skewMs) fail("forged", WORDS.forged);
    if (t >= p.iat + p.ttl || (p.expires !== undefined && p.expires <= t)) fail("expired", WORDS.expired);
    const person = a.person;
    if (!person || typeof person.id !== "string" || !person.id || !(person.publicKey || person.ops)) fail("bad_input", "Say who is joining.");
    if (p.to && p.to !== person.id) fail("forbidden", "This invite was made for someone else.");
    if (person.ops) {
      if (!deps.verifyPersonProof || typeof a.proof !== "string" || !await deps.verifyPersonProof(person, acceptMessage(p.id, p.space, person.id), a.proof)) fail("bad_proof", "Your device's proof did not check out. Open the link again on your device.");
    } else {
      if (deps.personIdFromKey && deps.personIdFromKey(person.publicKey) !== person.id) fail("bad_proof", "That key does not belong to that person.");
      if (typeof a.proof !== "string" || !edCheck(person.publicKey, acceptMessage(p.id, p.space, person.id), a.proof)) fail("bad_proof", "Your device's proof did not check out. Open the link again on your device.");
    }

    return locked(async () => {
      const rec = await store.get(p.id);
      if (!rec) fail("revoked", WORDS.revoked);
      if (rec.status === "revoked") fail("revoked", WORDS.revoked);
      if (rec.status === "used" || rec.used >= rec.uses) fail("used_up", WORDS.used_up);
      if (rec.status === "expired") fail("expired", WORDS.expired);
      // The creator must still hold the authority they used.
      const creator = await members.get(rec.created_by);
      try {
        if (!creator) throw new SpacesError("forbidden", "gone");
        await authorizeInvite(creator, { role: rec.role, scope: rec.scope }, t, { managersInvite: policy.managersInvite, projectsOf: deps.projectsOf });
      } catch (e) {
        if (e instanceof SpacesError && e.code === "forbidden") fail("revoked", WORDS.revoked);
        throw e;
      }
      const existing = await members.get(person.id);
      if (existing && !isExpired(existing, t)) fail("duplicate", "You are already a member of this space.");
      // Consume the use first (atomic in the store), so a replay or a race loses.
      const consumed = await store.update(p.id, (/** @type {any} */ r) => {
        if (r.status !== "active" || r.used >= r.uses) throw new SpacesError("used_up", WORDS.used_up);
        r.used += 1;
        r.accepted_by.push(person.id);
        if (r.used >= r.uses) r.status = "used";
        return r;
      });
      if (!consumed) fail("revoked", WORDS.revoked);
      try {
        const res = await members.addMember({
          actor: systemActor(rec.created_by), person: person.id, role: rec.role,
          scope: rec.role === "temp" ? rec.scope : undefined, expires: rec.role === "temp" ? rec.expires : undefined,
        });
        await emit("invite.accepted", { space: space.id, invite: p.id, person: person.id, role: rec.role, by: rec.created_by, at: t });
        return { membership: res.membership, projects: rec.role === "member" ? rec.scope || [] : [], warnings: res.warnings };
      } catch (e) {
        // Give the use back: the person did not join.
        await store.update(p.id, (/** @type {any} */ r) => {
          r.used = Math.max(0, r.used - 1);
          r.accepted_by = r.accepted_by.filter((/** @type {string} */ x) => x !== person.id);
          if (r.status === "used") r.status = "active";
          return r;
        });
        throw e;
      }
    });
  }

  /** The creator, an owner, or an admin (for roles an admin may assign) can revoke. */
  async function revokeInvite(/** @type {{ actor: string, id: string }} */ a) {
    return locked(async () => {
      const t = now();
      const m = await members.get(a.actor);
      if (!m || abilitiesOf(m, t).length === 0) fail("not_a_member", "That person is not an active member of this space.");
      const rec = await store.get(a.id);
      if (!rec) fail("unknown_invite", "No such invite.");
      if (!(rec.created_by === a.actor || canAssign(m.role, rec.role))) fail("forbidden", "You cannot cancel that invite.");
      if (rec.status === "revoked") return pub(rec);
      const next = await store.update(a.id, (/** @type {any} */ r) => { r.status = "revoked"; return r; });
      await emit("invite.revoked", { space: space.id, invite: a.id, role: rec.role, by: a.actor, at: t });
      return pub(next);
    });
  }

  /** Owners and admins see every invite they may manage; others see their own. Records never include the token. */
  async function listInvites(/** @type {{ actor: string }} */ a) {
    const t = now();
    const m = await members.get(a.actor);
    if (!m || abilitiesOf(m, t).length === 0) fail("not_a_member", "That person is not an active member of this space.");
    const all = await store.list();
    return all.filter((/** @type {any} */ r) => r.created_by === a.actor || canAssign(m.role, r.role)).map(pub);
  }

  /** Mark active invites past their lifetime (or whose temp end has passed) as expired, emit invite.expired, return them. */
  async function sweepInvites(/** @type {number} */ at) {
    return locked(async () => {
      const t = typeof at === "number" ? at : now();
      const out = [];
      for (const r of await store.list()) {
        if (r.status !== "active") continue;
        if (!(t >= r.iat + r.ttl || (r.expires !== undefined && r.expires <= t))) continue;
        const next = await store.update(r.id, (/** @type {any} */ x) => { x.status = "expired"; return x; });
        await emit("invite.expired", { space: space.id, invite: r.id, role: r.role, at: t });
        out.push(pub(next));
      }
      return out;
    });
  }

  return { createInvite, acceptInvite, revokeInvite, listInvites, sweepInvites, previewInvite: (/** @type {string} */ token, /** @type {any} */ o) => previewInvite(token, { store, now: now(), ...o }) };
}

