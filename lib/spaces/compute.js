// @ts-check
// The compute grant pair (team/0.3/DESIGN-wink.md section 7, contract section 11 "two-way consent").
//
// A space may run its work on its members' computers only when BOTH sides agree:
//   1. the space allows it (an owner or admin, with `devices.manage`), under terms the space names;
//   2. the member accepts those exact terms, and only the member can.
// The grant covers one thing: a member's OWN sessions on their OWN computer. An admin cannot run anything on a member's machine, or look into
// it, and a member cannot run another member's session. Either side ends it at once. If the space changes its terms, every acceptance stops
// until the member accepts the new terms. A temp member is never eligible: their access is scoped and ends.
//
// This file decides and records. It does not start a session; the scheduler asks `mayRun` and starts nothing without `allow`.

import crypto from "node:crypto";
import { abilitiesOf, SpacesError, isExpired } from "./members.js";

/** @param {string} code @param {string} message @returns {never} */
const fail = (code, message) => { throw new SpacesError(code, message); };

export const COMPUTE_TERMS_DEFAULT = Object.freeze({
  /** What the grant covers. Fixed: not a setting. */
  covers: "own-sessions-on-own-computer",
  /** The most sessions of one member the space may run on that member's computer at once. */
  maxSessions: 2,
});

/** A small in-memory store with the shape the module's key-value table has. */
export function memoryComputeStore() {
  /** @type {Map<string, any>} */ const m = new Map();
  return {
    async get(/** @type {string} */ k) { const v = m.get(k); return v === undefined ? null : structuredClone(v); },
    async put(/** @type {string} */ k, /** @type {any} */ v) { m.set(k, structuredClone(v)); },
    async delete(/** @type {string} */ k) { m.delete(k); },
  };
}

/** The hash of the terms a member accepts; any change to them is a new thing to accept. @param {any} t */
export const termsHash = t => crypto.createHash("sha256").update(JSON.stringify({ covers: t.covers, maxSessions: t.maxSessions })).digest("hex").slice(0, 32);

/**
 * @param {{ space: string, members: { get(person: string): Promise<any> }, store: ReturnType<typeof memoryComputeStore>, now: () => number,
 *   emit?: (type: string, payload: any) => any }} deps
 */
export function createCompute({ space, members, store, now, emit = () => {} }) {
  const spaceKey = `compute/${space}/space`;
  const memberKey = (/** @type {string} */ p) => `compute/${space}/member/${p}`;

  /** The member's record if they are an active, non-temp member. @param {string} person */
  async function active(person) {
    const m = await members.get(person);
    if (!m) fail("not_a_member", "That person is not a member of this space.");
    if (isExpired(m, now())) fail("expired", "That person's access has ended.");
    return m;
  }

  /** @param {any} t */
  function termsOf(t) {
    const maxSessions = t && t.maxSessions !== undefined ? t.maxSessions : COMPUTE_TERMS_DEFAULT.maxSessions;
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 16) fail("bad_input", "A member's computer may run 1 to 16 of their own sessions at once.");
    return { covers: COMPUTE_TERMS_DEFAULT.covers, maxSessions };
  }

  return {
    /** The space allows (or stops allowing) its work on members' computers. Owners and admins only. @param {{ actor: string, enabled: boolean, terms?: any }} a */
    async allowSpace({ actor, enabled, terms }) {
      const a = await active(actor);
      if (!abilitiesOf(a, now()).includes("devices.manage")) fail("forbidden", "Only an owner or admin can decide whether this space may use members' computers.");
      const t = now();
      const cur = await store.get(spaceKey);
      if (!enabled) {
        await store.put(spaceKey, { enabled: false, terms: cur ? cur.terms : termsOf(terms), hash: cur ? cur.hash : null, by: actor, at: t });
        emit("compute.space-stopped", { space, by: actor, at: t });
        return { enabled: false };
      }
      const next = termsOf(terms ?? (cur && cur.terms));
      const hash = termsHash(next);
      await store.put(spaceKey, { enabled: true, terms: next, hash, by: actor, at: t });
      emit("compute.space-allowed", { space, by: actor, terms: next, hash, at: t });
      return { enabled: true, terms: next, hash };
    },
    /** A member accepts the space's current terms for THEIR OWN computer, or stops accepting. Only the member themself. @param {{ person: string, enabled: boolean, terms?: string }} a */
    async acceptMember({ person, enabled, terms }) {
      const m = await active(person);
      if (m.role === "temp") fail("forbidden", "A temp guest's access is scoped and ends, so it cannot lend a computer.");
      const t = now();
      if (!enabled) {
        await store.put(memberKey(person), { enabled: false, hash: null, at: t });
        emit("compute.member-declined", { space, person, at: t });
        return { accepted: false };
      }
      const s = await store.get(spaceKey);
      if (!s || !s.enabled) fail("not_allowed", "This space has not allowed its work on members' computers.");
      if (terms !== s.hash) fail("terms_changed", "The space's terms are not the ones you were shown. Look again, then accept.");
      await store.put(memberKey(person), { enabled: true, hash: s.hash, at: t });
      emit("compute.member-accepted", { space, person, hash: s.hash, at: t });
      return { accepted: true, hash: s.hash };
    },
    /** What each side has said, for a person to read. @param {{ person: string }} a */
    async status({ person }) {
      const s = await store.get(spaceKey);
      const mine = await store.get(memberKey(person));
      const spaceAllows = Boolean(s && s.enabled);
      const accepted = Boolean(mine && mine.enabled && s && mine.hash === s.hash);
      return {
        spaceAllows, terms: s ? s.terms : null, hash: s ? s.hash : null,
        memberAccepted: Boolean(mine && mine.enabled), acceptedCurrentTerms: accepted, active: spaceAllows && accepted,
        ...(mine && mine.enabled && s && mine.hash !== s.hash ? { needs: "The space changed its terms. Accept the new ones to keep lending this computer." } : {}),
      };
    },
    /**
     * May this session run on this machine? Both grants, the same person on all three: the actor starting it, the session's owner and the
     * machine's owner. Anything else (an admin, another member, a service) is refused with the reason.
     * @param {{ actor: string, session: { owner: string, running?: number }, machine: { owner: string } }} a
     */
    async mayRun({ actor, session, machine }) {
      const deny = (/** @type {string} */ reason, /** @type {string} */ message) => ({ allow: false, reason, message });
      if (!actor || actor !== session.owner || actor !== machine.owner) return deny("not_own", "A space can run only a member's own sessions on that member's own computer.");
      const s = await store.get(spaceKey);
      if (!s || !s.enabled) return deny("space_not_allowed", "This space has not allowed its work on members' computers.");
      const m = await members.get(actor);
      if (!m || isExpired(m, now()) || m.role === "temp") return deny("not_a_member", "That person is not an active member of this space.");
      const mine = await store.get(memberKey(actor));
      if (!mine || !mine.enabled) return deny("member_not_accepted", "The member has not accepted using their computer for this space.");
      if (mine.hash !== s.hash) return deny("terms_changed", "The space changed its terms and the member has not accepted the new ones.");
      if ((session.running ?? 0) >= s.terms.maxSessions) return deny("at_limit", `That computer already runs ${s.terms.maxSessions} of this space's sessions.`);
      return { allow: true, reason: "both_agreed", terms: s.terms };
    },
  };
}
