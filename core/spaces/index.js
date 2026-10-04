// @ts-check
// spaces: identity, spaces, members and invites for Vyre 0.3 (team/0.3/DESIGN-spaces-first.md). This file is the wiring: the rules live in
// lib/spaces/ (members, invites, homes, home-unit, vps, authz), the names client is core/names/ids.js, and everything here is
// persisted in SQLite tables prefixed spaces_. Nothing polls: one timer sweeps expired temp members and invites, an hour apart.
//
// Who acts: until the kernel builds a chain, the acting person is THIS device's own identity (spaces.identity). Tools that
// change who can do what also ask for the person's presence where the lib demands it; the verified proof is the registry's
// `meta.presence`, never anything a caller put in the input.
//
// Secrets: the person key and each space's root key stay in files (mode 0600) and are never logged, evented or returned. The only
// secret ever returned is the recovery code of a new identity, once, in that one reply. The pairing code is shown to the person on
// purpose (the device displays it) and is kept as a hash.

import crypto from "node:crypto";
import { ROLE_IDS } from "../../kernel/contracts/index.js";
import { createMembers, abilitiesOf, SpacesError } from "../../lib/spaces/members.js";
import { createInvites, parseJoinLink, previewInvite, acceptMessage } from "../../lib/spaces/invites.js";
import { createRoleAuthorize, personChain } from "../../lib/spaces/authz.js";
import {
  createSpaceFlow, assessThisComputer, planMoveHome, PAIRING_DEFAULTS, INSTALL_COMMAND, PAIR_PROMPT,
} from "../../lib/spaces/homes.js";
import { SPACE_ID_RE } from "../../lib/spaces/home-unit.js";
import { idDirectory, DEFAULT_BASE } from "../../lib/identity/directory.js";
import * as C from "../../kernel/identity/chain.js";
import { createIdentityOps } from "./identity-ops.js";
import { PASSWORD_MIN } from "./recovery.js";
import { bindBytes } from "../../kernel/seal/wire.js";
import { WORDS } from "../../relay/client/words.js";
import { createCompute } from "../../lib/spaces/compute.js";
import { createKernelMembers } from "./kernel-members-compat.js";
import { kernelMembers, plainKernelError } from "./kernel-members.js";
import { acceptProofRequest } from "../../kernel/remote/proof.js";
import {
  MIGRATIONS, kvStore, seenStore, membershipStore, roleNames, inviteStore, pairingService, spaceTable,
} from "./store.js";
import { fileIdentityStore, signerOf, personIdOf } from "./identity.js";
import { spaceFiles } from "./host.js";
import fs from "node:fs";
import path from "node:path";

/** Test seams. Nothing here is a setting: a test sets them before the module starts. */
export const hooks = {
  /** @type {typeof globalThis.fetch | null} */ fetch: null,
  /** @type {(() => number) | null} */ now: null,
  /** @type {number | null} */ sweepMs: null,
  /** @type {number | null} */ syncMs: null,
  /** @type {{ memoryKiB: number, passes: number } | null} the recovery stretch, lowered by tests only */ stretch: null,
  /** @type {any} */ vpsDeps: null,
  /** @type {((device: string) => Promise<{ call(tool: string, input: any): Promise<any> }>) | null} the open Wink peer session to a paired server (the daemon wires it); a test sets it */ sessionFor: null,
};

const DAY = 24 * 60 * 60 * 1000;
/** Before membership exists the only callers are the relay and the person's devices: a local anonymous or model caller cannot spend a use count or burn the five tries. */
const RELAY_DEVICE_CALLERS = Object.freeze(["tailnet", "relay", "device"]);
const b64u = (/** @type {Buffer|Uint8Array} */ b) => Buffer.from(b).toString("base64url");
const PERSON_RE = /^per_[a-z2-7]{26}$/;
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const str = { type: "string" };
const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required, additionalProperties: true });
const HOME = obj({
  kind: { type: "string", enum: ["server", "vps", "this-computer"] }, provider: str, region: str, size: str, token: str,
  device: obj({ id: str, name: str, alwaysOn: { type: "boolean" } }), confirmed: { type: "boolean" },
}, ["kind"]);

/** What a directory failure says to a person. @param {any} e */
function plainDirectory(e) {
  if (e && e.code === "unreachable") return "Could not reach the name directory. Check the internet connection and try again.";
  if (e && e.code === "taken") return "That name is taken. Pick another.";
  if (e && e.code === "not_found") return "No such name.";
  return e && typeof e.message === "string" && e.message ? e.message : "The name directory could not do that. Try again in a moment.";
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const root = path.join(ctx.paths.root, "spaces");
    const clock = { now: () => (hooks.now ? hooks.now() : Date.now()) };
    const now = () => clock.now();
    // The directory checks a record's time against its own clock and wants each update newer than the last, so the client's clock never repeats.
    let lastTs = 0;
    const mono = () => (lastTs = Math.max(now(), lastTs + 1));
    const base = (ctx.config && ctx.config.names && ctx.config.names.directory) || DEFAULT_BASE;
    const seen = seenStore(db);
    const dir = idDirectory({ base, fetch: hooks.fetch || globalThis.fetch, now: mono, seen });

    const identity = fileIdentityStore(root);
    const idops = createIdentityOps({ store: identity, dir, seen, now, emit: (t, p) => emit(t, p), stretch: hooks.stretch || undefined });
    const files = spaceFiles(root);
    const kv = kvStore(db);
    // SHIM(legacy labels): the module-local membership store and every kernel-off path that reads it (mstore, membersFor, authorize/gate below the kernel branch, membershipOf, isMember)
    // are deleted in the kernel default-on commit, with their tests rewritten onto a fake kernel handle. A Space the kernel hosts never reads it.
    const mstore = membershipStore(db);
    const rnames = roleNames(db);
    const spaces = spaceTable(db);
    const pairing = pairingService(db, clock, { ttlMs: PAIRING_DEFAULTS.ttlMs });

    // ---- events: the lib's names carry more than one dot; a manifest name is `noun.past-verb` ----
    const mapType = (/** @type {string} */ t) => { const [a, ...r] = String(t).split("."); return r.length ? `${a}.${r.join("-").replace(/_/g, "-")}` : t; };
    const emit = (/** @type {string} */ type, /** @type {any} */ payload) => {
      const t = mapType(type);
      try { ctx.events.emit(t, payload); } catch (e) { ctx.log.warn(`event ${t} was not sent: ${/** @type {Error} */ (e).message}`); }
    };

    // ---- who is acting, and the generic gate ----
    const me = () => {
      const s = identity.status();
      if (!s.exists || s.pending) throw refuse("Choose your Vyre name first.", "no_identity");
      return s;
    };
    /** This person, as an owner of a space: the person id, acting through this device's entry on their list. */
    const ownerSigner = async () => { const s = me(); return { by: /** @type {string} */ (s.id), via: /** @type {string} */ (s.eid), pos: await C.viaOf(identity.ops()), sign: (/** @type {Uint8Array} */ m) => identity.sign(Buffer.from(m)) }; };
    /** This device's own entry, for acts of the person's own list. */
    const selfSigner = () => { const s = me(); return { by: /** @type {string} */ (s.eid), sign: (/** @type {Uint8Array} */ m) => identity.sign(Buffer.from(m)) }; };
    /** The chain's resolver for a space's owners: this person from the local copy, anyone else through the directory by the name their entry carries. @param {any[]} spaceOps */
    const ownerResolver = spaceOps => dir.ownersResolver(spaceOps, async (/** @type {string} */ id) => {
      const s = identity.status();
      return s.exists && s.id === id ? identity.ops() : null;
    });
    /** A space's chain as this device holds it: { ops, pin }, or null. @param {string} spaceId */
    const chainOf = spaceId => /** @type {any} */ (kv.get(`chain/${spaceId}`));
    const stateOfSpace = async (/** @type {string} */ spaceId) => {
      const c = await chainOf(spaceId);
      if (!c) throw refuse("This device does not hold the space's list of owners.", "no_chain");
      return { c, state: await C.verifyChain(c.ops, { now: now() + C.SKEW_MS, ownerOps: ownerResolver(c.ops) }) };
    };
    /** The fingerprint of a space as its inviter saw it: its permanent id and its root key. 32 hex characters; four words show the first 44 bits on the card. */
    const spaceFingerprint = (/** @type {string} */ chainId, /** @type {string} */ rootPublic) => crypto.createHash("sha256").update(`vyre-space-fingerprint-v1\n${chainId}\n${rootPublic}`).digest("hex").slice(0, 32);
    const wordList = Array.isArray(WORDS) ? WORDS : String(WORDS).split(/\s+/).filter(Boolean);
    const fingerprintWords = (/** @type {string|null|undefined} */ hex) => {
      if (!hex) return null;
      const bits = BigInt("0x" + hex.slice(0, 11)); // 44 bits, four words
      return [3, 2, 1, 0].map(k => wordList[Number((bits >> BigInt(11 * k)) & 2047n)]).join(" ");
    };
    const pinText = (/** @type {any} */ pin) => (pin ? `${pin.id}:${pin.seq}:${pin.head}` : undefined);
    const parsePin = (/** @type {unknown} */ t) => { const m = /^((?:per|spc)_[a-z2-7]{26}):(\d+):([0-9a-f]{64})$/.exec(String(t || "")); return m ? { id: m[1], seq: Number(m[2]), head: m[3] } : undefined; };
    const authorize = createRoleAuthorize({ membership: (space, person) => mstore.get(space, person), now });
    const REASONS = /** @type {Record<string, string>} */ ({ not_a_member: "You are not a member of this space.", expired: "Your access to this space has ended.", no_grant: "Your role cannot do that.", chain_not_person: "Only a person can do that." });
    /** Is the acting person an active member who may do `action`? Returns the person. @param {string} spaceId @param {string} [action] */
    /** The spaces a device is enrolled in: an explicit list per device (the device's entry id on the person's list). A device with no list yet is enrolled in every space (nothing was ever chosen); the list is made the first time it is changed or at pairing. */
    const enrolledList = async (/** @type {string} */ eid) => /** @type {string[]|null} */ ((await kv.get(`device-spaces/${eid}`)) || null);
    const isEnrolled = async (/** @type {string} */ eid, /** @type {string} */ spaceId) => { const l = await enrolledList(eid); return l === null || l.includes(spaceId); };
    /** Refuse a call that comes from a device that is not enrolled in this space. @param {string} spaceId @param {any} meta */
    const notRemoved = async (spaceId, meta) => {
      const dev = meta && meta.kernelFacts && meta.kernelFacts.kind === "device" ? String(meta.kernelFacts.device_key_id || "") : "";
      if (dev && !(await isEnrolled(dev, spaceId))) throw refuse("This device is not enrolled in this space.", "device_removed");
    };
    const gate = async (spaceId, action = "views.read", meta) => {
      const s = me();
      await notRemoved(spaceId, meta);
      if (kernelHandle(spaceId)) {
        // The kernel's answer: a member (and, for temp, one whose time has not run out) is let in; what they may DO is the kernel's to decide on each call.
        const m = await membershipOf(spaceId, /** @type {string} */ (s.id), meta).catch(() => null);
        if (!m) throw refuse("You are not a member of this space.", "not_a_member");
        return s;
      }
      const d = await authorize({ chain: personChain({ space: spaceId, person: /** @type {string} */ (s.id) }), action });
      if (d.effect !== "allow") throw refuse(REASONS[d.reason] || "You cannot do that here.", d.reason === "not_a_member" ? "not_a_member" : "forbidden");
      return s;
    };

    /** A space by id or by name, or a plain refusal. @param {any} ref */
    const spaceOf = ref => {
      const text = String(ref || "").trim().toLowerCase();
      const row = SPACE_ID_RE.test(text) ? spaces.get(text) : spaces.byName(text.endsWith(".vyre.run") ? text : `${text}.vyre.run`);
      if (!row) throw refuse("No such space on this device.", "not_found");
      return row;
    };
    /** The creator, or an owner of a space that exists. */
    const ownsFlow = (/** @type {any} */ row, /** @type {any} */ s) => row.createdBy === s.id || mstore.get(row.id, s.id)?.role === "owner";
    const mine = (/** @type {any} */ ref) => { const s = me(); const row = spaceOf(ref); if (!ownsFlow(row, s)) throw refuse("That space is not yours to run.", "forbidden"); return { s, row }; };

    // ---- the Space's own kernel decides roles and memberships when it hosts or can reach one (ctx.kernel.for(space)): nothing here is then an authority ----
    const K = ctx.kernel && typeof ctx.kernel.for === "function" ? ctx.kernel : null;
    const kernelHandle = (/** @type {string} */ id) => { if (!K) return null; try { return K.for(id) || null; } catch { return null; } };
    /** Creation is all or nothing, the kernel's registry included (PA-1): a creation that failed or was cancelled takes back the Space the kernel started for it (never one with content), and resume hosts it again under the same id. */
    /** Ask a PAIRED SERVER to run one of its spaces tools, over the owner's paired session, with the owner's presence proof beside the call (the server's own registry verifies it, nothing here is trusted).
     * The carrier is Wink's: `wink.server.call { device, tool, input, proof? }` (tailnet). Any failure is a refusal; a space is never hosted locally as a fallback. */
    const remoteCall = async (/** @type {string} */ device, /** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ meta) => {
      // ONE remote path (lead's ruling): the Wink peer wire to the paired server, as a session `{ call(tool, input) }` that a port supplies (`hooks.sessionFor(device)`, the daemon's wiring of the open
      // joinPeer session); the owner's proof rides in the input's `proof` for the SERVER's registry to verify. Until a port is wired, the Wink module's `wink.server.call` tool is tried.
      if (typeof hooks.sessionFor === "function") {
        let session; try { session = await hooks.sessionFor(device); } catch { throw refuse("The server could not be reached. Nothing was made.", "server_unreachable"); }
        if (!session || typeof session.call !== "function") throw refuse("The server could not be reached. Nothing was made.", "server_unreachable");
        let pr; try { pr = await session.call(tool, { ...input, ...(meta && meta.kernel_proof ? { proof: meta.kernel_proof } : {}) }); } catch (e) { throw refuse(String(/** @type {any} */ (e).message || "The server did not do that. Nothing was made.").slice(0, 160), String(/** @type {any} */ (e).code || "server_refused")); }
        if (!pr || pr.ok === false) throw refuse(pr && pr.error && pr.error.message ? String(pr.error.message).slice(0, 160) : "The server did not do that. Nothing was made.", (pr && pr.error && pr.error.code) || "server_refused");
        return pr.data !== undefined ? pr.data : pr;
      }
      let r; try { r = await ctx.call("wink.server.call", { device, tool, input, ...(meta && meta.kernel_proof ? { proof: meta.kernel_proof } : {}) }); } catch { throw refuse("The server could not be reached. Nothing was made.", "server_unreachable"); }
      if (!r || r.error) throw refuse(r && r.error && r.error.message ? String(r.error.message).slice(0, 160) : "The server did not do that. Nothing was made.", (r && r.error && r.error.code) || "server_refused");
      return r.data;
    };
    /** The device of a space whose home is a server and which the SERVER hosts (set when it was made there). */
    const serverOf = async (/** @type {string} */ spaceId) => { const v = await kv.get(`server-hosted/${spaceId}`); return v && typeof v.device === "string" ? v.device : null; };
    const retireHosted = async (/** @type {string} */ id, /** @type {any} */ meta) => {
      const srv = await serverOf(id);
      if (srv) { try { await remoteCall(srv, "spaces.retire-here", { id }, meta); await kv.delete(`server-hosted/${id}`); } catch (e) { ctx.log.warn(`the server kept a space that did not finish being made (${id}): ${String(/** @type {any} */ (e).message || e).slice(0, 120)}`); } return; }
      if (!K || !K.spaces || typeof K.spaces.retire !== "function" || !kernelHandle(id)) return;
      try { await K.spaces.retire(id); } catch (e) { ctx.log.warn(`the kernel kept a space that did not finish being made (${id}): ${String(/** @type {any} */ (e).message || e).slice(0, 120)}`); }
    };
    /** The caller's chain IN that Space (a hosted Space has its own key: the home's chain is not a member of it), and the proof beside the call. */
    const kctxOf = async (/** @type {any} */ meta, /** @type {string} */ space) => ({ chain: space && typeof K.chainIn === "function" ? await K.chainIn(space, meta) : await K.chain(meta), proof: K.proofFrom(meta) });
    /** The members service for a space: the kernel's (under the caller's chain and proof) when there is one, else the local table's. @param {string} id @param {any} [meta] */
    const members = async (id, meta) => {
      const h = kernelHandle(id);
      if (!h) return membersFor(id);
      const k = await kctxOf(meta, id);
      return createKernelMembers({ space: id, handle: h, now, displayNames: rnames.load(id), reader: () => k });
    };
    /** A person's role in a space from the place that decides it. @param {string} id @param {string} person @param {any} [meta] */
    const membershipOf = async (id, person, meta) => (kernelHandle(id) ? (await (await members(id, meta)).get(person)) : mstore.get(id, person)) || null;

    // ---- members and invites, one instance per space (their own queues keep one change at a time) ----
    /** @type {Map<string, any>} */ const memberSvc = new Map();
    // SHIM(legacy labels): the local-table members service, for a Space with no kernel.
    const membersFor = (/** @type {string} */ id) => {
      let m = memberSvc.get(id);
      if (!m) {
        m = createMembers({
          space: id, store: mstore, now, emit, displayNames: rnames.load(id),
          // The registry already verified the person's presence for this exact call; its proof arrives as meta.presence.
          verifyPresence: (/** @type {any} */ _payload, /** @type {any} */ proof) => Boolean(proof && typeof proof === "object" && proof.method),
        });
        memberSvc.set(id, m);
      }
      return m;
    };
    /** @type {Map<string, any>} */ const inviteSvc = new Map();
    const invitesFor = (/** @type {any} */ row) => {
      const key = `${row.id}|${row.aliases.join(",")}`;
      let inv = inviteSvc.get(key);
      if (!inv) {
        const k = files.keys.load(row.id);
        if (!k) throw refuse("This device does not hold the space's key, so it cannot make or check its invites.", "no_key");
        inv = createInvites({
          space: { id: row.id, name: row.name, aliases: row.aliases }, signer: { publicKey: k.publicKey, sign: k.sign },
          members: membersFor(row.id), store: inviteStore(db, row.id), now, emit, personIdFromKey: personIdOf, verifyPersonProof,
        });
        for (const k2 of [...inviteSvc.keys()]) if (k2.startsWith(`${row.id}|`)) inviteSvc.delete(k2);
        inviteSvc.set(key, inv);
      }
      return inv;
    };
    /** An acceptance by an identity: the directory's CURRENT list for the person's name decides, so a device that was removed cannot join. @param {any} person @param {Buffer} message @param {string} proof */
    const verifyPersonProof = async (person, message, proof) => {
      try {
        const name = String(person.name || "").toLowerCase().replace(/\.vyre\.run$/, "");
        const r = await dir.resolve(name);
        if (!r.ok || r.kind !== "person" || r.id !== person.id) return false;
        const e = r.state.entries.find((/** @type {any} */ x) => x.eid === person.by && (x.kind === "device" || x.kind === "code"));
        return Boolean(e) && await C.verifyWith(e.pub, message, proof);
      } catch { return false; }
    };
    const personRef = async (/** @type {any} */ value) => {
      const text = String(value || "").trim().toLowerCase();
      if (PERSON_RE.test(text)) return text;
      const label = text.replace(/\.vyre\.run$/, "");
      let r;
      // Pinned from the first time this device saw the name: a later answer that is older, or a different history, is refused.
      const pinKey = `person-pin/${label}`;
      const seen = /** @type {any} */ (await kv.get(pinKey));
      try { r = await dir.resolve(label, { pin: seen || undefined }); } catch (e) { throw refuse(plainDirectory(e), "not_found"); }
      if (!r.ok) throw refuse(`That name could not be verified: ${r.why}.`, r.code || "unverified");
      if (r.kind !== "person") throw refuse("That name does not belong to a person.", "not_found");
      await kv.put(pinKey, r.pin);
      await kv.put(`person-name/${r.id}`, label);
      return r.id;
    };

    /** The name a person chose for themselves (their identity card), as this device knows it: their own, or one it verified when they were added by name or joined. Null when not known here. @param {string} id */
    const nameOf = async id => {
      const st = identity.status();
      if (st.exists && (st.id === id || (K && K.owner === id)) && st.name) return `${st.name}.vyre.run`.replace(/(\.vyre\.run)+$/, ".vyre.run");
      const n = /** @type {string|null} */ (await kv.get(`person-name/${id}`));
      return n ? `${n}.vyre.run` : null;
    };
    const withName = async (/** @type {any} */ r) => {
      if (r && typeof r === "object" && r.membership && typeof r.membership.person === "string") return { ...r, membership: { ...r.membership, name: await nameOf(r.membership.person) } };
      return r && typeof r === "object" && typeof r.person === "string" ? { ...r, name: await nameOf(r.person) } : r;
    };

    // ---- a space's list of owners follows its owners ----
    /**
     * After any membership change, make the space's chain list the people who are owners now: adds first, then removals, each signed by this
     * person through this device. A newcomer device cannot change owners, so a refusal leaves a warning on the space and nothing else changes.
     * @param {any} row @param {string} [hint] the name of a person just added, so their entry can be found by name
     */
    const syncOwners = async (row, hint, meta) => {
      const c = await chainOf(row.id);
      if (!c) return;
      try {
        const t = now();
        let { state } = await stateOfSpace(row.id);
        const rows = await (await members(row.id, meta)).list();
        const owners = new Set(rows.filter((/** @type {any} */ r) => r.role === "owner" && !(r.expires && r.expires <= t)).map((/** @type {any} */ r) => r.person));
        let ops = c.ops;
        for (const id of owners) {
          if (state.entries.some(e => e.eid === id)) continue;
          const op = await C.makeOp(state, { type: "add", entry: { eid: id, kind: "owner", subject: id, label: hint && PERSON_RE.test(id) ? hint : undefined } }, { by: /** @type {string} */ (me().id), via: /** @type {string} */ (me().eid), viaPos: await C.viaOf(identity.ops()), ts: Math.max(t, state.ts), sign: (await ownerSigner()).sign });
          state = await C.applyOp(state, op, { now: t + C.SKEW_MS, ownerOps: ownerResolver(ops), live: true });
          await dir.append(row.label, [op]);
          ops = [...ops, op];
        }
        for (const e of [...state.entries]) {
          if (owners.has(e.eid)) continue;
          const op = await C.makeOp(state, { type: "remove", target: e.eid }, { by: /** @type {string} */ (me().id), via: /** @type {string} */ (me().eid), viaPos: await C.viaOf(identity.ops()), ts: Math.max(t, state.ts), sign: (await ownerSigner()).sign });
          state = await C.applyOp(state, op, { now: t + C.SKEW_MS, ownerOps: ownerResolver(ops), live: true });
          await dir.append(row.label, [op]);
          ops = [...ops, op];
        }
        await kv.put(`chain/${row.id}`, { ops, pin: C.pinOf(state) });
      } catch (e) {
        warn(row.id, { code: "owners_chain_behind", message: `The space's list of owners could not be updated yet: ${plainDirectory(e)}` });
      }
    };

    // ---- the create flow's dependencies, wired to real things ----
    const warn = (/** @type {string} */ spaceId, /** @type {{ code: string, message: string }} */ w) => {
      const row = spaces.get(spaceId);
      if (!row || row.warnings.some((/** @type {any} */ x) => x.code === w.code)) return;
      spaces.patch(spaceId, { warnings: [...row.warnings, w] }, now());
      emit("space.warning", { spaceId, code: w.code, message: w.message });
    };
    const vpsDeps = () => ({ emit, ...(hooks.vpsDeps || { fetch: hooks.fetch || globalThis.fetch }) });
    /** Is this server already paired to this person (the pairing proved it)? Wink answers from the identity's own list (wink.server.paired); no answer means no, and the typed code step runs. @param {string} id */
    const pairedServer = async id => {
      let who = null; try { who = identity.status(); } catch { who = null; }
      if (!who || !who.exists || !who.id) return false;
      try { const r = await ctx.call("wink.server.paired", { device: id, identity: who.id }); return Boolean(r && r.data && !r.error && r.data.paired === true); } catch { return false; }
    };
    const deps = {
      store: kv,
      emit,
      clock,
      random: (/** @type {number} */ n) => crypto.randomBytes(n),
      keys: files.keys,
      names: {
        async check(/** @type {string} */ label) {
          let r;
          try { r = await dir.check(label); } catch (e) { throw refuse(plainDirectory(e), /** @type {any} */ (e).code || "unreachable"); }
          if (r.status === "ok" || r.status === "mine") return { ok: true };
          if (r.status === "taken") return { ok: false, reason: "taken", message: "That name is taken. Pick another." };
          return { ok: false, reason: r.status, message: r.status === "reserved" ? "That name is reserved. Pick another." : `That name can't be used: ${r.why}.` };
        },
        async claimSpace(/** @type {{ name: string, rootPublic: string, record: any }} */ a) {
          const k = files.keys.load(a.record.spaceId);
          if (!k || k.publicKey !== a.rootPublic) return { ok: false, message: "The space's key is not on this device." };
          const label = String(a.record.displayName || a.name).slice(0, 80);
          try {
            // A space is an identity whose list holds its owners. This person is the first owner, acting through this device's entry.
            // The chain is kept on this device so a retried step reuses it instead of making a second identity. The invite key (the root key) is
            // carried in the sealed record, signed by an owner, which is how an invitee learns it.
            const who = me();
            let c = await chainOf(a.record.spaceId);
            if (!c) {
              const g = await C.makeGenesis({ kind: "space", entry: { eid: /** @type {string} */ (who.id), kind: "owner", subject: /** @type {string} */ (who.id), label: who.name || undefined },
                nonce: crypto.randomBytes(12).toString("base64url"), ts: now(), via: /** @type {string} */ (who.eid), viaPos: await C.viaOf(identity.ops()), sign: (await ownerSigner()).sign });
              c = { ops: [g], pin: null };
              await kv.put(`chain/${a.record.spaceId}`, c);
            }
            const state = await C.verifyChain(c.ops, { now: now() + C.SKEW_MS, ownerOps: ownerResolver(c.ops) });
            await dir.claim(a.name, state, c.ops, await ownerSigner(), { v: 1, id: a.record.spaceId, name: a.name, label, rootPublic: a.rootPublic });
            await kv.put(`chain/${a.record.spaceId}`, { ops: c.ops, pin: C.pinOf(state) });
            return { ok: true };
          } catch (e) { return { ok: false, code: /** @type {any} */ (e).code, message: plainDirectory(e) }; }
        },
        async releaseSpace(/** @type {{ name: string, spaceId: string }} */ a) { await dir.release(a.name, await ownerSigner()); await kv.delete(`chain/${a.spaceId}`); return { ok: true }; },
        async pointHome(/** @type {{ name: string, spaceId: string, home: any }} */ a) {
          const row = spaces.get(a.spaceId);
          const k = files.keys.load(a.spaceId);
          const home = { kind: a.home && a.home.kind, ...(a.home && a.home.address ? { address: a.home.address } : {}) };
          const { state } = await stateOfSpace(a.spaceId);
          await dir.update(a.name, state, await ownerSigner(), { v: 1, id: a.spaceId, name: a.name, label: (row && (row.displayName || row.label)) || a.name, home, rootPublic: k ? k.publicKey : undefined });
          return { ok: true };
        },
      },
      members: {
        async bootstrapOwner(/** @type {string} */ person, /** @type {any} */ c) {
          // A Space the kernel hosts made its first owner (the person named to host()) when it was hosted: nothing to write here, and never a second record of it in the local table.
          if (kernelHandle(c.spaceId)) return { space: c.spaceId, person, role: "owner" };
          const m = membersFor(c.spaceId);
          const have = await m.get(person);
          if (have && have.role === "owner") return have;
          return m.bootstrapOwner(person);
        },
      },
      records: {
        async provisionWorkspace(/** @type {{ spaceId: string, name: string }} */ a) {
          const r = await ctx.call("records.workspace.create", { space: a.spaceId, name: a.name });
          if (r.error) {
            // With the kernel hosting here every Space has its built-in store, so a refusal from the records tool is a failed step, not a warning; a space the kernel does not host has no store to attach, so it only warns.
            if ((r.error.code === "no_such_tool" || r.error.code === "not_available" || r.error.code === "not_found") && !(K && K.spaces && typeof K.spaces.host === "function")) {
              warn(a.spaceId, { code: "records_driver_missing", message: "records driver not installed" });
              return { workspaceId: null };
            }
            ctx.log.warn(`records.workspace.create refused: ${r.error.code}: ${r.error.message}`);
            throw new Error(r.error.message);
          }
          const id = (r.data && (r.data.workspaceId || r.data.id)) || null;
          if (id) spaces.patch(a.spaceId, { workspaceId: id }, now());
          return { workspaceId: id };
        },
        async deleteWorkspace(/** @type {{ spaceId: string }} */ a) {
          const row = spaces.get(a.spaceId);
          if (!row || !row.workspaceId) return { ok: true };
          const r = await ctx.call("records.workspace.delete", { space: a.spaceId });
          if (r.error) throw new Error(r.error.message);
          return { ok: true };
        },
      },
      pairing: { ...pairing, alreadyPaired: pairedServer },
      homeHost: files.homeHost,
      pairingOptions: { ...PAIRING_DEFAULTS },
      get vpsDeps() { return vpsDeps(); },
    };
    const flow = createSpaceFlow(/** @type {any} */ (deps));

    /** Keep my spaces table in step with the flow, and shape what a person sees. @param {string} id @param {any} view */
    const sync = async (id, view) => {
      const rec = /** @type {any} */ (await kv.get(`space-create/${id}`));
      const patch = /** @type {Record<string, any>} */ ({ status: view.status });
      if (rec) {
        if (rec.out && rec.out.rootPublic) patch.rootPublic = rec.out.rootPublic;
        if (rec.out && rec.out.home) patch.home = rec.out.home;
        else if (rec.home) patch.home = { kind: rec.home.kind, ...(rec.home.device ? { device: rec.home.device } : {}), ...(rec.home.provider ? { provider: rec.home.provider } : {}) };
        if (rec.name) { patch.label = rec.name; patch.name = `${rec.name}.vyre.run`; }
      }
      spaces.patch(id, patch, now());
      return shapeView(id, view);
    };
    const shapeView = (/** @type {string} */ id, /** @type {any} */ view) => {
      const row = spaces.get(id);
      return { ...view, space: id, address: view.address, workspaceId: row ? row.workspaceId : null, warnings: row ? row.warnings : [] };
    };

    // ---- tools ----
    /** Errors a person can read: ours and the libraries' carry a short lowercase code; anything else is logged and made plain. */
    /** The claimed identity IS the kernel's owner (one person, ruled 4 Oct): the first call after the claim (or after a start that finds one) hands the kernel the identity's id, once. */
    /** @type {Promise<void> | null} */ let adopting = null;
    const adoptOnce = async () => {
      if (!K || typeof K.adoptOwner !== "function") return;
      let s; try { s = identity.status(); } catch { return; }
      if (!s || !s.exists || !s.id || s.id === K.owner) return;
      try { if (typeof K.owner === "string" && !(await kv.get("home-first-owner"))) await kv.put("home-first-owner", K.owner); } catch { /* the space.json record still names it */ }
      try { await K.adoptOwner(s.id); } catch (e) { ctx.log.warn(`the kernel could not take your identity as its owner: ${String(/** @type {any} */ (e).message || e).slice(0, 160)}`); }
    };
    /** Every Space this home hosts has the claimed identity as its owner too (a Space made before the claim, or by an older build, still has the first-start id): the same once-only adoption in each hosted kernel. */
    /** The ids this home's owner has had before the claimed identity: the home kernel's space.json says it (previous_owner) and the module keeps what it saw at the first adoption. */
    const firstOwners = () => {
      const out = new Set();
      try { const j = JSON.parse(fs.readFileSync(path.join(ctx.paths.root, "kernel", "space.json"), "utf8")); if (typeof j.previous_owner === "string") out.add(j.previous_owner); if (typeof j.owner === "string" && K && j.owner !== K.owner) out.add(j.owner); } catch { /* none */ }
      if (K && typeof K.owner === "string") { try { const r = /** @type {any} */ (db.prepare("SELECT value FROM spaces_kv WHERE key = 'home-first-owner'").get()); if (r) out.add(JSON.parse(r.value)); } catch { /* none */ } }
      return out;
    };
    /** @type {Set<string>} */ const hostedAdopted = new Set();
    const adoptHosted = async () => {
      if (!K || !K.spaces || typeof K.spaces.list !== "function") return;
      let s; try { s = identity.status(); } catch { return; }
      if (!s || !s.exists || !s.id) return;
      for (const id of K.spaces.list()) {
        const h = kernelHandle(id);
        const k = h && h.hosted === true ? h.kernel : null;
        if (!k || typeof k.kernelFor !== "function" || id === (K.space) || hostedAdopted.has(id + s.id)) continue;
        try {
          const hk = k.kernelFor({ name: "spaces", needs: { kernel: { spaces: true } } });
          // ONLY a space hosted for this home's own first-start owner takes the claimed identity: a space hosted for somebody else (a person's own space this home hosts for them) is never touched.
          if (hk && typeof hk.adoptOwner === "function" && hk.owner !== s.id && firstOwners().has(String(hk.owner))) await hk.adoptOwner(s.id);
          hostedAdopted.add(id + s.id);
        } catch (e) { ctx.log.warn(`a hosted space could not take your identity as its owner (${id}): ${String(/** @type {any} */ (e).message || e).slice(0, 120)}`); }
      }
    };
    // single-flight: callers that arrive while one is running wait for it; the slot is cleared only AFTER the promise is stored (an early return must not leave a finished promise in it)
    const adoptOwner = () => { if (adopting) return adopting; const p = adoptOnce().then(adoptHosted); adopting = p; const clear = () => { if (adopting === p) adopting = null; }; p.then(clear, clear); return p; };
    const guarded = (/** @type {(i: any, meta: any) => any} */ fn) => async (/** @type {any} */ i, /** @type {any} */ meta) => {
      await adoptOwner();
      try { const out = await fn(i || {}, meta || {}); await adoptOwner(); return out; } catch (e) { // after too: a call that claims or recovers the identity makes it the kernel's owner at once, not at the next call
        const err = /** @type {any} */ (e);
        if (err && typeof err.code === "string" && /^[a-z][a-z0-9_.-]{1,40}$/.test(err.code) && typeof err.message === "string") throw err;
        ctx.log.error(`a spaces tool failed: ${err && err.name}: ${String(err && err.message).slice(0, 200)}`);
        throw refuse("Something went wrong. Try again in a moment.", "failed");
      }
    };
    const tool = (/** @type {string} */ name, /** @type {string} */ description, /** @type {any} */ input, /** @type {any} */ run, /** @type {any} */ extra = {}) =>
      ctx.tool(name, { description, input, run: guarded(run), ...extra });

    const publicIdentity = (/** @type {any} */ s) => ({
      exists: s.exists, name: s.name ? `${s.name}.vyre.run` : null, label: s.name, id: s.id, eid: s.eid, keyId: s.keyId, pending: s.pending, seq: s.seq, store: identity.kind,
    });
    /** A recovery password is optional; when there is one it must be long enough to be worth the stretching (four or more words is best). @param {any} i */
    const passwordOf = i => {
      const pw = i.password === undefined ? "" : String(i.password);
      if (pw && (pw.length < PASSWORD_MIN || pw.length > 256)) throw refuse(`A recovery password is ${PASSWORD_MIN} or more characters. Four or more words is best.`, "bad_password");
      return pw;
    };
    const idFail = (/** @type {any} */ e) => {
      const err = /** @type {any} */ (e);
      if (err && typeof err.code === "string" && /^[a-z][a-z0-9_.-]{1,40}$/.test(err.code) && !["unreachable", "directory"].includes(err.code)) return err;
      return refuse(plainDirectory(err), "failed");
    };

    // 1. identity: a permanent id and a signed list of who can speak for it (devices, a recovery code, optional recovery contacts)
    tool("spaces.identity.status", "This device's Vyre identity: its name, its permanent id and its place on the list. No key is ever shown.", obj(),
      async () => publicIdentity(identity.status()));

    tool("spaces.identity.id", "This device's permanent identity id, or null when none is claimed yet. The one place the id is kept is this module; pairing and install read it here, never keep their own. For modules.", obj(),
      async () => { const st = identity.status(); return { id: st.exists && !st.pending ? st.id : null }; }, { internal: true });

    tool("spaces.identity.create", "Make this device's key and your identity, and claim your Vyre name (for example alex.vyre.run). The recovery code comes back in this reply only: show it to the person once and never keep a copy. A recovery password is optional (four or more words is best); with one, the paper alone is not enough.",
      obj({ name: str, password: str, deviceLabel: str }, ["name"]), async i => {
        const st = identity.status();
        if (st.exists) throw refuse(st.name ? `This device already has the name ${st.name}.vyre.run.` : "This device already has a Vyre identity.", "exists");
        const label = String(i.name || "").trim().toLowerCase().replace(/\.vyre\.run$/, "");
        if (!label) throw refuse("Choose a name.", "bad_name");
        const password = passwordOf(i);
        let made;
        try {
          const c = await dir.check(label);
          if (c.status === "taken") throw refuse("That name is taken. Pick another.", "name_taken");
          if (c.status !== "ok" && c.status !== "mine") throw refuse(c.status === "reserved" ? "That name is reserved. Pick another." : `That name can't be used: ${c.why}.`, "bad_name");
          made = await idops.create({ name: label, password, deviceLabel: i.deviceLabel ? String(i.deviceLabel) : undefined });
        } catch (e) { const err = /** @type {any} */ (e); if (err.code === "name_taken" || err.code === "bad_name") throw err; throw idFail(err); }
        emit("identity.created", { name: `${label}.vyre.run`, id: made.status.id, at: now() });
        return {
          ...publicIdentity(made.status),
          recoveryCode: made.recoveryCode, passwordSet: made.passwordSet,
          note: "This recovery code is shown once. Write it down somewhere safe. " + (made.passwordSet ? "It works only with the recovery password you chose, so remember it. " : "Add a recovery password (four or more words) so the paper alone is not enough. ") + "Any one of your devices, this code, or two recovery contacts can bring you back, and the recovery code can only add a device, and a new sign-in cannot remove older ones for 24 hours, so none of them can take your name from you in a day.",
        };
      });

    tool("spaces.identity.resolve", "Look up a Vyre name (or an own domain) by its exact name and verify its list. Returns the kind, the permanent id and the list's head. There is no way to browse names.",
      obj({ name: str, pin: str }, ["name"]), async i => {
        const text = String(i.name || "").trim().toLowerCase();
        const alias = text.includes(".") && !text.endsWith(".vyre.run");
        let r;
        try { r = await dir.resolve(alias ? text : text.replace(/\.vyre\.run$/, ""), { alias, pin: parsePin(i.pin) }); } catch (e) { throw refuse(plainDirectory(e), "not_found"); }
        if (!r.ok) throw refuse(`That name could not be verified: ${r.why}.`, r.code || "unverified");
        return {
          name: alias ? (r.payload && r.payload.name ? `${r.payload.name}.vyre.run` : null) : `${text.replace(/\.vyre\.run$/, "")}.vyre.run`, kind: r.kind, id: r.id, pin: pinText(r.pin),
          label: (r.payload && r.payload.label) || null, ...(r.kind === "space" && r.payload ? { spaceId: r.payload.id } : {}), aliases: r.aliases, entries: r.state.entries.length, words: fingerprintWords(crypto.createHash("sha256").update(`vyre-identity-fingerprint-v1\n${r.id}`).digest("hex")),
        };
      });

    // ---- the sealing process's copy of the person's identity chain (R-8): `ctx.kernel.presence` carries the calls, the process checks everything itself (the chain, the pin, that the device was not barred,
    // that the chain's person is the one named). After every change to the list this device sends the new chain (`sync`), best effort: a box with no sealing process simply has none to tell. ----
    const presenceOf = () => (ctx.kernel && ctx.kernel.presence ? ctx.kernel.presence : null);
    /** @param {any} meta */
    const syncPresence = async meta => {
      const P = presenceOf();
      if (!P) return;
      try { const st = identity.status(); if (st.exists && !st.pending) await P.sync({ chain: await ctx.kernel.chain(meta), person: st.id, ops: identity.ops(), binds: [] }); } catch (e) { ctx.log.warn(`presence sync was not sent: ${/** @type {Error} */ (e).message}`); }
    };
    const needPresence = () => { const P = presenceOf(); if (!P) throw refuse("This computer has no sealing process running, so there is no presence to recover.", "unavailable"); return P; };
    tool("spaces.presence.begin", "On a new device that has lost every presence key: ask the sealing process for the one-time token the recovery needs, for the key this device just made (its id and public key).",
      obj({ key_id: str, spki: str }, ["key_id", "spki"]), async (i, meta) => {
        const P = needPresence(), st = me();
        return P.begin({ chain: await ctx.kernel.chain(meta), person: st.id, key_id: String(i.key_id), spki: String(i.spki) });
      });
    tool("spaces.presence.recover", "After taking your identity back (the recovery code, or two contacts): give the sealing process the new presence key, vouched for by this device's own key on your list. The process checks your list; the new key counts as a newcomer for 24 hours.",
      obj({ key_id: str, spki: str, signer: str, token: str, attestation: obj() }, ["key_id", "spki", "signer", "token"]), async (i, meta) => {
        const P = needPresence(), st = me();
        const bind = { eid: /** @type {string} */ (st.eid), sig: b64u(await identity.sign(bindBytes(String(st.id), String(i.key_id), String(i.spki)))) };
        return P.recover({ chain: await ctx.kernel.chain(meta), person: st.id, ops: identity.ops(), bind, key_id: String(i.key_id), spki: String(i.spki), signer: String(i.signer), token: String(i.token), ...(i.attestation ? { attestation: i.attestation } : {}) });
      });
    tool("spaces.presence.sync", "Send the sealing process your current identity list, so a device you removed loses its presence key at once.", obj(), async (_i, meta) => { me(); needPresence(); await syncPresence(meta); return { ok: true }; });

    tool("spaces.identity.entries", "Who can speak for you: your devices, your recovery code and your recovery contacts, with which are new sign-ins (under 24 hours old).", obj(),
      async () => { me(); return { id: identity.status().id, entries: await idops.entries() }; });
    tool("spaces.identity.entry.add", "Add a device (its public key from pairing) or a recovery contact (the key the contact made for you). Signed by this device. A sign-in under 24 hours old cannot add a contact.",
      obj({ kind: { type: "string", enum: ["device", "contact"] }, publicKey: str, label: str }, ["publicKey"]), async (i, meta) => {
        me();
        try { const r = await idops.addEntry({ kind: i.kind || "device", publicKey: i.publicKey, label: i.label }); await syncPresence(meta); return r; } catch (e) { throw idFail(e); }
      });
    tool("spaces.identity.entry.remove", "Take a device or contact off your list in one tap. Any older device can remove a newcomer. A sign-in under 24 hours old can remove only newer sign-ins.",
      obj({ eid: str }, ["eid"]), async (i, meta) => { me(); try { const r = await idops.removeEntry(String(i.eid)); await syncPresence(meta); return r; } catch (e) { throw idFail(e); } });
    tool("spaces.identity.code.replace", "Make a new recovery code (and optionally a new recovery password); the old code stops working. The code comes back in this reply only.",
      obj({ password: str }), async i => {
        me();
        try { return await idops.replaceCode({ password: passwordOf(i) }); } catch (e) { throw idFail(e); }
      });
    tool("spaces.identity.sync", "Check the directory for changes to your list: new sign-ins and removals (each is an alert), whether this device was removed, and whether the directory answered with a stale or different list.",
      obj(), async (_i, meta) => { me(); try { const r = await idops.sync(); await syncPresence(meta); return r; } catch (e) { throw idFail(e); } });
    tool("spaces.identity.recover.code", "On a new device: take your identity back with the recovery code (and the recovery password if you set one). Works at once; the new sign-in is a newcomer for 24 hours.",
      obj({ name: str, code: str, password: str, deviceLabel: str }, ["name", "code"]), async (i, meta) => {
        try {
          const r = await idops.recoverWithCode({ name: String(i.name).trim().toLowerCase().replace(/\.vyre\.run$/, ""), code: String(i.code), password: i.password === undefined ? "" : String(i.password), deviceLabel: i.deviceLabel ? String(i.deviceLabel) : undefined });
          await syncPresence(meta);
          return publicIdentity(r.status);
        } catch (e) { throw idFail(e); }
      });
    tool("spaces.identity.contact.key", "As a recovery contact: make the approval key for someone's identity and give them its public half. This device keeps the private half and signs when they ask, after you approve.",
      obj({ name: str }, ["name"]), async i => { me(); return idops.makeContactKey(String(i.name).replace(/\.vyre\.run$/, "")); });
    /** @type {Map<string, { request: any, key: any }>} */
    const recoveries = new Map();
    tool("spaces.identity.recover.begin", "On a new device with nothing else: ask your recovery contacts. Returns a request to pass to two of them.",
      obj({ name: str, deviceLabel: str }, ["name"]), async i => {
        try {
          const b = await idops.beginContactRecovery({ name: String(i.name).trim().toLowerCase().replace(/\.vyre\.run$/, ""), deviceLabel: i.deviceLabel ? String(i.deviceLabel) : undefined });
          const requestId = `rec_${crypto.randomBytes(9).toString("base64url")}`;
          recoveries.set(requestId, { request: b.request, key: b.key });
          if (recoveries.size > 8) recoveries.delete(/** @type {string} */ (recoveries.keys().next().value));
          return { requestId, request: b.request, contacts: b.contacts };
        } catch (e) { throw idFail(e); }
      });
    tool("spaces.identity.recover.approve", "As a recovery contact: approve someone's recovery request. Needs your approval on this device.",
      obj({ request: obj() }, ["request"]), async i => { try { return await idops.approveRecovery(i.request); } catch (e) { throw idFail(e); } },
      { presence: { summary: (/** @type {any} */ i) => `Help ${i && i.request && i.request.name ? i.request.name : "someone"} get their Vyre identity back` } });
    tool("spaces.identity.recover.finish", "On the new device: put two contacts' approvals on the request and take your identity back.",
      obj({ requestId: str, approvals: { type: "array", items: obj({ eid: str, sig: str }, ["eid", "sig"]) } }, ["requestId", "approvals"]), async (i, meta) => {
        const pending = recoveries.get(String(i.requestId));
        if (!pending) throw refuse("That recovery is no longer waiting. Start again.", "not_found");
        try {
          const r = await idops.finishContactRecovery({ request: pending.request, key: pending.key, approvals: i.approvals });
          recoveries.delete(String(i.requestId));
          await syncPresence(meta);
          return publicIdentity(r.status);
        } catch (e) { throw idFail(e); }
      });

    /** The identity (the person's or a space's) an alias call is about, with who signs for it. @param {any} i */
    const aliasTarget = async i => {
      if (i.space) {
        const { row } = mine(i.space);
        const { state } = await stateOfSpace(row.id);
        return { name: row.label, id: state.id, signer: await ownerSigner(), row };
      }
      const s = me();
      if (i.name && String(i.name).toLowerCase().replace(/\.vyre\.run$/, "") !== s.name) throw refuse("That is not this device's name.", "forbidden");
      return { name: /** @type {string} */ (s.name), id: /** @type {string} */ (s.id), signer: selfSigner(), row: null };
    };
    tool("spaces.identity.alias", "The DNS TXT record to publish at _vyre-id.<your domain> so your own domain can sit on top of your Vyre name (or a space's). Publish it, then call spaces.identity.alias.add.",
      obj({ name: str, domain: str, space: str }, ["domain"]), async i => {
        const t = await aliasTarget(i);
        const txt = await dir.aliasTxt(t.name, t.id, String(i.domain).trim().toLowerCase(), t.signer);
        return { name: `${t.name}.vyre.run`, host: txt.host, value: txt.value, then: "Publish this TXT record, wait for DNS, then add the domain." };
      });
    tool("spaces.identity.alias.add", "Add an own domain to your Vyre name (or a space's) once its TXT record is published.",
      obj({ name: str, domain: str, space: str }, ["domain"]), async i => {
        const t = await aliasTarget(i);
        let r;
        try { r = await dir.addAlias(t.name, String(i.domain).trim().toLowerCase()); } catch (e) { throw refuse(plainDirectory(e), /** @type {any} */ (e).code || "failed"); }
        if (t.row) { spaces.patch(t.row.id, { aliases: r.aliases }, now()); }
        emit("identity.alias-added", { name: `${t.name}.vyre.run`, domain: r.domain, at: now() });
        return { name: `${t.name}.vyre.run`, domain: r.domain, aliases: r.aliases };
      });

    // 2. spaces
    tool("spaces.create", "Create a space and say where it will live: a server you have (the one command, then a code), a new server (DigitalOcean) or this computer. Runs step by step and can be resumed or cancelled.",
      obj({ name: str, displayName: str, home: HOME, headscale: { type: "boolean" }, storeChoice: { type: "string", enum: ["create", "cancel"] } }, ["name", "home"]), async (i, meta) => {
        const s = me();
        const label = String(i.name || "").trim().toLowerCase().replace(/\.vyre\.run$/, "");
        if (!label) throw refuse("Give the space a name.", "bad_name");
        let spaceId = `spc_${crypto.randomBytes(8).toString("hex")}`;
        // A Space the kernel hosts here is made by the kernel (its own id, store and key). The kernel says first what store it would use: on a server too small for the larger one
        // it needs the person's confirmation, in the kernel's own words, and only on "create" is the Space made, with the flag that says they accepted the built-in store.
        // A space whose home is a PAIRED SERVER is hosted by that server (DESIGN-spaces-first, "Where a space is hosted"): the server's kernel makes it (key, store, log, files there) and answers THE id;
        // this device keeps only the row. A server that is not yet paired goes through the code step as before. "On this computer" stays local.
        let remoteServer = null;
        if (i.home && i.home.kind === "server" && i.home.device && typeof i.home.device.id === "string" && await pairedServer(i.home.device.id)) remoteServer = i.home.device.id;
        const KS = !remoteServer && K && K.spaces && typeof K.spaces.host === "function" ? K.spaces : null;
        if (remoteServer) {
          const made = await remoteCall(remoteServer, "spaces.host-here", { name: label }, meta);
          if (!made || typeof made.space !== "string" || !/^spc_[a-z2-7]{12}$/.test(made.space)) throw refuse("The server did not give the space an id. Nothing was made.", "server_refused");
          spaceId = made.space;
          await kv.put(`server-hosted/${spaceId}`, { device: remoteServer, at: now() });
        }
        if (KS) {
          const plan = typeof KS.storePlan === "function" ? await KS.storePlan() : null;
          const confirm = plan && plan.confirm ? plan.confirm : null;
          if (confirm) {
            if (i.storeChoice === "cancel") return { status: "cancelled", reason: "You chose not to create it on this server." };
            if (i.storeChoice !== "create") return { status: "needs_confirmation", confirm: { text: confirm.text, choices: ["create", "cancel"] } };
          }
          const hosted = await KS.host({ owner: s.id, name: label, ...(confirm ? { accept_builtin_store: true } : {}) });
          spaceId = hosted.space || hosted.id;
        }
        const home = { ...i.home };
        if (home.kind === "this-computer" && !home.device) home.device = { id: s.keyId, name: "this computer", alwaysOn: false };
        spaces.insert({ id: spaceId, name: `${label}.vyre.run`, label, displayName: i.displayName ? String(i.displayName).slice(0, 80) : null, createdBy: /** @type {string} */ (s.id), status: "running", now: now() });
        spaces.patch(spaceId, { home: { kind: home.kind, ...(home.device ? { device: home.device } : {}) } }, now());
        /** @type {any} */ let view;
        try { view = await flow.createSpace({ spaceId, name: label, displayName: i.displayName, personId: s.id, home, headscale: i.headscale === true }, { vpsToken: home.token }); } catch (e) { if (KS || remoteServer) await retireHosted(spaceId, meta); throw e; }
        if ((KS || remoteServer) && view && view.status === "failed") await retireHosted(spaceId, meta);
        // The device that made the space is enrolled in it; the person's other devices see it as "Add to this device".
        { const eid = ownDeviceEid(meta), l = await enrolledList(eid); if (l !== null && !l.includes(spaceId)) await kv.put(`device-spaces/${eid}`, [...l, spaceId]); }
        return sync(spaceId, view);
            });

    // A Space made before the kernel hosted them has a module-local id (spc_ plus 16 hex) that the kernel's registry does not know. This build makes none (spaces.create hosts in the kernel first) and
    // 0.3 is the first release with Spaces, so there is nothing to move; if one is found anyway it is said once, never mapped or deleted in silence.
    if (K && K.spaces) {
      const legacy = spaces.all().filter(r => !/^spc_[a-z2-7]{12}$/.test(r.id));
      if (legacy.length) ctx.log.warn(`${legacy.length} space(s) have a module-local id the kernel's registry does not know: ${legacy.map(r => r.id).join(", ")}. They keep working without a kernel only.`);
    }

    // ---- "setup in progress": the steps after the space has its home (look, members, connectors, the first Kit) are done on the device where the person started. The state is kept here, beside the
    // space's row, and read with the space (spaces.get, spaces.list). No secret, code, key or token is ever in it: only the shape below is kept, and anything else is dropped. ----
    const SETUP_STEPS = ["look", "members", "connectors", "kit"];
    const SETUP_WHERE = ["server", "vps", "here"];
    const text = (/** @type {any} */ v, /** @type {number} */ n) => (typeof v === "string" ? v.trim().slice(0, n) : null) || null;
    /** The device a call comes from, as the person sees it. A paired device's name is the home's own row; this computer is "this computer". @param {any} meta */
    const callerDevice = async meta => {
      const f = meta && meta.kernelFacts;
      if (f && f.kind === "device" && typeof f.device_key_id === "string") {
        const r = await ctx.call("relay.device.info", { id: f.device_key_id }).catch(() => null);
        return { id: f.device_key_id, name: text(r && r.data && r.data.name, 60) || "your device" };
      }
      const st = me();
      return { id: /** @type {string} */ (st.keyId), name: "this computer" };
    };
    const setupOf = async (/** @type {string} */ id) => /** @type {any} */ (await kv.get(`setup/${id}`)) || null;
    /** What the screens read. @param {any} row @param {any} s */
    const setupView = async (row, s) => (ownsFlow(row, s) ? setupOf(row.id) : null);
    /** @param {any} i the person's input @param {any} device @param {any} [prev] @param {number} at */
    const cleanSetup = (i, device, prev, at) => {
      if (!i || typeof i !== "object" || Array.isArray(i)) throw refuse("That is not a setup state.", "bad_input");
      if (!SETUP_STEPS.includes(i.step)) throw refuse(`Setup is at one of: ${SETUP_STEPS.join(", ")}.`, "bad_input");
      if (i.where !== undefined && i.where !== null && !SETUP_WHERE.includes(i.where)) throw refuse("Where is server, vps or here.", "bad_input");
      const picks = i.picks && typeof i.picks === "object" ? i.picks : {};
      const connectors = Array.isArray(picks.connectors) ? picks.connectors.filter((/** @type {any} */ c) => typeof c === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(c)).slice(0, 50) : [];
      const kit = typeof picks.kit === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(picks.kit) ? picks.kit : null;
      return { step: i.step, device, started: prev ? prev.started : at, updated: at, name: text(i.name, 80), address: text(i.address, 120), look: text(i.look, 80), where: i.where || null, picks: { connectors, kit } };
    };
    tool("spaces.setup.save", "Keep where setup has got to for a space you are setting up (one of look, members, connectors, kit), so another device can carry on. Send setup: null when the last step is done. Only the device setup is on may save; no secret, code or key is kept.",
      obj({ space: str, setup: { type: ["object", "null"] } }, ["space", "setup"]), async (i, meta) => {
        const { row } = mine(i.space);
        const cur = await setupOf(row.id);
        const device = await callerDevice(meta);
        if (i.setup === null) {
          if (cur && cur.device.id !== device.id) throw refuse(`Setup is in progress on your ${cur.device.name}.`, "setup_elsewhere");
          if (cur) await kv.delete(`setup/${row.id}`);
          return { space: row.id, setup: null };
        }
        if (cur && cur.device.id !== device.id) throw refuse(`Setup is in progress on your ${cur.device.name}. Continue here to take it over.`, "setup_elsewhere");
        const next = cleanSetup(i.setup, cur ? cur.device : device, cur, now());
        await kv.put(`setup/${row.id}`, next);
        return { space: row.id, setup: next };
      });
    tool("spaces.setup.claim", "Continue setting up a space on this device: setup moves here from the device it was on, and the state comes back. Only the person who is setting it up can do this.",
      obj({ space: str }, ["space"]), async (i, meta) => {
        const { row } = mine(i.space);
        const cur = await setupOf(row.id);
        if (!cur) throw refuse("Nothing is being set up for that space.", "no_setup");
        const device = await callerDevice(meta);
        if (cur.device.id === device.id) return { space: row.id, setup: cur, moved: false };
        const next = { ...cur, device, updated: now() };
        await kv.put(`setup/${row.id}`, next);
        emit("space.setup-moved", { space: row.id });
        return { space: row.id, setup: next, moved: true, from: cur.device };
      });

    // ---- a device's spaces (the Access screen): which spaces a device of the person's reaches, and removing it from one without touching the others ----
    const ownDeviceEid = (/** @type {any} */ meta) => (meta && meta.kernelFacts && meta.kernelFacts.kind === "device" && meta.kernelFacts.device_key_id) || String(me().eid);
    const deviceOf = async (/** @type {any} */ id, /** @type {any} */ meta) => {
      const eid = String(id || ownDeviceEid(meta));
      const e = (await idops.entries()).find((/** @type {any} */ x) => x.eid === eid && x.kind === "device");
      if (!e) throw refuse("That is not one of your devices.", "not_found");
      return e;
    };
    /** The ids of every space this person is in (finished or not), for the default list of a device. @param {any} s @param {any} meta */
    /** The kernel's HOME space as a row like any other (by its spc_ id): a device paired to the identity that owns the home is enrolled in it, or the daemon (which treats "not enrolled" as no chain) would give a paired phone nothing there. Not stored, not in spaces.list. */
    const homeRow = (/** @type {any} */ s) => (K && typeof K.space === "string" ? { id: K.space, name: "home", label: "home", displayName: null, status: "done", createdBy: /** @type {string} */ (s.id), home: true } : null);
    const spaceOrHome = (/** @type {any} */ ref) => { try { return spaceOf(ref); } catch (e) { const h = homeRow(me()); if (h && String(ref) === h.id) return h; throw e; } };
    const personSpaceIds = async (s, meta) => {
      const ids = [];
      const h = homeRow(s);
      if (h) { const m = await membershipOf(h.id, /** @type {string} */ (s.id), meta).catch(() => null); if (m) ids.push(h.id); }
      for (const row of spaces.all()) { const m = await membershipOf(row.id, /** @type {string} */ (s.id), meta).catch(() => null); if (m || row.createdBy === s.id) ids.push(row.id); }
      return ids;
    };
    tool("spaces.devices.spaces", "The spaces a device of yours can reach, each with your role there and whether this device is enrolled in it (`enrolled: false` is the space's \"Add to this device\"). Leave device out for the device you are on.",
      obj({ device: str }), async (i, meta) => {
        const s = me();
        const dev = await deviceOf(i.device, meta);
        const out2 = [];
        const hr = homeRow(s);
        if (hr) { const m = await membershipOf(hr.id, /** @type {string} */ (s.id), meta).catch(() => null); if (m) { const enrolled = await isEnrolled(dev.eid, hr.id); out2.push({ space: hr.id, name: hr.name, label: hr.label, displayName: null, role: m.role, enrolled, removed: !enrolled, home: true }); } }
        for (const row of spaces.all()) {
          if (row.status !== "done") continue;
          const m = await membershipOf(row.id, /** @type {string} */ (s.id), meta).catch(() => null);
          if (!m && row.createdBy !== s.id) continue;
          const enrolled = await isEnrolled(dev.eid, row.id);
          out2.push({ space: row.id, name: row.name, label: row.label, displayName: row.displayName, role: m ? m.role : "owner", enrolled, removed: !enrolled });
        }
        return { device: { eid: dev.eid, label: dev.label || null, self: dev.eid === ownDeviceEid(meta) }, spaces: out2 };
      });
    /** Change the list: enrol (on) or remove (off) one space for a device. Enrolling one of the person's own devices asks for nothing more. */
    const setEnrol = async (/** @type {any} */ i, /** @type {any} */ meta, /** @type {boolean} */ on) => {
      const s = me();
      const row = spaceOrHome(i.space);
      const m = await membershipOf(row.id, /** @type {string} */ (s.id), meta).catch(() => null);
      if (!m && row.createdBy !== s.id) throw refuse("You are not a member of this space.", "not_a_member");
      const dev = await deviceOf(i.device, meta);
      const cur = (await enrolledList(dev.eid)) || await personSpaceIds(s, meta);
      const next = on ? [...new Set([...cur, row.id])] : cur.filter(x => x !== row.id);
      await kv.put(`device-spaces/${dev.eid}`, next);
      // taking the device out of the space takes its compute offers with it (kernel withdraw: a live session, no fresh proof), then the stored lend record goes
      if (!on) { await kernelOffers(row.id, dev, false, meta, m ? m.role : "owner", /** @type {string} */ (s.id)); clearLends(row.id, { device: dev.eid }); }
      if (next.length !== cur.length) emit(on ? "space.device-restored" : "space.device-removed", { space: row.id, device: dev.eid });
      return { space: row.id, device: dev.eid, enrolled: on, removed: !on };
    };
    tool("spaces.devices.remove", "Remove one of your devices from one space. The space (and the kernel) refuse it from then on; your other spaces and the device's other access are untouched.", obj({ space: str, device: str }, ["space", "device"]), (i, meta) => setEnrol(i, meta, false));
    tool("spaces.devices.restore", "Enrol a device of yours in a space again (the same as spaces.devices.enrol).", obj({ space: str, device: str }, ["space", "device"]), (i, meta) => setEnrol(i, meta, true));
    tool("spaces.devices.enrol", "Enrol a device of yours in a space: \"Add to this device\", one tap, nothing more asked. Leave device out for the device you are on.", obj({ space: str, device: str }, ["space"]), (i, meta) => setEnrol(i, meta, true));
    tool("spaces.devices.set", "Set the whole list of spaces a device is enrolled in, as pairing does: every space you are in comes pre-ticked and the person unticks the ones to leave out. Leave device out for the device you are on.",
      obj({ device: str, spaces: { type: "array", items: str } }, ["spaces"]), async (i, meta) => {
        const s = me();
        const dev = await deviceOf(i.device, meta);
        const mineIds = new Set(await personSpaceIds(s, meta));
        const ids = [...new Set(i.spaces.map((/** @type {any} */ x) => spaceOrHome(x).id))].filter(x => mineIds.has(x));
        await kv.put(`device-spaces/${dev.eid}`, ids);
        for (const sid of mineIds) if (!ids.includes(sid)) { await kernelOffers(sid, dev, false, meta, "member", /** @type {string} */ (s.id)); clearLends(sid, { device: dev.eid }); }
        emit("space.device-enrolment-set", { device: dev.eid, spaces: ids.length });
        return { device: dev.eid, spaces: ids };
      });
    tool("spaces.devices.list", "The same as spaces.devices.spaces, for the Device screen: the spaces a device of yours reaches, whether it is enrolled in each, and whether you lend it to that space.",
      obj({ device: str }), async (i, meta) => {
        const s = me();
        const dev = await deviceOf(i.device, meta);
        const out2 = [];
        const hr = homeRow(s);
        if (hr) { const m = await membershipOf(hr.id, /** @type {string} */ (s.id), meta).catch(() => null); if (m) { const enrolled = await isEnrolled(dev.eid, hr.id); out2.push({ space: hr.id, name: hr.name, label: hr.label, displayName: null, role: m.role, enrolled, removed: !enrolled, lent: false, home: true }); } }
        for (const row of spaces.all()) {
          if (row.status !== "done") continue;
          const m = await membershipOf(row.id, /** @type {string} */ (s.id), meta).catch(() => null);
          if (!m && row.createdBy !== s.id) continue;
          const enrolled = await isEnrolled(dev.eid, row.id);
          const l = await kv.get(`lend/${row.id}/${dev.eid}`);
          out2.push({ space: row.id, name: row.name, label: row.label, displayName: row.displayName, role: m ? m.role : "owner", enrolled, removed: !enrolled, lent: Boolean(l && l.lent) });
        }
        return { device: { eid: dev.eid, label: dev.label || null, self: dev.eid === ownDeviceEid(meta) }, spaces: out2 };
      });
    // Lending a computer to a space is a grant STORED ON THE HOME (this module's own table, so it survives a restart), not a setting held by the screen. The first grant for a device in a space asks for the
    // person's presence (Face ID); turning it off never does, and turning it on again after a first grant does not. Only the person whose device it is (it is on their identity list) switches it on; the
    // space's owner may switch a lent device off.
    const lendKey = (/** @type {string} */ space, /** @type {string} */ device) => `lend/${space}/${device}`;
    const lendSync = (/** @type {string} */ key) => { try { const r = /** @type {any} */ (db.prepare("SELECT value FROM spaces_kv WHERE key = ?").get(key)); return r ? JSON.parse(r.value) : null; } catch { return null; } };
    /** The kernel's compute offers for a lent computer, the ONE mechanism: the Space's side (an owner or admin) and the member's own side, bound to the computer's key. A Space with no kernel has only the stored record. */
    const kernelOffers = async (/** @type {string} */ spaceId, /** @type {any} */ dev, /** @type {boolean} */ on, /** @type {any} */ meta, /** @type {any} */ _role, /** @type {string} */ member) => {
      const h = kernelHandle(spaceId);
      const offers = h && h.gateway && h.gateway.grants && h.gateway.grants.offers;
      if (!offers || typeof offers.lend !== "function") return false;
      // the person's chain IN that Space (a hosted Space has its own key), and the proof that comes with the call. ONE kernel act: the first lend takes one proof bound to it and makes both
      // sides (an owner or admin's Space side and the member's own); the member's own turning on again, and any turning off, take only the live session (kernel ruling 5 Oct).
      const k = await kctxOf(meta, spaceId);
      try {
        if (on) await offers.lend(k.chain, { member, device: dev.eid, device_key: dev.eid }, k.proof);
        else await offers.unlend(k.chain, { member, device: dev.eid }, k.proof);
      } catch (e) { ctx.log.warn(`lend: the kernel refused: ${/** @type {any} */ (e).code || ""} ${String(/** @type {any} */ (e).hidden_reason || "")}`); throw plainKernelError(e); }
      return true;
    };
    /** Delete lend records (LD-1): a removal of the device from the Space, of the person from it, or of the Space ends the consent, so the next first grant asks Face ID again. @param {string} space @param {{ device?: string, person?: string }} [only] */
    const clearLends = (space, only = {}) => {
      let n = 0;
      try {
        for (const r of /** @type {any[]} */ (db.prepare("SELECT key, value FROM spaces_kv WHERE key LIKE ?").all(`lend/${space}/%`))) {
          let v = null; try { v = JSON.parse(r.value); } catch { /* clear it */ }
          if (only.device && String(r.key) !== lendKey(space, only.device)) continue;
          if (only.person && v && v.allowed_by !== only.person && v.device_person !== only.person) continue;
          db.prepare("DELETE FROM spaces_kv WHERE key = ?").run(r.key); n++;
        }
      } catch { /* a table that is not there has nothing to clear */ }
      return n;
    };
    /** One change at a time per record (LD-4): a lend and an unlend of the same device never interleave. @type {Map<string, Promise<any>>} */
    const lendLocks = new Map();
    const lendLocked = (/** @type {string} */ key, /** @type {() => Promise<any>} */ f) => {
      const prev = lendLocks.get(key) || Promise.resolve();
      const run = prev.then(f, f);
      const tail = run.catch(() => {});
      lendLocks.set(key, tail);
      tail.then(() => { if (lendLocks.get(key) === tail) lendLocks.delete(key); });
      return run;
    };
    /** The person the call is from, by the kernel's chain (LD-5): the person on the chain, else the home identity. */
    const callerPerson = async (/** @type {any} */ meta) => {
      const home = /** @type {string} */ (me().id);
      if (!K || typeof K.chain !== "function" || !(meta && (meta.kernelFacts || meta.token))) return home;
      try { const c = await K.chain(meta); const h = c && c.hops && c.hops.length === 1 ? c.hops[0].actor : null; return h && h.kind === "person" ? String(h.id) : home; } catch { return home; }
    };
    tool("spaces.devices.lend", "Lend one of your computers to a space, or stop. The first time for a device in a space needs your Face ID or fingerprint; stopping never does.",
      obj({ space: str, device: str, on: { type: "boolean" } }, ["space", "device", "on"]), async (i, meta) => {
        const s = me();
        const row = spaceOf(i.space);
        const caller = await callerPerson(meta);
        if (caller !== s.id) throw refuse("That is not yours to do.", "forbidden");
        const m = await membershipOf(row.id, /** @type {string} */ (s.id), meta).catch(() => null);
        if (!m && row.createdBy !== s.id) throw refuse("You are not a member of this space.", "not_a_member");
        await notRemoved(row.id, meta);
        const key = lendKey(row.id, String(i.device));
        return lendLocked(key, async () => {
          const cur = await kv.get(key);
          if (i.on !== true) {
            // off: the person whose device it is, or an owner of the space
            const owner = (m && m.role === "owner") || row.createdBy === s.id;
            let mine = true; try { await deviceOf(i.device, meta); } catch { mine = false; }
            if (!mine && !(owner && cur)) throw refuse("That is not one of your devices.", "not_found");
            if (!cur || !cur.lent) return { space: row.id, device: String(i.device), lent: false, first_grant_at: cur ? cur.first_grant_at : null, allowed_by: cur ? cur.allowed_by : null };
            const viaKernel = await kernelOffers(row.id, { eid: String(i.device) }, false, meta, m ? m.role : "owner", cur.device_person || /** @type {string} */ (s.id));
            // LD-2: the space's owner switching a computer off that is not theirs withdraws the space's consent: turning it on again asks the device's person for Face ID again
            const next = { ...cur, lent: false, ended_at: now(), ended_by: s.id, kernel: viaKernel, ...(mine ? {} : { first_grant_at: null, allowed_by: null }) };
            await kv.put(key, next);
            emit("space.device-lent", { space: row.id, device: next.device, lent: false });
            return { space: row.id, device: next.device, lent: false, first_grant_at: next.first_grant_at, allowed_by: next.allowed_by };
          }
          const dev = await deviceOf(i.device, meta);
          if (!(await isEnrolled(dev.eid, row.id))) throw refuse("That device is not in this space. Add it first.", "device_removed");
          const viaKernel = await kernelOffers(row.id, dev, true, meta, m ? m.role : "owner", /** @type {string} */ (s.id));
          const first = cur && cur.first_grant_at ? cur.first_grant_at : now();
          const next = { lent: true, kernel: viaKernel, device: dev.eid, device_person: s.id, first_grant_at: first, allowed_by: cur && cur.allowed_by ? cur.allowed_by : s.id, at: now() };
          await kv.put(key, next);
          emit("space.device-lent", { space: row.id, device: dev.eid, lent: true });
          return { space: row.id, device: dev.eid, lent: true, first_grant_at: next.first_grant_at, allowed_by: next.allowed_by };
        });
      }, { presence: { summary: (/** @type {any} */ i) => `Lend this computer to ${i && i.space}`, when: (/** @type {any} */ i) => { if (!i || i.on !== true) return false; try { const row = spaceOf(i.space); const cur = lendSync(lendKey(row.id, String(i.device))); return !(cur && cur.first_grant_at); } catch { return true; } } } });
    tool("spaces.devices.lend.status", "Whether a device of yours is lent to a space, when it was first lent and who allowed it. Only the device's person and the space's owners and admins can ask.", obj({ space: str, device: str }, ["space", "device"]), async (i, meta) => {
      const s = me();
      const row = spaceOf(i.space);
      const m = await membershipOf(row.id, /** @type {string} */ (s.id), meta).catch(() => null);
      if (!m && row.createdBy !== s.id) throw refuse("You are not a member of this space.", "not_a_member");
      let mine = true; try { await deviceOf(i.device, meta); } catch { mine = false; }
      const lead = (m && (m.role === "owner" || m.role === "admin")) || row.createdBy === s.id;
      if (!mine && !lead) throw refuse("That is not one of your devices.", "not_found");
      const cur = await kv.get(lendKey(row.id, String(i.device)));
      return { space: row.id, device: String(i.device), lent: Boolean(cur && cur.lent), first_grant_at: cur ? cur.first_grant_at : null, allowed_by: cur ? cur.allowed_by : null };
    });
    // A server paired to a person's identity (Wink pairing, once the pairing proved the identity's own key over this pairing) has the person's id as its owner too, not its first-start id (walker, step 4).
    // For the pairing module only: the kernel makes the change once, logged, and refuses a second one.
    tool("spaces.owner.adopt", "For the pairing module, after it has PROVED the identity: make this home's owner (and its hosted Spaces') the person's identity id. Once only.", obj({ person: str }, ["person"]), async i => {
      const id = String(i.person);
      if (!/^per_[a-z2-7]{26}$/.test(id)) throw refuse("That is not a person id.", "bad_input");
      if (!K || typeof K.adoptOwner !== "function") throw refuse("This home has no kernel to change.", "unavailable");
      try { const r = await K.adoptOwner(id); return { owner: r.owner, previous: r.previous, changed: r.changed }; } catch (e) { throw plainKernelError(e); }
    }, { internal: true });
    // The spaces a person owns or administers, for the pairing module's "Pair to:" choices (one id: the kernel's space id, the name the person gave it, the person's role there).
    tool("spaces.admin-list", "The finished spaces a person owns or administers here: { spaces: [{ space, name, role }] }, and the identity's own name when it is this device's. For modules (pairing targets).", obj({ person: str }, ["person"]), async (i, meta) => {
      const person = String(i.person);
      const out2 = [];
      for (const row of spaces.all()) {
        if (row.status !== "done") continue;
        const m = await membershipOf(row.id, person, meta).catch(() => null);
        const role = m ? m.role : row.createdBy === person ? "owner" : null;
        if (role === "owner" || role === "admin") out2.push({ space: row.id, name: row.displayName || row.label, role });
      }
      let st = null; try { st = identity.status(); } catch { st = null; }
      return { spaces: out2, identity: st && st.exists && st.id === person ? { id: st.id, name: st.name || null } : null };
    }, { internal: true });
    tool("spaces.identity.republish", "Put your identity's chain and each finished space's name in the directory again, for a directory that lost its claims (a test server that restarted). Says what it put back and what it could not.", obj(), async () => {
      const done = { identity: false, spaces: /** @type {string[]} */ ([]), failed: /** @type {Array<{ name: string, why: string }>} */ ([]) };
      try { await idops.republish(); done.identity = true; } catch (e) { done.failed.push({ name: "identity", why: String(/** @type {any} */ (e).message || e).slice(0, 120) }); return done; }
      for (const row of spaces.all()) {
        if (row.status !== "done" || !row.rootPublic) continue;
        const r = await deps.names.claimSpace({ name: row.label, rootPublic: row.rootPublic, record: { spaceId: row.id, displayName: row.displayName } });
        if (r && r.ok) done.spaces.push(row.name); else done.failed.push({ name: row.name, why: String((r && r.message) || "refused").slice(0, 120) });
      }
      return done;
    });
    // The Vyre name for an identity id, for the pairing question at a server ("Alex (alex.vyre.run)"). The directory has no reverse lookup, so: this device's own identity (its claimed name), else a name the asker CLAIMS
    // (owner.vyre) that the directory resolves to exactly this id, else a name this home verified when that person joined. Otherwise null: the short id is shown, never an unchecked name.
    tool("spaces.identity.name-of", "The claimed Vyre name for a person's id, verified: { name: 'alex.vyre.run' | null }. For modules.", obj({ id: str, claimed: str }, ["id"]), async i => {
      const id = String(i.id);
      let st = null; try { st = identity.status(); } catch { st = null; }
      if (st && st.exists && st.id === id && st.name) return { name: `${st.name}.vyre.run` };
      const label = typeof i.claimed === "string" ? i.claimed.trim().toLowerCase().replace(/\.vyre\.run$/, "") : "";
      if (label && /^[a-z0-9][a-z0-9-]{1,30}$/.test(label)) { try { const r = await dir.resolve(label); if (r.ok && r.kind === "person" && r.id === id) return { name: `${label}.vyre.run` }; } catch { /* unreachable: no name */ } }
      const known = await kv.get(`person-name/${id}`);
      return { name: typeof known === "string" && known ? `${known}.vyre.run` : null };
    }, { internal: true });
    /** Is this id a device the box actually knows as the person's paired device? An ACTIVE relay_devices row of kind app (the table the relay trusts for `device:<id>` labels), or an active wink_devices row of that identity, or an entry on the identity's own list. Any other id (invented, removed, another person's) is not. */
    const isPairedDevice = async (/** @type {string} */ device, /** @type {string | null} */ person) => {
      try { if (db.prepare("SELECT 1 FROM relay_devices WHERE id = ? AND removed_at IS NULL AND kind = 'app'").get(device)) return true; } catch { /* no relay table */ }
      try { if (person && db.prepare("SELECT 1 FROM wink_devices WHERE id = ? AND identity = ? AND removed_at IS NULL").get(device, person)) return true; } catch { /* no wink table */ }
      try { const st = identity.status(); if (st && st.exists && (st.eid === device || (await idops.entries()).some((/** @type {any} */ e) => e.kind === "device" && e.eid === device))) return true; } catch { /* no identity */ }
      return false;
    };
    /** The spaces a person belongs to right now, by the kernel (the home first). */
    const kernelSpacesOf = async (/** @type {string} */ person) => {
      const ids = [];
      if (K && typeof K.membership === "function") {
        if (typeof K.space === "string" && (await K.membership(person, K.space).catch(() => ({ member: false }))).member === true) ids.push(K.space);
        // every space this home's kernel hosts (made here, or hosted for the person by spaces.host-here), plus the module's finished rows that have a kernel
        const all = new Set([...(K.spaces && typeof K.spaces.list === "function" ? K.spaces.list() : []), ...spaces.all().filter(r => r.status === "done").map(r => r.id)]);
        for (const id of all) if (id !== K.space && kernelHandle(id) && (await K.membership(person, id).catch(() => ({ member: false }))).member === true) ids.push(id);
      }
      return [...new Set(ids)];
    };
    /** A MEMBER's device (another person's, invited to a space this home hosts): the person whose own identity list carries this device as a device entry, among the people this home has verified by name
     * (person-name/<id>, written when they joined). Read from the directory, cached a minute. Null when no known person's list has it. @type {Map<string, { at: number, person: string | null }>} */
    const memberDeviceCache = new Map();
    const memberDevicePerson = async (/** @type {string} */ device) => {
      const hit = memberDeviceCache.get(device);
      if (hit && Date.now() - hit.at < 60_000) return hit.person;
      let person = null;
      try {
        for (const r of /** @type {any[]} */ (db.prepare("SELECT key, value FROM spaces_kv WHERE key LIKE 'person-name/%' LIMIT 200").all())) {
          const id = String(r.key).slice("person-name/".length);
          let label = null; try { label = JSON.parse(r.value); } catch { continue; }
          if (typeof label !== "string" || !label) continue;
          try {
            const v = await dir.resolve(label, { resolve: ownerLookup });
            if (v && v.ok && v.id === id && v.kind === "person" && Array.isArray(v.state && v.state.entries) && v.state.entries.some((/** @type {any} */ e) => e.kind === "device" && e.eid === device)) { person = id; break; }
          } catch { /* that person's list could not be read: not them */ }
        }
      } catch { person = null; }
      memberDeviceCache.set(device, { at: Date.now(), person });
      return person;
    };
    const homePerson = () => { let who = null; try { const st = identity.status(); who = st && st.exists ? st.id : null; } catch { who = null; } return who || (K && typeof K.owner === "string" ? K.owner : null); };
    // The SERVER's half of "a space whose home is this server": the creating device asks over the paired session and THIS home's kernel hosts the Space (kernel, store, key, log live here), for this
    // home's owner (the identity that paired it). Idempotent for a given id. Only the owner person acts: a chain that is not exactly the home's owner is refused.
    /** Only exactly this home's owner (one person on the chain, equal to the kernel's owner). @param {any} meta */
    const ownerOnly = async meta => {
      if (!K || typeof K.owner !== "string") throw refuse("This home has no kernel to host a space.", "unavailable");
      let person = null;
      try { const c = await K.chain(meta); const h = c && c.hops && c.hops.length === 1 ? c.hops[0].actor : null; person = h && h.kind === "person" ? String(h.id) : null; } catch { person = null; }
      if (!person || person !== K.owner) throw refuse("Only this home's owner can have it host a space.", "forbidden");
    };
    tool("spaces.retire-here", "On a server: take back a space that was only started here (a failed or cancelled create). Refuses a space with content (fail closed).", obj({ id: str }, ["id"]), async (i, meta) => {
      await ownerOnly(meta);
      if (!K || !K.spaces || typeof K.spaces.retire !== "function") throw refuse("This home has no kernel to change.", "unavailable");
      try { return await K.spaces.retire(String(i.id)); } catch (e) { throw plainKernelError(e); }
    }, { presence: { summary: (/** @type {any} */ i) => `Take back the space ${i && i.id} on this server` } });
    tool("spaces.host-here", "On a server: host a new space in THIS home's kernel for its owner (called by the owner's device over the paired session when a space is made with this server as its home). Answers { space }. Idempotent when given the id.", obj({ name: str, id: str }, ["name"]), async (i, meta) => {
      if (!K || !K.spaces || typeof K.spaces.host !== "function" || typeof K.owner !== "string") throw refuse("This home has no kernel to host a space.", "unavailable");
      let person = null;
      try { const c = await K.chain(meta); const h = c && c.hops && c.hops.length === 1 ? c.hops[0].actor : null; person = h && h.kind === "person" ? String(h.id) : null; } catch { person = null; }
      if (!person || person !== K.owner) throw refuse("Only this home's owner can have it host a space.", "forbidden");
      const label = String(i.name || "").trim().toLowerCase().replace(/\.vyre\.run$/, "");
      if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(label)) throw refuse("That is not a space name.", "bad_name");
      if (typeof i.id === "string" && i.id) {
        if (!/^spc_[a-z2-7]{12}$/.test(i.id)) throw refuse("That is not a space id.", "bad_input");
        if (K.spaces.hosts(i.id) === true) return { space: i.id, existed: true };
      }
      try { const h = await K.spaces.host({ owner: K.owner, name: label, ...(typeof i.id === "string" && i.id ? { id: i.id } : {}) }); return { space: h.space || h.id, existed: false }; } catch (e) { throw plainKernelError(e); }
    }, { presence: { summary: (/** @type {any} */ i) => `Make the space ${i && i.name} on this server` } });
    // Which paired server hosts a space this device made with a server as its home (null for a space hosted here): for the module that opens the remote path to that Space.
    tool("spaces.server-of", "The paired server's device id that hosts a space this device made, or null. For modules.", obj({ space: str }, ["space"]), async i => ({ device: await serverOf(String(i.space)) }), { internal: true });
    tool("spaces.devices.enrolled", "Whether a device is enrolled in a space (true when the device has no list yet). For the kernel and other modules, which refuse a device that is not.", obj({ device: str, space: str }, ["device", "space"]),
      async i => {
        // A Space this module has no row for (the home's own Space, which the kernel makes before any space is created here) is asked by its id as given: no list means enrolled.
        // The device argument comes from other modules and the kernel (internal is reach, not trust): only the shapes a device id has are looked up (a relay device id or an enrolment entry id).
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(i.device))) return { enrolled: false };
        // Only a device the box knows as this person's paired device is ever enrolled anywhere, with a list or without; an id in none of the tables answers false and writes nothing.
        let memberPerson = null;
        if (K && !(await isPairedDevice(String(i.device), homePerson()))) {
          // not the home person's device: a MEMBER's device is enrolled in a space only when it is a device on that member's own identity list AND the member is an active member of that space NOW
          memberPerson = await memberDevicePerson(String(i.device));
          let ok = false;
          if (memberPerson && typeof K.membership === "function") { try { ok = (await K.membership(memberPerson, String(i.space))).member === true; } catch { ok = false; } }
          return { enrolled: ok };
        }
        let id = String(i.space);
        let known = true;
        let rowStatus = "done";
        try { const r0 = spaceOf(i.space); id = r0.id; rowStatus = r0.status; } catch { known = false; }
        // A space this module has marked cancelled, or one still being made, is no space to be enrolled in.
        if (known && rowStatus !== "done") return { enrolled: false };
        // FAIL CLOSED: a space this module has no row for is enrolled only if the KERNEL hosts it (the home, or one it hosts) and the home's person belongs to it. "No list means every space" is
        // every space the person BELONGS to, never an id nobody here has heard of.
        if (!known) {
          if (!K || typeof K.space !== "string") return { enrolled: false };
          const hosted = id === K.space || (K.spaces && typeof K.spaces.hosts === "function" && K.spaces.hosts(id) === true);
          if (!hosted) return { enrolled: false };
          let who = null; try { const st = identity.status(); who = st && st.exists ? st.id : null; } catch { who = null; }
          const person = who || (typeof K.owner === "string" ? K.owner : null);
          let member = false;
          if (person && typeof K.membership === "function") { try { member = (await K.membership(person, id)).member === true; } catch { member = false; } }
          if (!member) return { enrolled: false };
        }
        // Belonging is asked of the kernel NOW (a removed, expired, revoked member is not enrolled anywhere): for a space with a kernel, whoever this home's person is must be an active member.
        if (known && K && kernelHandle(id)) {
          let who = null; try { const st = identity.status(); who = st && st.exists ? st.id : null; } catch { who = null; }
          const person = who || (typeof K.owner === "string" ? K.owner : null);
          let member = false;
          if (person && typeof K.membership === "function") { try { member = (await K.membership(person, id)).member === true; } catch { member = false; } }
          if (!member) return { enrolled: false };
        }
        const deviceId = String(i.device);
        // Migration by contact: a device that is asked about and has no explicit list yet gets one written NOW (the spaces its person belongs to at this moment), logged once. From then on a space the
        // person joins later is not added to it by itself: "Add to this device" is the person's own tap.
        if ((await enrolledList(deviceId)) === null && K && typeof K.membership === "function") {
          try {
            const person = homePerson();
            if (person) {
              const ids = await kernelSpacesOf(person);
              await kv.put(`device-spaces/${deviceId}`, ids);
              ctx.log.warn(`device ${deviceId} had no space list: now enrolled in ${ids.length} space(s) it belonged to at first contact`);
            }
          } catch { /* the answer below stands without a list */ }
        }
        return { enrolled: await isEnrolled(deviceId, id) };
      }, { internal: true });

    tool("spaces.list", "Spaces on this device that you created or belong to, with your role in each. For a space with a kernel the role is the kernel's answer. On a server that has no identity of its own (paired to yours), the spaces its kernel hosts for its owner.", obj(), async (_i, meta) => {
      let st0 = null; try { st0 = identity.status(); } catch { st0 = null; }
      if ((!st0 || !st0.exists) && K && K.spaces && typeof K.spaces.list === "function" && typeof K.owner === "string") {
        const mine = [];
        for (const id of K.spaces.list()) {
          // the kernel's own answer for the home's person (no caller chain needed: a terminal on a server is not always recognised as the person, and this list is the owner's own)
          let m = null; try { const r = await K.membership(K.owner, id); if (r && r.member === true) m = { role: r.role }; } catch { m = null; }
          if (!m) continue;
          const d0 = typeof K.spaces.describe === "function" ? K.spaces.describe(id) : null;
          mine.push({ id, name: d0 && d0.name ? `${String(d0.name).replace(/\.vyre\.run$/, "")}.vyre.run` : null, label: d0 && d0.name ? String(d0.name).replace(/\.vyre\.run$/, "") : null, displayName: null, status: "done", home: id === K.space ? { kind: "this-computer" } : null, role: m.role, aliases: [], workspaceId: null, warnings: [], hosted: true });
        }
        return mine;
      }
      const s = me();
      const rows = [];
      for (const row of spaces.all()) rows.push({ row, m: await membershipOf(row.id, /** @type {string} */ (s.id), meta).catch(() => null) });
      const out = [];
      for (const { row, m } of rows) {
        if (!m && row.createdBy !== s.id) continue;
        // A space is listed once it has its home. One still being made (or whose server step failed) is not a space yet: its steps are spaces.status and spaces.resume.
        if (row.status !== "done") continue;
        if (await notRemoved(row.id, meta).then(() => false, () => true)) continue;
        out.push({ ...(row.home && row.home.kind === "server" && K && K.spaces && K.spaces.hosts(row.id) === true && !(await serverOf(row.id)) ? { hostedHere: true, note: "hosted on this device, home says server" } : {}), id: row.id, name: row.name, label: row.label, displayName: row.displayName, status: row.status, home: row.home, role: m ? m.role : null, aliases: row.aliases, workspaceId: row.workspaceId, warnings: row.warnings, createdAt: row.createdAt, setup: await setupView(row, s) });
      }
      return out;
    });

    tool("spaces.get", "One space: its name, home, owners and warnings.", obj({ space: str }, ["space"]), async (i, meta) => {
      const row = spaceOf(i.space);
      const s = me();
      await notRemoved(row.id, meta);
      if (row.createdBy !== s.id) await gate(row.id, undefined, meta);
      const m = await members(row.id, meta);
      const all = await m.list();
      return {
        id: row.id, name: row.name, label: row.label, displayName: row.displayName, status: row.status, home: row.home, aliases: row.aliases, workspaceId: row.workspaceId,
        warnings: [...row.warnings, ...(await m.warnings())], members: all.length, owners: await m.ownerCount(), role: ((await membershipOf(row.id, /** @type {string} */ (s.id), meta)) || {}).role || null,
        roleNames: m.getDisplayNames(), createdAt: row.createdAt, setup: await setupView(row, s),
      };
    });

    tool("spaces.status", "Where creating a space has got to: each step, what it is waiting for, and why anything failed, in plain words.", obj({ space: str }, ["space"]), async i => {
      const { row } = mine(i.space);
      if (!(await kv.get(`space-create/${row.id}`))) return { spaceId: row.id, space: row.id, status: row.status, name: row.label, steps: [], waiting: null, failed: null, warnings: row.warnings, workspaceId: row.workspaceId };
      return shapeView(row.id, await flow.status(row.id));
    });

    tool("spaces.resume", "Continue creating a space from the last good step. Give a new name if the first was taken, confirm 'this computer' if asked, or paste the server token again.",
      obj({ space: str, name: str, confirmThisComputer: { type: "boolean" }, vpsToken: str }, ["space"]), async i => {
        const { row } = mine(i.space);
        const ctx2 = /** @type {any} */ ({});
        if (i.name) ctx2.name = String(i.name).trim().toLowerCase().replace(/\.vyre\.run$/, "");
        if (i.confirmThisComputer) ctx2.confirmThisComputer = true;
        if (i.vpsToken) ctx2.vpsToken = String(i.vpsToken);
        // a creation that failed gave its kernel Space back: host it again under the same id before going on
        if (row.status !== "done" && K && K.spaces && typeof K.spaces.host === "function" && /^spc_[a-z2-7]{12}$/.test(row.id) && !kernelHandle(row.id)) {
          try { await K.spaces.host({ owner: /** @type {string} */ (me().id), name: row.label, id: row.id }); } catch (e) { ctx.log.warn(`the kernel could not start the space again: ${String(/** @type {any} */ (e).message || e).slice(0, 120)}`); }
        }
        const rv = await flow.resume(row.id, ctx2);
        if (rv && rv.status === "failed") await retireHosted(row.id);
        return sync(row.id, rv);
      });

    tool("spaces.cancel", "Stop creating a space and roll back what can be rolled back: the name, the key, a new server. Says what it could not remove.",
      obj({ space: str, vpsToken: str }, ["space"]), async i => {
        const { row } = mine(i.space);
        const r = await flow.cancel(row.id, i.vpsToken ? { vpsToken: String(i.vpsToken) } : {});
        if (r.cancelled) { spaces.patch(row.id, { status: "cancelled" }, now()); await kv.delete(`setup/${row.id}`); await retireHosted(row.id, undefined); }
        return { ...r, space: row.id };
      });

    tool("spaces.code.submit", "The new server sends the code its person typed (or, for a second server, with join). The two numbers must match, five tries, ten minutes.",
      obj({ space: str, code: str, join: str, vpsToken: str }, ["space", "code"]), async i => {
        const row = spaceOf(i.space);
        if (i.join) return flow.submitServerCode(row.id, String(i.join), String(i.code));
        const r = await flow.submitCode(row.id, String(i.code), i.vpsToken ? { vpsToken: String(i.vpsToken) } : {});
        const { pairing: p, ...view } = /** @type {any} */ (r);
        return { pairing: p, ...(await sync(row.id, view)), ...(r.message ? { message: r.message } : {}) };
      }, { callers: RELAY_DEVICE_CALLERS });

    tool("spaces.server.install", "The one command to run on a server, the prompt it will show, and the code to type there. For a space still being created it shows the current code; for a finished space it starts adding a server (as compute, or as the new home with moveHome).",
      obj({ space: str, moveHome: { type: "boolean" } }, ["space"]), async i => {
        const { s, row } = mine(i.space);
        const rec = /** @type {any} */ (await kv.get(`space-create/${row.id}`));
        if (rec && rec.status === "waiting" && rec.waiting && rec.waiting.for === "code") {
          return { installCommand: INSTALL_COMMAND, prompt: PAIR_PROMPT, code: rec.waiting.code, expiresAt: rec.waiting.expiresAt, triesLeft: rec.waiting.triesLeft };
        }
        if (row.status !== "done") throw refuse("This space is not waiting for a server. Use spaces.status to see where it is.", "not_waiting");
        const m = mstore.get(row.id, /** @type {string} */ (s.id));
        if (!m || !abilitiesOf(m, now()).includes("devices.manage")) throw refuse("Only an owner or admin can add a server.", "forbidden");
        const manifest = rec && rec.out && rec.out.unit ? rec.out.unit.manifest : undefined;
        const out = await flow.addServer({ spaceId: row.id, moveHome: i.moveHome === true, space: { id: row.id, name: row.name, home: row.home, manifest } });
        return { installCommand: INSTALL_COMMAND, prompt: PAIR_PROMPT, ...out };
      });

    tool("spaces.move.plan", "The plan for moving a space to another home in one action: ordered steps, the checks each needs, nothing moves yet. Owners only.",
      obj({ space: str, to: HOME }, ["space", "to"]), async i => {
        const { s, row } = mine(i.space);
        const m = mstore.get(row.id, /** @type {string} */ (s.id));
        if (!m || !abilitiesOf(m, now()).includes("space.move")) throw refuse("Only an owner can move a space.", "forbidden");
        const rec = /** @type {any} */ (await kv.get(`space-create/${row.id}`));
        return planMoveHome({ id: row.id, name: row.name, home: row.home, manifest: rec && rec.out && rec.out.unit ? rec.out.unit.manifest : undefined }, i.to);
      });

    tool("spaces.assess-computer", "What it means to keep a space on this computer: it is unreachable while it sleeps, is off or offline.",
      obj({ device: obj({ id: str, name: str, alwaysOn: { type: "boolean" } }) }), async i => assessThisComputer(i.device || { name: "this computer" }));

    // 3. members
    const out = (/** @type {any} */ r) => JSON.parse(JSON.stringify(r));
    const ownerGrant = (/** @type {any} */ i) => Boolean(i && i.role === "owner");
    tool("spaces.members.list", "Everyone in a space with their role, scope and end date, and any warnings (such as a single owner).", obj({ space: str }, ["space"]), async (i, meta) => {
      const row = spaceOf(i.space);
      await gate(row.id, undefined, meta);
      const m = await members(row.id, meta);
      const rows = [];
      for (const r of await m.list()) rows.push({ ...r, role_label: m.roleLabel(r.role), name: await nameOf(String(r.person)) });
      return { space: row.id, members: out(rows), warnings: await m.warnings() };
    });
    tool("spaces.members.add", "Add a person (their per_ id or their Vyre name) with a role. A temp member needs scope and an end date. Making an owner needs the person's approval on their device.",
      obj({ space: str, person: str, role: { type: "string", enum: ROLE_IDS }, scope: { type: "array", items: str }, expires: { type: "number" } }, ["space", "person", "role"]),
      async (i, meta) => {
        const row = spaceOf(i.space);
        const s = await gate(row.id, undefined, meta);
        const r = out(await withName(await (await members(row.id, meta)).addMember({ actor: s.id, person: await personRef(i.person), role: i.role, scope: i.scope, expires: i.expires, presence: meta.presence })));
        if (i.role === "owner") await syncOwners(row, PERSON_RE.test(String(i.person)) ? undefined : String(i.person).toLowerCase().replace(/\.vyre\.run$/, ""), meta);
        return r;
      }, { presence: { summary: (/** @type {any} */ i) => `Make ${i && i.person} an owner of ${i && i.space}`, when: ownerGrant } });
    tool("spaces.members.set-role", "Change a person's role. Making someone an owner needs the person's approval on their device.",
      obj({ space: str, person: str, role: { type: "string", enum: ROLE_IDS }, scope: { type: "array", items: str }, expires: { type: "number" } }, ["space", "person", "role"]),
      async (i, meta) => {
        const row = spaceOf(i.space);
        const s = await gate(row.id, undefined, meta);
        const r = out(await withName(await (await members(row.id, meta)).setRole({ actor: s.id, person: await personRef(i.person), role: i.role, scope: i.scope, expires: i.expires, presence: meta.presence })));
        await syncOwners(row, PERSON_RE.test(String(i.person)) ? undefined : String(i.person).toLowerCase().replace(/\.vyre\.run$/, ""), meta);
        return r;
      }, { presence: { summary: (/** @type {any} */ i) => `Make ${i && i.person} an owner of ${i && i.space}`, when: ownerGrant } });
    tool("spaces.members.remove", "Remove a person from a space. A space always keeps at least one owner.", obj({ space: str, person: str }, ["space", "person"]), async (i, meta) => {
      const row = spaceOf(i.space);
      const s = await gate(row.id, undefined, meta);
      const gone = await personRef(i.person);
      const r = out(await (await members(row.id, meta)).removeMember({ actor: s.id, person: gone }));
      clearLends(row.id, { person: gone }); // LD-1: the removed person's consent goes with them
      await syncOwners(row, undefined, meta);
      return r;
    });
    tool("spaces.members.extend", "Give a temp member a later end date. This is a grant change, so it needs the person's approval on their device.",
      obj({ space: str, person: str, expires: { type: "number" } }, ["space", "person", "expires"]), async (i, meta) => {
        const row = spaceOf(i.space);
        const s = await gate(row.id, undefined, meta);
        return out(await (await members(row.id, meta)).extendTemp({ actor: s.id, person: await personRef(i.person), newExpires: i.expires, presence: meta.presence }));
      }, { presence: { summary: (/** @type {any} */ i) => `Extend ${i && i.person}'s access to ${i && i.space}` } });
    tool("spaces.members.transfer", "Hand a space to another member. The old owner becomes an admin (or the role you name). Needs the person's approval on their device.",
      obj({ space: str, to: str, demoteTo: { type: "string", enum: ["admin", "manager", "member"] } }, ["space", "to"]), async (i, meta) => {
        const row = spaceOf(i.space);
        const s = await gate(row.id, undefined, meta);
        const r = out(await (await members(row.id, meta)).transferOwnership({ actor: s.id, to: await personRef(i.to), demoteTo: i.demoteTo, presence: meta.presence }));
        await syncOwners(row, PERSON_RE.test(String(i.to)) ? undefined : String(i.to).toLowerCase().replace(/\.vyre\.run$/, ""), meta);
        return r;
      }, { presence: { summary: (/** @type {any} */ i) => `Transfer ${i && i.space} to ${i && i.to}` } });
    tool("spaces.roles.names", "Read the display names of the five roles, or rename one (owner or admin). The ids never change.",
      obj({ space: str, role: { type: "string", enum: ROLE_IDS }, name: str }, ["space"]), async i => {
        const row = spaceOf(i.space);
        const s = await gate(row.id);
        const m = membersFor(row.id);
        if (i.role && i.name !== undefined) {
          const r = await m.setDisplayName({ actor: s.id, role: i.role, name: i.name });
          rnames.save(row.id, m.getDisplayNames());
          return { ...r, names: ROLE_IDS.map(id => ({ id, name: m.roleLabel(id) })) };
        }
        return { names: ROLE_IDS.map(id => ({ id, name: m.roleLabel(id) })) };
      });
    /** One person's membership in one space: the kernel's answer (member or not, and the role) when it hosts or reaches that space, else the local table's. @param {string} space @param {string} person */
    const membershipRow = async (space, person) => {
      if (K && typeof K.membership === "function" && kernelHandle(space)) {
        let r; try { r = await K.membership(person, space); } catch { return null; }
        return r && r.member ? { space, person, role: r.role, scope: null, expires: null } : null;
      }
      const m = mstore.get(space, person);
      return m ? out(m) : null;
    };
    tool("spaces.membership", "A person's membership in a space, or null. For other modules to decide who may do what. For a space with a kernel it is the kernel's answer.", obj({ space: str, person: str }, ["space", "person"]), async i => membershipRow(String(i.space), String(i.person)), { internal: true });
    tool("spaces.abilities", "What a person may do in a space right now (a temp's access ends on time). For other modules.", obj({ space: str, person: str }, ["space", "person"]), async i => {
      const m = await membershipRow(String(i.space), String(i.person));
      return { membership: m, abilities: m ? [...abilitiesOf(/** @type {any} */ (m), now())] : [] };
    }, { internal: true });

    // 4. invites
    /** What a link carries so the joiner starts pinned: the space's list as this device last saw it, and the fingerprint of its root key. */
    const invitePin = async (/** @type {any} */ row) => {
      const c = await chainOf(row.id);
      const k = files.keys.load(row.id);
      return c && c.pin && k ? { chain: c.pin, rk: spaceFingerprint(c.pin.id, k.publicKey) } : {};
    };
    tool("spaces.invites.create", "Make a join link (https://<space>.vyre.run/join/...) for a role. A temp or member invite can name projects. Owners and admins only, unless the space lets managers invite.",
      obj({ space: str, role: { type: "string", enum: ROLE_IDS }, scope: { type: "array", items: str }, expires: { type: "number" }, uses: { type: "number" }, ttlDays: { type: "number" }, alias: str, to: str }, ["space", "role"]),
      async (i, meta) => {
        const row = spaceOf(i.space);
        const s = await gate(row.id, undefined, meta);
        if (kernelHandle(row.id)) {
          // The Space's kernel makes the invite (a grant act under the admin's own proof) and holds it; the link carries only its id and this device's pin.
          const k = await kctxOf(meta, row.id);
          const rec = await kernelMembers({ handle: kernelHandle(row.id), now }).invites.create(k, { role: i.role, ...(i.scope ? { scope: i.scope } : {}), ...(i.expires ? { expires: i.expires } : {}), ...(i.to ? { invitee: await personRef(i.to) } : {}), ...(i.ttlDays ? { valid_ms: Number(i.ttlDays) * DAY } : {}) });
          const pin = await invitePin(row);
          const token = `${rec.id}.${b64u(Buffer.from(JSON.stringify(pin)))}`;
          return { id: rec.id, link: `https://${row.name}/join/${token}`, token, needs_confirm: rec.needs_confirm === true, valid_until: rec.valid_until };
        }
        const r = await invitesFor(row).createInvite({ creator: s.id, role: i.role, scope: i.scope, expires: i.expires, uses: i.uses, ttl: i.ttlDays === undefined ? undefined : Number(i.ttlDays) * DAY, alias: i.alias, to: i.to ? await personRef(i.to) : undefined, ...(await invitePin(row)) });
        return { id: r.id, link: r.link, token: r.token };
      });
    tool("spaces.invites.confirm", "As the inviter of an admin or owner: confirm the fingerprint words the invitee reads to you. Their invite waits for this.", obj({ space: str, id: str, words: str }, ["space", "id", "words"]), async (i, meta) => {
      const row = spaceOf(i.space);
      await gate(row.id, undefined, meta);
      if (!kernelHandle(row.id)) throw refuse("Only an invite made through the space's kernel waits for confirmation.", "not_kernel");
      return out(await kernelMembers({ handle: kernelHandle(row.id), now }).invites.confirm(await kctxOf(meta, row.id), String(i.id), String(i.words)));
    });
    tool("spaces.invites.revoke", "Cancel an invite so its link stops working.", obj({ space: str, id: str }, ["space", "id"]), async (i, meta) => {
      const row = spaceOf(i.space);
      const s = await gate(row.id, undefined, meta);
      if (kernelHandle(row.id)) return out(await kernelMembers({ handle: kernelHandle(row.id), now }).invites.revoke(await kctxOf(meta, row.id), String(i.id)));
      return out(await invitesFor(row).revokeInvite({ actor: s.id, id: String(i.id) }));
    });
    tool("spaces.invites.list", "Invites you made, or all you may manage as owner or admin. Never includes the link.", obj({ space: str }, ["space"]), async (i, meta) => {
      const row = spaceOf(i.space);
      const s = await gate(row.id, undefined, meta);
      if (kernelHandle(row.id)) return { invites: out(await kernelMembers({ handle: kernelHandle(row.id), now }).invites.list(await kctxOf(meta, row.id))) };
      const rows = out(await invitesFor(row).listInvites({ actor: s.id }));
      // who joined by it, for "Joined by <name> from <device>": the person ids (accepted_by), their names where this home knows them (joined_by_label, same order), and the device they joined from
      // (joined_device: null until the redeeming call carries one). `to` is the person the invite was made for, if any.
      for (const r of rows) {
        const ids = Array.isArray(r.accepted_by) ? r.accepted_by : [];
        r.joined_by_label = await Promise.all(ids.map(async (/** @type {string} */ id) => { const n = await kv.get(`person-name/${id}`); return typeof n === "string" ? n : null; }));
        r.joined_device = null;
      }
      return { invites: rows };
    });

    /** This person's own list answers for themselves; everyone else is looked up by name inside the client. */
    const ownerLookup = async (/** @type {string} */ id) => {
      const s = identity.status();
      return s.exists && s.id === id ? identity.ops() : null;
    };
    /** A join link, with an own-domain host resolved through the directory when this device does not know it. @param {string} link */
    const parseLink = async link => {
      const known = Object.fromEntries(spaces.all().flatMap(r => r.aliases.map((/** @type {string} */ a) => [a, r.name])));
      try { return parseJoinLink(link, { aliases: known }); } catch (e) {
        let host = "";
        try { host = new URL(String(link)).hostname.toLowerCase(); } catch { /* the lib already said it is not a link */ }
        if (!host || host.endsWith(".vyre.run") || (/** @type {any} */ (e)).code !== "bad_input") throw e;
        let r;
        try { r = await dir.resolve(host, { alias: true, resolve: ownerLookup }); } catch { throw e; }
        if (!r.ok || r.kind !== "space") throw e;
        const spaceName = r.payload && r.payload.name ? `${r.payload.name}.vyre.run` : null;
        if (!spaceName) throw e;
        return parseJoinLink(link, { aliases: { [host]: spaceName } });
      }
    };
    /** What the invite card shows, checked against the space's pinned root key. @param {any} i */
    const previewLink = async i => {
      const p = await parseLink(i.link);
      const local = spaces.byName(p.name);
      const kept = local ? await chainOf(local.id) : null;
      let carried;
      try { carried = JSON.parse(Buffer.from(String(p.token).split(".")[0], "base64url").toString("utf8")).chain; } catch { carried = undefined; }
      const pinned = parsePin(i.pin) || (kept && kept.pin) || (carried && { id: carried.id, seq: carried.seq, head: carried.head }) || undefined;
      // Never an unpinned first fetch: the link says which version of the space's list it was made for, or this device already holds one.
      if (!pinned) return { p, res: { ok: false, code: "unpinned", message: "This invite does not say which version of the space it was made for. Ask for a new one." }, local };
      const res = await previewInvite(p.token, {
        now: now(), expectName: p.name,
        resolveSpace: async (/** @type {string} */ name) => {
          const label = name.replace(/\.vyre\.run$/, "");
          const r = await dir.resolve(label, { pin: pinned, resolve: ownerLookup });
          if (!r.ok || r.kind !== "space" || !r.payload) return null;
          return { name, id: r.payload.id, root_public_key: r.payload.rootPublic, rk: spaceFingerprint(r.id, r.payload.rootPublic), label: r.payload.label || label };
        },
        ...(local ? { store: inviteStore(db, local.id) } : {}),
      });
      return { p, res, local };
    };
    const isKernelToken = (/** @type {string} */ t) => /^inv_[0-9a-f]{32}\.[A-Za-z0-9_-]+$/.test(String(t));
    /** The card for a kernel invite, from the Space's own kernel, after the link's pin and fingerprint are checked against the identity list. @param {any} i @param {any} p @param {any} meta */
    const kernelCard = async (i, p, meta) => {
      const [invId, blob] = String(p.token).split(".");
      let carried = {};
      try { carried = JSON.parse(Buffer.from(blob, "base64url").toString("utf8")); } catch { /* checked below */ }
      const pin = parsePin(i.pin) || (carried.chain && { id: carried.chain.id, seq: carried.chain.seq, head: carried.chain.head }) || undefined;
      if (!pin) throw refuse("This invite does not say which version of the space it was made for. Ask for a new one.", "unpinned");
      const label = String(p.name).replace(/\.vyre\.run$/, "");
      let r;
      try { r = await dir.resolve(label, { pin, resolve: ownerLookup }); } catch (e) { throw refuse(plainDirectory(e), "not_found"); }
      if (!r.ok || r.kind !== "space" || !r.payload) throw refuse("That space could not be verified. Ask for a new invite.", "wrong_space");
      if (carried.rk && spaceFingerprint(r.id, r.payload.rootPublic) !== carried.rk) throw refuse("This invite could not be verified. Ask for a new one.", "forged");
      const h = kernelHandle(r.payload.id);
      if (!h) throw refuse("This device cannot reach that space yet.", "unreachable");
      const k = await kctxOf(meta, r.payload.id);
      const card = await kernelMembers({ handle: h, now }).invites.get(k, invId);
      return { card, invId, spaceId: r.payload.id, handle: h, k, fingerprint: carried.rk || null };
    };
    tool("spaces.invites.preview", "What a join link offers, before joining: the space, the role, what you will see and the button. Checks the link's signature against the space's pinned key. Shows nothing else.",
      obj({ link: str, pin: str }, ["link"]), async (i, meta) => {
        if (K) { const p0 = await parseLink(i.link); if (isKernelToken(p0.token)) { const c = await kernelCard(i, p0, meta); return { ...c.card, fingerprint: c.fingerprint, fingerprint_words: fingerprintWords(c.fingerprint) }; } }
        const { res } = await previewLink(i);
        if (!res.ok) throw refuse(res.message, res.code);
        return { ...res.card, fingerprint_words: fingerprintWords(res.card.fingerprint) };
      });
    tool("spaces.invites.accept", "Join a space from its link, signing with this device's person key. When this device is the space's home the membership is made at once; otherwise the signed acceptance is returned for the home to redeem.",
      obj({ link: str, pin: str }, ["link"]), async (i, meta) => {
        const s = me();
        if (K) {
          const p0 = await parseLink(i.link);
          if (isKernelToken(p0.token)) {
            const c = await kernelCard(i, p0, meta);
            // What the invitee signs on their own device: the kernel's accept request over exactly this card. The surface sends the signed proof beside the next call.
            const req = acceptProofRequest(c.handle.space || c.card.space.id, c.card, /** @type {string} */ (s.id));
            if (!meta || !meta.kernel_proof) return { joined: false, needs_proof: true, request: req, card: c.card, fingerprint_words: fingerprintWords(c.fingerprint) };
            const got = await kernelMembers({ handle: c.handle, now }).invites.accept(c.k, c.invId, req.seen);
            return { joined: true, space: c.spaceId, membership: out(got.membership) };
          }
        }
        const { p, res, local } = await previewLink(i);
        if (!res.ok) throw refuse(res.message, res.code);
        const payload = JSON.parse(Buffer.from(p.token.split(".")[0], "base64url").toString("utf8"));
        const proof = b64u(await identity.sign(acceptMessage(payload.id, payload.space, /** @type {string} */ (s.id))));
        const redeem = { token: p.token, person: { id: s.id, name: s.name, ops: identity.ops(), by: s.eid }, proof };
        if (local && files.keys.has(local.id)) return { joined: true, space: local.id, ...out(await invitesFor(local).acceptInvite(redeem)) };
        return { joined: false, pending: true, space: payload.space, card: res.card, redeem };
      });
    tool("spaces.invites.redeem", "The space's home checks a signed acceptance (from spaces.invites.accept on another device) and makes the membership. The link's signature, the person's own signature and the use count are the authority.",
      obj({ token: str, person: obj({ id: str, name: str, ops: { type: "array", items: obj() }, by: str, publicKey: str }, ["id"]), proof: str }, ["token", "person", "proof"]), async i => {
        let payload;
        try { payload = JSON.parse(Buffer.from(String(i.token).split(".")[0], "base64url").toString("utf8")); } catch { throw refuse("That is not a valid invite.", "bad_input"); }
        const row = payload && typeof payload.sid === "string" ? spaces.get(payload.sid) : null;
        if (!row || row.name !== payload.space) throw refuse("This invite is for a different space than the one it points to.", "wrong_space");
        const joined = out(await invitesFor(row).acceptInvite({ token: String(i.token), person: i.person, proof: String(i.proof) }));
        // Keep the name they chose, but only once the directory says that name is theirs: it shows on the member list, so it is never taken from the invitee's say-so.
        const label = typeof i.person.name === "string" ? i.person.name.trim().toLowerCase().replace(/\.vyre\.run$/, "") : "";
        if (label) { try { const r = await dir.resolve(label); if (r.ok && r.kind === "person" && r.id === i.person.id) await kv.put(`person-name/${i.person.id}`, label); } catch { /* the name stays unknown here */ } }
        return joined;
      }, { callers: RELAY_DEVICE_CALLERS });

    // 5a. what other modules (bridges, publish) ask of spaces: who is a member, who is acting, which spaces a person is in. Modules only, never a person or a model.
    tool("spaces.self", "This device's person and the space a call is for (the one named, or the only one this person is in), for a module that has already taken the person from the call's kernel chain (ctx.kernel.chain(meta)): `person` is that chain's person, and it is this device's own only when it is the home's own person; anyone else is nobody. For modules.", obj({ person: str, space: str }, ["person"]), async i => {
      const s = me();
      if (!K || typeof K.owner !== "string" || String(i.person) !== K.owner) return { person: null, space: null };
      const mine = [];
      for (const r of spaces.all()) if (r.status === "done" && (r.createdBy === s.id || await membershipRow(r.id, /** @type {string} */ (s.id)))) mine.push(r);
      const row = i.space ? mine.find(r => r.id === i.space || r.name === i.space || r.label === i.space) : mine.length === 1 ? mine[0] : null;
      return row ? { person: s.id, space: { id: row.id, name: row.name } } : { person: s.id, space: null };
    }, { internal: true });
    tool("spaces.merge-list", "The spaces a person is in, one entry each: { space, name, color, link }, for a device that merges spaces itself. For modules.", obj({ person: str }, ["person"]), async i => {
      const p = String(i.person);
      const mineList = [];
      for (const r of spaces.all()) if (r.status === "done" && (r.createdBy === p || await membershipRow(r.id, p))) mineList.push({ space: r.id, name: r.name, color: null, link: `https://${r.name}` });
      return { spaces: mineList };
    }, { internal: true });

    // 5a'. for the transport: which person a proven device is. `spaces.identity.state` is the live, verified list of a person's entries (read from the directory on every
    // call, never cached: a device the person removed is gone at its next call), and `spaces.people` the candidates to look at. kernel/remote/person-of.js asks both.
    /** A person's identity list as verified now, read live from the directory (pinned to what this device saw first). @param {string} id */
    const stateOfPerson = async id => {
      const mineId = identity.status();
      const name = mineId.exists && mineId.id === id ? mineId.name : /** @type {string|null} */ (await kv.get(`person-name/${id}`));
      if (!name) return { entries: [] };
      const pinKey = `person-pin/${name}`;
      let r;
      try { r = await dir.resolve(String(name), { pin: /** @type {any} */ (await kv.get(pinKey)) || undefined }); } catch { return { entries: [] }; }
      if (!r.ok || r.kind !== "person" || r.id !== id) return { entries: [] };
      await kv.put(pinKey, r.pin);
      return { entries: r.state.entries.map((/** @type {any} */ e) => ({ eid: e.eid, kind: e.kind, pub: e.pub })) };
    };
    // The one identity of this device's person, for the modules that must name it (Wink's pairing targets): the id and name only, read live. Spaces owns it; nobody makes a second.
    tool("spaces.identity.self", "This device's identity id and name, or null when none is claimed. Read live every call. For other modules, so that nothing makes a second identity.", obj(), async () => {
      const st = identity.status();
      return st.exists && st.id ? { id: st.id, name: st.name || null, label: st.name || null } : null;
    }, { internal: true });
    // This computer's own entry on its identity's list, for the daemon's runner ({ deviceId, deviceKey }: the id the Offers name it by and its public key); null until an identity is claimed.
    tool("spaces.identity.device", "This device's entry on its identity list: { deviceId, deviceKey }, or null when none is claimed. The public half only. For the daemon.", obj(), async () => {
      const st = identity.status();
      return st.exists && st.eid && st.publicKey ? { deviceId: st.eid, deviceKey: st.publicKey } : null;
    }, { internal: true });
    tool("spaces.identity.state", "A person's identity list as verified now: their entry ids and kinds. Read live each call. For the transport's personOf.", obj({ person: str }, ["person"]), async i => stateOfPerson(String(i.person)), { internal: true });
    /** Is this person a member of this space, by the place that decides it (the kernel's membership read when it offers one, else the local table)? @param {string} space @param {string} person */
    const isMember = async (space, person) => {
      if (K && typeof K.membership === "function" && kernelHandle(space)) { try { return (await K.membership(person, space)).member === true; } catch { return false; } }
      return Boolean(mstore.get(space, person));
    };
    /** The people this device knows an identity name for (it has resolved them), the candidates for a proven device. */
    const knownPeople = () => {
      const rows = /** @type {any[]} */ (db.prepare("SELECT key FROM spaces_kv WHERE key LIKE 'person-name/%'").all());
      const mine = identity.status();
      return [...new Set([...(mine.exists && mine.id ? [mine.id] : []), ...rows.map(r => String(r.key).slice("person-name/".length))])];
    };
    // The port the transport asks before EVERY call from a device (team/0.3 tailnet CHAT): is this entry a device on the identity list of a person in this space, now?
    // Read live from the directory (never cached): a device its person removed answers null at its very next call. A device on two people's lists is no one's.
    tool("spaces.identity.entry", "A device entry as the identity list holds it now, if it belongs to a member of the space: { eid, kind, pub }, else null. Read live every call. For the transport.", obj({ space: str, eid: str }, ["space", "eid"]), async i => {
      const row = spaceOf(i.space);
      const eid = String(i.eid);
      /** @type {any} */ let found = null;
      for (const person of knownPeople()) {
        if (!(await isMember(row.id, person))) continue;
        const st = await stateOfPerson(person);
        const e = (st.entries || []).find((/** @type {any} */ x) => x.kind === "device" && x.eid === eid);
        if (e) { if (found) return null; found = { eid, kind: "device", pub: e.pub }; }
      }
      return found;
    }, { internal: true });
    // Pairing's last step: the device that was just confirmed (three words on both sides) becomes an entry on the person's list, signed by an entry already on it.
    tool("spaces.identity.enrol", "Put a newly paired device on this person's identity list. Signed by this device's entry; the device is a newcomer for 24 hours. For pairing.", obj({ publicKey: str, label: str }, ["publicKey"]), async i => {
      me();
      try { return await idops.addEntry({ kind: "device", publicKey: String(i.publicKey), label: i.label }); } catch (e) { throw idFail(e); }
    }, { internal: true });
    // The device's own signer for the transport's proof: only the transport's own message, never anything else.
    tool("spaces.identity.sign", "Sign the transport's device proof (a message that starts with vyre-wink-peer-v2) with this device's key. Refuses anything else.", obj({ message: str }, ["message"]), async i => {
      const s0 = me();
      const msg = Buffer.from(String(i.message), "base64url");
      // Two messages only: the transport's device proof, and Wink's proof that this app is the identity a server was installed to pair to (`vyre-wink-pair-to-v1`, over that pairing's box and device).
      if (msg.subarray(0, 18).toString() !== "vyre-wink-peer-v2\n" && msg.subarray(0, 21).toString() !== "vyre-wink-pair-to-v1\n") throw refuse("This key signs only the transport's device proof and a pairing's proof of who is asking.", "forbidden");
      return { eid: s0.eid, sig: b64u(await identity.sign(msg)) };
    }, { internal: true });
    tool("spaces.people", "The people of a space that hold an identity this device knows: its members and the person of a pending invite. For the transport's personOf.", obj({ space: str }, ["space"]), async (i, meta) => {
      const row = spaceOf(i.space);
      const list = await (await members(row.id, meta)).list().catch(() => []);
      return { people: [...new Set(list.map((/** @type {any} */ m) => m.person))] };
    }, { internal: true });

    tool("spaces.label", "What a join card shows for a space the kernel hosts: its name and the four fingerprint words of its identity list and root key. With no space it answers for this home's own Space once it holds the root key. The kernel reads this on every invite card.", obj({ space: str }), async i => {
      // The daemon asks with no space for this home's own Space: the one the kernel keeps here, once this module holds its root key (until then the card shows none).
      const home = i.space ? null : spaces.all().find(r => K && r.id === K.space && r.status === "done");
      if (!i.space && !home) throw refuse("This home's space has no root key here yet.", "not_found");
      const row = home || spaceOf(i.space);
      const c = await chainOf(row.id);
      const k = files.keys.load(row.id);
      return { name: row.name, words: c && c.pin && k ? fingerprintWords(spaceFingerprint(c.pin.id, k.publicKey)) : null };
    }, { internal: true });

    // 5b. the compute grant pair: the space allows its work on members' computers, the member accepts, and it covers only their own sessions on their own machine
    /** @type {Map<string, any>} */ const computeSvc = new Map();
    const computeFor = (/** @type {string} */ id) => {
      let c = computeSvc.get(id);
      if (!c) { c = createCompute({ space: id, members: membersFor(id), store: kv, now, emit }); computeSvc.set(id, c); }
      return c;
    };
    tool("spaces.compute.allow", "As an owner or admin: allow (or stop allowing) this space's work to run on members' own computers. A member must still accept, and it covers only that member's own sessions on their own machine.",
      obj({ space: str, enabled: { type: "boolean" }, maxSessions: { type: "number" } }, ["space", "enabled"]), async i => {
        const row = spaceOf(i.space);
        const s = await gate(row.id);
        return out(await computeFor(row.id).allowSpace({ actor: /** @type {string} */ (s.id), enabled: i.enabled === true, terms: i.maxSessions === undefined ? undefined : { maxSessions: Number(i.maxSessions) } }));
      });
    tool("spaces.compute.accept", "As a member: accept (or stop accepting) this space using your own computer for your own sessions. `terms` is the hash the space's terms show; if the space changed them you must look again.",
      obj({ space: str, enabled: { type: "boolean" }, terms: str }, ["space", "enabled"]), async i => {
        const row = spaceOf(i.space);
        const s = await gate(row.id);
        return out(await computeFor(row.id).acceptMember({ person: /** @type {string} */ (s.id), enabled: i.enabled === true, terms: i.terms === undefined ? undefined : String(i.terms) }));
      });
    tool("spaces.compute.status", "What the space and you have each said about running its work on your computer, and whether it is on.", obj({ space: str }, ["space"]), async i => {
      const row = spaceOf(i.space);
      const s = await gate(row.id);
      return out(await computeFor(row.id).status({ person: /** @type {string} */ (s.id) }));
    });
    tool("spaces.compute.may-run", "The scheduler asks: may this member's session run on this member's computer? Needs both grants and the same person on the session, the machine and the request.",
      obj({ space: str, session: obj({ owner: str, running: { type: "number" } }, ["owner"]), machine: obj({ owner: str }, ["owner"]) }, ["space", "session", "machine"]), async i => {
        const row = spaceOf(i.space);
        const s = await gate(row.id);
        return out(await computeFor(row.id).mayRun({ actor: /** @type {string} */ (s.id), session: i.session, machine: i.machine }));
      }, { internal: true });

    // 6. the sweep
    const sweep = async () => {
      let members = 0, invites = 0;
      for (const row of spaces.all()) {
        if (row.status !== "done") continue;
        members += (await membersFor(row.id).sweepExpired(now())).length;
        if (files.keys.has(row.id)) invites += (await invitesFor(row).sweepInvites(now())).length;
      }
      return { members, invites };
    };
    tool("spaces.sweep", "End temp memberships and invites whose time has come, and say so (member.expired, invite.expired). Runs by itself an hour apart.", obj(), async () => sweep(), { internal: true });
    const every = Math.max(60_000, hooks.sweepMs ?? 3_600_000);
    const timer = setInterval(() => { sweep().catch(e => ctx.log.warn(`the sweep failed: ${/** @type {Error} */ (e).message}`)); }, every);
    if (typeof timer.unref === "function") timer.unref();
    const first = setTimeout(() => { sweep().catch(() => {}); }, 2_000);
    if (typeof first.unref === "function") first.unref();

    // A removed or added sign-in is an alert on every device, so each device asks the directory for its list now and then (never faster than 60 s).
    const syncEvery = Math.max(60_000, hooks.syncMs ?? 60_000);
    const syncTimer = setInterval(() => { const s = identity.status(); if (s.exists && s.name) idops.sync().catch(e => ctx.log.warn(`the identity check failed: ${/** @type {Error} */ (e).message}`)); }, syncEvery);
    if (typeof syncTimer.unref === "function") syncTimer.unref();

    // At start: an identity claimed before this start, on a home whose kernel still has its first-start owner, is adopted now, not at the first spaces call.
    adoptOwner().catch(() => {});
    // Existing homes: a device that already has an explicit list (paired before the home was a row here) is enrolled in the home space once, logged. A device with no list needs nothing.
    (async () => {
      try {
        const hid = K && typeof K.space === "string" ? K.space : null;
        if (!hid) return;
        let n = 0;
        for (const r of /** @type {any[]} */ (db.prepare("SELECT key, value FROM spaces_kv WHERE key LIKE 'device-spaces/%'").all())) {
          let list = null; try { list = JSON.parse(r.value); } catch { continue; }
          if (Array.isArray(list) && !list.includes(hid)) { await kv.put(String(r.key), [hid, ...list]); n++; }
        }
        if (n) (ctx.log.info || ctx.log.warn).call(ctx.log, `${n} device list(s) now include the home space (${hid})`);
        // Paired devices with NO list (paired before per-space lists): an explicit list of the spaces the person belongs to now, once, logged with the count. After this no list means no device the box knows.
        const person = homePerson();
        if (person) {
          let m = 0;
          const ids = [];
          try { for (const r of /** @type {any[]} */ (db.prepare("SELECT id FROM relay_devices WHERE removed_at IS NULL AND kind = 'app'").all())) ids.push(String(r.id)); } catch { /* no relay table */ }
          try { for (const r of /** @type {any[]} */ (db.prepare("SELECT id FROM wink_devices WHERE identity = ? AND removed_at IS NULL").all(person))) ids.push(String(r.id)); } catch { /* no wink table */ }
          const have = await kernelSpacesOf(person);
          for (const dv of new Set(ids)) if ((await enrolledList(dv)) === null) { await kv.put(`device-spaces/${dv}`, have); m++; }
          if (m) (ctx.log.info || ctx.log.warn).call(ctx.log, `${m} paired device(s) without a space list were given one at boot (${have.length} space(s) each)`);
        }
      } catch (e) { ctx.log.warn(`the home space could not be added to the device lists: ${String(/** @type {any} */ (e).message || e).slice(0, 120)}`); }
    })();
    return { async stop() { clearInterval(timer); clearTimeout(first); clearInterval(syncTimer); } };
  },
};

export { SpacesError };
