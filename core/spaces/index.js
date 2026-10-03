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
import { idDirectory, DEFAULT_BASE } from "../names/ids.js";
import * as C from "../../names/worker/chain.js";
import { createIdentityOps } from "./identity-ops.js";
import { PASSWORD_MIN } from "./recovery.js";
import { createCompute } from "../../lib/spaces/compute.js";
import {
  MIGRATIONS, kvStore, membershipStore, roleNames, inviteStore, pairingService, spaceTable,
} from "./store.js";
import { fileIdentityStore, signerOf, personIdOf } from "./identity.js";
import { spaceFiles } from "./host.js";
import path from "node:path";

/** Test seams. Nothing here is a setting: a test sets them before the module starts. */
export const hooks = {
  /** @type {typeof globalThis.fetch | null} */ fetch: null,
  /** @type {(() => number) | null} */ now: null,
  /** @type {number | null} */ sweepMs: null,
  /** @type {number | null} */ syncMs: null,
  /** @type {{ memoryKiB: number, passes: number } | null} the recovery stretch, lowered by tests only */ stretch: null,
  /** @type {any} */ vpsDeps: null,
};

const DAY = 24 * 60 * 60 * 1000;
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
    const dir = idDirectory({ base, fetch: hooks.fetch || globalThis.fetch, now: mono });

    const identity = fileIdentityStore(root);
    const idops = createIdentityOps({ store: identity, dir, now, emit: (t, p) => emit(t, p), stretch: hooks.stretch || undefined });
    const files = spaceFiles(root);
    const kv = kvStore(db);
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
    const pinText = (/** @type {any} */ pin) => (pin ? `${pin.id}:${pin.seq}:${pin.head}` : undefined);
    const parsePin = (/** @type {unknown} */ t) => { const m = /^((?:per|spc)_[a-z2-7]{26}):(\d+):([0-9a-f]{64})$/.exec(String(t || "")); return m ? { id: m[1], seq: Number(m[2]), head: m[3] } : undefined; };
    const authorize = createRoleAuthorize({ membership: (space, person) => mstore.get(space, person), now });
    const REASONS = /** @type {Record<string, string>} */ ({ not_a_member: "You are not a member of this space.", expired: "Your access to this space has ended.", no_grant: "Your role cannot do that.", chain_not_person: "Only a person can do that." });
    /** Is the acting person an active member who may do `action`? Returns the person. @param {string} spaceId @param {string} [action] */
    const gate = async (spaceId, action = "views.read") => {
      const s = me();
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

    // ---- members and invites, one instance per space (their own queues keep one change at a time) ----
    /** @type {Map<string, any>} */ const memberSvc = new Map();
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
      try { r = await dir.resolve(label); } catch (e) { throw refuse(plainDirectory(e), "not_found"); }
      if (!r.ok || r.kind !== "person") throw refuse("That name does not belong to a person.", "not_found");
      return r.id;
    };

    // ---- a space's list of owners follows its owners ----
    /**
     * After any membership change, make the space's chain list the people who are owners now: adds first, then removals, each signed by this
     * person through this device. A newcomer device cannot change owners, so a refusal leaves a warning on the space and nothing else changes.
     * @param {any} row @param {string} [hint] the name of a person just added, so their entry can be found by name
     */
    const syncOwners = async (row, hint) => {
      const c = await chainOf(row.id);
      if (!c) return;
      try {
        const t = now();
        let { state } = await stateOfSpace(row.id);
        const rows = await membersFor(row.id).list();
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
            if (r.error.code === "no_such_tool" || r.error.code === "not_available") {
              warn(a.spaceId, { code: "records_driver_missing", message: "records driver not installed" });
              return { workspaceId: null };
            }
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
      pairing,
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
    const guarded = (/** @type {(i: any, meta: any) => any} */ fn) => async (/** @type {any} */ i, /** @type {any} */ meta) => {
      try { return await fn(i || {}, meta || {}); } catch (e) {
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
          label: (r.payload && r.payload.label) || null, ...(r.kind === "space" && r.payload ? { spaceId: r.payload.id } : {}), aliases: r.aliases, entries: r.state.entries.length,
        };
      });

    tool("spaces.identity.entries", "Who can speak for you: your devices, your recovery code and your recovery contacts, with which are new sign-ins (under 24 hours old).", obj(),
      async () => { me(); return { id: identity.status().id, entries: await idops.entries() }; });
    tool("spaces.identity.entry.add", "Add a device (its public key from pairing) or a recovery contact (the key the contact made for you). Signed by this device. A sign-in under 24 hours old cannot add a contact.",
      obj({ kind: { type: "string", enum: ["device", "contact"] }, publicKey: str, label: str }, ["publicKey"]), async i => {
        me();
        try { return await idops.addEntry({ kind: i.kind || "device", publicKey: i.publicKey, label: i.label }); } catch (e) { throw idFail(e); }
      });
    tool("spaces.identity.entry.remove", "Take a device or contact off your list in one tap. Any older device can remove a newcomer. A sign-in under 24 hours old can remove only newer sign-ins.",
      obj({ eid: str }, ["eid"]), async i => { me(); try { return await idops.removeEntry(String(i.eid)); } catch (e) { throw idFail(e); } });
    tool("spaces.identity.code.replace", "Make a new recovery code (and optionally a new recovery password); the old code stops working. The code comes back in this reply only.",
      obj({ password: str }), async i => {
        me();
        try { return await idops.replaceCode({ password: passwordOf(i) }); } catch (e) { throw idFail(e); }
      });
    tool("spaces.identity.sync", "Check the directory for changes to your list: new sign-ins and removals (each is an alert), whether this device was removed, and whether the directory answered with a stale or different list.",
      obj(), async () => { me(); try { return await idops.sync(); } catch (e) { throw idFail(e); } });
    tool("spaces.identity.recover.code", "On a new device: take your identity back with the recovery code (and the recovery password if you set one). Works at once; the new sign-in is a newcomer for 24 hours.",
      obj({ name: str, code: str, password: str, deviceLabel: str }, ["name", "code"]), async i => {
        try {
          const r = await idops.recoverWithCode({ name: String(i.name).trim().toLowerCase().replace(/\.vyre\.run$/, ""), code: String(i.code), password: i.password === undefined ? "" : String(i.password), deviceLabel: i.deviceLabel ? String(i.deviceLabel) : undefined });
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
      obj({ requestId: str, approvals: { type: "array", items: obj({ eid: str, sig: str }, ["eid", "sig"]) } }, ["requestId", "approvals"]), async i => {
        const pending = recoveries.get(String(i.requestId));
        if (!pending) throw refuse("That recovery is no longer waiting. Start again.", "not_found");
        try {
          const r = await idops.finishContactRecovery({ request: pending.request, key: pending.key, approvals: i.approvals });
          recoveries.delete(String(i.requestId));
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
      obj({ name: str, displayName: str, home: HOME, headscale: { type: "boolean" } }, ["name", "home"]), async i => {
        const s = me();
        const label = String(i.name || "").trim().toLowerCase().replace(/\.vyre\.run$/, "");
        if (!label) throw refuse("Give the space a name.", "bad_name");
        const spaceId = `spc_${crypto.randomBytes(8).toString("hex")}`;
        const home = { ...i.home };
        if (home.kind === "this-computer" && !home.device) home.device = { id: s.keyId, name: "this computer", alwaysOn: false };
        spaces.insert({ id: spaceId, name: `${label}.vyre.run`, label, displayName: i.displayName ? String(i.displayName).slice(0, 80) : null, createdBy: /** @type {string} */ (s.id), status: "running", now: now() });
        spaces.patch(spaceId, { home: { kind: home.kind, ...(home.device ? { device: home.device } : {}) } }, now());
        const view = await flow.createSpace({ spaceId, name: label, displayName: i.displayName, personId: s.id, home, headscale: i.headscale === true }, { vpsToken: home.token });
        return sync(spaceId, view);
      });

    tool("spaces.list", "Spaces on this device that you created or belong to, with your role in each.", obj(), async () => {
      const s = me();
      return spaces.all().flatMap(row => {
        const m = mstore.get(row.id, /** @type {string} */ (s.id));
        if (!m && row.createdBy !== s.id) return [];
        return [{ id: row.id, name: row.name, label: row.label, displayName: row.displayName, status: row.status, home: row.home, role: m ? m.role : null, aliases: row.aliases, workspaceId: row.workspaceId, warnings: row.warnings, createdAt: row.createdAt }];
      });
    });

    tool("spaces.get", "One space: its name, home, owners and warnings.", obj({ space: str }, ["space"]), async i => {
      const row = spaceOf(i.space);
      const s = me();
      if (row.createdBy !== s.id) await gate(row.id);
      const m = membersFor(row.id);
      const all = await m.list();
      return {
        id: row.id, name: row.name, label: row.label, displayName: row.displayName, status: row.status, home: row.home, aliases: row.aliases, workspaceId: row.workspaceId,
        warnings: [...row.warnings, ...(await m.warnings())], members: all.length, owners: await m.ownerCount(), role: (mstore.get(row.id, /** @type {string} */ (s.id)) || {}).role || null,
        roleNames: m.getDisplayNames(), createdAt: row.createdAt,
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
        return sync(row.id, await flow.resume(row.id, ctx2));
      });

    tool("spaces.cancel", "Stop creating a space and roll back what can be rolled back: the name, the key, a new server. Says what it could not remove.",
      obj({ space: str, vpsToken: str }, ["space"]), async i => {
        const { row } = mine(i.space);
        const r = await flow.cancel(row.id, i.vpsToken ? { vpsToken: String(i.vpsToken) } : {});
        if (r.cancelled) spaces.patch(row.id, { status: "cancelled" }, now());
        return { ...r, space: row.id };
      });

    tool("spaces.code.submit", "The new server sends the code its person typed (or, for a second server, with join). The two numbers must match, five tries, ten minutes.",
      obj({ space: str, code: str, join: str, vpsToken: str }, ["space", "code"]), async i => {
        const row = spaceOf(i.space);
        if (i.join) return flow.submitServerCode(row.id, String(i.join), String(i.code));
        const r = await flow.submitCode(row.id, String(i.code), i.vpsToken ? { vpsToken: String(i.vpsToken) } : {});
        const { pairing: p, ...view } = /** @type {any} */ (r);
        return { pairing: p, ...(await sync(row.id, view)), ...(r.message ? { message: r.message } : {}) };
      }, {});

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
    tool("spaces.members.list", "Everyone in a space with their role, scope and end date, and any warnings (such as a single owner).", obj({ space: str }, ["space"]), async i => {
      const row = spaceOf(i.space);
      await gate(row.id);
      const m = membersFor(row.id);
      return { space: row.id, members: out((await m.list()).map((/** @type {any} */ r) => ({ ...r, role_label: m.roleLabel(r.role) }))), warnings: await m.warnings() };
    });
    tool("spaces.members.add", "Add a person (their per_ id or their Vyre name) with a role. A temp member needs scope and an end date. Making an owner needs the person's approval on their device.",
      obj({ space: str, person: str, role: { type: "string", enum: ROLE_IDS }, scope: { type: "array", items: str }, expires: { type: "number" } }, ["space", "person", "role"]),
      async (i, meta) => {
        const row = spaceOf(i.space);
        const s = await gate(row.id);
        const r = out(await membersFor(row.id).addMember({ actor: s.id, person: await personRef(i.person), role: i.role, scope: i.scope, expires: i.expires, presence: meta.presence }));
        if (i.role === "owner") await syncOwners(row, PERSON_RE.test(String(i.person)) ? undefined : String(i.person).toLowerCase().replace(/\.vyre\.run$/, ""));
        return r;
      }, { presence: { summary: (/** @type {any} */ i) => `Make ${i && i.person} an owner of ${i && i.space}`, when: ownerGrant } });
    tool("spaces.members.set-role", "Change a person's role. Making someone an owner needs the person's approval on their device.",
      obj({ space: str, person: str, role: { type: "string", enum: ROLE_IDS }, scope: { type: "array", items: str }, expires: { type: "number" } }, ["space", "person", "role"]),
      async (i, meta) => {
        const row = spaceOf(i.space);
        const s = await gate(row.id);
        const r = out(await membersFor(row.id).setRole({ actor: s.id, person: await personRef(i.person), role: i.role, scope: i.scope, expires: i.expires, presence: meta.presence }));
        await syncOwners(row, PERSON_RE.test(String(i.person)) ? undefined : String(i.person).toLowerCase().replace(/\.vyre\.run$/, ""));
        return r;
      }, { presence: { summary: (/** @type {any} */ i) => `Make ${i && i.person} an owner of ${i && i.space}`, when: ownerGrant } });
    tool("spaces.members.remove", "Remove a person from a space. A space always keeps at least one owner.", obj({ space: str, person: str }, ["space", "person"]), async i => {
      const row = spaceOf(i.space);
      const s = await gate(row.id);
      const r = out(await membersFor(row.id).removeMember({ actor: s.id, person: await personRef(i.person) }));
      await syncOwners(row);
      return r;
    });
    tool("spaces.members.extend", "Give a temp member a later end date. This is a grant change, so it needs the person's approval on their device.",
      obj({ space: str, person: str, expires: { type: "number" } }, ["space", "person", "expires"]), async (i, meta) => {
        const row = spaceOf(i.space);
        const s = await gate(row.id);
        return out(await membersFor(row.id).extendTemp({ actor: s.id, person: await personRef(i.person), newExpires: i.expires, presence: meta.presence }));
      }, { presence: { summary: (/** @type {any} */ i) => `Extend ${i && i.person}'s access to ${i && i.space}` } });
    tool("spaces.members.transfer", "Hand a space to another member. The old owner becomes an admin (or the role you name). Needs the person's approval on their device.",
      obj({ space: str, to: str, demoteTo: { type: "string", enum: ["admin", "manager", "member"] } }, ["space", "to"]), async (i, meta) => {
        const row = spaceOf(i.space);
        const s = await gate(row.id);
        const r = out(await membersFor(row.id).transferOwnership({ actor: s.id, to: await personRef(i.to), demoteTo: i.demoteTo, presence: meta.presence }));
        await syncOwners(row, PERSON_RE.test(String(i.to)) ? undefined : String(i.to).toLowerCase().replace(/\.vyre\.run$/, ""));
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
    tool("spaces.membership", "A person's membership in a space, or null. For other modules to decide who may do what.", obj({ space: str, person: str }, ["space", "person"]), async i => {
      const m = mstore.get(String(i.space), String(i.person));
      return m ? out(m) : null;
    }, { internal: true });
    tool("spaces.abilities", "What a person may do in a space right now (a temp's access ends on time). For other modules.", obj({ space: str, person: str }, ["space", "person"]), async i => {
      const m = mstore.get(String(i.space), String(i.person));
      return { membership: m ? out(m) : null, abilities: m ? [...abilitiesOf(m, now())] : [] };
    }, { internal: true });

    // 4. invites
    tool("spaces.invites.create", "Make a join link (https://<space>.vyre.run/join/...) for a role. A temp or member invite can name projects. Owners and admins only, unless the space lets managers invite.",
      obj({ space: str, role: { type: "string", enum: ROLE_IDS }, scope: { type: "array", items: str }, expires: { type: "number" }, uses: { type: "number" }, ttlDays: { type: "number" }, alias: str, to: str }, ["space", "role"]),
      async i => {
        const row = spaceOf(i.space);
        const s = await gate(row.id);
        const r = await invitesFor(row).createInvite({ creator: s.id, role: i.role, scope: i.scope, expires: i.expires, uses: i.uses, ttl: i.ttlDays === undefined ? undefined : Number(i.ttlDays) * DAY, alias: i.alias, to: i.to ? await personRef(i.to) : undefined });
        return { id: r.id, link: r.link, token: r.token };
      });
    tool("spaces.invites.revoke", "Cancel an invite so its link stops working.", obj({ space: str, id: str }, ["space", "id"]), async i => {
      const row = spaceOf(i.space);
      const s = await gate(row.id);
      return out(await invitesFor(row).revokeInvite({ actor: s.id, id: String(i.id) }));
    });
    tool("spaces.invites.list", "Invites you made, or all you may manage as owner or admin. Never includes the link.", obj({ space: str }, ["space"]), async i => {
      const row = spaceOf(i.space);
      const s = await gate(row.id);
      return { invites: out(await invitesFor(row).listInvites({ actor: s.id })) };
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
      const pinned = parsePin(i.pin) || (kept && kept.pin) || undefined;
      const res = await previewInvite(p.token, {
        now: now(), expectName: p.name,
        resolveSpace: async (/** @type {string} */ name) => {
          const label = name.replace(/\.vyre\.run$/, "");
          const r = await dir.resolve(label, { pin: pinned, resolve: ownerLookup });
          if (!r.ok || r.kind !== "space" || !r.payload) return null;
          return { name, id: r.payload.id, root_public_key: r.payload.rootPublic, label: r.payload.label || label };
        },
        ...(local ? { store: inviteStore(db, local.id) } : {}),
      });
      return { p, res, local };
    };
    tool("spaces.invites.preview", "What a join link offers, before joining: the space, the role, what you will see and the button. Checks the link's signature against the space's pinned key. Shows nothing else.",
      obj({ link: str, pin: str }, ["link"]), async i => {
        const { res } = await previewLink(i);
        if (!res.ok) throw refuse(res.message, res.code);
        return res.card;
      });
    tool("spaces.invites.accept", "Join a space from its link, signing with this device's person key. When this device is the space's home the membership is made at once; otherwise the signed acceptance is returned for the home to redeem.",
      obj({ link: str, pin: str }, ["link"]), async i => {
        const s = me();
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
        return out(await invitesFor(row).acceptInvite({ token: String(i.token), person: i.person, proof: String(i.proof) }));
      });

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

    return { async stop() { clearInterval(timer); clearTimeout(first); clearInterval(syncTimer); } };
  },
};

export { SpacesError };
