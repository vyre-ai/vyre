    /**
     * See `resealPortFor` (lib/spaces/upgrade.js): the sealed-value transfer through platform's seal ops. EX-1: the target's wrapping key is taken only from a signed answer (`spaces.upgrade.wrap-key`, run
     * in My Cloud's home) whose signature checks against the Space's PUBLISHED key under the pin, so a courier cannot swap in a key of its own; with no server, name or pin to check against there is no port at all.
     */
    const resealPort = async (/** @type {any} */ sides, /** @type {string} */ plan_hash, /** @type {{ proof?: any }} */ approval, /** @type {any} */ i, /** @type {any} */ meta) => {
      const to = String(i && i.to);
      const row = spaces.get(to), kept = await chainOf(to);
      const name = typeof (i && i.toName) === "string" && i.toName ? String(i.toName) : (row ? String(row.name || "") : "");
      const pin = parsePin(i && i.pin) || (kept && kept.pin) || null;
      const server = typeof (i && i.server) === "string" && i.server ? i.server : await serverOf(to);
      if (!name || !pin || !server) return null;
      const attest = async () => {
        const r = await remoteCall(server, "spaces.upgrade.wrap-key", { space: to }, meta);
        const b = r && r.body;
        if (!b || b.v !== 1 || b.space !== to || typeof b.wrap_key !== "string" || typeof r.pub !== "string" || typeof r.sig !== "string") throw refuse("My Cloud did not answer with a signed key. Nothing was moved.", "unverified_target");
        const published = await publishedKeyOf(to, { name, pin });
        if (!published || published !== r.pub || !(await verifySigned(r.pub, UPGRADE_WRAPKEY_TAG, b, r.sig))) throw refuse(`The key My Cloud gave is not signed by ${name}'s published key. Nothing was moved.`, "unverified_target");
        return b.wrap_key;
      };
      return resealPortFor({ local: sides.local, remote: sides.remote, sealing: sides.sealing, plan_hash, approval, attest, targetName: name, requireAttest: true });
    };
// @ts-check
// spaces: identity, spaces, members and invites for Vyre 0.3 (team/0.3/DESIGN-spaces-first.md). This file is the wiring: the rules live in
// lib/spaces/ (members, invites, homes, home-unit, vps, authz), the names client is core/names/ids.js, and everything here is
// persisted in SQLite tables prefixed spaces_. Nothing polls: one timer sweeps expired temp members and invites, an hour apart.
//
// Who acts: until the kernel builds a chain, the acting person is THIS device's own identity (spaces.identity). Tools that
// change who can do what also ask for the person's presence where the lib demands it; the verified proof is the registry's
// `meta.presence`, never anything a caller put in the input.
//
// A space's root key, two kinds. A space this device hosts ITSELF without a kernel record (the old module-local flow) signs its invite links with it. A space hosted by a SERVER's kernel
// (spaces.host-here) has a key made and held on that server whose ONLY job is to attest the server to a joiner (spaces.attest signs a fixed-tag nonce); NO authority derives from a signature by
// it: an invite is accepted only on the strength of the kernel's own invite record (id, pin, status, grants.invites.accept), never on a token signed by this key. A file read of it
// therefore mints no invite and no membership; it could only let someone impersonate the server to a joiner, which the box key pinned in the record also has to match.
//
// Secrets: the person key and each space's root key stay in files (mode 0600) and are never logged, evented or returned. The only
// secret ever returned is the recovery code of a new identity, once, in that one reply. The pairing code is shown to the person on
// purpose (the device displays it) and is kept as a hash.

import { exportBundle, enrol as enrolBundle, enrolled as bundleEnrolled } from "../../lib/space-bundle.js";
import crypto from "node:crypto";
import { devKindSwitch } from "../../lib/release-build.js";
import * as config from "../config/index.js";
import { validZone, systemZone } from "../../lib/time/index.js";
import { createMemberStorage } from "../../lib/spaces/member-storage.js";
import { canonical as canonicalOf } from "../../kernel/core/canonical.js";
import { planUpgrade, runUpgrade, fingerprint, resealPortFor } from "../../lib/spaces/upgrade.js";
import { sealExportApproveRequest } from "../../kernel/remote/proof.js";
import { createPullSource, pullMessage, srcMessage, SESSION_CAP_MS } from "../../lib/spaces/move-pull.js";
import { ROLE_IDS, ROLE_DEMOTE_TO } from "../../kernel/contracts/index.js";
import { createMembers, abilitiesOf, SpacesError } from "../../lib/spaces/members.js";
import { createInvites, parseJoinLink, previewInvite, acceptMessage } from "../../lib/spaces/invites.js";
import { createRoleAuthorize, personChain } from "../../lib/spaces/authz.js";
import {
  createSpaceFlow, assessThisComputer, planMoveHome, PAIRING_DEFAULTS, INSTALL_COMMAND, PAIR_PROMPT,
} from "../../lib/spaces/homes.js";
import { SPACE_ID_RE } from "../../lib/spaces/home-unit.js";
import { within } from "../../lib/within.js";
import { idDirectory, DEFAULT_BASE } from "../../lib/identity/directory.js";
import * as C from "../../kernel/identity/chain.js";
import { createIdentityOps } from "./identity-ops.js";
import { PASSWORD_MIN } from "./recovery.js";
import { bindBytes } from "../../kernel/seal/wire.js";
import { WORDS } from "../../relay/client/words.js";
import { createCompute } from "../../lib/spaces/compute.js";
import { createKernelMembers } from "./kernel-members-compat.js";
import { kernelMembers, plainKernelError } from "./kernel-members.js";
import { createRemoteKernel } from "../../kernel/remote/client.js";
import { devSwitch } from "../../kernel/devbuild.js";
import { softwareProof, softwareActProof, softwareKey, challengeProblem } from "./presence-signer.js";
import { winkTransport } from "../../kernel/remote/wink.js";
import { acceptProofRequest, proofRequest } from "../../kernel/remote/proof.js";
import { payloadHash } from "../../kernel/core/presence.js";
import { joinBytes } from "../../kernel/seal/wire.js";
import {
  MIGRATIONS, kvStore, seenStore, membershipStore, roleNames, inviteStore, pairingService, spaceTable,
} from "./store.js";
import { fileIdentityStore, signerOf, personIdOf } from "./identity.js";
import { spaceFiles } from "./host.js";
import fs from "node:fs";
import path from "node:path";
import { entryProof } from "../../kernel/seal/entry-proof.js";
import { newPrefixedId } from "../../lib/id.js";
import { httpFetch } from "../../lib/http.js";

/** Test seams. Nothing here is a setting: a test sets them before the module starts. */
export const hooks = {
  /** @type {typeof globalThis.fetch | null} */ fetch: null,
  /** @type {((entry: { publicKey: string, enclave?: string, agree?: string, attest?: string }, meta: any) => Promise<boolean> | boolean) | null} replaces the default verifier (kernel/seal/entry-proof.js): answers true only for an offered device entry it PROVED is held by the OS's key store (a platform attestation); the default is closed until a real-device fixture passes, so every enrolled entry is held "web" (KP-2) */ entryProof: null,
  /** @type {(() => number) | null} */ now: null,
  /** @type {number | null} */ sweepMs: null,
  /** @type {number | null} */ syncMs: null,
  /** @type {{ memoryKiB: number, passes: number } | null} the recovery stretch, lowered by tests only */ stretch: null,
  /** @type {any} */ vpsDeps: null,
  /** @type {((channel: { relay: string, route: string, box: string }, hello: any) => Promise<{ call(tool: string, input: any): Promise<any> }> | { call(tool: string, input: any): Promise<any> }) | null} an invitee's peer session to the home a space's record names (the daemon wires it); a test sets it */ inviteeSessionFor: null,
  /** @type {((spaceId: string) => { relay: string, route: string, box: string } | null) | null} the home's route for a space's directory record (read at call time) */ route: null,
  /** @type {number | null} how long a read of a SERVER-hosted space's members waits for the server before it counts as unknown (default 4000 ms; read at call time) */ remoteMs: null,
  /** @type {(() => Promise<any>) | null} replaces the kernel's store plan in host-here (read at call time) */ storePlan: null,
  /** @type {boolean | null} when set, answers "does this space live on this computer" for every space (read at call time) */ livesHere: null,
  /** @type {((challenge: any, who: { space: string, person: string }) => Promise<any> | any) | null} the person's own signer (Touch ID, the Secure Enclave, a passkey): answers a space home's presence challenge with a proof carrying `home` and `challenge`, or null; a test sets it */ signer: null,
  /** @type {string | undefined} a package root a test points at to be a release-kind or development-kind build for the software key's switch (read at call time) */ buildRoot: undefined,
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

/** The associated data every file drop wrap starts with: the one purpose spaces.identity.unwrap-drop opens. */
const DROP_AAD_PREFIX = "vyre-drop-wrap\n";

/** @type {((entry: any, meta?: any) => Promise<boolean>) | null} the default entry verifier, made on first use */
let defaultEntryProof = null;

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
    const dir = idDirectory({ base, fetch: hooks.fetch || httpFetch, now: mono, seen });

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
      if (!c) throw refuse("This device does not hold the space's list of owners; join the space on this device again (spaces.invites.accept).", "no_chain");
      return { c, state: await C.verifyChain(c.ops, { now: now() + C.SKEW_MS, ownerOps: ownerResolver(c.ops) }) };
    };
    /** The fingerprint of a space as its inviter saw it: its permanent id and its root key. 32 hex characters; four words show the first 44 bits on the card. */
    const attestMessage = (/** @type {string} */ space, /** @type {string} */ nonce) => `vyre-space-attest-v1\n${space}\n${nonce}`;
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
        // A space on a SERVER that did not answer who belongs (down, or the read came back empty) still lets in the person who made it from this device: the server's kernel decides each call.
        const h0 = kernelHandle(spaceId), r0 = spaces.get(spaceId);
        if (!m && !(h0 && h0.hosted === false && r0 && r0.createdBy === s.id)) throw refuse("You are not a member of this space.", "not_a_member");
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
      if (!row) {
        // A home with no claimed identity has nobody to own or invite into a space yet: say that, not "no such space".
        let who = null; try { who = identity.status(); } catch { who = null; }
        if (!who || !who.exists || who.pending) throw refuse("Choose your Vyre name first.", "no_identity");
        throw refuse("No such space on this device (spaces.list shows yours).", "not_found");
      }
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
      const sessionForFn = typeof hooks.sessionFor === "function" ? hooks.sessionFor : typeof ctx.sessionFor === "function" && typeof ctx.sessionForReady === "function" && ctx.sessionForReady() ? ctx.sessionFor : null;
      if (sessionForFn) {
        let session; try { session = await sessionForFn(device); } catch { throw refuse("The server could not be reached. Nothing was made.", "server_unreachable"); }
        if (!session || typeof session.call !== "function") throw refuse("The server could not be reached. Nothing was made.", "server_unreachable");
        let pr; try { pr = await session.call(tool, { ...input, ...(meta && meta.kernel_proof ? { proof: meta.kernel_proof } : {}) }); } catch (e) { throw refuse(String(/** @type {any} */ (e).message || "The server did not do that. Nothing was made.").slice(0, 160), String(/** @type {any} */ (e).code || "server_refused")); }
        if (!pr || pr.ok === false) throw refuse(pr && pr.error && pr.error.message ? String(pr.error.message).slice(0, 160) : "The server did not do that. Nothing was made.", (pr && pr.error && pr.error.code) || "server_refused");
        return pr.data !== undefined ? pr.data : pr;
      }
      throw refuse("This device has no way to reach a paired server. Nothing was made.", "server_unreachable");
    };
    /** The device of a space whose home is a server and which the SERVER hosts (set when it was made there). */
    /** Where a server-hosted space's home is reached (relay, route, box), from Wink's paired record of that server: it goes into the space's directory record so an invitee's device can find the home from the link alone. @param {string} spaceId */
    const routeOf = async spaceId => {
      if (typeof hooks.route === "function") return hooks.route(spaceId);
      const dev = await serverOf(spaceId);
      let who = null; try { who = identity.status(); } catch { who = null; }
      if (!dev || !who || !who.exists || !who.id) return null;
      try { const r = await ctx.call("wink.server.channel", { device: dev, identity: who.id }); const c = r && r.data && !r.error ? r.data.channel : null; return c && c.route ? { relay: String(c.relay || ""), route: String(c.route), box: String(c.box || "") } : null; } catch { return null; }
    };
    /** True when this daemon is a person's own computer (it has an identity) and the space is not hosted on a paired server. */
    const livesOnThisComputer = async (/** @type {string} */ spaceId) => {
      if (typeof hooks.livesHere === "boolean") return hooks.livesHere;
      let st = null; try { st = identity.status(); } catch { st = null; }
      return !!(st && st.exists) && !(await serverOf(spaceId));
    };
    /** The hosting server's key for a space it hosts for this person (from its host-here answer): what the directory record's rootPublic and the invite fingerprint are made from. @param {string} spaceId */
    const attestedKeyOf = async spaceId => { const v = await kv.get(`server-hosted/${spaceId}`); return v && typeof v.rootPublic === "string" && v.rootPublic ? v.rootPublic : null; };
    const serverOf = async (/** @type {string} */ spaceId) => { const v = await kv.get(`server-hosted/${spaceId}`); return v && typeof v.device === "string" ? v.device : null; };
    const retireHosted = async (/** @type {string} */ id, /** @type {any} */ meta) => {
      const srv = await serverOf(id);
      if (srv) { try { await remoteCall(srv, "spaces.retire-here", { id }, meta); await kv.delete(`server-hosted/${id}`); } catch (e) { ctx.log.warn(`the server kept a space that did not finish being made (${id}): ${String(/** @type {any} */ (e).message || e).slice(0, 120)}`); } return; }
      if (!K || !K.spaces || typeof K.spaces.retire !== "function" || !kernelHandle(id)) return;
      try { await K.spaces.retire(id); } catch (e) { ctx.log.warn(`the kernel kept a space that did not finish being made (${id}): ${String(/** @type {any} */ (e).message || e).slice(0, 120)}`); }
    };
    /** The caller's chain IN that Space (a hosted Space has its own key: the home's chain is not a member of it), and the proof beside the call. */
    /** The person's own answer to a home's challenge, or null: the hardware signer a surface set, else this computer's software key, only on a development build behind VYRE_SEAL_SOFTWARE. @param {any} ch @param {string} space */
    const answerChallenge = async (ch, space, expect) => {
      try {
        const st = identity.status();
        if (!st.exists || st.pending || !st.id) return null;
        const full = { ...ch, space: ch.space || space };
        // WN-1: whatever signs, signs what THIS device asked for: the challenge must be for the request it made, and its hash the one worked out here
        const problem = challengeProblem(full, expect);
        if (problem) { ctx.log.warn(`a space's home asked for a signature this device did not ask for (${problem}): refused`); return null; }
        if (typeof hooks.signer === "function") { const p = await hooks.signer({ ...full, payload_hash: payloadHash(full.op, full.space, full.fields) }, { space, person: st.id }); if (p && typeof p === "object") return p; }
        if (!devSwitch(process.env.VYRE_SEAL_SOFTWARE, hooks.buildRoot)) return null;
        return softwareProof(path.join(ctx.paths.root, "wink-keys.json.device"), st.id, full, undefined, expect);
      } catch { return null; }
    };
    const kctxOf = async (/** @type {any} */ meta, /** @type {string} */ space) => {
      // A space the SERVER hosts is reached through a RemoteKernel: the chain argument never leaves this device (the server mints the chain from the peer it proved), so none is built here.
      const h = space ? kernelHandle(space) : null;
      if (h && h.hosted === false) {
        // A proof the person's device made for the home's challenge carries `home` and `challenge` (kernel/core/presence.js remoteBinding): it goes beside the call with the challenge it answers, as the remote client takes it.
        const kp = meta && meta.kernel_proof;
        const answers = kp && typeof kp === "object" && typeof kp.challenge === "string" && kp.challenge ? { presence: kp, challenge: kp.challenge } : K.proofFrom(meta);
        return { chain: null, proof: answers };
      }
      return { chain: space && typeof K.chainIn === "function" ? await K.chainIn(space, meta) : await K.chain(meta), proof: K.proofFrom(meta) };
    };
    /** The members service for a space: the kernel's (under the caller's chain and proof) when there is one, else the local table's. @param {string} id @param {any} [meta] */
    const members = async (id, meta) => {
      const h = kernelHandle(id);
      if (!h) return membersFor(id);
      const k = await kctxOf(meta, id);
      return createKernelMembers({ space: id, handle: h, now, displayNames: rnames.load(id), reader: () => k });
    };
    /** A person's role in a space from the place that decides it. @param {string} id @param {string} person @param {any} [meta] */
    const membershipOf = async (id, person, meta) => {
      const h = kernelHandle(id);
      if (!h) return mstore.get(id, person) || null;
      const ask = async () => (await (await members(id, meta)).get(person)) || null;
      // A space on a SERVER is read over the network: a server that is down, rebuilt or silent must not hold up every list and every pairing that asks who belongs where (walker, 4 Oct: wink.pair.server
      // hung 90 s on a stale server-hosted row). No answer in time is "unknown", and the caller falls back to what this device itself knows.
      if (h.hosted !== false) return ask();
      const ms = typeof hooks.remoteMs === "number" ? hooks.remoteMs : 4000;
      return within(ask().catch(() => null), ms, null);
    };

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
    const vpsDeps = () => ({ emit, ...(hooks.vpsDeps || { fetch: hooks.fetch || httpFetch }) });
    /** Is this server already paired to this person (the pairing proved it)? Wink answers from the identity's own list (wink.server.paired); no answer means no, and the typed code step runs. @param {string} id */
    /** Who may call a modules-only tool: the registry names a module caller `module:<name>` from the module it verified; only these first-party modules (and the daemon) are admitted, whatever a module's declaration says. @param {any} meta @param {string[]} names */
    const onlyModules = (meta, names) => {
      const c = String((meta && meta.caller) || "");
      if (!names.some(n => c === `module:${n}`)) throw refuse("That is not for this caller; only the modules that run it may call it.", "denied");
    };
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
          const attested = await attestedKeyOf(a.record.spaceId);
          const k = files.keys.load(a.record.spaceId);
          if (!attested && (!k || k.publicKey !== a.rootPublic)) return { ok: false, message: "The space's key is not on this device." };
          const rootPublic = attested || a.rootPublic;
          const label = String(a.record.displayName || a.name).slice(0, 80);
          try {
            // A space is an identity whose list holds its owners. This person is the first owner, acting through this device's entry.
            // The chain is kept on this device so a retried step reuses it instead of making a second identity. The root key (a joiner fingerprints a link with its public half) is
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
            await dir.claim(a.name, state, c.ops, await ownerSigner(), { v: 1, id: a.record.spaceId, name: a.name, label, rootPublic, ...(who.name ? { ownerName: who.name } : {}) });
            await kv.put(`chain/${a.record.spaceId}`, { ops: c.ops, pin: C.pinOf(state) });
            return { ok: true };
          } catch (e) { return { ok: false, code: /** @type {any} */ (e).code, message: plainDirectory(e) }; }
        },
        async releaseSpace(/** @type {{ name: string, spaceId: string }} */ a) { await dir.release(a.name, await ownerSigner()); await kv.delete(`chain/${a.spaceId}`); return { ok: true }; },
        async pointHome(/** @type {{ name: string, spaceId: string, home: any }} */ a) {
          const row = spaces.get(a.spaceId);
          const k = files.keys.load(a.spaceId);
          const attested = await attestedKeyOf(a.spaceId);
          const home = { kind: a.home && a.home.kind, ...(a.home && a.home.address ? { address: a.home.address } : {}) };
          const { state } = await stateOfSpace(a.spaceId);
          const route = await routeOf(a.spaceId);
          let ownerLabel = null; try { const st = identity.status(); ownerLabel = st && st.exists && st.name ? String(st.name) : null; } catch { ownerLabel = null; }
          await dir.update(a.name, state, await ownerSigner(), { v: 1, id: a.spaceId, name: a.name, label: (row && (row.displayName || row.label)) || a.name, home, rootPublic: attested || (k ? k.publicKey : undefined), ...(route ? { route } : {}), ...(ownerLabel ? { ownerName: ownerLabel } : {}) });
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
      try { await K.adoptOwner(s.id, { from: K.owner }); } catch (e) { ctx.log.warn(`the kernel could not take your identity as its owner: ${String(/** @type {any} */ (e).message || e).slice(0, 160)}`); }
    };
    // Hosted spaces are NOT adopted here (HA-1): the kernel moves a hosted space to the claimed identity itself (kernel/spaces adoptOwner(to, from), at the claim and at every boot), only where the
    // replaced home owner is its owner, keyed on the sealed owner.adopted event. This module never calls a hosted kernel's adoptOwner: through a handle that call replaces ANY owner.
    // single-flight: callers that arrive while one is running wait for it; the slot is cleared only AFTER the promise is stored (an early return must not leave a finished promise in it)
    const adoptOwner = () => { if (adopting) return adopting; const p = adoptOnce(); adopting = p; const clear = () => { if (adopting === p) adopting = null; }; p.then(clear, clear); return p; };
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

    tool("spaces.identity.id", "This device's permanent identity id (and its own entry id on the list, `eid`), or null when none is claimed yet. The one place the id is kept is this module; pairing and install read it here, never keep their own. For modules.", obj(),
      async () => { const st = identity.status(); const ok = st.exists && !st.pending; return { id: ok ? st.id : null, ...(ok && st.eid ? { eid: st.eid } : {}) }; }, { internal: true });

    tool("spaces.identity.create", "Become yourself on this device: make its key and your identity, and finish the Vyre name that a reservation code (VYRE-XXXX-XXXX-XXXX-XXXX, made at vyre.run/setup) holds. The recovery code comes back in this reply only: show it to the person once and never keep a copy. A recovery password is optional (four or more words is best); with one, the paper alone is not enough.",
      obj({ code: str, name: str, password: str, deviceLabel: str }), async i => {
        const st = identity.status();
        if (st.exists) throw refuse(st.name ? `This device already has the name ${st.name}.vyre.run.` : "This device already has a Vyre identity.", "exists");
        const password = passwordOf(i);
        let made, label, code = typeof i.code === "string" ? i.code.trim() : "";
        // Development builds only (never a release): the walks and tests that make many people reserve each name themselves. A release build takes a code and nothing else.
        if (!code && devKindSwitch(process.env.VYRE_TEST_SELF_RESERVE) && typeof i.name === "string") {
          const want = String(i.name).trim().toLowerCase().replace(/\.vyre\.run$/, "");
          try { code = String((await dir.reserve(want)).code); } catch (e) { const c = /** @type {any} */ (e).code; throw refuse(c === "taken" ? "That name is taken. Pick another." : "That name can't be used.", c === "taken" ? "name_taken" : "bad_name"); }
        }
        if (!code) throw refuse("Paste the reservation code from vyre.run/setup.", "code_needed");
        try {
          // The code says which name it holds; the directory spends it only when the claim goes through.
          const held = await dir.reservedFor(code);
          label = String(held.name);
          made = await idops.create({ name: label, password, deviceLabel: i.deviceLabel ? String(i.deviceLabel) : undefined, code });
        } catch (e) { const err = /** @type {any} */ (e); if (err.code === "bad_code") throw refuse("That code does not work. It may have run out, been used, or been replaced by a newer one. Reserve the name again at vyre.run/setup.", "bad_code"); throw idFail(err); }
        emit("identity.created", { name: `${label}.vyre.run`, id: made.status.id, at: now() });
        return {
          ...publicIdentity(made.status),
          recoveryCode: made.recoveryCode, passwordSet: made.passwordSet,
          note: "This recovery code is shown once. Write it down somewhere safe. " + (made.passwordSet ? "It works only with the recovery password you chose, so remember it. " : "Add a recovery password (four or more words) so the paper alone is not enough. ")
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
    const needPresence = () => { const P = presenceOf(); if (!P) throw refuse("This computer has no sealing process running, so there is no presence to recover; start Vyre on this computer first.", "unavailable"); return P; };
    const personIdOfChain = (/** @type {any} */ c) => { const h = c && c.hops && c.hops[0]; return h && h.actor.kind === "person" ? String(h.actor.id) : ""; };
    // ---- The Space bundle (R031-83, lib/space-bundle.js): every Space this box holds, each opened by its OWN owner's recovery code, given once; the export then runs unattended into the home, where a backup carries it ----
    const bundleK = ctx.kernel && ctx.kernel.bundle ? ctx.kernel.bundle : null;
    const homeSpace = () => String(ctx.kernel.space);
    /** @type {Map<string, number>} */ const bundleLast = new Map();
    const bundleOfSpace = (/** @type {string} */ id) => { const k = bundleK && bundleK.of(id); if (!k) throw Object.assign(new Error("this box has no Space bundle yet; spaces.bundle.enrol turns backups on for a Space"), { code: "unavailable" }); return k; };
    const bundleIdent = (/** @type {string} */ id, /** @type {any} */ k) => (id === homeSpace() ? { space: id, owner: String(ctx.kernel.owner) } : { space: id, owner: String(k.id.owner), ...(k.id.name ? { name: k.id.name } : {}) });
    const exportSpace = async (/** @type {string} */ id) => { const k = bundleOfSpace(id), r = await exportBundle({ root: ctx.paths.root, id: bundleIdent(id, k), k, home: id === homeSpace() }); bundleLast.set(id, Date.now()); return r; };
    const nameOfSpace = (/** @type {string} */ id, /** @type {any} */ k) => (id === homeSpace() ? "this box's own Space" : String((k.id && k.id.name) || id));
    tool("spaces.bundle.enrol", "Give a Space's owner's recovery code ONCE so that Space can be backed up with its members, grants, store and sealed values, and brought back on a fresh box with the same code. Each Space has its own owner and its own code. Nothing is stored in the clear: the code only wraps a key the Space keeps sealed.",
      obj({ space: str, code: str, password: str }, ["code"]), async (i, meta) => {
        const id = String(i.space || homeSpace()), k = bundleOfSpace(id);
        const who = personIdOfChain(await ctx.kernel.chain(meta)), owner = bundleIdent(id, k).owner;
        if (!who || who !== owner) throw Object.assign(new Error("only this Space's owner can turn on its backup"), { code: "denied" });
        await enrolBundle(k, id, String(i.code), String(i.password || ""));
        return { enrolled: true, space: id, ...(await exportSpace(id)) };
      }, { effect: "write", reach: "person" });
    tool("spaces.bundle.export", "Write the Space bundles now: every Space whose owner turned on backups (it also runs by itself, hourly). A backup of this box carries the files.", obj({}), async () => {
      const done = [];
      for (const id of bundleOfIds()) { if (await bundleEnrolled(bundleOfSpace(id))) done.push({ space: id, ...(await exportSpace(id)) }); }
      return { written: done };
    }, { effect: "write", reach: "person" });
    tool("spaces.bundle.status", "Which Spaces on this box are backed up, and which are not because their owner has not turned on backups, with the plain line to show for each.", obj({}), async () => {
      const spaces = [];
      for (const id of bundleOfIds()) {
        const k = bundleOfSpace(id), on = await bundleEnrolled(k), name = nameOfSpace(id, k);
        spaces.push({ space: id, name, home: id === homeSpace(), enrolled: on, last: bundleLast.get(id) || null, ...(on ? {} : { note: id === homeSpace() ? "Your own Space isn't backed up yet: turn on backups with your recovery code." : `Space ${name} isn't backed up: its owner hasn't turned on backups.` }) });
      }
      return { available: Boolean(bundleK), spaces };
    }, { effect: "read", reach: "person" });
    const bundleOfIds = () => (bundleK ? bundleK.ids() : []);
    // unattended: at start and every hour, every Space whose owner has enrolled, so a scheduled backup always carries fresh bundles
    const bundleTick = async () => { for (const id of bundleOfIds()) { try { if (await bundleEnrolled(bundleOfSpace(id))) await exportSpace(id); } catch (e) { ctx.log.warn(`space bundle for ${id} not written: ${/** @type {Error} */ (e).message}`); } } };
    const bundleFirst = setTimeout(() => void bundleTick(), 5000), bundleTimer = setInterval(() => void bundleTick(), 3_600_000);
    bundleFirst.unref?.(); bundleTimer.unref?.();
    tool("spaces.presence.begin", "On a new device that has lost every presence key: ask the sealing process for the one-time token the recovery needs, for the key this device just made (its id and public key).",
      obj({ key_id: str, spki: str }, ["key_id", "spki"]), async (i, meta) => {
        const P = needPresence(), st = me();
        return P.begin({ chain: await ctx.kernel.chain(meta), person: st.id, key_id: String(i.key_id), spki: String(i.spki) });
      });
    tool("spaces.presence.recover", "After taking your identity back (the recovery code, or two contacts): give the sealing process the new presence key, vouched for by this device's own key on your list. The process checks your list; the new key counts as a newcomer for 24 hours.",
      obj({ key_id: str, spki: str, signer: str, token: str, attestation: obj() }, ["key_id", "spki", "signer", "token"]), async (i, meta) => {
        const P = needPresence(), st = me();
        const bind = { eid: /** @type {string} */ (st.eid), sig: b64u(await identity.sign(bindBytes(String(st.id), String(i.key_id), String(i.spki)))) };
        return P.recover({ chain: await ctx.kernel.chain(meta), person: st.id, ops: identity.ops(), bind, key_id: String(i.key_id), spki: String(i.spki), signer: String(i.signer), ...(typeof i.rp === "string" ? { rp: i.rp } : {}), token: String(i.token), ...(i.attestation ? { attestation: i.attestation } : {}) });
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
          const requestId = newPrefixedId("rec");
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
      if (i.name && String(i.name).toLowerCase().replace(/\.vyre\.run$/, "") !== s.name) throw refuse("That is not this device's name; spaces.identity.status shows it.", "forbidden");
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
      obj({ name: str, displayName: str, home: HOME, storeChoice: { type: "string", enum: ["server", "cancel"] } }, ["name", "home"]), async (i, meta) => {
        const s = me();
        const label = String(i.name || "").trim().toLowerCase().replace(/\.vyre\.run$/, "");
        if (!label) throw refuse("Give the space a name.", "bad_name");
        // A space that lives on this computer is reachable only while the computer is on: that is asked first, and nothing is made until the person says yes (`home.confirmed: true`), so a "no" or a walk-away leaves nothing behind.
        if (i.home && i.home.kind === "this-computer" && i.home.confirmed !== true) {
          const a = assessThisComputer(i.home.device && typeof i.home.device === "object" ? i.home.device : { name: "this computer", alwaysOn: false });
          return { status: "needs_confirmation", confirm: { text: `${a.warning} ${a.advice} ${a.moveToServerLater}`, choices: ["create", "cancel"], again: "Call spaces.create again with home.confirmed set to true to create it. Nothing has been made yet." } };
        }
        let spaceId = `spc_${crypto.randomBytes(8).toString("hex")}`;
        // The same person asking again for a name whose earlier attempt did not finish picks that attempt up (its id, its stored steps) instead of colliding with what it left behind: a refused or
        // failed create retires what the server started, and the retry resumes the pending row (walker, 4 Oct: a retry under the same name answered "That name is taken").
        let resumed = false;
        { const prior = spaces.all().find(r => r.label === label && r.createdBy === s.id && r.status !== "done");
          const prec = prior ? /** @type {any} */ (await kv.get(`space-create/${prior.id}`)) : null;
          if (prior && prec && prec.status !== "cancelled" && prec.status !== "done") { spaceId = prior.id; resumed = true; } }
        // A Space the kernel hosts here is made by the kernel (its own id, store and key). The kernel says first what store it would use: on a server too small for the larger one
        // it answers in the kernel's own words and offers the person's server; nothing is made here without Twenty.
        // A space whose home is a PAIRED SERVER is hosted by that server (DESIGN-spaces-first, "Where a space is hosted"): the server's kernel makes it (key, store, log, files there) and answers THE id;
        // this device keeps only the row. A server that is not yet paired goes through the code step as before. "On this computer" stays local.
        let remoteServer = null;
        if (i.home && i.home.kind === "server" && i.home.device && typeof i.home.device.id === "string" && i.home.device.id) {
          // A person who named THEIR server never gets a space on this computer instead: a server that is not paired to this person is refused, and nothing is made. (A new server with no device named
          // still goes through the typed-code step below.)
          if (!(await pairedServer(i.home.device.id))) throw refuse("That server is not paired with you yet, so Vyre did not make the space. Pair the server first, then try again. Nothing was made.", "server_not_paired");
          remoteServer = i.home.device.id;
        }
        const KS = !remoteServer && K && K.spaces && typeof K.spaces.host === "function" ? K.spaces : null;
        if (remoteServer) {
          let made;
          try { made = await remoteCall(remoteServer, "spaces.host-here", { name: label, ...(resumed ? { id: spaceId } : {}) }, meta); }
          catch (e) {
            if (/** @type {any} */ (e).code === "store_unavailable") {
              if (i.storeChoice === "cancel") return { status: "cancelled", reason: "You chose not to create it on this server." };
              return { status: "needs_confirmation", confirm: { text: String(/** @type {any} */ (e).message), choices: ["cancel"] } };
            }
            throw e;
          }
          if (!made || typeof made.space !== "string" || !/^spc_[a-z2-7]{12}$/.test(made.space)) throw refuse("The server did not give the space an id. Nothing was made.", "server_refused");
          spaceId = made.space;
          await kv.put(`server-hosted/${spaceId}`, { device: remoteServer, at: now(), ...(typeof made.rootPublic === "string" && made.rootPublic ? { rootPublic: made.rootPublic } : {}) });
        }
        if (KS && !(resumed && typeof K.spaces.hosts === "function" && K.spaces.hosts(spaceId) === true)) {
          const plan = typeof KS.storePlan === "function" ? await KS.storePlan() : null;
          const confirm = plan && plan.confirm ? plan.confirm : null;
          if (confirm) {
            if (i.storeChoice === "cancel") return { status: "cancelled", reason: "You chose not to create it on this server." };
            // the record store cannot run here: nothing is made, and the person's server is offered
            if (i.storeChoice === "server") return { status: "use_server", reason: "Pair your server and make the space there: choose it as the home." };
            return { status: "needs_confirmation", confirm: { text: confirm.text, choices: confirm.choices || ["server", "cancel"] } };
          }
          const hosted = await KS.host({ owner: s.id, name: label });
          spaceId = hosted.space || hosted.id;
        }
        if (resumed && !spaces.get(spaceId)) resumed = false;
        const home = { ...i.home };
        if (home.kind === "this-computer" && !home.device) home.device = { id: s.keyId, name: "this computer", alwaysOn: false };
        if (!resumed) spaces.insert({ id: spaceId, name: `${label}.vyre.run`, label, displayName: i.displayName ? String(i.displayName).slice(0, 80) : null, createdBy: /** @type {string} */ (s.id), status: "running", now: now() });
        // the creator's device zone is the space's home zone until an owner or admin changes it
        if (!resumed) await kv.put(`zone/${spaceId}`, { zone: validZone(meta && meta.zone) ? meta.zone : systemZone() });
        else spaces.patch(spaceId, { status: "running" }, now());
        spaces.patch(spaceId, { home: { kind: home.kind, ...(home.device ? { device: home.device } : {}) } }, now());
        /** @type {any} */ let view;
        try { view = await flow.createSpace({ spaceId, name: label, displayName: i.displayName, personId: s.id, home, headscale: i.headscale === true }, { vpsToken: home.token }); } catch (e) { if (KS || remoteServer) await retireHosted(spaceId, meta); throw e; }
        if ((KS || remoteServer) && view && view.status === "failed") await retireHosted(spaceId, meta);
        // The home's route goes into the space's directory record so another person's device can find the home from an invite link (the flow's own pointHome ran before the server-hosted record existed on every path).
        if (remoteServer && view && view.status !== "failed") { try { await deps.names.pointHome({ name: `${label}.vyre.run`.replace(/\.vyre\.run$/, ""), spaceId, home: { kind: "server" } }); } catch { /* the record is republished by spaces.identity.republish */ } }
        // The server serves the space's name (a server holds no name of its own): the space lists the server's route in the directory, signed by its owner, and the server is told which name it serves.
        if (remoteServer && view && view.status !== "failed") {
          try {
            const rt = await routeOf(spaceId);
            if (rt && rt.route) { await dir.server(label, String(rt.route), await ownerSigner()); await remoteCall(remoteServer, "names.serve", { name: label }, meta); }
          } catch (e) { ctx.log.warn(`spaces: ${label} was made, but its server could not be listed to serve the name (${/** @type {Error} */ (e).message}); run spaces.identity.republish after fixing the cause`); }
        }
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
    const SETUP_STEPS = ["look", "members", "ai", "connectors", "kit"];
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
      // Who the space is for (team, client or personal) decides whether setup asks about members, so another device carrying on has to know it.
      const who = ["team", "client", "personal"].includes(picks.who) ? picks.who : null;
      return { step: i.step, device, started: prev ? prev.started : at, updated: at, name: text(i.name, 80), address: text(i.address, 120), look: text(i.look, 80), where: i.where || null, picks: { connectors, kit, ...(who ? { who } : {}) } };
    };
    tool("spaces.setup.save", "Keep where setup has got to for a space you are setting up (one of look, members, ai, connectors, kit), so another device can carry on. Send setup: null when the last step is done. Only the device setup is on may save; no secret, code or key is kept.",
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
        if (!cur) throw refuse("Nothing is being set up for that space; spaces.setup.save starts keeping a setup.", "no_setup");
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
      if (!e) throw refuse("That is not one of your devices (spaces.identity.entries lists yours).", "not_found");
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
    const kernelOffers = async (/** @type {string} */ spaceId, /** @type {any} */ dev, /** @type {boolean} */ on, /** @type {any} */ meta, /** @type {any} */ _role, /** @type {string} */ member, /** @type {boolean} */ again = false, /** @type {{ network_cap?: "provider" | "internet", loosen?: true }} */ limit = {}) => {
      const h = kernelHandle(spaceId);
      const offers = h && h.gateway && h.gateway.grants && h.gateway.grants.offers;
      if (!h || !offers || typeof offers.lend !== "function") return false;
      // the person's chain IN that Space (a hosted Space has its own key), and the proof that comes with the call. ONE kernel act: the first lend takes one proof bound to it and makes both
      // sides (an owner or admin's Space side and the member's own); the member's own turning on again, and any turning off, take only the live session (kernel ruling 5 Oct).
      const k = await kctxOf(meta, spaceId);
      // A Space on a server knows this computer by the id its home gives it (from what the transport proved), not by the identity list's entry id: the Offers are made for that id, which is also the one the
      // computer presents when it runs a session. Another of the person's computers is named by its entry id as before.
      let kdev = dev.eid;
      if (h.hosted === false && dev.eid === ownDeviceEid(meta) && typeof h.call === "function") { try { const me = await h.call("lent.whoami", []); if (me && typeof me.device === "string" && me.device) kdev = me.device; } catch { /* the home did not answer: the entry id stands */ } }
      const act = (/** @type {any} */ kc) => (on ? offers.lend(kc.chain, { member, device: kdev, device_key: kdev, ...(limit.network_cap ? { network_cap: limit.network_cap } : {}), ...(limit.loosen ? { loosen: true } : {}) }, kc.proof) : offers.unlend(kc.chain, { member, device: kdev }, kc.proof));
      /** Run one act that needs the person's yes; a space on a server asks with a one-use challenge, which this computer answers (its own key; on a development build the software key) and the act goes again. */
      const withYes = async (/** @type {(kc: any) => Promise<any>} */ run) => {
        try { return await run(k); }
        catch (e) {
          // A space on a server: its home asks for the person's yes on THIS act with a one-use challenge. This computer answers with the person's own key (the hardware signer, or a software key on a development
          // build) and the same act goes again with that proof; with no key to answer, the refusal stands and carries the challenge for a surface that can sign.
          const ch = /** @type {any} */ (e) && /** @type {any} */ (e).challenge;
          if (!ch || typeof ch.nonce !== "string" || !/^(presence_required|needs_presence)$/.test(String(/** @type {any} */ (e).code))) throw e;
          const proof = await answerChallenge(ch, spaceId);
          ctx.log.warn(`lend: the home asked for a yes (${String(/** @type {any} */ (e).code)}); this computer ${proof ? "answered it" : "has no key to answer with"}; challenge ${Object.keys(ch).join(",")}`);
          if (!proof) throw e;
          return await run(await kctxOf({ ...meta, kernel_proof: proof }, spaceId));
        }
      };
      try {
        await withYes(act);
        // Granting a computer again after its access ended is the reinstate (the sealing process refuses a lease for a removed computer until an owner or admin says yes): it goes with the new lend, under the
        // kernel's own role check, and a person who may not reinstate gets that refusal in words.
        // Whether it is needed is the home's own answer: a lease that comes back revoked means this member's computer was removed before (an Offer withdrawn, the member taken out and back in). A first lend, or one whose
        // computer was never removed, gets its lease and nothing more is asked of the person.
        let removedBefore = again;
        if (on && h.gateway.leases && typeof h.gateway.leases.issue === "function") {
          try { const t = h.hosted === false ? await h.gateway.leases.issue(null, { device: kdev, device_key: kdev, probe: true }) : await h.gateway.leases.issue(k.chain, { device: kdev, device_key: kdev, probe: true }); removedBefore = Boolean(t && t.revoked); } catch { /* the probe could not be asked: the lender's own record decides */ }
        }
        if (on && removedBefore && h.gateway.leases && typeof h.gateway.leases.reinstate === "function") {
          // The development stand-in for Face ID (a development build only) is not a proof the sealing process can check, so it cannot reinstate: the lend still goes through, as it did before the reinstate existed, and says so
          const standIn = (/** @type {any} */ p) => Boolean(p) && (p.method === "stand-in" || (p.presence && p.presence.method === "stand-in"));
          try {
            await withYes(kc => { if (standIn(kc.proof)) throw Object.assign(new Error("stand-in"), { code: "stand_in" }); return (h.hosted === false ? (kc.proof && kc.proof.presence !== undefined ? h.gateway.leases.reinstate(null, { member, device: kdev }, kc.proof) : h.gateway.leases.reinstate(null, { member, device: kdev })) : h.gateway.leases.reinstate(kc.chain, { member, device: kdev, proof: kc.proof && kc.proof.presence })); });
          } catch (e) { if (/** @type {any} */ (e).code === "stand_in") ctx.log.warn("lend: the development stand-in for Face ID cannot reinstate a removed computer's lease; use a real presence proof"); else throw e; }
        }
      } catch (e) { ctx.log.warn(`lend: the kernel refused: ${/** @type {any} */ (e).code || ""} ${String(/** @type {any} */ (e).hidden_reason || "")}`); throw plainKernelError(e); }
      return kdev;
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
    const callerPerson = async (/** @type {any} */ meta, /** @type {string | undefined} */ homeId = undefined) => {
      const home = homeId !== undefined ? homeId : /** @type {string} */ (me().id);
      if (!K || typeof K.chain !== "function" || !(meta && (meta.kernelFacts || meta.token))) return home;
      try { const c = await K.chain(meta); const h = c && c.hops && c.hops.length === 1 ? c.hops[0].actor : null; return h && h.kind === "person" ? String(h.id) : home; } catch { return home; }
    };
    tool("spaces.devices.lend", "Lend one of your computers to a space, or stop. The first time for a device in a space needs your Face ID or fingerprint; stopping never does.",
      obj({ space: str, device: str, on: { type: "boolean" }, network_cap: { type: "string", enum: ["provider", "internet"], description: "Lending only: the most network the Space's work may use on your computer. The tightest limit you ever set for this computer stays until you lend again with loosen." }, loosen: { type: "boolean", description: "Lending only: you mean to allow more network than you did before on this computer." }, member: { ...str, description: "Stopping only: the person whose computer it is, when an owner or admin of the space stops it from the space's own server (the computer is then named by the id the space gives it)." } }, ["space", "device", "on"]), async (i, meta) => {
        const s = me();
        const row = spaceOf(i.space);
        const caller = await callerPerson(meta);
        if (caller !== s.id) throw refuse("That is not yours to do; only that person can do it, on their own device.", "forbidden");
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
            // An owner or admin stopping a member's computer from the space's own home names it by the id the space knows it by, and the person: nothing local says whose it is.
            const byHome = !mine && owner && !cur && typeof i.member === "string" && i.member;
            if (byHome) {
              const viaHome = await kernelOffers(row.id, { eid: String(i.device) }, false, meta, "owner", String(i.member));
              emit("space.device-lent", { space: row.id, device: String(i.device), lent: false });
              return { space: row.id, device: String(i.device), lent: false, first_grant_at: null, allowed_by: null, stopped: viaHome };
            }
            if (!mine && !(owner && cur)) throw refuse("That is not one of your devices (spaces.identity.entries lists yours).", "not_found");
            if (!cur || !cur.lent) return { space: row.id, device: String(i.device), lent: false, first_grant_at: cur ? cur.first_grant_at : null, allowed_by: cur ? cur.allowed_by : null };
            const viaKernel = await kernelOffers(row.id, { eid: cur.kdevice || String(i.device) }, false, meta, m ? m.role : "owner", cur.device_person || /** @type {string} */ (s.id));
            // LD-2: the space's owner switching a computer off that is not theirs withdraws the space's consent: turning it on again asks the device's person for Face ID again
            const next = { ...cur, lent: false, ended_at: now(), ended_by: s.id, kernel: viaKernel, ...(mine ? {} : { first_grant_at: null, allowed_by: null }) };
            await kv.put(key, next);
            emit("space.device-lent", { space: row.id, device: next.device, lent: false });
            return { space: row.id, device: next.device, lent: false, first_grant_at: next.first_grant_at, allowed_by: next.allowed_by };
          }
          const dev = await deviceOf(i.device, meta);
          if (!(await isEnrolled(dev.eid, row.id))) throw refuse("That device is not in this space. Add it first.", "device_removed");
          const viaKernel = await kernelOffers(row.id, dev, true, meta, m ? m.role : "owner", /** @type {string} */ (s.id), Boolean(cur), { ...(i.network_cap ? { network_cap: i.network_cap } : {}), ...(i.loosen === true ? { loosen: true } : {}) });
          const first = cur && cur.first_grant_at ? cur.first_grant_at : now();
          const next = { lent: true, kernel: Boolean(viaKernel), ...(typeof viaKernel === "string" ? { kdevice: viaKernel } : {}), device: dev.eid, device_person: s.id, first_grant_at: first, allowed_by: cur && cur.allowed_by ? cur.allowed_by : s.id, at: now() };
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
      if (!mine && !lead) throw refuse("That is not one of your devices (spaces.identity.entries lists yours).", "not_found");
      const cur = await kv.get(lendKey(row.id, String(i.device)));
      return { space: row.id, device: String(i.device), lent: Boolean(cur && cur.lent), first_grant_at: cur ? cur.first_grant_at : null, allowed_by: cur ? cur.allowed_by : null };
    });
    // A server paired to a person's identity (Wink pairing, once the pairing proved the identity's own key over this pairing) has the person's id as its owner too, not its first-start id (walker, step 4).
    // For the pairing module only: the kernel makes the change once, logged, and refuses a second one.
    tool("spaces.owner.adopt", "For the pairing module, after it has PROVED the identity: make this home's owner (and its hosted Spaces') the person's identity id. Once only.", obj({ person: str, name: str, presence_key: obj({ device: str, key_id: str, spki: str, signer: str }, ["device", "key_id", "spki", "signer"]) }, ["person"]), async (i, meta) => {
      // Second layer (the registry's reach is the first): only the Wink module, and only for the identity ITS OWN pairing record names (never a value a caller chose), on a home that has no adopted owner yet.
      onlyModules(meta, ["wink"]);
      const id = String(i.person);
      let rec = null; try { const r = await ctx.call("wink.server.owner", {}); rec = r && r.data ? r.data : null; } catch { rec = null; }
      if (!rec || rec.identity !== id) throw refuse("That is not the identity this server was paired to; give the identity of the person who paired it.", "forbidden");
      if (!/^per_[a-z2-7]{26}$/.test(id)) throw refuse("That is not a person id.", "bad_input");
      if (!K || typeof K.adoptOwner !== "function") throw refuse("This home has no kernel to change; run this on a server that hosts spaces.", "unavailable");
      // First owner wins: a home whose owner is already a claimed identity is never taken by another one
      { const had = typeof K.ownerClaimed === "function" ? K.ownerClaimed() : null; if (had && had !== id) throw refuse("This server already belongs to another Vyre identity.", "owned_by_other"); }
      let r;
      try { r = await K.adoptOwner(id, { from: K.owner }); } catch (e) { throw plainKernelError(e); }
      // The owner's Vyre name, checked against the directory (the name is the pairing's word, the directory's answer is the proof), so this home can read the owner's own identity list later:
      // a recovered or new phone of the owner is on that list and reaches the owner's spaces here without being paired again (member-device enrolment).
      const label = typeof i.name === "string" ? i.name.trim().toLowerCase().replace(/\.vyre\.run$/, "") : "";
      if (label) { try { const v = await dir.resolve(label); if (v.ok && v.kind === "person" && v.id === id) await kv.put(`person-name/${id}`, label); } catch { /* the name is learned later, when the owner is next verified */ } }
      // The device that paired as this owner offered a presence key in its hello: it is enrolled in the sealing process inside this same pairing, so the owner's own acts (inviting, changing roles) can be proved by it.
      // A refusal leaves the pairing as it is and says why (a release-kind home takes no software key; a person who already has a key needs that key's proof for a further device); nothing is kept half done.
      /** @type {{ enrolled: boolean, reason?: string }} */ let presence = { enrolled: false, reason: "no presence key offered" };
      const pk = i.presence_key;
      if (pk && typeof pk === "object" && typeof K.enrolOwnerKey === "function") {
        try { await K.enrolOwnerKey({ person: id, device: String(pk.device), key_id: String(pk.key_id), spki: String(pk.spki), signer: String(pk.signer), ...(typeof pk.rp === "string" ? { rp: pk.rp } : {}) }); presence = { enrolled: true }; }
        catch (e) { presence = { enrolled: false, reason: String(/** @type {any} */ (e).code || "failed").slice(0, 40) }; ctx.log.warn(`the owner's presence key was not enrolled (${presence.reason})`); }
      }
      return { owner: r.owner, previous: r.previous, changed: r.changed, presence };
    }, { internal: true });
    // For the pairing module: the identity that already took this home's owner place, or null. Wink refuses to pair a different identity to a home that has one (first owner wins).
    tool("spaces.owner.claimed", "For the pairing module: the identity id that took this home's owner place ({ claimed }), or { claimed: null } while the owner is still the first-start id. Read only.", obj(), async (_i, meta) => {
      onlyModules(meta, ["wink"]);
      if (!K || typeof K.ownerClaimed !== "function") return { claimed: null };
      return { claimed: K.ownerClaimed() };
    }, { internal: true });
    // The spaces a person owns or administers, for the pairing module's "Pair to:" choices (one id: the kernel's space id, the name the person gave it, the person's role there).
    tool("spaces.admin-list", "The finished spaces a person owns or administers here: { spaces: [{ space, name, role }] }, and the identity's own name when it is this device's. For modules (pairing targets).", obj({ person: str }, ["person"]), async (i, meta) => {
      onlyModules(meta, ["wink"]);
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
    tool("spaces.identity.republish", "Put your identity's chain and each finished space's name in the directory again, for a directory that lost its claims (a test server that restarted). Your name is finished again with a fresh reservation code (`code`) when the directory no longer holds it. Says what it put back and what it could not.", obj({ code: str }), async i => {
      const done = { identity: false, spaces: /** @type {string[]} */ ([]), failed: /** @type {Array<{ name: string, why: string }>} */ ([]) };
      try { await idops.republish({ code: typeof i.code === "string" ? i.code : undefined }); done.identity = true; } catch (e) { done.failed.push({ name: "identity", why: String(/** @type {any} */ (e).message || e).slice(0, 120) }); return done; }
      for (const row of spaces.all()) {
        if (row.status !== "done" || !row.rootPublic) continue;
        const r = await deps.names.claimSpace({ name: row.label, rootPublic: row.rootPublic, record: { spaceId: row.id, displayName: row.displayName } });
        if (r && r.ok) done.spaces.push(row.name); else done.failed.push({ name: row.name, why: String((r && r.message) || "refused").slice(0, 120) });
      }
      return done;
    });
    // The Vyre name for an identity id, for the pairing question at a server ("Alex (alex.vyre.run)"). The directory has no reverse lookup, so: this device's own identity (its claimed name), else a name the asker CLAIMS
    // (owner.vyre) that the directory resolves to exactly this id, else a name this home verified when that person joined. Otherwise null: the short id is shown, never an unchecked name.
    tool("spaces.person.learn", "For the peer door: remember a person's Vyre name once the directory says it is theirs, so this home can find their identity list (member-device enrolment). Answers { known }.", obj({ id: str, name: str }, ["id", "name"]), async (i, meta) => {
      onlyModules(meta, ["vyred", "wink", "tailnet", "relay"]);
      const label = String(i.name || "").trim().toLowerCase().replace(/\.vyre\.run$/, "");
      if (!/^per_[a-z2-7]{26}$/.test(String(i.id)) || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(label)) return { known: false };
      try { const v = await dir.resolve(label); if (v.ok && v.kind === "person" && v.id === String(i.id)) { await kv.put(`person-name/${i.id}`, label); return { known: true }; } } catch { /* not theirs, or unreachable */ }
      return { known: false };
    }, { internal: true });
    tool("spaces.identity.name-of", "The claimed Vyre name for a person's id, verified: { name: 'alex.vyre.run' | null }. For modules.", obj({ id: str, claimed: str }, ["id"]), async (i, meta) => {
      onlyModules(meta, ["wink"]);
      const id = String(i.id);
      let st = null; try { st = identity.status(); } catch { st = null; }
      if (st && st.exists && st.id === id && st.name) return { name: `${st.name}.vyre.run` };
      // a name this home learned and verified when the person paired it as their owner (spaces.owner.adopt)
      { const known = /** @type {string | null} */ (await kv.get(`person-name/${id}`)); if (typeof known === "string" && known) return { name: `${known.replace(/\.vyre\.run$/, "")}.vyre.run` }; }
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
        if (typeof K.space === "string" && ((await K.membership(person, K.space).catch(() => ({ member: false }))).member === true || person === K.owner)) ids.push(K.space); // the home Space is its owner's by definition
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
      if (!K || typeof K.owner !== "string") throw refuse("This home has no kernel to host a space; run this on a server that hosts spaces.", "unavailable");
      let person = null;
      try { const c = await K.chain(meta); const h = c && c.hops && c.hops.length === 1 ? c.hops[0].actor : null; person = h && h.kind === "person" ? String(h.id) : null; } catch { person = null; }
      if (!person || person !== K.owner) throw refuse("Only this home's owner can have it host a space.", "forbidden");
    };
    tool("spaces.retire-here", "On a server: take back a space that was only started here (a failed or cancelled create). Refuses a space with content (fail closed).", obj({ id: str }, ["id"]), async (i, meta) => {
      await ownerOnly(meta);
      if (!K || !K.spaces || typeof K.spaces.retire !== "function") throw refuse("This home has no kernel to change; run this on a server that hosts spaces.", "unavailable");
      let r;
      try { r = await K.spaces.retire(String(i.id)); } catch (e) { throw plainKernelError(e); }
      if (/^spc_[a-z2-7]{12}$/.test(String(i.id))) await files.keys.discard(String(i.id)).catch(() => {});
      return r;
    }, { presence: { summary: (/** @type {any} */ i) => `Take back the space ${i && i.id} on this server` } });
    tool("spaces.host-here", "On a server: host a new space in THIS home's kernel for its owner (called by the owner's device over the paired session when a space is made with this server as its home). Answers { space }. Idempotent when given the id. Needs no presence proof: the owner check is the gate.", obj({ name: str, id: str, acceptBuiltinStore: { type: "boolean" } }, ["name"]), async (i, meta) => {
      if (!K || !K.spaces || typeof K.spaces.host !== "function" || typeof K.owner !== "string") throw refuse("This home has no kernel to host a space; run this on a server that hosts spaces.", "unavailable");
      let person = null;
      try { const c = await K.chain(meta); const h = c && c.hops && c.hops.length === 1 ? c.hops[0].actor : null; person = h && h.kind === "person" ? String(h.id) : null; } catch { person = null; }
      if (!person || person !== K.owner) throw refuse("Only this home's owner can have it host a space.", "forbidden");
      const label = String(i.name || "").trim().toLowerCase().replace(/\.vyre\.run$/, "");
      if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(label)) throw refuse("That is not a space name.", "bad_name");
      if (typeof i.id === "string" && i.id) {
        if (!/^spc_[a-z2-7]{12}$/.test(i.id)) throw refuse("That is not a space id.", "bad_input");
        if (K.spaces.hosts(i.id) === true) { const have = files.keys.load(i.id); return { space: i.id, existed: true, ...(have ? { rootPublic: have.publicKey } : {}) }; }
      }
      // A server that cannot run the record store (Twenty) hosts nothing: the refusal carries the kernel's own words.
      const plan = typeof hooks.storePlan === "function" ? await hooks.storePlan() : typeof K.spaces.storePlan === "function" ? await K.spaces.storePlan().catch(() => null) : null;
      const confirm = plan && plan.confirm ? plan.confirm : null;
      if (confirm) throw refuse(String(confirm.text || "This server cannot run the record store (Twenty)."), "store_unavailable");
      let h;
      try { h = await K.spaces.host({ owner: K.owner, name: label, ...(typeof i.id === "string" && i.id ? { id: i.id } : {}) }); } catch (e) { throw plainKernelError(e); }
      const id = h.space || h.id;
      // The space's key as a joiner can check it: made and held HERE (spaces/<id>/root.key, 0600), never returned. Its public half goes into the owner-signed directory record as `rootPublic`,
      // and a joiner's device asks this server to sign a fresh nonce with it (spaces.attest, answered inside grants.invites.get) before it shows the join card.
      const kp = await files.keys.generate();
      await files.keys.hold(id, kp.privateKey);
      // the device that asked for it is enrolled in the new space on this server (a device that already has a list is not added by itself: devices enrol per space), so its own later calls into the space have a chain
      { const dk = meta && meta.kernelFacts && meta.kernelFacts.kind === "device" ? String(meta.kernelFacts.device_key_id || "") : ""; if (dk) { const l = await enrolledList(dk); if (l !== null && !l.includes(id)) await kv.put(`device-spaces/${dk}`, [...l, id]); } }
      return { space: id, existed: false, rootPublic: kp.publicKey };
    });
    // Making a space is not one of the yes moments (pair, vault, outward, owner changes): it rides on the owner's authenticated call above and asks for no presence.
    // A server proves it holds a space: it signs a joiner's nonce with the space's key (the one whose public half is the record's `rootPublic`). Asked by the peer door's remote server, inside the
    // answer to grants.invites.get; modules only. The message is fixed and starts with its own tag, so the signature is good for nothing else.
    tool("spaces.attest", "Sign a joiner's nonce with this home's key for a space it hosts: { pub, sig }. For the peer door (modules only).", obj({ space: str, nonce: str }, ["space", "nonce"]), async (i, meta) => {
      onlyModules(meta, ["vyred"]);
      const id = String(i.space), nonce = String(i.nonce);
      if (!/^spc_[a-z2-7]{12}$/.test(id) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw refuse("That is not a request this home answers.", "bad_input");
      if (!K || !K.spaces || K.spaces.hosts(id) !== true) throw refuse("This home does not host that space (spaces.get names its home).", "not_found");
      const k = files.keys.load(id);
      if (!k) throw refuse("This home holds no key for that space (spaces.get names the home that does).", "unavailable");
      return { pub: k.publicKey, sig: b64u(await k.sign(Buffer.from(attestMessage(id, nonce)))) };
    }, { internal: true });
    // Which paired server hosts a space this device made with a server as its home (null for a space hosted here): for the module that opens the remote path to that Space.
    tool("spaces.server-of", "The paired server's device id that hosts a space this device made, or null. For modules.", obj({ space: str }, ["space"]), async (i, meta) => { onlyModules(meta, ["wink", "runner", "vyred"]); return { device: await serverOf(String(i.space)) }; }, { internal: true });
    tool("spaces.devices.enrolled", "Whether a device is enrolled in a space (true when the device has no list yet). For the kernel and other modules, which refuse a device that is not.", obj({ device: str, space: str }, ["device", "space"]),
      async (i, meta) => {
        onlyModules(meta, ["vyred", "wink", "runner"]);
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
          // The home's own Space belongs to the home's owner by definition: a kernel whose membership table still names the owner it had before the identity was adopted must not turn the owner's own
          // confirmed devices away (typed-paired devices got no person chain, so records.* said "not a signed-in person").
          if (!member && person && id === K.space && person === K.owner) member = true;
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

    /** The tier shown for a space (the user's two-tier ruling): a space whose home is a server (a team space, or a personal one on the person's own server) is "cloud"; a space whose home is this computer is "cloud" only when this machine is a server, and "basic" on a device. The same machine role storeMode reads. @param {any} home */
    const tierOf = (home) => (home && home.kind && home.kind !== "this-computer") || config.isServer(ctx.config && ctx.config.machine) ? "cloud" : "basic";

    /** A space's home time zone (an IANA zone), or null when none is set. Kept beside the space; modules read it through spaces.list, spaces.get and spaces.tier. @param {string} id */
    const zoneOf = async (id) => { const v = await kv.get(`zone/${id}`); return v && typeof v.zone === "string" && validZone(v.zone) ? v.zone : null; };
    const listSpaces = async (/** @type {any} */ i0, /** @type {any} */ meta0) => {
      const rows = await listSpacesRaw(i0, meta0);
      return Promise.all(rows.map(async (/** @type {any} */ r) => ({ ...r, time_zone: await zoneOf(r.id) })));
    };
    /** The person's own (home) space always carries a name to show: label "personal", and the display name the tier gives it (the app words it from `tier`). */
    /** Where the Personal space points after an upgrade: `upgraded_to` is My Cloud's id, and the row says it is frozen. */
    const upgradedRow = () => { try { const h = K && typeof K.space === "string" ? K.for(K.space) : null; const m = h && h.gateway && h.gateway.upgrade ? h.gateway.upgrade.movedTo() : null; return m ? { upgraded_to: m.to } : {}; } catch { return {}; } };
    const homeNames = () => ({ label: "personal", displayName: tierOf({ kind: "this-computer" }) === "cloud" ? "My Cloud" : "Personal" });
    const listSpacesRaw = async (/** @type {any} */ _i, /** @type {any} */ meta) => {
      let st0 = null; try { st0 = identity.status(); } catch { st0 = null; }
      if ((!st0 || !st0.exists) && K && K.spaces && typeof K.spaces.list === "function" && typeof K.owner === "string") {
        const mine = [];
        for (const id of K.spaces.list()) {
          // the kernel's own answer for the home's person (no caller chain needed: a terminal on a server is not always recognised as the person, and this list is the owner's own)
          let m = null; try { const r = await K.membership(K.owner, id); if (r && r.member === true) m = { role: r.role }; } catch { m = null; }
          if (!m) continue;
          const d0 = typeof K.spaces.describe === "function" ? K.spaces.describe(id) : null;
          mine.push({ tier: "cloud", id, name: d0 && d0.name ? `${String(d0.name).replace(/\.vyre\.run$/, "")}.vyre.run` : null, label: d0 && d0.name ? String(d0.name).replace(/\.vyre\.run$/, "") : id === K.space ? homeNames().label : null, displayName: id === K.space ? homeNames().displayName : null, status: "done", home: id === K.space ? { kind: "this-computer" } : null, role: m.role, aliases: [], workspaceId: null, warnings: [], hosted: true });
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
        out.push({ tier: tierOf(row.home), ...(row.home && row.home.kind === "server" && K && K.spaces && K.spaces.hosts(row.id) === true && !(await serverOf(row.id)) ? { hostedHere: true, note: "hosted on this device, home says server" } : {}), id: row.id, name: row.name, label: row.label, displayName: row.displayName, status: row.status, home: row.home, role: m ? m.role : null, aliases: row.aliases, workspaceId: row.workspaceId, warnings: row.warnings, createdAt: row.createdAt, setup: await setupView(row, s) });
      }
      // the person's own (home) space, when this home has a kernel and they are its person: it is not a row of the module's table, so it is added here, always with a name and a tier
      try {
        if (K && typeof K.space === "string" && K.owner && !out.some(x => x.id === K.space)) {
          const sId = /** @type {string} */ (me().id);
          const m = typeof K.membership === "function" ? await K.membership(sId, K.space).catch(() => null) : null;
          if (m && m.member === true) out.unshift({ tier: tierOf({ kind: "this-computer" }), id: K.space, name: null, ...homeNames(), ...upgradedRow(), status: "done", home: { kind: "this-computer" }, role: m.role, aliases: [], workspaceId: null, warnings: [], hosted: true });
        }
      } catch { /* no home row */ }
      // spaces this person joined on someone else's server: they live there, this device keeps only where the home is
      try {
        for (const r of /** @type {any[]} */ (db.prepare("SELECT key, value FROM spaces_kv WHERE key LIKE 'member-of/%'").all())) {
          const id = String(r.key).slice("member-of/".length), v = JSON.parse(r.value);
          if (out.some(x => x.id === id)) continue;
          const name = typeof v.name === "string" ? v.name : null;
          out.push({ tier: "cloud", id, name, label: name ? name.replace(/\.vyre\.run$/, "") : null, displayName: null, status: "done", home: { kind: "server" }, role: v.role || null, member: true });
        }
      } catch { /* no joined spaces */ }
      return out;
    };

    // Whether each space's records are up (a team space's own store takes about a minute the first time): { spaces: [{ space, ready, words? }] }, `words` the plain progress sentence. The app's Now shows a calm
    // "setting up" card from it instead of an error or an empty list.
    tool("spaces.records.status", "Whether the records of each space on this device are ready, and when not, in plain words how far the first start is.", obj(), async () => {
      const out = [];
      const ids = new Set([...(K && typeof K.space === "string" ? [K.space] : []), ...(K && K.spaces && typeof K.spaces.list === "function" ? K.spaces.list() : [])]);
      for (const id of ids) {
        let h = null; try { h = K ? K.for(id) : null; } catch { h = null; }
        const store = (h && h.store) || (id === (K && K.space) ? K.store : null);
        if (!store || typeof store.attached !== "function") { out.push({ space: id, ready: true }); continue; }
        if (store.attached()) { out.push({ space: id, ready: true }); continue; }
        let words = "";
        try { words = String((await store.health()).detail || ""); } catch { /* no words */ }
        out.push({ space: id, ready: false, ...(words ? { words } : {}) });
      }
      return { spaces: out };
    });

    tool("spaces.list", "Spaces on this device that you created or belong to, with your role in each. For a space with a kernel the role is the kernel's answer. On a server that has no identity of its own (paired to yours), the spaces its kernel hosts for its owner.", obj(), listSpaces);

    /**
     * Which Cloud space keeps this person's encrypted personal items and identity home: their own server's home space when this machine is a server (My Cloud), else the Cloud space they chose
     * (`spaces.personal-host.set`) while they are still in it, else the earliest one they joined, else null. @param {{ id: string }[]} cloud the Cloud rows, earliest first
     */
    const personalHostOf = async (cloud) => {
      if (config.isServer(ctx.config && ctx.config.machine) && K && typeof K.space === "string") return K.space;
      const chosen = await kv.get("personal-host");
      if (chosen && typeof chosen.space === "string" && cloud.some(c => c.id === chosen.space)) return chosen.space;
      return cloud.length ? cloud[0].id : null;
    };
    // ---- the team server's per-member object storage (lib/spaces/member-storage.js): ciphertext a member keeps on a space this server hosts, for their own personal items and identity home. The caller
    // is the member themself (the chain's one person, a member of that space); each call reaches only that person's own folder. The space's owner sets the cap. ----
    const storage = createMemberStorage({ dir: root });
    const MAX_OBJECT = 8 * 1024 * 1024;
    /** @param {string} space @param {any} meta @param {boolean} [owner] @returns {Promise<{ person: string, role: string }>} */
    const storageCaller = async (space, meta, owner = false) => {
      if (!K || !K.spaces || typeof K.spaces.hosts !== "function" || K.spaces.hosts(String(space)) !== true) throw refuse("This server does not host that space (spaces.get names its home).", "not_found");
      let person = null;
      try { const c = await K.chain(meta); const h = c && c.hops && c.hops.length === 1 ? c.hops[0].actor : null; person = h && h.kind === "person" ? String(h.id) : null; } catch { person = null; }
      if (!person) throw refuse("Only a person can use their storage.", "forbidden");
      const m = await K.membership(person, String(space)).catch(() => null);
      if (!m || m.member !== true) throw refuse("You are not a member of that space.", "forbidden");
      if (owner && m.role !== "owner") throw refuse("Only an owner can set a storage cap.", "forbidden");
      return { person, role: String(m.role) };
    };
    const decode = (/** @type {any} */ v) => { if (typeof v !== "string" || v.length > Math.ceil(MAX_OBJECT * 4 / 3) + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw refuse("An object is base64 text of at most 8 MB.", "bad_input"); return Buffer.from(v, "base64"); };
    const wrapStorage = (/** @type {() => any} */ f) => { try { return f(); } catch (e) { const c = /** @type {any} */ (e).code; if (c === "over_cap") throw refuse("Your storage on this server is full.", "over_cap"); if (c === "bad_input") throw refuse(String(/** @type {Error} */ (e).message), "bad_input"); throw e; } };
    tool("spaces.storage.put", "Keep an object (ciphertext, base64) in your own storage on a space this server hosts. Refused once your storage reaches the cap the owner set.", obj({ space: str, name: str, data: str }, ["space", "name", "data"]), async (i, meta) => {
      const { person } = await storageCaller(i.space, meta);
      return wrapStorage(() => storage.put(i.space, person, i.name, decode(i.data)));
    });
    tool("spaces.storage.put-if", "Keep an object only if it is still what you last saw: `expected` is its sha256 in hex, or null when it should not exist yet. Answers { ok, sha256 }, with the sha256 that is there now.", obj({ space: str, name: str, data: str, expected: { type: ["string", "null"] } }, ["space", "name", "data", "expected"]), async (i, meta) => {
      const { person } = await storageCaller(i.space, meta);
      return wrapStorage(() => storage.putIf(i.space, person, i.name, decode(i.data), i.expected));
    });
    tool("spaces.storage.get", "Read one of your objects: { data (base64), sha256 }, or null when it is not there.", obj({ space: str, name: str }, ["space", "name"]), async (i, meta) => {
      const { person } = await storageCaller(i.space, meta);
      const r = wrapStorage(() => storage.get(i.space, person, i.name));
      return r ? { data: r.data.toString("base64"), sha256: r.sha256 } : null;
    });
    tool("spaces.storage.list", "Your objects under a prefix, one level: `names`, and `entries` ({ name, sha, size }) to compare against.", obj({ space: str, prefix: str }, ["space"]), async (i, meta) => {
      const { person } = await storageCaller(i.space, meta);
      return wrapStorage(() => ({ names: storage.list(i.space, person, i.prefix || ""), entries: storage.entries(i.space, person, i.prefix || "") }));
    });
    tool("spaces.storage.delete", "Delete one of your objects. With `expected` (its sha256, or null for \"must not exist\") it deletes only if it is still what you last saw, else answers { ok: false, sha256 } and deletes nothing. Never refused for the cap.", obj({ space: str, name: str, expected: { type: ["string", "null"] } }, ["space", "name"]), async (i, meta) => {
      const { person } = await storageCaller(i.space, meta);
      return wrapStorage(() => storage.delete(i.space, person, i.name, i.expected));
    });
    tool("spaces.storage.usage", "How much of your storage on this space you have used, and the cap.", obj({ space: str }, ["space"]), async (i, meta) => {
      const { person } = await storageCaller(i.space, meta);
      return storage.usage(i.space, person);
    });
    tool("spaces.storage.set-cap", "As an owner: set the storage cap in bytes (0 for none) for one member, or for everyone with person \"*\".", obj({ space: str, person: str, bytes: { type: "number" } }, ["space", "person", "bytes"]), async (i, meta) => {
      await storageCaller(i.space, meta, true);
      return wrapStorage(() => storage.setCap(i.space, i.person, i.bytes));
    });

    // ---- moving a project to a Space on ANOTHER home (kernel/gateway/moves.js, reviewer-3's team/0.3/reviews/remote-move-design.md). The mover's own device is the courier between the two homes; each side
    // signs only what its own log says, with its Space key (the one whose public half is the Space's published `rootPublic`), and the other side checks that signature against the DIRECTORY's key for
    // that Space id, resolved under the pin the mover's device holds (RM-6), never against a key it is handed. ----
    const MOVE_EVIDENCE_TAG = "vyre-move-evidence-v1", MOVE_RECEIPT_TAG = "vyre-move-receipt-v1", MOVE_UPGRADE_RECEIPT_TAG = "vyre-upgrade-receipt-v1", UPGRADE_WRAPKEY_TAG = "vyre-upgrade-wrapkey-v1";
    const EVIDENCE_KEYS = ["v", "from", "to", "project", "plan_hash", "move_id", "person", "at"];
    const RECEIPT_KEYS = ["v", "move_id", "from", "to", "counts", "files_root", "at"];
    const exactKeys = (/** @type {any} */ o, /** @type {string[]} */ keys) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
    /** The directory context a hook needs for the move being checked, set by the tool around its one kernel call. @type {Map<string, { name: string, pin: any }>} */
    const moveContext = new Map();
    /** Sign `obj` under `tag` with a hosted Space's own key: { pub, sig }. The kernel hands over only what its own log said, never a key. */
    const signMove = async (/** @type {string} */ space, /** @type {string} */ tag, /** @type {any} */ obj) => {
      const k = files.keys.load(space);
      if (!k) throw refuse("This home holds no key for that space (spaces.get names the home that does).", "unavailable");
      return { pub: k.publicKey, sig: b64u(await k.sign(Buffer.from(`${tag}\n${canonicalOf(obj)}`))) };
    };
    /** The Space's published key, by Space id, resolved under the pin (RM-6): null unless the directory names this very Space id with a key. */
    const publishedKeyOf = async (/** @type {string} */ spaceId, /** @type {{ name: string, pin: any } | undefined} */ c) => {
      if (!c || typeof c.name !== "string" || !c.pin) return null;
      let r; try { r = await dir.resolve(c.name.replace(/\.vyre\.run$/, ""), { pin: c.pin, resolve: ownerLookup }); } catch { return null; }
      return r && r.ok && r.kind === "space" && r.payload && r.payload.id === spaceId && typeof r.payload.rootPublic === "string" && r.payload.rootPublic ? r.payload.rootPublic : null;
    };
    const verifySigned = async (/** @type {string} */ pub, /** @type {string} */ tag, /** @type {any} */ obj, /** @type {string} */ sig) => { try { return await C.verifyWith(pub, Buffer.from(`${tag}\n${canonicalOf(obj)}`), sig); } catch { return false; } };
    if (K && K.spaces && typeof K.spaces.setMoveHooks === "function") {
      K.spaces.setMoveHooks({
        /** The target checks the source's signed evidence: the signature is the Space key's, and that key is the directory's for the source Space id. */
        remoteEvidence: async (/** @type {any} */ bundle, /** @type {{ from: string, to: string }} */ c) => {
          if (!bundle || typeof bundle.pub !== "string" || typeof bundle.sig !== "string" || !exactKeys(bundle.evidence, EVIDENCE_KEYS) || bundle.evidence.v !== 1) return null;
          const ev = bundle.evidence;
          if (ev.from !== c.from || ev.to !== c.to) return null;
          const ctx = moveContext.get(`${ev.from}/${ev.to}/${ev.move_id}`);
          const published = await publishedKeyOf(ev.from, ctx);
          if (!published || published !== bundle.pub) return null;
          return (await verifySigned(bundle.pub, MOVE_EVIDENCE_TAG, ev, bundle.sig)) ? ev : null;
        },
        /** The Personal kernel checks My Cloud's signed upgrade receipt against My Cloud's published key (name and pin from the device that is upgrading). */
        verifyUpgradeReceipt: async (/** @type {any} */ receipt, /** @type {{ from: string, to: string, upgrade_id: string }} */ c) => {
          if (!receipt || typeof receipt.sig !== "string" || !receipt.body || typeof receipt.body !== "object") return null;
          const b = receipt.body;
          if (b.v !== 1 || b.from !== c.from || b.to !== c.to || b.upgrade_id !== c.upgrade_id) return null;
          const published = await publishedKeyOf(c.to, moveContext.get(`${c.from}/${c.to}/${c.upgrade_id}`));
          if (!published) return null;
          return (await verifySigned(published, MOVE_UPGRADE_RECEIPT_TAG, b, receipt.sig)) ? b : null;
        },
        /** The source checks the target's signed receipt the same way, against the TARGET Space's published key. */
        verifyReceipt: async (/** @type {any} */ receipt, /** @type {{ from: string, to: string }} */ c) => {
          if (!receipt || typeof receipt.pub !== "string" || typeof receipt.sig !== "string" || !exactKeys(receipt.body, RECEIPT_KEYS) || receipt.body.v !== 1) return null;
          const b = receipt.body;
          if (b.from !== c.from || b.to !== c.to) return null;
          const ctx = moveContext.get(`${b.from}/${b.to}/${b.move_id}`);
          const published = await publishedKeyOf(b.to, ctx);
          if (!published || published !== receipt.pub) return null;
          return (await verifySigned(receipt.pub, MOVE_RECEIPT_TAG, b, receipt.sig)) ? b : null;
        },
      });
    }
    /** The mover's chain in a hosted Space and its gateway's moves. @param {string} space @param {any} meta */
    const moveSide = async (space, meta) => {
      if (!K || typeof K.chainIn !== "function" || !K.spaces || K.spaces.hosts(String(space)) !== true) throw refuse("This home does not host that space (spaces.get names its home).", "not_found");
      let chain; try { chain = await K.chainIn(String(space), meta); } catch { throw refuse("You are not a member of that space.", "forbidden"); }
      const h = kernelHandle(String(space));
      if (!h || !h.gateway || !h.gateway.moves) throw refuse("That space cannot move projects; ask its owner to update its home.", "unavailable");
      return { chain, moves: h.gateway.moves };
    };
    const asRefusal = (/** @type {any} */ e) => { const c = String((e && e.code) || ""); if (/^(not_found|invalid|bad_input|chain_not_person|rate_limited|unavailable|not_allowed|needs_presence)$/.test(c)) return refuse(String(e.message || "That move is refused."), c); throw plainKernelError(e); };
    tool("spaces.moves.evidence", "In the SOURCE home: the signed evidence that you started a move of a project out of a space here, for the target to check. { evidence, pub, sig }; the Space's own key signs only what its own log says. `toName` and `pin` say which published space the move goes to: this home resolves that space's key now and holds the right to pull for that space only.", obj({ space: str, move_id: str, toName: str, pin: str }, ["space", "move_id", "toName", "pin"]), async (i, meta) => {
      const { chain, moves } = await moveSide(i.space, meta);
      let evidence; try { evidence = moves.evidenceOf(chain, { move_id: i.move_id }); } catch (e) { throw asRefusal(e); }
      const pin = parsePin(i.pin);
      if (!pin) throw refuse("A move names the pinned version of the target space's list.", "bad_input");
      const toKey = await publishedKeyOf(evidence.to, { name: String(i.toName), pin });
      if (!toKey) throw refuse("The target space has no published key, so a move to it cannot be checked. Ask its owner to publish it.", "not_found");
      const signed = await signMove(String(i.space), MOVE_EVIDENCE_TAG, evidence);
      // this home may now serve a pull for this move to the target space whose key it just resolved, for as long as a pull may live
      await kv.put(`move-pull/${evidence.move_id}`, { from: String(i.space), to: evidence.to, to_pub: toKey, person: evidence.person, plan_hash: evidence.plan_hash, project: evidence.project, expires: evidence.at + SESSION_CAP_MS });
      // the home's door admits the target home for this move, and only while this is open (network's home-to-home channel); with no such tool (a build without it) the pull simply cannot arrive
      try { const r = await ctx.call("wink.home-move.open", { space: String(i.space), move_id: evidence.move_id, to: evidence.to, expires: evidence.at + SESSION_CAP_MS }); if (r && r.error && r.error.code !== "no_such_tool") throw refuse("This server could not open its door for the move. Nothing was started. Try the move again in a minute.", "unavailable"); }
      catch (e) { if (e && /** @type {any} */ (e).code === "unavailable") throw e; /* the channel is not part of this build */ }
      return { evidence, ...signed };
    });
    tool("spaces.moves.receive", "In the TARGET home: receive a project moved from a space on another home. `bundle` is the signed evidence; `fromName` and `pin` say which published space it names, the way an invite does.", obj({ space: str, from: str, project: str, plan_hash: str, move_id: str, bundle: { type: "object" }, fromName: str, pin: str }, ["space", "from", "project", "plan_hash", "move_id", "bundle", "fromName", "pin"]), async (i, meta) => {
      const { chain, moves } = await moveSide(i.space, meta);
      const pin = parsePin(i.pin);
      if (!pin) throw refuse("A move names the pinned version of the source space's list.", "bad_input");
      const key = `${i.from}/${i.space}/${i.move_id}`;
      moveContext.set(key, { name: String(i.fromName), pin });
      try { return await moves.in(chain, { from: i.from, project: i.project, plan_hash: i.plan_hash, move_id: i.move_id, bundle: i.bundle }); }
      catch (e) { throw asRefusal(e); }
      finally { moveContext.delete(key); }
    });
    tool("spaces.moves.receipt", "In the TARGET home, after the copy is checked: finish the move here and answer the receipt the SOURCE needs ({ body, pub, sig }), signed with this space's key over the counts and the root of the per-file hashes.", obj({ space: str, move_id: str, counts: { type: "object" }, files_root: str }, ["space", "move_id", "counts", "files_root"]), async (i, meta) => {
      const { chain, moves } = await moveSide(i.space, meta);
      let body; try { body = await moves.finishTarget(chain, { move_id: i.move_id, counts: i.counts, files_root: i.files_root }); } catch (e) { throw asRefusal(e); }
      return { body, ...(await signMove(String(i.space), MOVE_RECEIPT_TAG, body)) };
    });
    tool("spaces.moves.finish", "In the SOURCE home: the target's signed receipt arrived. Checked against the target space's published key (`toName`, `pin`), then the move is marked done here, and only then may anything be cleared from the source.", obj({ space: str, move_id: str, receipt: { type: "object" }, toName: str, pin: str }, ["space", "move_id", "receipt", "toName", "pin"]), async (i, meta) => {
      const { chain, moves } = await moveSide(i.space, meta);
      const pin = parsePin(i.pin);
      if (!pin) throw refuse("A move names the pinned version of the target space's list.", "bad_input");
      const b = i.receipt && i.receipt.body;
      const key = `${i.space}/${b && b.to}/${i.move_id}`;
      moveContext.set(key, { name: String(i.toName), pin });
      try {
        const done = await moves.finishSource(chain, { move_id: i.move_id, receipt: i.receipt });
        // the move is over: its door closes at once (best effort; it also closes by itself when the right expires)
        try { await ctx.call("wink.home-move.close", { move_id: i.move_id }); } catch { /* not part of this build, or already closed */ }
        return done;
      }
      catch (e) { throw asRefusal(e); }
      finally { moveContext.delete(key); }
    });
    /** @type {Map<string, any>} one pull source per hosted Space this home serves, so a stream's nonces and sessions persist between its requests */ const pullSources = new Map();
    const pullSourceOf = (/** @type {string} */ space) => {
      let src = pullSources.get(space);
      if (!src) {
        const serve = async (/** @type {any} */ input) => { const r = await ctx.call("work.move.serve", { space, ...input }); if (r && r.error) throw Object.assign(new Error(String(r.error.message || "the move could not be served")), { code: String(r.error.code || "unavailable") }); return r.data; };
        src = createPullSource({
          space,
          grantOf: async (/** @type {string} */ moveId) => { const g = await kv.get(`move-pull/${moveId}`); return g && g.from === space ? g : null; },
          sign: async (/** @type {string} */ m) => { const k = files.keys.load(space); if (!k) throw refuse("This home holds no key for that space (spaces.get names the home that does).", "unavailable"); return b64u(await k.sign(Buffer.from(m))); },
          verify: async (/** @type {string} */ pub, /** @type {string} */ m, /** @type {string} */ sig) => { try { return await C.verifyWith(pub, Buffer.from(m), sig); } catch { return false; } },
          // every call names exactly what was approved: the serving side checks it against the source's own `project.move_started` (it does not rely on this pull check alone)
          planFor: (g) => serve({ op: "plan", person: g.person, project: g.project, move_id: g.move_id, plan_hash: g.plan_hash, to_space: g.to }),
          readRecord: (g, urn) => serve({ op: "record", person: g.person, project: g.project, move_id: g.move_id, plan_hash: g.plan_hash, urn }),
          readFile: async (g, path, offset, length) => Buffer.from(String((await serve({ op: "file", person: g.person, project: g.project, move_id: g.move_id, plan_hash: g.plan_hash, path, offset, length })).base64 || ""), "base64"),
          sealedFor: (g, ref) => serve({ op: "sealed", person: g.person, project: g.project, move_id: g.move_id, plan_hash: g.plan_hash, ref }),
          log: (m) => ctx.log.info(m),
        });
        pullSources.set(space, src);
      }
      return src;
    };
    tool("spaces.moves.pull", "In the SOURCE home: answer one request of a target home's pull (hello, auth, plan, records, file, sealed or done). For the daemon's peer door only: the target proves itself with its Space key, and nothing is served outside the plan this home recomputes under the mover. See lib/spaces/move-pull.js.", obj({ space: str, request: { type: "object" } }, ["space", "request"]), async (i, meta) => {
      onlyModules(meta, ["vyred"]);
      const space = String(i.space);
      if (!SPACE_ID_RE.test(space) || !K || !K.spaces || K.spaces.hosts(space) !== true) throw refuse("This home does not host that space (spaces.get names its home).", "not_found");
      const r = i.request;
      const t = r && typeof r.t === "string" ? r.t : "";
      if (!["hello", "auth", "plan", "records", "file", "sealed", "done"].includes(t)) throw refuse("That is not a request this home answers.", "bad_input");
      // the door names who is asking (`home:<id>`); a nonce and a session belong to the stream that earned them and nothing else may use them
      const who = typeof meta.onBehalfOf === "string" && /^home:[A-Za-z0-9_-]{1,80}$/.test(meta.onBehalfOf) ? meta.onBehalfOf : null;
      try { return await pullSourceOf(space)[/** @type {"hello"} */ (t)](r, who); }
      catch (e) { const c = String(/** @type {any} */ (e).code || ""); if (/^(not_found|denied|bad_input|rate_limited|plan_changed|too_large|unavailable|blocked)$/.test(c)) throw refuse(String(/** @type {Error} */ (e).message), c); throw plainKernelError(e); }
    }, { internal: true });
    // the TARGET side of the pull: the driver (the Flow's copy) checks the source before it signs anything, then asks this home to sign with the target Space's key. Neither tool takes a key or returns one.
    tool("spaces.moves.pull-check-source", "In the TARGET home: is this signature the SOURCE space's, by its published key (`fromName`, `pin`)? The driver asks before it signs anything.", obj({ from: str, to: str, move_id: str, nonce: str, src_sig: str, fromName: str, pin: str }, ["from", "to", "move_id", "nonce", "src_sig", "fromName", "pin"]), async (i, meta) => {
      onlyModules(meta, ["work", "vyred"]);
      const pin = parsePin(i.pin);
      if (!pin) throw refuse("A move names the pinned version of the source space's list.", "bad_input");
      const key = await publishedKeyOf(String(i.from), { name: String(i.fromName), pin });
      return { ok: Boolean(key) && await C.verifyWith(key, Buffer.from(srcMessage(i.from, i.to, i.move_id, i.nonce)), String(i.src_sig)).catch(() => false) };
    }, { internal: true });
    tool("spaces.moves.source-channel", "In the TARGET home: where the SOURCE space's home can be reached, from its published directory record (`fromName`, `pin`): { relay, route, box }. The driver passes it to the home-to-home channel (`wink.home.call`). Refused unless the record names this very space id.", obj({ from: str, fromName: str, pin: str }, ["from", "fromName", "pin"]), async (i, meta) => {
      onlyModules(meta, ["work", "vyred"]);
      const pin = parsePin(i.pin);
      if (!pin) throw refuse("A move names the pinned version of the source space's list.", "bad_input");
      let r; try { r = await dir.resolve(String(i.fromName).replace(/\.vyre\.run$/, ""), { pin, resolve: ownerLookup }); } catch { throw refuse("The source space could not be looked up; check its name and try again (spaces.identity.resolve looks a name up).", "not_found"); }
      const rt = r && r.ok && r.kind === "space" && r.payload && r.payload.id === i.from ? r.payload.route : null;
      if (!rt || typeof rt.route !== "string" || typeof rt.box !== "string" || !rt.box) throw refuse("The source space publishes no address for its home, so it cannot be pulled from; ask its owner to bring that home online.", "not_found");
      return { relay: String(rt.relay || ""), route: rt.route, box: rt.box };
    }, { internal: true });
    tool("spaces.moves.pull-sign", "In the TARGET home: sign the pull proof for a move this space received, bound to both spaces, the move and the source's nonce, with this space's key. Only for a move this space has received (`project.move_in` in its log).", obj({ space: str, from: str, move_id: str, nonce: str }, ["space", "from", "move_id", "nonce"]), async (i, meta) => {
      onlyModules(meta, ["work", "vyred"]);
      const space = String(i.space);
      if (!K || !K.spaces || K.spaces.hosts(space) !== true) throw refuse("This home does not host that space (spaces.get names its home).", "not_found");
      const h = kernelHandle(space);
      const got = h && h.kernel && h.kernel.log ? h.kernel.log.read({ type: "project.move_in" }).find((/** @type {any} */ e) => e.data && e.data.move_id === i.move_id && e.data.from === i.from) : null;
      if (!got) throw refuse("This space received no such move; say which move you mean (the move id the source home gave).", "not_found");
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(i.nonce))) throw refuse("That is not a challenge.", "bad_input");
      const k = files.keys.load(space);
      if (!k) throw refuse("This home holds no key for that space (spaces.get names the home that does).", "unavailable");
      return { proof: b64u(await k.sign(Buffer.from(pullMessage(String(i.from), space, String(i.move_id), String(i.nonce))))) };
    }, { internal: true });
    // ---- upgrading this device's Personal space to My Cloud (kernel/gateway/upgrade.js, lib/spaces/upgrade.js). The device carries it: it holds this home's gateway and My Cloud's over the paired session. ----
    /**
     * The upgrade ports of the modules that own sealed data. Chats are `work.chat.upgrade-plan { to }` and `work.chat.upgrade-move { to }`, memory is `memory.upgrade.plan` and `memory.upgrade.move { to }`:
     * module callers only, and each runs AS THE PERSON in both Spaces, so this module relays the person it is acting for (`relay: true`, an allowlist in core/modules/index.js). A module without the tools is
     * simply not part of the plan.
     */
    /** The four port calls, by literal tool name (the reach check reads them from source). `relay` carries the person; the allowlist is RELAY_ALLOWED in core/modules/index.js. */
    const portCall = (/** @type {"chats" | "memory"} */ kind, /** @type {"plan" | "move"} */ op, /** @type {any} */ input) => {
      if (kind === "chats") return op === "plan" ? ctx.call("work.chat.upgrade-plan", input, { relay: true }) : ctx.call("work.chat.upgrade-move", input, { relay: true });
      return op === "plan" ? ctx.call("memory.upgrade.plan", input, { relay: true }) : ctx.call("memory.upgrade.move", input, { relay: true });
    };
    const upgradePorts = async (/** @type {string} */ to) => {
      /** @type {Record<string, any>} */ const ports = {};
      for (const k of /** @type {("chats" | "memory")[]} */ (["chats", "memory"])) {
        let plan = null;
        try {
          const r = await portCall(k, "plan", { to });
          if (r && r.error) { if (r.error.code === "no_such_tool" || r.error.code === "not_hosted") continue; plan = { blockers: [`could not be read: ${String(r.error.message || r.error.code).slice(0, 80)}`], counts: null }; } else plan = r.data;
        } catch (e) { if (String(/** @type {any} */ (e).code) === "no_such_tool") continue; plan = { blockers: ["could not be read"], counts: null }; }
        ports[k] = { items: plan && Array.isArray(plan.chats) ? plan.chats : [], plan: async () => plan, move: async (/** @type {{ to: string }} */ a) => { const r = await portCall(k, "move", a); if (r && r.error) throw Object.assign(new Error(String(r.error.message || "not moved")), { code: String(r.error.code || "unavailable") }); return r.data; } };
      }
      return ports;
    };
    const upgradeSides = async (/** @type {string} */ to, /** @type {any} */ meta) => {
      if (!K || typeof K.space !== "string") throw refuse("This device has no Personal space to upgrade.", "unavailable");
      if (!SPACE_ID_RE.test(String(to)) || to === K.space) throw refuse("Name your My Cloud space.", "bad_input");
      const lh = kernelHandle(K.space), rh = kernelHandle(String(to));
      if (!lh || !lh.gateway || !rh || !rh.gateway) throw refuse("That space is not reachable from this device (spaces.list shows the ones that are).", "not_found");
      const lk = await kctxOf(meta, K.space);
      return {
        local: { space: K.space, records: lh.gateway.records, definitions: (/** @type {any} */ c) => lh.gateway.definitions(c), chain: lk.chain },
        remote: { space: String(to), records: rh.gateway.records, definitions: (/** @type {any} */ c) => rh.gateway.definitions(c), chain: null },
        gateway: lh.gateway, proof: lk.proof, sealing: { local: lh.gateway.seal, remote: rh.gateway.seal },
      };
    };
    /** See `resealPortFor` (lib/spaces/upgrade.js): the sealed-value transfer through platform's seal ops. */
    const resealPort = (/** @type {any} */ sides, /** @type {string} */ plan_hash, /** @type {{ proof?: any }} */ approval) => resealPortFor({ local: sides.local, remote: sides.remote, sealing: sides.sealing, plan_hash, approval });
    tool("spaces.servers", "The servers this device is paired to, for \"Set up My Cloud\": { servers: [{ id, name }] }, where `id` is what `spaces.create` takes as `home.device.id`. Empty when none is paired.", obj(), async () => {
      let who = null; try { who = identity.status(); } catch { who = null; }
      /** @type {any[]} */ let rows = [];
      try { rows = db.prepare("SELECT id, name, created FROM wink_devices WHERE kind = 'server' ORDER BY created, id").all(); } catch { rows = []; }
      void who;
      // `online` is null: whether the server is reachable right now is not known without opening its session, which a list does not do
      return { servers: rows.map(r => ({ id: String(r.id), name: String(r.name), online: null })) };
    });
    tool("spaces.upgrade.receipt", "In MY CLOUD's home: say what this space holds of the objects an upgrade carried, signed with this space's key. It reads its OWN records under your chain and answers { body, pub, sig }: the count and the root of the per-object hashes. The Personal space freezes only on this.", obj({ space: str, upgrade_id: str, from: str, objects: { type: "array" } }, ["space", "upgrade_id", "from", "objects"]), async (i, meta) => {
      const space = String(i.space);
      if (!K || typeof K.chainIn !== "function" || !K.spaces || K.spaces.hosts(space) !== true) throw refuse("This home does not host that space (spaces.get names its home).", "not_found");
      if (!Array.isArray(i.objects) || i.objects.length > 5000) throw refuse("An upgrade receipt covers at most 5000 objects.", "bad_input");
      let chain; try { chain = await K.chainIn(space, meta); } catch (e) { ctx.log.warn(`upgrade receipt: no chain in ${space}: ${/** @type {any} */ (e).code} ${/** @type {Error} */ (e).message} (facts ${JSON.stringify(meta && meta.kernelFacts ? Object.keys(meta.kernelFacts) : null)})`); throw refuse("You are not a member of that space.", "forbidden"); }
      const h = kernelHandle(space);
      const objects = i.objects.map((/** @type {any} */ o) => ({ type: String(o.type), id: String(o.id), keys: Array.isArray(o.keys) ? o.keys.map(String) : [] }));
      const fp = await fingerprint({ space, records: h.gateway.records, chain }, objects);
      const body = { v: 1, upgrade_id: String(i.upgrade_id), from: String(i.from), to: space, count: fp.count, objects_root: fp.root, at: now() };
      return { body, ...(await signMove(space, MOVE_UPGRADE_RECEIPT_TAG, body)) };
    });
    tool("spaces.upgrade.wrap-key", "In MY CLOUD's home: answer this space's sealed-value wrapping key, signed with this space's own key, so the device can check it came from the Space it names before it approves carrying sealed values there.", obj({ space: str }, ["space"]), async (i, meta) => {
      const space = String(i.space);
      if (!K || typeof K.chainIn !== "function" || !K.spaces || K.spaces.hosts(space) !== true) throw refuse("This home does not host that space (spaces.get names its home).", "not_found");
      let chain; try { chain = await K.chainIn(space, meta); } catch { throw refuse("You are not a member of that space.", "forbidden"); }
      const h = kernelHandle(space);
      if (!h || !h.gateway || !h.gateway.seal || typeof h.gateway.seal.wrapKey !== "function") throw refuse("This space cannot receive sealed values yet; ask its owner to update its home.", "unavailable");
      const r = await h.gateway.seal.wrapKey(chain, { record: `vyre://${space}/contact/0190c3f2-1111-4abc-8def-000000000000` });
      const body = { v: 1, space, wrap_key: String(r.key), at: now() };
      return { body, ...(await signMove(space, UPGRADE_WRAPKEY_TAG, body)) };
    });
    tool("spaces.upgrade.plan", "What moving your Personal space to My Cloud would carry: records by type, what cannot be carried, and the hash your one approval is bound to. Reads only.", obj({ to: str }, ["to"]), async (i, meta) => {
      const sides = await upgradeSides(i.to, meta);
      const { local, remote } = sides;
      const ports = await upgradePorts(String(i.to));
      { const rp = await resealPort(sides, "", {}, i, meta); if (rp) ports.reseal = rp; }
      try { const p = await planUpgrade({ local, remote, to: String(i.to), ports }); return { ...p, ports: Object.keys(ports) }; }
      catch (e) { throw plainKernelError(e); }
    });
    tool("spaces.upgrade.run", "Move your Personal space to My Cloud with one approval: `plan_hash` is the plan you were shown. Answers what moved and, by name, anything that did not. My Cloud's name, the pinned version of its list and the paired server are worked out from the space this device made (override with `toName`, `pin`, `server`). It asks My Cloud for its signed receipt: only then does this space point to My Cloud and stop taking new records.", obj({ to: str, plan_hash: str, toName: str, pin: str, server: str, approve_proof: { type: "object" } }, ["to", "plan_hash"]), async (i, meta) => {
      const sides = await upgradeSides(i.to, meta);
      const { local, remote, gateway, proof } = sides;
      const ports = await upgradePorts(String(i.to));
      const approval = { proof: i.approve_proof };
      const rp = await resealPort(sides, String(i.plan_hash), approval, i, meta);
      if (rp) ports.reseal = rp;
      let plan; try { plan = await planUpgrade({ local, remote, to: String(i.to), ports }); } catch (e) { throw plainKernelError(e); }
      if (plan.hash !== i.plan_hash) throw refuse("Your Personal space changed since you were shown the plan. Look at it again.", "plan_changed");
      if (plan.blockers.length) throw refuse(`This cannot start yet: ${plan.blockers.join("; ")}`, "blocked");
      // sealed values need the person's one approval of the exact list (the same prompt as the upgrade's own): the app signs `request` and `approve_request` together and calls again with both
      const refs = plan.sealedRefs || [];
      /** @type {any} */ let approveRequest = null;
      if (refs.length && rp) { try { approveRequest = sealExportApproveRequest(K.space, { plan_hash: plan.hash, target_key: await rp.targetKey(), refs }); } catch (e) { throw plainKernelError(e); } }
      if (approveRequest && !i.approve_proof && !(proof && proof.presence)) return { needs_proof: true, request: K.proofRequest("upgrade", { to: String(i.to), plan_hash: plan.hash }), approve_request: approveRequest };
      if (approveRequest && !i.approve_proof) return { needs_proof: true, approve_request: approveRequest };
      let started;
      try { started = await gateway.upgrade.start(local.chain, { to: String(i.to), plan_hash: plan.hash }, proof); }
      catch (e) { if (String(/** @type {any} */ (e).code) === "needs_presence") return { needs_proof: true, request: K.proofRequest("upgrade", { to: String(i.to), plan_hash: plan.hash }) }; ctx.log.warn(`upgrade start failed: ${/** @type {any} */ (e).code} ${/** @type {Error} */ (e).message}`); throw plainKernelError(e); }
      if (approveRequest) {
        const m = /^([^/]+)\/([^:]+): /.exec(String(plan.sealed[0] || ""));
        try { await rp.approve(refs, `vyre://${K.space}/${m ? m[1] : "contact"}/${m ? m[2] : ""}`); }
        catch (e) { ctx.log.warn(`upgrade export approval failed: ${/** @type {any} */ (e).code} ${/** @type {Error} */ (e).message}`); throw plainKernelError(e); }
      }
      let report; try { report = await runUpgrade({ plan, local, remote, ports }); } catch (e) { ctx.log.warn(`upgrade run failed: ${/** @type {any} */ (e).code} ${/** @type {Error} */ (e).message}`); throw plainKernelError(e); }
      const server = typeof i.server === "string" && i.server ? i.server : await serverOf(String(i.to));
      /** @type {{ what: string, why: string }[]} */ const notes = [];
      // each moved chat's history (its frames, members and runs) comes back to life in My Cloud once its files have landed: chat's own tool, run there
      if (ports.chats && server) {
        for (const chat of ports.chats.items || []) {
          try { await remoteCall(server, "work.chat.history-import", { chat }, meta); }
          catch (e) { const c = String(/** @type {any} */ (e).code || ""); if (c !== "not_found") report.notMoved.push({ what: `chats: ${chat} history`, why: String(/** @type {Error} */ (e).message).slice(0, 120) }); }
        }
      } else if (ports.chats && (ports.chats.items || []).length) report.notMoved.push({ what: "chats: history", why: "no paired server to bring it back on" });
      // My Cloud says what it holds, signed with its own key; only that lets this space point there and freeze
      let receipt = null;
      // My Cloud is an ordinary space on the person's own server: its name and the pinned version of its list are this device's own (it made the space), so nothing needs to be typed
      const toRow = spaces.get(String(i.to));
      const toName = typeof i.toName === "string" && i.toName ? i.toName : (toRow ? toRow.name : "");
      const kept = await chainOf(String(i.to));
      const pin = parsePin(i.pin) || (kept && kept.pin) || null;
      if (report.notMoved.length === 0 && server && pin && toName) {
        try {
          receipt = await remoteCall(server, "spaces.upgrade.receipt", { space: String(i.to), upgrade_id: started.upgrade_id, from: K.space, objects: plan.objects.map((/** @type {any} */ o) => ({ type: o.type, id: o.id, keys: o.keys })) }, meta);
        } catch (e) { notes.push({ what: "My Cloud's receipt", why: String(/** @type {Error} */ (e).message).slice(0, 120) }); }
      } else if (report.notMoved.length === 0) notes.push({ what: "My Cloud's receipt", why: "not asked for: this needs My Cloud's published name, the pin and the paired server" });
      const ctxKey = `${K.space}/${String(i.to)}/${started.upgrade_id}`;
      if (pin && toName) moveContext.set(ctxKey, { name: String(toName), pin });
      let fin;
      try { fin = await gateway.upgrade.finish(local.chain, { upgrade_id: started.upgrade_id, counts: { records: report.moved.records, chats: report.moved.chats ?? null, memory: report.moved.memory ?? null }, failed: report.notMoved.map((/** @type {any} */ n) => `${n.what}: ${n.why}`), freeze: report.recordsComplete && report.notMoved.length === 0, ...(receipt ? { receipt } : {}) }); }
      catch (e) { ctx.log.warn(`upgrade finish failed: ${/** @type {any} */ (e).code} ${/** @type {Error} */ (e).message}`); throw plainKernelError(e); }
      finally { moveContext.delete(ctxKey); }
      return { upgraded: true, to: fin.to, moved: report.moved, notMoved: report.notMoved, frozen: fin.frozen, ...(fin.not_frozen_because ? { not_frozen_because: fin.not_frozen_because } : {}), ...(notes.length ? { notes } : {}) };
    });
    tool("spaces.personal-host.set", "Choose which Cloud space keeps your encrypted personal items (Settings). It must be one you are in.", obj({ space: str }, ["space"]), async (i, meta) => {
      let rows = []; try { rows = await listSpaces({}, meta); } catch { rows = []; }
      if (!rows.some(r => r.id === i.space && r.tier === "cloud")) throw refuse("That is not a Cloud space you are in.", "bad_input");
      await kv.put("personal-host", { space: i.space });
      return { personal_host: i.space };
    });
    tool("spaces.tier", "Which tier a space is on (basic or cloud), and the Cloud spaces this person is in. For a module that must refuse on a Basic personal space (Planner, tasks). With no space named, the home's own.",
      obj({ space: str }), async (/** @type {any} */ i, /** @type {any} */ meta) => {
        /** @type {any[]} */ let rows = [];
        try { rows = await listSpaces({}, meta); } catch { rows = []; }
        const cloud = rows.filter(r => r.tier === "cloud").map(r => ({ id: r.id, name: r.name ?? null, label: r.label ?? null }));
        const personalHost = await personalHostOf(cloud);
        if (i.space && !(K && i.space === K.space)) {
          const r = rows.find(x => x.id === i.space);
          if (!r) throw refuse("No such space here (spaces.list shows them).", "not_found");
          return { tier: r.tier, cloud, time_zone: r.time_zone ?? null, personal_host: personalHost };
        }
        return { tier: tierOf({ kind: "this-computer" }), cloud, time_zone: K && typeof K.space === "string" ? await zoneOf(K.space) : null, personal_host: personalHost };
      }, { internal: true });

    tool("spaces.time-zone.set", "As an owner or admin: set a space's home time zone (an IANA zone such as America/Los_Angeles). Tasks, Flow schedules and business hours read it.", obj({ space: str, zone: str }, ["space", "zone"]), async (i, meta) => {
      const row = spaceOf(i.space);
      const s = me();
      await notRemoved(row.id, meta);
      const m = await membershipOf(row.id, /** @type {string} */ (s.id), meta).catch(() => null);
      if (!(row.createdBy === s.id || (m && (m.role === "owner" || m.role === "admin")))) throw refuse("Only an owner or an admin can set the time zone.", "forbidden");
      if (typeof i.zone !== "string" || i.zone.length > 64 || !validZone(i.zone)) throw refuse("That is not a time zone. Use a name like America/Los_Angeles.", "bad_input");
      await kv.put(`zone/${row.id}`, { zone: i.zone });
      return { space: row.id, time_zone: i.zone };
    });
    // The Spaces this person belongs to, by name and role, for what an agent is told at the start of a session (core/sessions/environment.js): names and roles only, and only for a module.
    tool("spaces.brief", "The person's Spaces by name and role, and which one this home is: what an agent's environment brief says. Names and roles only. Modules only.", obj(), async (i, meta) => {
      const rows = /** @type {any[]} */ (await listSpaces(i, meta));
      return { spaces: rows.map(x => ({ name: String(x.label || x.name || x.id), role: x.role || null, current: Boolean(K && x.id === K.space), zone: typeof x.time_zone === "string" ? x.time_zone : typeof x.zone === "string" ? x.zone : null })) };
    }, { internal: true, callers: ["module"] });

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
        roleNames: m.getDisplayNames(), createdAt: row.createdAt, setup: await setupView(row, s), time_zone: await zoneOf(row.id),
      };
    });

    tool("spaces.status", "Where creating a space has got to: each step, what it is waiting for, and why anything failed, in plain words.", obj({ space: str }, ["space"]), async i => {
      const { row } = mine(i.space);
      if (!(await kv.get(`space-create/${row.id}`))) return { spaceId: row.id, space: row.id, status: row.status, name: row.label, steps: [], waiting: null, failed: null, warnings: row.warnings, workspaceId: row.workspaceId };
      return shapeView(row.id, await flow.status(row.id));
    });

    tool("spaces.resume", "Continue creating a space from the last good step. Give a new name if the first was taken, confirm 'this computer' if asked, or paste the server token again.",
      obj({ space: str, name: str, confirmThisComputer: { type: "boolean" }, vpsToken: str }, ["space"]), async (i, meta) => {
        const { row } = mine(i.space);
        const ctx2 = /** @type {any} */ ({});
        if (i.name) ctx2.name = String(i.name).trim().toLowerCase().replace(/\.vyre\.run$/, "");
        if (i.confirmThisComputer) ctx2.confirmThisComputer = true;
        if (i.vpsToken) ctx2.vpsToken = String(i.vpsToken);
        // a creation that failed gave its Space back: host it again under the same id before going on (on the SERVER when that is its home)
        const srvDevice = await serverOf(row.id);
        if (srvDevice && row.status !== "done") await remoteCall(srvDevice, "spaces.host-here", { name: row.label, id: row.id }, meta);
        else if (row.status !== "done" && K && K.spaces && typeof K.spaces.host === "function" && /^spc_[a-z2-7]{12}$/.test(row.id) && !kernelHandle(row.id)) {
          try { await K.spaces.host({ owner: /** @type {string} */ (me().id), name: row.label, id: row.id }); } catch (e) { ctx.log.warn(`the kernel could not start the space again: ${String(/** @type {any} */ (e).message || e).slice(0, 120)}`); }
        }
        const rv = await flow.resume(row.id, ctx2);
        if (rv && rv.status === "failed") await retireHosted(row.id, meta);
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
    tool("spaces.members.add-agent", "Add an agent (an assistant that does work in the space, for example as the doer of a task) to a space. The kernel's own actor membership: owners and admins only, under the person's proof.",
      obj({ space: str, agent: str }, ["space", "agent"]),
      async (i, meta) => {
        const row = spaceOf(i.space);
        await gate(row.id, undefined, meta);
        const agent = String(i.agent || "").trim().toLowerCase();
        if (!/^[a-z][a-z0-9_-]{0,39}$/.test(agent)) throw refuse("An agent's name is letters, digits, - and _, up to 40.", "bad_input");
        const h = kernelHandle(row.id);
        if (!h || !h.gateway || !h.gateway.grants || typeof h.gateway.grants.addActor !== "function") throw refuse("This space has no kernel here to add an agent to.", "unavailable");
        const k = await kctxOf(meta, row.id);
        try { await h.gateway.grants.addActor(k.chain, { kind: "agent", id: agent, space: row.id }, k.proof); }
        catch (e) {
          const c = String(/** @type {any} */ (e).code || "");
          if (c === "needs_presence") throw refuse("This change needs your approval on your device.", "needs_presence");
          if (c === "not_allowed") throw refuse("Only an owner or an admin can add an agent.", "forbidden");
          throw e;
        }
        return { space: row.id, agent: { kind: "agent", id: agent } };
      }, { presence: { summary: (/** @type {any} */ i) => `Add the agent ${i && i.agent} to ${i && i.space}` } });
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
      obj({ space: str, to: str, demoteTo: { type: "string", enum: [...ROLE_DEMOTE_TO] } }, ["space", "to"]), async (i, meta) => {
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
      const rootPublic = (await attestedKeyOf(row.id)) || (k ? k.publicKey : null);
      return c && c.pin && rootPublic ? { chain: c.pin, rk: spaceFingerprint(c.pin.id, rootPublic) } : {};
    };
    /** The short typed code for an invite's own link (RC1): wink makes it, so it carries this same link and nothing else. Best effort: with no relay or no typed codes the invite is just the link (`code` null). @param {string} link @param {string} space */
    const typedCodeFor = async (link, space) => {
      try {
        const r = /** @type {any} */ (await ctx.call("wink.code.carry", { link, space }));
        const d = r && !r.error && r.data ? r.data : null;
        return d && d.code ? { code: d.code, code_expires: d.expires, code_offer: d.offer, ...(d.avatar ? { code_avatar: d.avatar } : {}) } : { code: null };
      } catch { return { code: null }; }
    };
    tool("spaces.invites.create", "Make a join link (https://<space>.vyre.run/join/...) for a role. A temp or member invite can name projects. Owners and admins only, unless the space lets managers invite.",
      obj({ space: str, role: { type: "string", enum: ROLE_IDS }, scope: { type: "array", items: str }, expires: { type: "number" }, uses: { type: "number" }, ttlDays: { type: "number" }, alias: str, to: str }, ["space", "role"]),
      async (i, meta) => {
        const row = spaceOf(i.space);
        const s = await gate(row.id, undefined, meta);
        // A space that lives on this person's own computer cannot be reached by anyone else (no relay path in 0.3.0), so no link is made for it.
        if (kernelHandle(row.id) && await livesOnThisComputer(row.id)) throw refuse("This space lives on this computer, so other people cannot join it. Move it to your server first.", "this_computer");
        if (kernelHandle(row.id)) {
          // The Space's kernel makes the invite (a grant act under the admin's own proof) and holds it; the link carries only its id and this device's pin.
          const k = await kctxOf(meta, row.id);
          const body = { role: i.role, ...(i.scope ? { scope: i.scope } : {}), ...(i.expires ? { expires: i.expires } : {}), ...(i.to ? { invitee: await personRef(i.to) } : {}), ...(i.ttlDays ? { valid_ms: Number(i.ttlDays) * DAY } : {}) };
          /** @type {any} */ let rec;
          try { rec = await kernelMembers({ handle: kernelHandle(row.id), now }).invites.create(k, body); }
          catch (e) {
            // A space on a server: the home asks for the person's yes on THIS invite with a one-use challenge. This computer answers it with the person's own key (the hardware signer, or a software key on a development build) and the same call goes again with that proof, which carries `home` and `challenge`. With no key to answer, it is handed back as a request to sign.
            const ch = /** @type {any} */ (e) && /** @type {any} */ (e).code === "presence_required" ? /** @type {any} */ (e).challenge : null;
            if (!ch || typeof ch.nonce !== "string") throw e;
            const proof = await answerChallenge(ch, row.id, proofRequest(row.id, "inviteCreate", body));
            if (!proof) return { needs_proof: true, request: { space: row.id, op: ch.op, fields: ch.fields, payload_hash: ch.payload_hash, home: ch.home, challenge: ch.nonce, expires: ch.expires } };
            rec = await kernelMembers({ handle: kernelHandle(row.id), now }).invites.create(await kctxOf({ ...meta, kernel_proof: proof }, row.id), body);
          }
          const pin = await invitePin(row);
          const token = `${rec.id}.${b64u(Buffer.from(JSON.stringify(pin)))}`;
          const link = `https://${row.name}/join/${token}`;
          return { id: rec.id, link, token, needs_confirm: rec.needs_confirm === true, valid_until: rec.valid_until, ...(await typedCodeFor(link, row.name)) };
        }
        const r = await invitesFor(row).createInvite({ creator: s.id, role: i.role, scope: i.scope, expires: i.expires, uses: i.uses, ttl: i.ttlDays === undefined ? undefined : Number(i.ttlDays) * DAY, alias: i.alias, to: i.to ? await personRef(i.to) : undefined, ...(await invitePin(row)) });
        return { id: r.id, link: r.link, token: r.token, ...(await typedCodeFor(r.link, row.name)) };
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
    /** @type {Map<string, any>} */ const remoteHandles = new Map();
    /** @type {Map<string, any>} the remote kernels of spaces this person joined on a server */ const memberHandles = new Map();
    /** The row of a space this person joined (read synchronously: the daemon asks while it builds a kernel handle). @param {string} id @returns {any} */
    const memberRow = id => { try { const r = /** @type {any} */ (db.prepare("SELECT value FROM spaces_kv WHERE key = ?").get(`member-of/${id}`)); return r ? JSON.parse(r.value) : null; } catch { return null; } };
    /** A remote kernel for a joined space, over a member stream to its home (the invitee channel, a hello that names `member`), or null. @param {string} id */
    const memberRemote = id => {
      const row = memberRow(id);
      if (!row || !row.channel) return null;
      const have = memberHandles.get(id);
      if (have) return have;
      const sf = typeof hooks.inviteeSessionFor === "function" ? hooks.inviteeSessionFor : typeof ctx.inviteeSessionFor === "function" ? ctx.inviteeSessionFor : null;
      if (!sf) return null;
      const channel = row.channel;
      const h = createRemoteKernel({ space: id, transport: winkTransport({ sessionFor: async () => sf(channel, (/** @type {string} */ channelKey) => inviteeHello(channel, id, "member", channelKey), { invite: "member" }) }) });
      memberHandles.set(id, h);
      return h;
    };
    try { if (typeof ctx.provide === "function") ctx.provide("memberRemote", memberRemote); } catch { /* provided already (a restart in one process), or no daemon (a test ctx) */ }
    /** The invitee's signed hello for the home's door: their identity key over the box, the space and the invite (core/wink/serverlink.js carries it in the stream head). @param {{ box: string }} channel @param {string} space @param {string} invite */
    const inviteeHello = async (channel, space, invite, channelKey) => {
      const who = me();
      const ts = now(), nonce = crypto.randomBytes(12).toString("base64url");
      const sig = b64u(await identity.sign(`vyre-invitee-hello-v2\n${channel.box}\n${space}\n${invite}\n${who.id}\n${who.eid}\n${ts}\n${nonce}\n${channelKey}`));
      return { space, invite, channel: channelKey, identity: who.id, ...(who.name ? { name: `${String(who.name).replace(/\.vyre\.run$/, "")}.vyre.run` } : {}), entry: who.eid, ts, nonce, sig };
    };
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
      let h = kernelHandle(r.payload.id);
      // Not hosted here: the space's record says where its home is (relay route and box). This device opens the invitee stream to it, signed by the invitee's own identity, and asks the home's kernel for the card
      // over the same remote client a paired device uses. The row is kept from the first preview until the invite is accepted.
      if (!h && r.payload.route && typeof r.payload.route.route === "string") {
        const channel = { relay: String(r.payload.route.relay || ""), route: r.payload.route.route, box: String(r.payload.route.box || "") };
        const have = remoteHandles.get(`${r.payload.id}/${invId}`);
        const sf = typeof hooks.inviteeSessionFor === "function" ? hooks.inviteeSessionFor : typeof ctx.inviteeSessionFor === "function" ? ctx.inviteeSessionFor : null;
        if (have && now() - have.at < 60_000) h = have.h; // the open stream is reused inside the hello's two-minute life
        else if (sf) {
          // the hello is signed over the channel's own key id, which only the link knows once it has made the channel's key, so the link asks for it (and signs a new one for every stream it opens)
          const helloFor = (/** @type {string} */ channelKey) => inviteeHello(channel, r.payload.id, invId, channelKey);
          h = createRemoteKernel({ space: r.payload.id, transport: winkTransport({ sessionFor: async () => sf(channel, helloFor, { invite: invId }) }) });
        }
        if (h) {
          await kv.put(`invitee-route/${r.payload.id}`, { channel, invite: invId, name: `${label}.vyre.run`, at: now() });
        }
      }
      const gone = () => {
        const owner = r.payload.ownerName || r.payload.owner_name || null;
        return refuse(`This space lives on ${owner ? `${owner}'s` : "its owner's"} computer and cannot be reached from here. Ask them to move it to their server.`, "unreachable");
      };
      if (!h) throw gone();
      const k = h.hosted === false ? { chain: null, proof: K.proofFrom(meta) } : await kctxOf(meta, r.payload.id);
      let card;
      // A server reached through the record's route must prove it holds the space: the invite preview carries its signature over a fresh nonce, made with the key whose public half the owner-signed record
      // names as `rootPublic`. A server that cannot is refused before the card is shown or anything is accepted; the fingerprint words come from the same key, so they say which server holds the space.
      if (h.hosted === false) {
        const nonce = b64u(crypto.randomBytes(16));
        let got;
        try { got = await h.gateway.grants.invites.get(null, invId, { attest: nonce }); }
        catch (e) { remoteHandles.delete(`${r.payload.id}/${invId}`); const c = String(/** @type {any} */ (e).code || "");
          // The home's door refusing this person (an invite made for someone else, spent, or not admitted) is not an outage: it gets its own plain answer and no reason (JE-1); the words also fit a spent or expired invite.
          if (/^(denied|not_a_member|forbidden|not_allowed)$/.test(c)) throw refuse("This invite cannot be used.", "not_for_you");
          if (/^(unavailable|unreachable|failed)$/.test(c) || !c) throw gone(); throw plainKernelError(e); }
        const { attest, ...bare } = got && typeof got === "object" ? got : /** @type {any} */ ({});
        let proven = false;
        try { proven = Boolean(r.payload.rootPublic) && Boolean(attest) && attest.pub === r.payload.rootPublic && typeof attest.sig === "string" && await C.verifyWith(String(attest.pub), Buffer.from(attestMessage(r.payload.id, nonce)), attest.sig); } catch { proven = false; }
        if (!proven) { remoteHandles.delete(`${r.payload.id}/${invId}`); throw refuse("This server could not prove that it holds this space, so Vyre will not join it. Ask the person who invited you.", "server_not_proven"); }
        if (!remoteHandles.has(`${r.payload.id}/${invId}`)) remoteHandles.set(`${r.payload.id}/${invId}`, { h, at: now() });
        card = bare;
      } else
      try { card = await kernelMembers({ handle: h, now }).invites.get(k, invId); if (h.hosted === false && !remoteHandles.has(`${r.payload.id}/${invId}`)) remoteHandles.set(`${r.payload.id}/${invId}`, { h, at: now() }); } catch (e) { remoteHandles.delete(`${r.payload.id}/${invId}`); if (h.hosted === false && /^(unavailable|unreachable|failed)$/.test(String(/** @type {any} */ (e).code || ""))) throw gone(); throw e; }
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
      obj({ link: str, pin: str, presence_key: { type: "object" } }, ["link"]), async (i, meta) => {
        const s = me();
        if (K) {
          const p0 = await parseLink(i.link);
          if (isKernelToken(p0.token)) {
            const c = await kernelCard(i, p0, meta);
            // What the invitee signs on their own device: the kernel's accept request over exactly this card. The surface sends the signed proof beside the next call.
            const req = acceptProofRequest((c.card.space && c.card.space.id) || c.handle.space, c.card, /** @type {string} */ (s.id));
            // This computer signs it itself when it can: the hardware signer a surface set, else (a development build only) its software key, which then also names itself as the presence key to enrol on this server (RC1 below).
            let given = meta, named = i.presence_key;
            if (!meta || !meta.kernel_proof) {
              /** @type {any} */ let signed = null;
              try { if (typeof hooks.signer === "function") signed = await hooks.signer({ ...req, accept: true }, { space: c.spaceId, person: /** @type {string} */ (s.id) }); } catch { signed = null; }
              if (!signed && devSwitch(process.env.VYRE_SEAL_SOFTWARE, hooks.buildRoot)) {
                const file = path.join(ctx.paths.root, "wink-keys.json.device");
                try { signed = softwareActProof(file, /** @type {string} */ (s.id), req); if (signed && !named) { const k0 = softwareKey(file); named = { key_id: k0.key_id, spki: k0.spki, signer: k0.signer }; } } catch { signed = null; }
              }
              if (!signed || typeof signed !== "object") return { joined: false, needs_proof: true, request: req, card: c.card, fingerprint_words: fingerprintWords(c.fingerprint) };
              given = { ...(meta || {}), kernel_proof: signed };
              c.k = c.handle.hosted === false ? { chain: null, proof: K.proofFrom(given) } : await kctxOf(given, c.spaceId);
            }
            // RC1: a person who has never touched this server has no presence key there. The app names the key it signed with, and this device's own identity key vouches for it, over this invite, this Space, this identity and that key;
            // the server reads the identity's list from the directory, checks the device and the signature, and enrols the key inside this same accept (kernel/remote/server.js joinKey).
            const pk = named;
            const bind = c.handle.hosted === false && pk && typeof pk === "object" && typeof pk.key_id === "string" && typeof pk.spki === "string" && typeof pk.signer === "string"
              ? { key_id: pk.key_id, spki: pk.spki, signer: pk.signer, sig: b64u(await identity.sign(joinBytes(c.invId, c.spaceId, /** @type {string} */ (s.id), pk.key_id, pk.spki))), ...(pk.attestation && typeof pk.attestation === "object" ? { attestation: pk.attestation } : {}) }
              : undefined;
            const got = await kernelMembers({ handle: c.handle, now }).invites.accept(c.k, c.invId, req.seen, bind);
            // the invitee stream has done its one job; a member session starts next, by the member-device path
            if (c.handle.hosted === false) {
              // the person is a member now: keep where the home is, so this device reaches the space with a member stream (no invite) and lists it
              try { const route = await kv.get(`invitee-route/${c.spaceId}`); if (route && route.channel) await kv.put(`member-of/${c.spaceId}`, { channel: route.channel, name: route.name, role: got && got.membership && got.membership.role ? String(got.membership.role) : null, at: now() }); } catch { /* the join stands; the row is made again by the next accept of a link */ }
              memberHandles.delete(c.spaceId);
              remoteHandles.delete(`${c.spaceId}/${c.invId}`); await kv.delete(`invitee-route/${c.spaceId}`);
            }
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
      return { person: s.id, space: row ? { id: row.id, name: row.name } : null, spaces: mine.map(r => ({ id: r.id, name: r.name })) };
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
      return { entries: r.state.entries.map((/** @type {any} */ e) => ({ eid: e.eid, kind: e.kind, pub: e.pub, ...(e.agree ? { agree: e.agree } : {}) })) };
    };
    // The one identity of this device's person, for the modules that must name it (Wink's pairing targets): the id and name only, read live. Spaces owns it; nobody makes a second.
    tool("spaces.identity.self", "This device's identity id and name, or null when none is claimed. Read live every call. For other modules, so that nothing makes a second identity.", obj(), async () => {
      const st = identity.status();
      const pin = st.exists && st.id ? identity.pin() : null;
      return st.exists && st.id ? { id: st.id, name: st.name || null, label: st.name || null, ...(pin && pin.head ? { pin: { id: String(pin.id), seq: Number(pin.seq), head: String(pin.head) } } : {}) } : null;
    }, { internal: true });
    // This computer's own entry on its identity's list, for the daemon's runner ({ deviceId, deviceKey }: the id the Offers name it by and its public key); null until an identity is claimed.
    // The paired server that hosts a Space this computer made there (the id this computer knows that server by), or null: the Wink module asks it to check that a message about a Space's grant comes from that Space's own home.
    tool("spaces.server.of", "The paired server that hosts this space: { device }, or null when this computer does not know one. For the Wink module.", obj({ space: str }, ["space"]), async (i) => ({ device: await serverOf(String(i.space)) }), { internal: true });
    tool("spaces.identity.device", "This device's entry on its identity list: { deviceId, deviceKey }, or null when none is claimed. The public half only. For the daemon.", obj(), async () => {
      const st = identity.status();
      return st.exists && st.eid && st.publicKey ? { deviceId: st.eid, deviceKey: st.publicKey } : null;
    }, { internal: true });
    // For the pairing module on a server that has never seen an identity: read the claimed Vyre name's chain from the directory (verified, first sight) and answer its device entries only when the chain is
    // THIS id's. Nothing is stored. A directory that cannot be reached is `unreachable`, which is not the same as no such entry.
    tool("spaces.identity.lookup", "A claimed Vyre name's identity list from the directory, verified, and only if it is the given id's: { entries }. Nothing is kept. For the pairing module.", obj({ name: str, id: str, pin: { type: "object" } }, ["name", "id"]), async i => {
      const label = String(i.name).trim().toLowerCase().replace(/\.vyre\.run$/, "");
      if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(label)) return { entries: [] };
      let r;
      const pin = i.pin && typeof i.pin === "object" && typeof i.pin.id === "string" && Number.isInteger(i.pin.seq) && typeof i.pin.head === "string" ? { id: i.pin.id, seq: i.pin.seq, head: i.pin.head } : undefined;
      try { r = await dir.resolve(label, pin ? { pin } : undefined); } catch (e) {
        // Name the cause when the guarded client refused the address itself (a plain-http or non-public directory is refused before any request): the next real failure must say what it was.
        const w = String(/** @type {any} */ (e)?.why || "");
        const why = w === "not_https" ? " The directory address was refused: it is plain http." : /^(not_public|bad_url|credentials_in_url)$/.test(w) ? ` The directory address was refused (${w}).` : "";
        throw refuse(`The names directory could not be reached; wait a minute and try again.${why}`, "unreachable");
      }
      if (!r.ok || r.kind !== "person" || r.id !== String(i.id)) { if (process.env.WLOG) ctx.log.warn(`lookup ${label}: ok=${r.ok} kind=${r.kind} id=${r.id} want=${i.id} why=${r.why || r.code || ""}`); return { entries: [] }; }
      return { entries: r.state.entries.map((/** @type {any} */ e) => ({ eid: e.eid, kind: e.kind, pub: e.pub, ...(e.held ? { held: e.held } : {}), ...(e.alg ? { alg: e.alg, ...(e.rp ? { rp: e.rp } : {}) } : {}), ...(e.enclave ? { enclave: e.enclave } : {}), ...(e.agree ? { agree: e.agree } : {}) })) };
    }, { internal: true });
    // The invitee's first presence key (RC1): the identity's chain and its entries as the directory shows them, for the home's own remote door. The ops go to the sealing process, which verifies them itself; each entry carries `founder` and `since` (the signed time of the add op); the door and the sealing process each apply the same rule (youngAt) against this server's clock, never a flag this tool computed. By the claimed name from the invitee's signed hello, else the name this device knows.
    tool("spaces.identity.evidence", "A person's identity chain and entries from the directory, verified, only if it is the given id's: { ops, entries }. Each entry says whether it is the founder and when it was added (signed time); the door decides what is young. For the home's invitee door.", obj({ person: str, name: str }, ["person"]), async i => {
      const id = String(i.person);
      const mineId = identity.status();
      const name = i.name ? String(i.name) : mineId.exists && mineId.id === id ? mineId.name : /** @type {string|null} */ (await kv.get(`person-name/${id}`));
      const label = String(name || "").trim().toLowerCase().replace(/\.vyre\.run$/, "");
      if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(label)) return null;
      let r;
      try { r = await dir.resolve(label, { pin: /** @type {any} */ (await kv.get(`person-pin/${label}`)) || undefined }); } catch { return null; }
      if (!r.ok || r.kind !== "person" || r.id !== id || !Array.isArray(r.ops)) return null;
      await kv.put(`person-pin/${label}`, r.pin);
      // ONE clock for "young" (the sealing process uses the same): the signed time the entry was added to the list (the op's own), against this server's clock. Not when this server first saw it.
      const at = Date.now(), st = await C.verifyChain(r.ops, { now: at });
      return { ops: r.ops, entries: st.entries.map((/** @type {any} */ e) => ({ eid: e.eid, kind: e.kind, pub: e.pub, founder: e.founder === true, since: e.since })) };
    }, { internal: true });
    tool("spaces.identity.state", "A person's identity list as verified now: their entry ids and kinds. Read live each call. For the transport's personOf.", obj({ person: str }, ["person"]), async i => stateOfPerson(String(i.person)), { internal: true });
    // The devices of a person you share a space with, as public data only: each listed device's id and its key-agreement point (`agree`, the key a chat key is wrapped to). No label, no signing key, no other
    // field. The caller must be that person or share a space with them (both members of one space this device knows); a stranger gets nothing, the same answer as a person with no such devices.
    /** The public devices of a person the caller shares a space with (see spaces.identity.devices). @param {any} i @param {any} meta */
    const devicesOf = async (i, meta) => {
      const target = String(i.person || "");
      if (!/^per_[A-Za-z0-9_-]{1,64}$/.test(target)) return { devices: [] };
      // The person the call acts for when no person rides on it: this home's own person, or on a SERVER (no identity of its own) the owner that paired it (the kernel's claimed owner). Nobody else: with neither, the answer is empty.
      /** @type {string | null} */ let home = null;
      try { home = String(me().id); } catch { const claimed = K && typeof K.ownerClaimed === "function" ? K.ownerClaimed() : null; home = claimed ? String(claimed) : null; }
      if (!home) return { devices: [] };
      const caller = await callerPerson(meta, home);
      if (!caller) return { devices: [] };
      let shares = caller === target;
      if (!shares) {
        for (const row of spaces.all()) {
          const [a, b] = await Promise.all([membershipOf(row.id, caller, meta).catch(() => null), membershipOf(row.id, target, meta).catch(() => null)]);
          if (a && b) { shares = true; break; }
        }
      }
      if (!shares) return { devices: [] };
      const st = await stateOfPerson(target);
      const entries = st && Array.isArray(st.entries) ? st.entries : [];
      return { devices: entries.filter((/** @type {any} */ e) => e && e.kind === "device" && typeof e.agree === "string").map((/** @type {any} */ e) => ({ device: String(e.eid), agree: String(e.agree) })) };
    };
    tool("spaces.identity.devices", "The devices of a person you share a space with: each one's id and its key-agreement point, for wrapping a chat key. Public data only; a person you share no space with gives nothing.", obj({ person: str }, ["person"]), async (i, meta) => devicesOf(i, meta), { effect: "read" });
    // The same public read for the first-party modules that wrap keys server-side (work makes a server-started chat's ring, files): a module caller is not a person (spaces.identity.devices is reach person), so this is its own internal tool, with the same
    // share-a-space check, answered for the person the call acts for (this home's person when no token rides). Public data only: a device id and its agreement point.
    tool("spaces.identity.devices.read", "The devices of a person you share a space with: each one's id and its key-agreement point, for a first-party module that wraps a chat key. Public data only.", obj({ person: str }, ["person"]), async (i, meta) => {
      onlyModules(meta, ["work", "files"]);
      return devicesOf(i, meta);
    }, { internal: true });

    // A drop's key, unwrapped by this device: the wrap was made to this device's `agree` point (ECDH-ES on P-256, HKDF-SHA256 over the shared secret with the ephemeral point as salt, AES-256-GCM, the same format as lib/keywrap.js
    // so a wrap from memory's library opens here). The ECDH, the KDF and the unwrap all happen INSIDE this tool: only the unwrapped file key leaves, never the shared secret and never the private scalar. It is bound to ONE
    // purpose: the wrap's associated data must start with "vyre-drop-wrap\n", so a chat ring's wrap (another purpose's aad) or a bare ephemeral point is refused: this door cannot be used as a general decryption oracle.
    // First-party only: `files` opens a drop with it.
    tool("spaces.identity.unwrap-drop", "Open a file drop's wrapped key with this device's key-agreement key: the wrap and its associated data in, the unwrapped file key out. Only for a wrap whose associated data starts with vyre-drop-wrap. For first-party modules only.", obj({ wrap: { type: "object" }, aad: str }, ["wrap", "aad"]), async (i, meta) => {
      onlyModules(meta, ["files"]);
      const aad = typeof i.aad === "string" ? i.aad : "";
      if (!aad.startsWith(DROP_AAD_PREFIX)) throw refuse("That is not a file drop's wrap.", "wrong_purpose");
      const w = i.wrap && typeof i.wrap === "object" ? /** @type {any} */ (i.wrap) : null;
      if (!w || w.v !== 1 || ["epk", "iv", "ct", "tag"].some(k => typeof w[k] !== "string")) throw refuse("That is not a wrapped key.", "bad_wrap");
      const epk = Buffer.from(w.epk, "base64url");
      if (epk.length !== 65 || epk[0] !== 4) throw refuse("That is not a P-256 point.", "bad_point");
      let shared;
      try { shared = identity.ecdh(epk); } catch (e) { throw refuse(/** @type {any} */ (e).code === "no_agree_key" ? "This device has no agreement key yet." : "That is not a P-256 point.", /** @type {any} */ (e).code || "failed"); }
      try {
        const kek = Buffer.from(crypto.hkdfSync("sha256", shared, epk, Buffer.from("vyre-identity-wrap-v1"), 32));
        const d = crypto.createDecipheriv("aes-256-gcm", kek, Buffer.from(w.iv, "base64url"));
        d.setAAD(Buffer.from(aad, "utf8")); d.setAuthTag(Buffer.from(w.tag, "base64url"));
        return { key: Buffer.concat([d.update(Buffer.from(w.ct, "base64url")), d.final()]).toString("base64url") };
      } catch { throw refuse("This device cannot open that wrap.", "cannot_open"); }
    }, { internal: true });
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
    tool("spaces.identity.enrol", "Put a newly paired device on this person's identity list. Signed by this device's entry; the device is a newcomer for 24 hours. For pairing.", obj({ publicKey: str, label: str, agree: str, enclave: str, held: str, attest: str }, ["publicKey"]), async (i, meta) => {
      me();
      // KP-2: the entry's `held` is decided HERE, from what this side can verify, never from the offered fields (they come from the pairing's channel, which can be a page script). An entry nobody proved is held by the OS's key store
      // is "web" by default: it cannot change who speaks for the identity. A caller can only make it stricter (it may say held web; it cannot say "not web"). `hooks.entryProof` replaces the default verifier (tests); the
      // default is kernel/seal/entry-proof.js, closed until a real-device fixture passes, so every enrolled entry is web until then.
      // The proof is a platform attestation of the chip key (kernel/seal/entry-proof.js: App Attest for an iPhone, Keystore key attestation for Android), each closed by its own VERIFIED flag until a real-device fixture passes. It is checked here and not stored on the list.
      let proven = false;
      const proofOf = typeof hooks.entryProof === "function" ? hooks.entryProof : (defaultEntryProof ||= entryProof());
      try { proven = (await proofOf({ publicKey: String(i.publicKey), ...(typeof i.enclave === "string" ? { enclave: i.enclave } : {}), ...(typeof i.agree === "string" ? { agree: i.agree } : {}), ...(typeof i.attest === "string" ? { attest: i.attest } : {}) }, meta)) === true; } catch { proven = false; }
      try { return await idops.addEntry({ kind: "device", publicKey: String(i.publicKey), label: i.label, ...(typeof i.agree === "string" ? { agree: i.agree } : {}), ...(typeof i.enclave === "string" ? { enclave: i.enclave } : {}), ...(proven && i.held !== "web" ? {} : { held: "web" }) }); } catch (e) { throw idFail(e); }
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
      if (!i.space && !home) throw refuse("This home's space has no root key here yet; finish setting up this home first (spaces.status shows how far it got).", "not_found");
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
    // An identity made before the agreement key gets one on its own entry (one self-signed op), at the first start and again on every check until it has it. A failure (offline) tries again next time.
    const completeAgree = () => { const s = identity.status(); if (s.exists && s.name) idops.completeAgree().catch(e => ctx.log.warn(`the agreement key could not be added yet: ${/** @type {Error} */ (e).message}`)); };
    const agreeFirst = setTimeout(completeAgree, 3_000);
    if (typeof agreeFirst.unref === "function") agreeFirst.unref();
    const agreeTimer = setInterval(completeAgree, syncEvery);
    if (typeof agreeTimer.unref === "function") agreeTimer.unref();

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
    return { async stop() { clearInterval(timer); clearTimeout(first); clearTimeout(bundleFirst); clearInterval(bundleTimer); clearInterval(syncTimer); clearTimeout(agreeFirst); clearInterval(agreeTimer); } };
  },
};

export { SpacesError };
