// kernel/index.js: the composition root. `createKernel` wires one Space's kernel from safe defaults, so no consumer and no test rig assembles the parts by
// hand: the event log, the store, the chain builder, the grants store (or the caller's own grants and members, for the retrofit path), the limits, the
// tasks, the rule evaluator (kernel/expr), the sealing client and the door when given, and the gateway over them. A part the caller passes replaces its
// default; nothing is left unwired that would make a decision fail open (no evaluator means the kernel's own, not none).
//
//   const k = createKernel({ space, owner: "per_owner", owner_uid: process.getuid(), key });          // in memory, a first owner, everything wired
//   const k = createKernel({ space, ..., store, log, grants: { forSubject, get }, members: { has } }); // your own store, log or grants (a test rig)
//   k.gateway.records / .events / .grants / .seal / .audit / .tasks   k.chains.fromFacts(...)   k.log   k.store   k.limits
import { createGateway } from "./gateway/index.js";
import { createMemoryStore } from "./store/memory.js";
import { createEventLog } from "./core/events.js";
import { createChainBuilder, isExactlyPerson, isChain } from "./core/chain.js";
import { createGrantsStore } from "./grants/index.js";
import { createLimits } from "./core/limits.js";
import { createTasks } from "./tasks/tasks.js";
import { sealerPresence } from "./core/presence.js";
import { OWNER_SCOPED_TYPES } from "./core/authorize.js";
import { expr as defaultExpr } from "./expr/index.js";
import { KernelError } from "./core/errors.js";
import { createSurfaces } from "./core/surfaces.js";
import { verifyTail, anchorCheck, createCheckpointer } from "./audit/index.js";
import { sealerKey } from "./audit/key.js";
import { createRoom, createRoomPort } from "./core/room.js";
import { proofFrom, proofRequest, acceptProofRequest, proofChainHash } from "./remote/proof.js";
import { createOffersPort } from "./remote/offers-port.js";
import { createKernelSeal } from "./core/seal.js";
import { runnerPorts } from "./gateway/runner-ports.js";
import { createKitApply } from "./tasks/kit-apply.js";
import { holdKernelDrive } from "./storage/keys.js";
import { backendFor } from "./storage/devices.js";
import { createBridge } from "./storage/bridge.js";
import { TASK } from "../records/core-types.js";

/**
 * @param {{ space: string, owner: string, owner_uid: number, key?: Uint8Array | string, seal?: any, label?: () => { name?: string, words?: string }, clock?: () => number,
 *   legacyKeys?: (Uint8Array | string)[], snapshot_every?: number, bootCheck?: boolean, currentCall?: () => any, store?: any, log?: any, chains?: any, grantsStore?: any, grants?: any, members?: any, bootstrap?: boolean, presence?: any, sealer?: any, door?: any,
 *   expr?: any, hasPresenceSession?: (chain: any) => boolean, onStageEnter?: any, stageTasks?: any, checkpointKey?: any, unit?: { begin(): Promise<{ commit(): void, rollback(): void, abandon(): void }> }, checkpointSigner?: { key_id: string, pub: string, sign: (bytes: Buffer) => Promise<string> | string }, checkpoints?: boolean, anchor?: { read(): Promise<any>, advance(i: { seq: number, head: string }): Promise<any> },
 *   deviceEnrolled?: (space: string, device: string) => Promise<boolean>, onOwnerAdopted?: (owner: string, previous: string) => Promise<void> | void,
 *   drive?: any, resolveCredential?: any, forwardCredential?: any, routeAction?: any, templates?: any, destinations?: any, resolve?: any, actions?: any[], attrs?: any, sinks?: Set<string> }} cfg
 *   grants and members together replace the grants store (the retrofit path and test rigs); otherwise a grants store is made and, on an empty log, its first owner
 */
export async function createKernel(cfg) {
  const clock = cfg.clock || Date.now;
  const log = cfg.log || createEventLog({ space: cfg.space, clock });
  const store = cfg.store || createMemoryStore({ clock });
  // The one sealing handle (K-3): the sealing process when there is one, a development key when there is not. Only the chain builder and the grants store are given it.
  const seal = cfg.seal || createKernelSeal({ sealer: cfg.sealer, key: cfg.key });
  /** The Space's owner: a local id from first start until the person claims their identity, then THE identity's id (`adoptOwner`). Everything below reads it live. */
  const ownerRef = { id: cfg.owner };
  const chains = cfg.chains || createChainBuilder({ space: cfg.space, get owner() { return ownerRef.id; }, owner_uid: cfg.owner_uid, seal, clock, is_person: () => true });
  const own = Boolean(cfg.grants && cfg.members);
  /** The Space's name and fingerprint words for the join card: given at start, or later by the module that holds the Space's identity (`setLabel`). */
  /** @type {(() => { name?: string, words?: string }) | undefined} */ let label = cfg.label;
  // DEVELOPMENT ONLY (`cfg.standIn`, true only in a development build whose home holds the owner's hand-made `dev-presence-stand-in`): the automated walk's presence. A one-person chain then counts as
  // having a presence session, and a proof with method "stand-in" is taken; every use is a `presence.stand-in` event naming the method, so a walk is never mistaken for a real proof.
  const standIn = typeof cfg.standIn === "function" ? cfg.standIn : () => false;
  const standInUse = (/** @type {string} */ what) => { try { void Promise.resolve(log.append(chains.fromFacts({ kind: "module", module: "presence", first_party: true }), { type: "presence.stand-in", sv: 1, subject: `vyre://${cfg.space}/presence/stand-in`, data: { method: "stand-in", what }, vis: "owner", red: "internal" })).catch(() => {}); } catch { /* the walk goes on */ } };
  const baseHas = cfg.hasPresenceSession || ((/** @type {any} */ chain) => isExactlyPerson(chain) && Boolean(chain.hops[0].via && chain.hops[0].via.session));
  const hasPresenceSession = (/** @type {any} */ chain) => baseHas(chain) || (standIn() === true && isExactlyPerson(chain) && (standInUse("session"), true));
  const presence0 = cfg.presence || (cfg.sealer ? sealerPresence(cfg.sealer) : undefined);
  const presence = typeof cfg.standIn === "function" ? Object.freeze({ check: async (/** @type {any} */ i) => { if (i && i.proof && i.proof.method === "stand-in" && standIn() === true && isChain(i.chain) && isExactlyPerson(i.chain)) { standInUse(String(i.op)); return null; } return presence0 ? presence0.check(i) : "no_presence"; } }) : presence0;
  /** Attributes of a resource by its type, offered by a first-party module that declared `needs.kernel.attrs` (a session's owner): merged over the home's own `cfg.attrs`. */
  /** @type {Map<string, (urn: string) => any>} */ const attrProviders = new Map();
  const attrsOf = (/** @type {string} */ urn) => {
    const base = (cfg.attrs && cfg.attrs(urn)) || {};
    const m = /^vyre:\/\/[^/]+\/([^/]+)\//.exec(String(urn));
    const fn = m && attrProviders.get(m[1]);
    let extra = {}; if (fn) { try { extra = fn(urn) || {}; } catch { extra = {}; } }
    // A provider says WHOSE a resource is (`owner`, `project`) and nothing else: the kernel's own keys (space, sensitivity, created_by ...) always win (reviewer-2's AT-1).
    const own = {}; for (const k of ["owner", "project"]) if (typeof /** @type {any} */ (extra)[k] === "string") /** @type {any} */ (own)[k] = /** @type {any} */ (extra)[k];
    return { ...own, ...base };
  };
  const grantsStore = own ? undefined : cfg.grantsStore || createGrantsStore({ snapshot_every: cfg.snapshot_every, legacyKeys: cfg.legacyKeys, space: cfg.space, log, chains, seal, clock, presence, label: () => (label ? label() : {}) });
  const limits = createLimits({ space: cfg.space, log, clock });
  let fresh = false, migrated = false;
  if (grantsStore && cfg.bootstrap !== false) { if (log.latestSeq() === 0) { await grantsStore.bootstrap({ owner: cfg.owner }); fresh = true; } else { migrated = (await grantsStore.rebuild()).migrated; limits.rebuild(); } }
  // The log decides who the owner is (AO-3): an adoption it holds wins over what the home's own file says, a move a crash cut short is finished here, and the file is rewritten from it.
  if (grantsStore && cfg.bootstrap !== false && typeof grantsStore.adopted === "function" && grantsStore.adopted()) {
    const ad = /** @type {{ from: string, to: string }} */ (grantsStore.adopted());
    await grantsStore.adoptOwner(ad.to, ad.from);
    if (ownerRef.id !== ad.to) { const from = ownerRef.id; ownerRef.id = ad.to; if (typeof cfg.onOwnerAdopted === "function") await cfg.onOwnerAdopted(ad.to, from); }
  }
  // A presence session (the person signed in with their passkey on this device) stands for admin acts only for a chain that is exactly one person.
  /** @type {any} */ let gateway;
  const members = grantsStore ? grantsStore.members : cfg.members;
  const tasks = createTasks({
    canonicalPerson: (/** @type {string} */ id) => (grantsStore ? grantsStore.canonicalPerson(id) : id), texts: cfg.texts,
    space: cfg.space, log, chains, clock, presence: presence || { check: async () => "no_presence_verifier" }, members: { has: (/** @type {any} */ a) => members.has(a), roleOf: (/** @type {any} */ a) => (grantsStore ? grantsStore.roleOf(a) : null) },
    authorizer: { authorize: (/** @type {any} */ i) => gateway.authorize(i), get actions() { return gateway.registry; } },
    approver: () => ({ kind: "person", id: ownerRef.id, space: cfg.space }), resolve: cfg.resolve, enforce: (/** @type {any} */ c, /** @type {any} */ d) => limits.enforce(c, d),
    // A task's project link must name a record that is there (the gate says whether the chain may read it, not whether it exists).
    // A task is a record of the Space's store (DESIGN-tasks-records): its words and fields live there, the kernel keeps what decides who may act.
    records: store,
    projectExists: async (/** @type {string} */ u) => { const m = /^vyre:\/\/[^/]+\/([^/]+)\/([^/]+)$/.exec(u); if (!m) return false; try { return Boolean(await store.get(m[1], m[2])); } catch { return false; } },
  });
  // The task record type is defined once, and every task the kernel already holds gets its record (idempotent: a task with a record is skipped).
  // The task record type is asked for at boot. A record store that is not there yet (stores/twenty/deferred-store.js) remembers a definition made now and applies it when it attaches; what it cannot do
  // now, the task migration (it reads and writes records), runs when the store comes up (`whenReady`), so no second retry loop lives here. Any other error stops the boot.
  const defineTasks = async () => { await store.define({ add_types: [TASK] }); await tasks.migrate(); };
  try { await defineTasks(); }
  catch (e) {
    if (/** @type {any} */ (e).code !== "unavailable" || typeof store.whenReady !== "function") throw e;
    store.whenReady(() => tasks.migrate());
  }
  const roomPort = grantsStore ? createRoomPort({ grantsStore }) : null;
  // An approved Kit install is presence for that install (kernel/tasks/kit-apply.js); the gateway's authorizer asks `waives`, the install asks `begin`.
  const kitApply = createKitApply({ space: cfg.space, tasks, log, chains, clock, types: () => store.types() });
  gateway = createGateway({
    // The stored attributes are the whole truth about a type's owner and project only where no module supplies them and the home has no attribute function: then a store may filter by them.
    attrPush: (/** @type {string} */ type) => !cfg.attrs && !attrProviders.has(type),
    ...(cfg.basic ? { basic: cfg.basic } : {}),
    kitApply, waives: (/** @type {any} */ w, /** @type {any} */ q) => kitApply.waives(w, q),
    // the other Space's log, for a move received here: this home hosts both (kernel/gateway/moves.js); a Space it does not host has no evidence
    moveEvidence: (/** @type {string} */ from, /** @type {string} */ moveId) => { const h = spaces && typeof spaces.hosted === "function" ? spaces.hosted(from) : null; return h && h.kernel && h.kernel.log ? h.kernel.log.read({ type: "project.move_started" }).find((/** @type {any} */ e) => e.data && e.data.move_id === moveId) ?? null : null; },
    remoteMoveEvidence: (/** @type {any} */ b, /** @type {any} */ c) => { const h = spaces && typeof spaces.moveHooks === "function" ? spaces.moveHooks() : null; if (!h || typeof h.remoteEvidence !== "function") throw new KernelError("unavailable", "this home cannot check evidence from another home"); return h.remoteEvidence(b, c); }, // another home's evidence and receipts for a project move are checked by the spaces module (it holds the names client): late-bound through the Spaces registry, so a Space this home hosts asks the same one
    verifyUpgradeReceipt: (/** @type {any} */ r, /** @type {any} */ c) => { const h = spaces && typeof spaces.moveHooks === "function" ? spaces.moveHooks() : null; if (!h || typeof h.verifyUpgradeReceipt !== "function") throw new KernelError("unavailable", "this home cannot check My Cloud's receipt"); return h.verifyUpgradeReceipt(r, c); },
    verifyMoveReceipt: (/** @type {any} */ r, /** @type {any} */ c) => { const h = spaces && typeof spaces.moveHooks === "function" ? spaces.moveHooks() : null; if (!h || typeof h.verifyReceipt !== "function") throw new KernelError("unavailable", "this home cannot check a receipt from another home"); return h.verifyReceipt(r, c); },
    room: roomPort,
    space: cfg.space, store, log, chains, clock, limits, tasks, approvedAct: (/** @type {any} */ q) => tasks.useApproval(q), approvedPeek: (/** @type {any} */ q) => tasks.approvedAct(q), get owner() { return ownerRef.id; }, presence, hasPresenceSession, expr: cfg.expr === undefined ? defaultExpr : cfg.expr,
    ...(grantsStore ? { grantsStore } : { grants: cfg.grants, members: cfg.members }),
    sealer: cfg.sealer, unit: cfg.unit, door: cfg.door, onStageEnter: cfg.onStageEnter, stageTasks: cfg.stageTasks, checkpointKey: cfg.checkpointKey, templates: cfg.templates, destinations: cfg.destinations,
    actions: cfg.actions, attrs: attrsOf, canonicalPerson: (/** @type {string} */ id) => (grantsStore ? grantsStore.canonicalPerson(id) : id), sinks: cfg.sinks, drive: cfg.drive, resolveCredential: cfg.resolveCredential, forwardCredential: cfg.forwardCredential, routeAction: cfg.routeAction,
  });
  const surfaces = createSurfaces({ space: cfg.space, chains, door: cfg.door, clock, isAdmin: (/** @type {string} */ id) => Boolean(grantsStore && grantsStore.isAdmin({ kind: "person", id, space: cfg.space })), chatMember: (/** @type {string} */ person, /** @type {string} */ chat) => Boolean(grantsStore && grantsStore.chatHas(person, chat)) });
  const room = grantsStore ? createRoom({ space: cfg.space, grantsStore, port: roomPort, surfaces, chains, gateway, log, clock, currentCall: cfg.currentCall }) : null;
  /**
   * `ctx.kernel` for one first-party module (the registry calls this when it builds the module's context): the gateway's own surfaces, bound to this Space, and the
   * module's own service chain. A module declares what it needs under `needs.kernel` ({ actions, prefixes, types }) and is given exactly that: grants whose source is
   * `install:<module>`, and the record types it declared, defined by the kernel itself (a kernel act at install, not a call a module can make). With nothing declared it
   * is a service of the Space that can do nothing. `chain(meta)` is the Surfaces door's chain for a call that carries a session token, else the module's own service
   * chain: a module never builds a chain. Record calls wait for the module's types to be defined.
   * @param {any} m the module's manifest
   */
  /** Is this device (a `device` fact) still enrolled in this Space? The spaces module keeps the list (`cfg.deviceEnrolled`); with no port every device is (a build without the module). Any error is a no. */
  const enrolledHere = async (/** @type {string} */ space, /** @type {any} */ facts) => {
    if (!cfg.deviceEnrolled || !facts || facts.kind !== "device" || typeof facts.device_key_id !== "string") return true;
    try { return (await cfg.deviceEnrolled(space, facts.device_key_id)) !== false; } catch { return false; }
  };
  /** The one adoption path (the handle's call and the boot repair share it). The grants store serialises it and reads the owner it replaces itself, so two callers at once make one adoption. */
  const adoptNow = async (/** @type {string} */ to, /** @type {any} */ fromArg) => {
    const from = fromArg && typeof fromArg === "object" ? fromArg.from : fromArg; // `adoptOwner(to, { from })` (windows' shape) or `adoptOwner(to, from)`
    const r = await grantsStore.adoptOwner(to, from);
    if (r.owner !== ownerRef.id) { const was = ownerRef.id; ownerRef.id = r.owner; if (typeof cfg.onOwnerAdopted === "function") await cfg.onOwnerAdopted(r.owner, was); }
    return r;
  };
  const kernelFor = (/** @type {any} */ m) => {
    if (!grantsStore) throw new Error("ctx.kernel needs the kernel's own grants store");
    const needs = (m.needs && m.needs.kernel) || { actions: [] };
    // Only a module that declared `needs.kernel` is made a service of the Space (one sealed event each); the rest get a handle that can do nothing.
    const installed = m.needs && m.needs.kernel ? grantsStore.installModule(m.name, { actions: Array.isArray(needs.actions) ? needs.actions : [], prefixes: Array.isArray(needs.prefixes) ? needs.prefixes : undefined, ...(Array.isArray(needs.grants) ? { grants: needs.grants.filter((/** @type {any} */ e) => e && typeof e.prefix === "string" && Array.isArray(e.actions)) } : {}) }) : Promise.resolve();
    // On a Basic device only the fixed personal types exist: a module's other types are not made (its tools answer the Cloud line when they reach for one).
    const wanted = Array.isArray(needs.types) ? (cfg.basic ? needs.types.filter((/** @type {any} */ t) => cfg.basic.allow.has(String(t && t.name))) : needs.types) : [];
    const ready = Promise.all([installed, wanted.length ? store.define({ add_types: wanted }) : Promise.resolve()]);
    // A failure here (the sealing process went away) surfaces on the module's first call, not as an unhandled rejection nobody can catch.
    ready.catch(() => {});
    // A Proxy over a COPY of the gateway's (frozen) records: a Proxy over a frozen target must answer with the target's own values, and these answers wait for `ready`. The handle is read only: nothing
    // may assign to it, delete from it or redefine a method on it, so no holder can replace what another caller gets.
    const records = new Proxy({ ...gateway.records }, {
      get: (t, k) => (typeof t[k] === "function" ? async (/** @type {any[]} */ ...a) => { await ready; return t[k](...a); } : t[k]),
      set: () => false, defineProperty: () => false, deleteProperty: () => false, setPrototypeOf: () => false,
    });
    /** @type {any} */ const handle = {
      space: cfg.space, get owner() { return ownerRef.id; },
      /** A person id as the Space knows them now (the owner an adoption replaced is the identity that replaced them): a module that keyed anything by person id reads it through this. */
      canonicalPerson: (/** @type {string} */ id) => (grantsStore ? grantsStore.canonicalPerson(id) : id),
      records, memory: gateway.memory, events: gateway.events, grants: gateway.grants, tasks: gateway.ask, audit: gateway.audit, authorize: gateway.authorize, limits: gateway.limits,
      model: surfaces.model,
      /** The `{ presence }` option from what a surface sent beside the request (`meta.kernel_proof`), and what that surface must sign for a grants call. The kernel's verifier checks it. */
      /** Any Space by id: this one, another this home hosts, or a remote client with the same gateway API (the chain argument carries no authority across). */
      for: (/** @type {string} */ id) => (id === cfg.space ? Object.freeze({ space: cfg.space, hosted: true, gateway, surfaces }) : spaces ? spaces.for(id) : (() => { throw new KernelError("unavailable", "this kernel has no Spaces registry"); })()),
      proofFrom, acceptProofRequest: (/** @type {any} */ card, /** @type {string} */ person) => acceptProofRequest(cfg.space, card, person), proofChainHash: (/** @type {string} */ person) => proofChainHash(cfg.space, person), proofRequest: (/** @type {string} */ call, /** @type {any[]} */ ...a) => proofRequest(cfg.space, call, ...a),
      leases: gateway.leases, drive: gateway.drive, chats: gateway.grants && gateway.grants.chats ? Object.freeze({ ...gateway.grants.chats, append: (/** @type {string} */ token, /** @type {any} */ message) => { if (!room) throw new KernelError("unavailable", "this kernel keeps no chats"); return room.append(token, message); }, beginTurn: (/** @type {string} */ token) => { if (!room) throw new KernelError("unavailable", "this kernel keeps no chats"); return room.beginTurn(token); }, appendOpen: (/** @type {string} */ token, /** @type {any} */ message) => { if (!room) throw new KernelError("unavailable", "this kernel keeps no chats"); return room.appendOpen(token, message); }, ...(needs.room === true ? { roomFor: (/** @type {string} */ token) => { if (!room) throw new KernelError("unavailable", "this kernel keeps no chats"); return room.roomFor(token); } } : {}), mayReceive: (/** @type {any} */ chain, /** @type {string} */ messageId) => { if (!room) throw new KernelError("unavailable", "this kernel keeps no chats"); return room.mayReceive(chain, messageId); } }) : undefined,
      // Only the pool's own module may record the index head; a head any module could write would make the rollback check worthless.
      // The pool behind this Space's Drive, for the Wink module only: it adds a node for every storage device a person paired (core/wink/storage/pool.js) and builds each node's backend with `backendFor`; `createBridge` serves
      // a drive on this computer to the Space's home. The Pool is what the Drive's chunks are placed on, so a module that holds it can place data: nothing else is given it.
      ...(m.name === "wink" && cfg.drive && cfg.drive.pool ? { storage: Object.freeze({ pool: cfg.drive.pool, backendFor, createBridge }) } : {}),
      ...(m.name === "wink-storage" ? { storageIndex: Object.freeze({ record: recordStorageIndex, head: storageIndexHead }) } : {}),
      /** The runner's ports from the kernel's own pieces (see kernel/gateway/runner-ports.js): allowed, revocation and the device key are the kernel's. */
      runnerPorts: (/** @type {any} */ o) => runnerPorts({ leases: gateway.leases, offers: gateway.grants && gateway.grants.offers }, o),
      /** What the runner needs from this computer, supplied by the daemon (`cfg.runnerHost`): this computer's device identity and key, the person, and either the pieces `runnerPorts` builds from or ready `ports` (a lent computer whose Space lives on another home). Without it the runner says it is not connected. */
      runnerHost: () => { if (typeof cfg.runnerHost !== "function") throw new KernelError("unavailable", "this computer has no runner host"); return cfg.runnerHost({ space: cfg.space }); },
      /** The room the RUNNING turn answers in (see kernel/core/room.js): `{ group: false }` or an opaque handle `{ group, read, canRead }`. The turn's own token is used, never an argument; throws `no_audience`. */
      audienceFor: async (/** @type {any} */ _extra) => { if (!room) throw new KernelError("unavailable", "this kernel keeps no chats"); return room.audienceFor(); },
      /**
       * Only for a first-party module that declares `needs.kernel.membership: true`: whether ONE named person is a member of this Space and their role, and nothing else
       * (no list, no grants, no expiry). Each call is an owner-visible event naming the module and the person asked about. A module that must list members runs under
       * the calling PERSON's chain instead (`grants.members.list(chain)`: a manager and above sees everyone, anyone else only themselves).
       * @param {string} person @param {string} [space] this Space only
       */
      ...(needs.membership === true && grantsStore ? { membership: async (/** @type {string} */ person, /** @type {string} */ space = cfg.space) => {
        if (typeof person !== "string" || !/^per_[A-Za-z0-9_-]{1,64}$/.test(person)) throw new KernelError("bad_input", "name one person");
        // This Space, or another this home hosts (its own grants and its own log): the answer and the owner-visible note come from the Space asked about.
        const h = space === cfg.space ? null : (spaces && typeof spaces.hosted === "function" ? spaces.hosted(space) : null);
        if (space !== cfg.space && !(h && h.kernel && h.kernel.grants)) throw new KernelError("not_found", "no such space here");
        const store = h ? h.kernel.grants : grantsStore, slog = h ? h.kernel.log : log, sgw = h ? h.kernel.gateway : gateway;
        const a = { kind: "person", id: person, space };
        const role = store.roleOf(a) || null;
        try { slog.append(sgw.serviceChain(m.name), { type: "membership.read", sv: 1, subject: `vyre://${space}/member/${person}`, data: { module: m.name, person, member: role !== null }, vis: "owner", red: "internal" }); } catch { /* the answer is a read; a log that cannot be written says so on the next write */ }
        return Object.freeze({ member: role !== null, role });
      } } : {}),
      /**
       * Only for a first-party module that declares `needs.kernel.sealDetect: true` (memory, recall): is this ONE candidate the current value of a sealed field the chain's person may read.
       * Yes or no and nothing else; the sealing process counts and limits the calls per module and Space. The module name comes from the registry (`m.name`), never from the call, and
       * a record the chain may not read counts for nothing. Each answer is one owner-visible event naming the module and the count, never the candidate.
       * @param {any} chain the caller's chain (`chain(meta)`) @param {string} value
       */
      ...(needs.sealDetect === true && cfg.sealer && typeof cfg.sealer.detectValue === "function" ? { sealDetect: async (/** @type {any} */ chain, /** @type {string} */ value) => {
        await ready;
        const r = await cfg.sealer.detectValue({ chain, caller: { module: m.name, first_party: true }, value,
          canRead: async (/** @type {string} */ resource) => { try { return (await gateway.authorize({ chain, action: "records.read", resource })).effect === "allow"; } catch { return false; } } });
        try { log.append(gateway.serviceChain(m.name), { type: "seal.detect", sv: 1, subject: `vyre://${cfg.space}/module/${m.name}`, data: { module: m.name, count: r.event ? r.event.count : null }, vis: "owner", red: "internal" }); } catch { /* the answer stands; a log that cannot be written says so on the next write */ }
        return Object.freeze({ match: r.match === true });
      } } : {}),
      /**
       * Only for a first-party module that declares `needs.kernel.work: true` (core/work: Space memory, teammates, the tool surface). It is the Kernel port core/work is written against,
       * made from the kernel's own pieces. What it does NOT give: another person's chain, anything the caller's own chain could not do, or the Engineer's compile and simulate ports
       * (records and sessions own those; the Engineer answers `unavailable` until they are wired).
       *  - chainFor(extra): the chain of THIS call, which must hold a person (a session token's, or the person's own surface). The module's own service chain is refused: a work tool
       *    acts for someone.
       *  - chainForPerson(person): `[person, service:<this module>]` for a CURRENT member of this Space, to READ as that person with the service's reach (what a fact is proposed from).
       *    It is a viewer chain plus the module's service hop: authorize refuses every act above read for it and it never stands for presence, so a proposed fact is kept as a
       *    suggestion for the person to accept under their own chain, never written on their behalf.
       *  - serviceChain(name): the module's own service chain (the name is the module's, never another's).
       *  - tasks.list(chain): the queue of the person the chain acts for; tasks.forRecord(chain, urn): the open tasks on a record, read through the caller's own chain.
       */
      ...(needs.work === true ? (() => {
        const personOnly = async (/** @type {any} */ meta) => {
          const c = await handle.chain(meta || {});
          if (!c || !Array.isArray(c.hops) || !c.hops.length || c.hops.every((/** @type {any} */ h) => h.actor.kind === "service")) throw new KernelError("not_allowed", "this call carries no person, so there is nothing to act for");
          return c;
        };
        const viewer = (/** @type {string} */ person) => chains.fromFacts({ kind: "viewer", person, vouched: true });
        return {
          chainFor: personOnly,
          chainForPerson: (/** @type {string} */ person) => {
            if (typeof person !== "string" || !/^per_[A-Za-z0-9_-]{1,64}$/.test(person)) throw new KernelError("bad_input", "name one person");
            if (!grantsStore.roleOf({ kind: "person", id: person, space: cfg.space })) throw new KernelError("not_found", "not a member of this Space");
            return chains.appendService(viewer(person), m.name, true);
          },
          serviceChain: (/** @type {string} */ _name) => gateway.serviceChain(m.name),
          ask: gateway.ask,
          definitions: gateway.definitions,
          actions: gateway.actions,
          registry: () => gateway.actions(),
          members: gateway.members,
          tasks: Object.freeze({
            list: (/** @type {any} */ chain) => gateway.tasks.list(viewer(String(chain.hops[0].actor.id))),
            forRecord: async (/** @type {any} */ chain, /** @type {string} */ recordUrn) => {
              const out = [];
              for (const e of await gateway.events.read(chain, { type: "task.created" })) {
                const id = String(e.subject).split("/").pop();
                const t = await gateway.ask.get(chain, /** @type {string} */ (id)).catch(() => null);
                if (t && t.record === recordUrn) out.push(t);
              }
              return out;
            },
          }),
        };
      })() : {}),
      /**
       * Only for a first-party module that declares `needs.kernel.spaces: true` (the module that creates Spaces): what a Space made here would be stored in (`storePlan`, with the confirmation to
       * show BEFORE it is made) and starting to host one (`host({ owner, name })` -> `{ space }`, the kernel's own `spc_` plus 12 base32 id). The Space's first owner is the
       * person id named; nothing here lists or reaches another Space (`for` and `chainIn` do that, under a chain).
       */
      ...(needs.spaces === true ? { spaces: Object.freeze({
        retire: async (/** @type {string} */ id) => { if (!spaces) throw new KernelError("unavailable", "this kernel has no Spaces registry"); return spaces.retire(id); },
        storePlan: () => { if (!spaces) throw new KernelError("unavailable", "this kernel has no Spaces registry"); return spaces.storePlan(); },
        host: async (/** @type {{ owner: string, name?: string }} */ o) => { if (!spaces) throw new KernelError("unavailable", "this kernel has no Spaces registry"); const h = await spaces.host(o); return { space: h.space || h.id, id: h.space || h.id }; },
      }) } : {}),
      /**
       * Sessions for a daemon (kernel/core/surfaces.js): the PERSON opens one under their own chain (`open(chain, { agent?, chat?, session?, thread?, ttl_ms? })` gives
       * `{ token, session, expires }`; the chat is checked and written into the token), `valid(token)` says whether it is still good (so a session socket can close when it
       * is revoked or expires), and `revoke(session, chain)` ends it. A module never mints a token for a person: `open` needs a chain that is exactly one person.
       */
      sessions: Object.freeze({
        open: (/** @type {any} */ chain, /** @type {any} */ o) => surfaces.open(chain, o),
        valid: (/** @type {string} */ token) => surfaces.verify(token).then(() => true, () => false),
        revoke: (/** @type {string} */ session, /** @type {any} */ chain) => surfaces.revoke(session, chain),
      }),
      /**
       * The sealing process's presence calls, for the module that holds the identity chain (windows' spaces): after a recovery it hands the process the person's chain evidence so
       * a person with no presence key left gets a new first key (`recover`, a newcomer for 24 hours), and keeps the process's copy of the chain current (`sync`). The process checks
       * everything itself (the chain, the pin, that the device was not barred, that the chain's person is the one in the chain argument); this only carries the call. A first-party module only.
       */
      ...(cfg.sealer && typeof cfg.sealer.recover === "function" ? { presence: Object.freeze({
        begin: (/** @type {any} */ i) => cfg.sealer.begin(i),
        enrol: (/** @type {any} */ i) => cfg.sealer.enrol(i),
        sync: (/** @type {any} */ i) => cfg.sealer.sync(i),
        recover: (/** @type {any} */ i) => cfg.sealer.recover(i),
      }) } : {}),
      serviceChain: () => gateway.serviceChain(m.name),
      /**
       * The chain of the call itself: a session token's (an assistant acting for its person), else the person's own chain built from the facts the daemon proved about the connection
       * (`meta.kernelFacts`, set only by the daemon: a person's surface on the socket, a paired or signed-in owner device), else the module's own service chain. The kernel's builder
       * refuses facts that do not hold (a uid that is not the owner's, an unverified Capsule); then the call has no person chain, never a wider one.
       */
      chain: async (/** @type {any} */ meta) => {
        if (meta && typeof meta.token === "string") return surfaces.chainFor(meta.token);
        if (meta && meta.kernelFacts && typeof meta.kernelFacts === "object") {
          // A device the person removed from THIS Space has no chain in it (the user's ruling: devices enrol per Space); it keeps its chains in the Spaces it is still in.
          if (!(await enrolledHere(cfg.space, meta.kernelFacts))) return gateway.serviceChain(m.name);
          try { return chains.fromFacts(meta.kernelFacts); } catch { /* no person chain for this connection */ }
        }
        await ready;
        return gateway.serviceChain(m.name);
      },
    };
    // Only the spaces module (`needs.kernel.spaces: true`) may make or list Spaces: `spaces.create` makes the Space HERE, in the kernel's registry, and the kernel's id (`spc_` and 12 base32
    // characters) is the Space's id everywhere. One registry, one id; the store is attached at that moment (the kernel opens the built-in store for every hosted Space).
    if (needs.attrs === true) {
      /** Say whose a resource of this type is (`{ owner, project }` by its URN): the kernel then lets only the owner read a type it scopes by owner (`session`). Fail-safe: a throw is no attributes. */
      const mayType = new Set([...OWNER_SCOPED_TYPES, ...(Array.isArray(needs.attrTypes) ? needs.attrTypes.map(String) : [])]);
      handle.registerAttrs = (/** @type {string} */ type, /** @type {(urn: string) => any} */ fn) => { if (!mayType.has(String(type))) throw new KernelError("not_allowed", "a module gives attributes only for a type it declared (needs.kernel.attrTypes) or an owner-scoped one"); if (typeof type !== "string" || !/^[a-z][a-z0-9_-]{0,40}$/.test(type) || typeof fn !== "function") throw new KernelError("bad_input", "name a type and give a function"); attrProviders.set(type, fn); };
    }
    if (needs.spaces === true) {
      /** The claimed identity's id becomes the owner's id here (once, logged): the one person of this Space. */
      handle.adoptOwner = (/** @type {string} */ to, /** @type {any} */ from) => {
        if (!grantsStore) throw new KernelError("unavailable", "this kernel has no grants store");
        return adoptNow(to, from);
      };

      /** The identity that took this Space's owner place (claimed at the server's own screen or by a pairing), or null while the owner is still the first-start id. First owner wins: nothing else may become the owner. */
      handle.ownerClaimed = () => { const a = grantsStore && typeof grantsStore.adopted === "function" ? grantsStore.adopted() : null; return a ? String(a.to) : null; };

      /**
       * The owner's first presence key, enrolled in the sealing process inside the pairing that made this person the owner: the home builds the owner's chain itself (never a module) and only for
       * the identity that took the owner place. The sealing process then does the rest: one chain-person, a one-use token for this key, no key yet for the person (a further device needs a proof from
       * an enrolled key), and a software key only on a development build.
       * @param {{ person: string, device: string, key_id: string, spki: string, signer: string }} o
       */
      handle.enrolOwnerKey = async o => {
        if (!cfg.sealer || typeof cfg.sealer.begin !== "function" || typeof cfg.sealer.enrol !== "function") throw new KernelError("unavailable", "this home has no sealing process to enrol a key in");
        const a = grantsStore && typeof grantsStore.adopted === "function" ? grantsStore.adopted() : null;
        if (!a || String(a.to) !== String(o.person)) throw new KernelError("not_allowed", "only the identity that owns this home gets its first presence key here");
        const chain = chains.fromFacts({ kind: "device", device_key_id: String(o.device), person: String(o.person), path: "direct" });
        const { token } = await cfg.sealer.begin({ chain, person: o.person, key_id: o.key_id, spki: o.spki });
        return cfg.sealer.enrol({ chain, person: o.person, key_id: o.key_id, spki: o.spki, signer: o.signer, token });
      };

      const reg = () => { if (!spaces) throw new KernelError("unavailable", "this kernel has no Spaces registry"); return spaces; };
      handle.spaces = Object.freeze({
        host: (/** @type {any} */ o) => reg().host(o),
        retire: (/** @type {string} */ id) => reg().retire(id),
        describe: (/** @type {string} */ id) => reg().describe(id),
        storePlan: () => reg().storePlan(),
        list: () => reg().list(),
        hosts: (/** @type {string} */ id) => reg().hosts(id),
        setMoveHooks: (/** @type {any} */ h) => reg().setMoveHooks(h),
      });
    }
    /**
     * The chain of the call itself, in ANY Space this home hosts (the app's one call names a Space): this Space's is `chain(meta)`; another hosted Space builds the chain from the same proved
     * facts (or its own session token) under THAT Space's own key, so the call is a member of that Space or nothing. A Space this home does not host has no chain here.
     * @param {string} space @param {any} meta
     */
    handle.chainIn = async (space, meta) => {
      if (space === cfg.space) return handle.chain(meta);
      const h = spaces && typeof spaces.hosted === "function" ? spaces.hosted(space) : null;
      if (!h || !h.kernel) throw new KernelError("not_found", "no such space here");
      if (meta && typeof meta.token === "string") {
        try { return await h.surfaces.chainFor(meta.token); } catch { /* not a token of that Space's own: a session of this home, below */ }
        // A session opened in this home speaks for its person in every Space they belong to (an assistant works wherever its person does): this home verifies the token it signed, and the other Space
        // builds the chain from the person and agent the token names by the same rule a session of its own gets. The Space's own grants still decide what that chain may do, and a person who is not a member there gets no chain.
        let t; try { t = await surfaces.verify(meta.token); } catch { throw new KernelError("not_a_member", "no chain for this connection"); }
        const facts = t.agent ? { kind: "agent_session", agent: t.agent, session: t.session, thread: t.thread || t.session, person: t.person, from_token: true, vouched: true } : { kind: "session_person", person: t.person, session: t.session, from_token: true, vouched: true };
        try { return h.kernel.chains.fromFacts(facts); } catch { throw new KernelError("not_a_member", "no chain for this connection"); }
      }
      if (meta && meta.kernelFacts && typeof meta.kernelFacts === "object") {
        if (!(await enrolledHere(space, meta.kernelFacts))) throw new KernelError("not_a_member", "this device is not enrolled in that space");
        try { return h.kernel.chains.fromFacts(meta.kernelFacts); } catch { /* no person chain for this connection */ }
      }
      throw new KernelError("not_a_member", "no chain for this connection");
    };
    /** Wink's `offers` port over this Space's grants.offers (kernel/remote/offers-port.js): the caller's chain and proof come from the call's meta. */
    handle.offersPort = () => createOffersPort(handle);
    return Object.freeze(handle);
  };
  /** The home's registry of Spaces (kernel/spaces), set once by it: `ctx.kernel.for(id)` reaches any Space, hosted here or remote, through the same gateway. */
  /** @type {any} */ let spaces = null;
  const bindSpaces = (/** @type {any} */ reg) => { spaces = reg; };
  /**
   * The pool's index backup head (vault: `storage.index { seq, hash, copies, at_risk }` after each backup) goes into the log, so the checkpoint the owners' devices already
   * hold covers it: a new home restoring the index is told the head to expect (`restoreIndex({ expected })`) and refuses anything older or different (`rollback`).
   * @param {{ seq: number, hash: string, copies: number, at_risk?: boolean }} head
   */
  function recordStorageIndex(head) {
    if (!head || !Number.isInteger(head.seq) || head.seq < 0 || typeof head.hash !== "string" || !/^[A-Za-z0-9_+/=-]{8,128}$/.test(head.hash) || !Number.isInteger(head.copies) || head.copies < 0) throw new Error("a storage index head needs seq, hash and copies");
    return log.append(chains.fromFacts({ kind: "module", module: "storage", first_party: true }), { type: "storage.index", sv: 1, subject: `vyre://${cfg.space}/storage/index`, data: { seq: head.seq, hash: head.hash, copies: head.copies, at_risk: Boolean(head.at_risk) }, vis: "owner", red: "internal" });
  }
  /**
   * The head to expect on restore: the latest `storage.index` at or before a checkpoint the owner's devices hold (so a head written after what they hold, or one a rolled-back
   * home invented, is not what they vouch for). With no checkpoint, the latest in the log, marked unverified.
   * @param {{ seq: number } | null} [checkpoint] @returns {{ seq: number, hash: string, copies: number, at_risk: boolean, unverified: boolean } | null}
   */
  function storageIndexHead(checkpoint = null) {
    const all = log.read({ type: "storage.index" }).filter((/** @type {any} */ e) => !checkpoint || e.seq <= checkpoint.seq);
    const e = all[all.length - 1];
    return e ? { ...e.data, unverified: !checkpoint } : null;
  }
  // The check a restart makes (incremental): the last signed checkpoint against the event at its position, then the chain from there to the head, not from event zero. Reported
  // for the daemon to act on (`boot.tamper`); it never throws here.
  // The log anchor (BL-2): the sealing process keeps the newest (seq, head) it was shown outside the database; the restart compares the log with it, which the log's own checkpoints cannot do.
  const anchor = cfg.anchor || (cfg.sealer && cfg.sealer.anchor ? { read: () => cfg.sealer.anchor.read({ space: cfg.space }), advance: (/** @type {any} */ i) => cfg.sealer.anchor.advance({ space: cfg.space, seq: i.seq, head: i.head }) } : null);
  // `checkpoints: true` takes the Space's checkpoint key from the sealing process (which holds it and never returns it); a caller may bring a signer of its own.
  const signer = cfg.checkpointSigner || (cfg.checkpoints && cfg.sealer && cfg.sealer.spaceKey ? await sealerKey(cfg.sealer, chains.fromFacts({ kind: "module", module: "audit", first_party: true })) : null);
  const checkpointKey = cfg.checkpointKey || (signer && signer.pub) || null;
  const tail = checkpointKey && cfg.bootCheck !== false ? verifyTail({ space: cfg.space, log, publicKey: checkpointKey }) : null;
  const anchored = anchor && cfg.bootCheck !== false ? await anchorCheck({ log, anchor }) : null;
  /** @type {any} */ const boot = tail || anchored ? { ...(tail || { ok: true, from: 0, checked: 0 }), ok: (!tail || tail.ok) && (!anchored || anchored.ok), ...(tail && !tail.ok ? {} : anchored && !anchored.ok ? { why: anchored.why } : {}), ...(anchored ? { anchor: anchored } : {}) } : null;
  // Signed checkpoints, when the Space's key is given (the sealing process holds it): each one verifies the log, moves the anchor, and is written into the log.
  const checkpoints = signer ? createCheckpointer({ space: cfg.space, log, chains, publicKey: signer.pub, sign: signer.sign, key_id: signer.key_id, clock, ...(anchor ? { anchor } : {}) }) : null;
  /** An invitee's first presence key on this server (RC1), through the sealing process; only the remote door's accept calls it, with the identity chain it read from the directory itself. */
  const joinKey = cfg.sealer && typeof cfg.sealer.join === "function" ? (/** @type {any} */ i) => cfg.sealer.join(i) : undefined;
  const unjoinKey = cfg.sealer && typeof cfg.sealer.unjoin === "function" ? (/** @type {any} */ i) => cfg.sealer.unjoin(i) : undefined;
  /** A module's tools that may be a Flow step become actions of this Space, and the owner and admin roles hold them (kernel/gateway registerActions, grants installFlowActions). Kernel-only: the registry calls it for a module that started. */
  const registerFlowActions = async (/** @type {string} */ module, /** @type {any[]} */ defs) => {
    if (!grantsStore) throw new Error("flow actions need the kernel's own grants store");
    const names = gateway.registerActions(module, defs);
    await grantsStore.installFlowActions(module, names);
    return names;
  };
  return holdKernelDrive(Object.freeze({ boot, checkpoints, presence, adoptOwner: adoptNow, registerFlowActions, ...(joinKey ? { joinKey, ...(unjoinKey ? { unjoinKey } : {}) } : {}), setLabel: (/** @type {() => { name?: string, words?: string }} */ f) => { label = f; }, bindCalls: (/** @type {() => any} */ fn) => { if (room) room.bindCalls(fn); }, recordStorageIndex, storageIndexHead, gateway, log, store, chains, grants: grantsStore, limits, tasks, surfaces, kernelFor, bindSpaces, fresh, migrated }), cfg.drive);
}
