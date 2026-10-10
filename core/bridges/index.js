// @ts-check
// bridges: the one way a Space shares with another (contract 10). This module is thin wiring over
// lib/spaces/bridges.js (the lifecycle, pure) and lib/spaces/authz.js (a role authorize with the
// kernel's shape). It builds the chain from the verified caller, never from input; it stores the
// bridges in SQLite; it reads each Space through that Space's own records tools and writes events
// to BOTH Spaces' logs with a `space` field. No server joins data across Spaces: bridges.merge.links
// only hands a device the link for each Space it belongs to (README.md).
//
// Seams other modules fill (all tolerant: a missing one answers in plain words, never a crash):
//   spaces.membership {space, person}  -> Membership | null          (core/spaces)
//   spaces.merge-list {person}             -> [{space|id, name, color, link}]
//   spaces.policy {space}              -> { inference, secrets, allow_copy }
//   records.read {space,type,id} -> {record}   records.query {space,type,spec} -> {rows,next_cursor}
//   records.create {space,type,id,data,meta}   records.schema {space,type} -> {schema}
//   records.define {space,diff}                records.state {space} -> installed definitions
//   tasks.create {space,title,source,doer,inputs,output,how} -> {id}

import {
  BridgeError, BRIDGE_ACTIONS, proposeView, proposeReference, proposeProjection, proposalHash, acceptBridge, revokeBridge, readView,
  resolveReference, copyRecord, projectEvent, kitExport, kitInstallPlan, installKit, continueIn, sessionPolicy, canonicalHash, chainIsExactlyOnePerson,
} from "../../lib/spaces/bridges.js";
import { createRoleAuthorize, personChain } from "../../lib/spaces/authz.js";
import { isExpired } from "../../lib/spaces/members.js";
import { PRESENCE_SIGNERS } from "../../kernel/contracts/index.js";

export const MIGRATIONS = [
  `
  CREATE TABLE bridges_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    destination TEXT NOT NULL,
    status TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX bridges_items_source ON bridges_items (source);
  CREATE INDEX bridges_items_destination ON bridges_items (destination);
  CREATE TABLE bridges_continuations (
    id TEXT PRIMARY KEY,
    from_space TEXT NOT NULL,
    to_space TEXT NOT NULL,
    title TEXT NOT NULL,
    refs TEXT NOT NULL,
    note TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];

/** The actions this module registers (lib BRIDGE_ACTIONS). */
export const ACTIONS = BRIDGE_ACTIONS;

const str = { type: "string" };
const strs = { type: "array", items: { type: "string" } };
/** The callers a person-facing bridges tool may be reached by: the person's own surfaces and devices, and sessions (a model session is the person's only through its assistant claim, which personOf checks). Not guests, hooks or modules. */
const BRIDGE_CALLERS = Object.freeze(["cli", "local", "deck", "capsule", "mobile", "tailnet", "mcp", "harness"]);
const PERSON = { type: "string", minLength: 1, maxLength: 128 };
const NO_RECORDS = "records are not installed in that space";
const NOT_FOUND = "no such share";
const HOLD_TYPES = new Set(["bridge_offer", "bridge_acceptance"]);

/** @param {string} message @param {string} code @param {any} [detail] */
const refuse = (message, code, detail) => Object.assign(new Error(message), { code, ...(detail && typeof detail === "object" ? { detail } : {}) });

/** A BridgeError becomes a tool error with the same code; an Ask that is not answered is `held`. */
const asToolError = e => {
  if (e instanceof BridgeError || e?.name === "BridgeError") {
    if (e.code === "not_accepted" && e.details?.action) return refuse(`${e.details.action} is held for a person to approve`, "held", { action: e.details.action });
    return refuse(e.message, e.code, e.details);
  }
  return e;
};

/** What a presence method proves, in the contract's words. Only a hardware key counts for a bridge. */
const SIGNER_OF = { touchid: "secure_enclave", passkey: "webauthn_platform" };
const proofFrom = (meta, hash, now) => {
  const method = meta && meta.presence && meta.presence.method;
  if (!method) return null;
  const signer = PRESENCE_SIGNERS.includes(method) ? method : SIGNER_OF[method] || "none";
  return { signer, expires_at: now + 60_000, payload_hash: hash };
};

/** The shape of a share a Space's member may see: ids, names and counts, never values or the salt. */
const shape = b => b && ({
  id: b.id, kind: b.kind, source: b.source, destination: b.destination, status: b.status, created_at: b.created_at, expires_at: b.expires_at,
  max_red: b.max_red, ...(b.accepted_at ? { accepted_at: b.accepted_at } : {}), ...(b.revoked_at ? { revoked_at: b.revoked_at } : {}),
  spec: { ...(b.spec.type ? { type: b.spec.type } : {}), ...(b.spec.types ? { types: b.spec.types } : {}), ...(b.spec.fields ? { fields: b.spec.fields } : {}), ...(b.spec.label_fields ? { label_fields: b.spec.label_fields } : {}) },
});

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const now = () => Date.now();

    // ---------------------------------------------------------------- the store behind the lib's bridge interface
    const store = {
      async get(id) { const r = /** @type {any} */ (db.prepare("SELECT body FROM bridges_items WHERE id = ?").get(String(id))); return r ? JSON.parse(r.body) : null; },
      async put(b) {
        db.prepare(`INSERT INTO bridges_items (id, kind, source, destination, status, expires_at, body) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, expires_at = excluded.expires_at, body = excluded.body`)
          .run(b.id, b.kind, b.source, b.destination, b.status, b.expires_at, JSON.stringify(b));
        return b;
      },
      async list() { return /** @type {any[]} */ (db.prepare("SELECT body FROM bridges_items ORDER BY rowid").all()).map(r => JSON.parse(r.body)); },
    };

    // ---------------------------------------------------------------- calls into other modules, all tolerant
    const call = async (tool, input) => { try { return await ctx.call(tool, input); } catch (e) { return { error: { code: "failed", message: String(e && e.message) } }; } };
    const missing = r => !r || (r.error && ["no_such_tool", "not_available", "not_declared"].includes(r.error.code));
    const value = r => (r && !r.error ? r.data : null);

    const membership = async (space, person) => {
      const r = await call("spaces.membership", { space, person });
      const d = value(r);
      const m = d && typeof d === "object" && "membership" in d ? d.membership : d;
      return m || null;
    };
    const liveMember = async (space, person) => { const m = await membership(space, person); return m && !isExpired(m, now()) ? m : null; };
    const policyOf = async space => { const d = value(await call("spaces.policy", { space })); return d && typeof d === "object" ? (d.policy && typeof d.policy === "object" ? d.policy : d) : {}; };

    const base = createRoleAuthorize({ membership, now, policy: policyOf });
    /** The kernel's shape of authorize, from the role bundles. The record reads and writes the lib asks for are a member's own business. */
    const authorize = async (chain, action, resource) => {
      const hops = chain && Array.isArray(chain.hops) ? chain.hops : [];
      let out;
      if (action === "records.read" || action === "records.create") {
        const p = hops.find(h => h.actor && h.actor.kind === "person");
        if (!p) return { effect: "deny", reason: "chain_not_person" };
        if (!(await liveMember(String(chain.space), p.actor.id))) return { effect: "deny", reason: "not_a_member" };
        out = action === "records.create" && !hops.every(h => h.actor && (h.actor.kind === "person" || h.actor.kind === "device"))
          ? { effect: "ask", reason: "needs_approval" } : { effect: "allow", reason: "ok" };
      } else out = await base({ chain, action, resource });
      // The lib's authz holds only some outward acts for a model (tasks.continue is a write there); the declared risk of each bridge act decides here.
      const risk = (BRIDGE_ACTIONS.find(a => a.action === action) || {}).risk;
      if (out.effect === "allow" && risk && (risk === "grant" || risk.startsWith("outward.")) && !hops.every(h => h.actor && (h.actor.kind === "person" || h.actor.kind === "device"))) out = { ...out, effect: "ask", reason: "needs_approval" };
      // The person's own tool call is the answer to the Ask for a chain of exactly one person; a model's is held.
      if (out.effect === "ask" && chainIsExactlyOnePerson(chain)) return { ...out, effect: "allow" };
      return out;
    };

    // ---------------------------------------------------------------- records: each Space is read through its own tools
    const records = space => {
      const need = async (tool, input, soft) => {
        const r = await call(tool, { space, ...input });
        if (missing(r)) { if (soft) return { soft: true }; throw new BridgeError("not_found", NO_RECORDS); }
        if (r.error) throw refuse(r.error.message, r.error.code);
        return r.data;
      };
      return {
        async read(type, id) { const d = await need("records.read", { type, id }); return d && "record" in d ? d.record : d; },
        async query(type, spec) { return (await need("records.query", { type, spec })) || { rows: [] }; },
        async create(type, id, data, meta) {
          const d = await need("records.create", { type, id, data, meta }, HOLD_TYPES.has(type));
          return d && d.soft ? { id, type, data } : d && "record" in d ? d.record : d;
        },
        async define(diff) { return need("records.define", { diff }); },
      };
    };
    const schema = async (space, type) => { const d = value(await call("records.schema", { space, type })); return d && (d.schema || d) && Object.keys(d.schema || d).length ? d.schema || d : null; };

    const task = {
      async request(chain, t) {
        const r = await call("tasks.create", { space: chain.space, ...t });
        if (missing(r)) {
          const id = `pending_${canonicalHash({ at: now(), t }).slice(0, 12)}`;
          const note = "Tasks are not installed here, so this hand-off is saved as a pending continuation. It becomes a task when tasks are installed.";
          db.prepare("INSERT INTO bridges_continuations (id, from_space, to_space, title, refs, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)")
            .run(id, t.inputs[0] ? String(t.inputs[0]).split("/")[2] : "", chain.space, t.title, JSON.stringify(t.inputs), note, `${t.doer.kind}:${t.doer.id}`, now());
          return { id, pending: true, note };
        }
        if (r.error) throw refuse(r.error.message, r.error.code);
        return r.data && r.data.task ? r.data.task : r.data;
      },
    };

    /** Both Spaces' logs: one event, the Space it belongs to named in the payload. Ids, counts and field names only. */
    const emit = async (space, type, payload) => { ctx.events.emit(type, { ...payload, space }); };

    /** The hops after the person in the call's own chain (an assistant's session adds its agent hop), set by personOf for the call's meta object. @type {WeakMap<object, {kind: string, id: string}[]>} */
    const extras = new WeakMap();
    const chainFor = (space, person, meta) => personChain({ space, person, extra: (meta && typeof meta === "object" && extras.get(meta)) || [] });

    const deps = {
      authorize, emit, now, bridges: store, records, schema, task,
      policy: policyOf,
      ask: async (space, card) => { const r = await call("spaces.ask", { space, card }); return value(r) && value(r).id || card.bridge; },
      installedState: async space => value(await call("records.state", { space })) || {},
      destinationChain: async (chain, space) => {
        const p = chain.hops[0].actor.id;
        if (!(await liveMember(space, p))) throw new BridgeError("forbidden", "you are not a member of that Space");
        return personChain({ space, person: p, extra: chain.hops.slice(1).map(h => ({ kind: h.actor.kind, id: h.actor.id })) });
      },
    };

    /**
     * The person a call is for comes from the call's own kernel chain and from nothing else (BR-1, BR-2): `ctx.kernel.chain(meta)` is a session token's chain (the person and
     * their assistant) or the person's own chain built from the facts the daemon proved about the connection (a person's surface on the socket, a paired app device). A label never
     * counts. No chain, a module's own service chain, a viewer chain or a chain whose first hop is not a person is a refusal. The kernel's person is mapped to this device's
     * identity by the spaces module (spaces.self), only for the home's own person. An `input.person` is accepted only when it is that same person: naming another is a refusal.
     */
    const personOf = async (i, meta) => {
      let chain = null;
      try { chain = ctx.kernel && typeof ctx.kernel.chain === "function" ? await ctx.kernel.chain(meta || {}) : null; } catch { chain = null; }
      const first = chain && Array.isArray(chain.hops) && chain.hops[0] ? chain.hops[0] : null;
      if (!first || !first.actor || first.actor.kind !== "person" || chain.viewer === true) throw new BridgeError("forbidden", "only a person, or their own assistant, can do that");
      const r = await call("spaces.self", { person: String(first.actor.id) });
      const who = value(r) && value(r).person;
      if (typeof who !== "string" || !who) throw new BridgeError("forbidden", "only a person, or their own assistant, can do that");
      if (i && i.person !== undefined && String(i.person) !== who) throw new BridgeError("bad_input", "that is not you");
      if (meta && typeof meta === "object") extras.set(meta, chain.hops.slice(1).map((/** @type {any} */ h) => ({ kind: String(h.actor.kind), id: String(h.actor.id) })));
      return who;
    };
    const guard = fn => async (i, meta = {}) => { try { return await fn(i, meta); } catch (e) { throw asToolError(e); } };
    const party = (b, space) => b && (b.source === space || b.destination === space);
    /** A share this person may see: they belong to one of its Spaces. Otherwise it does not exist for them. */
    const visible = async (id, person, space) => {
      const b = await store.get(id);
      if (!b) return null;
      const spaces = space ? [space] : [b.source, b.destination];
      for (const s of spaces) if (party(b, s) && await liveMember(s, person)) return { b, space: s };
      return null;
    };
    const must = async (id, person, space) => { const v = await visible(id, person, space); if (!v) throw new BridgeError("not_found", NOT_FOUND); return v; };

    const proposeInput = { person: PERSON, source: str, destination: str, expires_at: { type: "number" }, max_red: str, owner_confirmed: { type: "boolean" } };
    const proposer = (kind, fn) => async (i, meta) => {
      const input = { ...i, chain: chainFor(i.source, (await personOf(i, meta)), meta) };
      input.presence = proofFrom(meta, proposalHash(kind, input), now());
      return shape(await fn(input, deps));
    };
    const summaryOf = kind => ({ summary: i => `Share ${kind === "view" ? "a view" : kind === "reference" ? "references" : "events"} from ${i && i.source} with ${i && i.destination}` });

    ctx.tool("bridges.propose-view", {
      description: "Offer another Space a live, read-only view: a record type, a filter, a sort and the fields that may cross (default deny). Nothing flows until the other Space accepts. Needs you in person.",
      input: { type: "object", required: ["source", "destination", "expires_at", "type", "fields"], properties: { ...proposeInput, type: str, fields: strs, filter: { type: "object" }, sort: { type: "array" }, sealed_placeholder: { type: "boolean" }, destination_cache: { type: "boolean" } } },
      presence: summaryOf("view"),
      run: guard(proposer("view", proposeView)),
    });
    ctx.tool("bridges.propose-reference", {
      description: "Let another Space show the names of chosen record types here. A reference is an address, not access. Needs you in person.",
      input: { type: "object", required: ["source", "destination", "expires_at", "types"], properties: { ...proposeInput, types: strs, label_fields: strs, cache_label: { type: "boolean" } } },
      presence: summaryOf("reference"),
      run: guard(proposer("reference", proposeReference)),
    });
    ctx.tool("bridges.propose-projection", {
      description: "Send chosen fields of chosen events to another Space. The other Space accepts first; everything it receives is marked external. Needs you in person.",
      input: { type: "object", required: ["source", "destination", "expires_at", "types", "fields"], properties: { ...proposeInput, types: strs, fields: strs, subject_prefix: str, free_text_confirmed: { type: "boolean" } } },
      presence: summaryOf("projection"),
      run: guard(proposer("projection", proposeProjection)),
    });

    ctx.tool("bridges.accept", {
      description: "Accept what another Space offered to share with yours. Until you do, nothing flows.",
      input: { type: "object", required: ["bridge"], properties: { person: PERSON, bridge: str } },
      run: guard(async (i, meta) => {
        const person = (await personOf(i, meta));
        const b = await store.get(i.bridge);
        if (!b || !(await liveMember(b.destination, person))) throw new BridgeError("not_found", NOT_FOUND);
        return shape(await acceptBridge({ chain: chainFor(b.destination, person, meta), bridgeId: i.bridge }, deps));
      }),
    });

    ctx.tool("bridges.revoke", {
      description: "Stop a share at once, from either side. Devices drop what they cached for it.",
      input: { type: "object", required: ["bridge"], properties: { person: PERSON, bridge: str, space: str, reason: str } },
      run: guard(async (i, meta) => {
        const person = (await personOf(i, meta));
        const { b, space } = await must(i.bridge, person, i.space);
        const was = b.status;
        const out = await revokeBridge({ chain: chainFor(space, person, meta), bridgeId: i.bridge, reason: i.reason }, deps);
        if (was !== "revoked") for (const s of [out.source, out.destination]) await emit(s, "bridge.revoked", { bridge: out.id, kind: out.kind, source: out.source, destination: out.destination, by_space: space, at: now() });
        return shape(out);
      }),
    });

    const spacesOf = async (person, candidates) => {
      const d = value(await call("spaces.merge-list", { person }));
      const rows = Array.isArray(d) ? d : d && Array.isArray(d.spaces) ? d.spaces : null;
      if (rows) return rows.map(r => ({ space: String(r.space ?? r.id), name: r.name ?? String(r.space ?? r.id), color: r.color ?? null, link: r.link ?? r.url ?? null }));
      return (candidates || []).map(s => ({ space: s, name: s, color: null, link: null }));
    };

    ctx.tool("bridges.list", {
      description: "The shares a Space is part of, on both sides: the ones it offered and the ones offered to it.",
      input: { type: "object", required: [], properties: { person: PERSON, space: str } },
      run: guard(async (i, meta) => {
        const person = (await personOf(i, meta));
        let spaces;
        if (i.space) { if (!(await liveMember(i.space, person))) throw new BridgeError("not_found", "no such space"); spaces = [i.space]; }
        else spaces = (await spacesOf(person)).map(s => s.space);
        const mine = [];
        for (const s of spaces) if (await liveMember(s, person)) mine.push(s);
        return (await store.list()).filter(b => mine.some(s => party(b, s))).map(b => ({ ...shape(b), side: mine.includes(b.source) ? (mine.includes(b.destination) ? "both" : "source") : "destination" }));
      }),
    });

    ctx.tool("bridges.get", {
      description: "One share a Space is part of.",
      input: { type: "object", required: ["bridge"], properties: { person: PERSON, bridge: str, space: str } },
      run: guard(async (i, meta) => shape((await must(i.bridge, (await personOf(i, meta)), i.space)).b)),
    });

    ctx.tool("bridges.view.read", {
      callers: BRIDGE_CALLERS,
      description: "Read a shared view live and read-only through its source Space. Returns only the fields the share lists, marked external.",
      input: { type: "object", required: ["share"], properties: { person: PERSON, share: str, space: str, filter: { type: "object" }, sort: { type: "array" }, limit: { type: "number" }, cursor: str } },
      run: guard(async (i, meta) => {
        const person = (await personOf(i, meta));
        const b = await store.get(i.share);
        const space = b && b.kind === "view" ? b.destination : null;
        if (!space || (i.space && i.space !== space) || !(await liveMember(space, person))) throw new BridgeError("not_found", NOT_FOUND);
        return readView(i.share, { chain: chainFor(space, person, meta), filter: i.filter, sort: i.sort, limit: i.limit, cursor: i.cursor }, deps);
      }),
    });

    ctx.tool("bridges.resolve", {
      callers: BRIDGE_CALLERS,
      description: "Look up the name behind a vyre:// reference to another Space. Unreadable and missing references answer alike.",
      input: { type: "object", required: ["space", "urn"], properties: { person: PERSON, space: str, urn: str } },
      run: guard(async (i, meta) => resolveReference(i.urn, { chain: chainFor(i.space, (await personOf(i, meta)), meta) }, deps)),
    });

    ctx.tool("bridges.copy", {
      callers: BRIDGE_CALLERS,
      description: "Copy a record into another Space you belong to. Sealed fields arrive empty unless you copy_sealed in person; a model's copy is held for approval.",
      input: { type: "object", required: ["urn", "toSpace"], properties: { person: PERSON, urn: str, toSpace: str, destType: str, copy_sealed: { ...strs, description: "sealed fields to copy; only a person, in person" } } },
      presence: { when: i => Boolean(i && Array.isArray(i.copy_sealed) && i.copy_sealed.length), summary: i => `Copy sealed values (${i && i.copy_sealed ? i.copy_sealed.join(", ") : ""}) into another Space` },
      run: guard(async (i, meta) => {
        const person = (await personOf(i, meta));
        const m = /^vyre:\/\/([^/?#\s]+)\//.exec(i.urn);
        const from = m ? m[1] : "";
        const sealed = (i.copy_sealed || []).filter(Boolean);
        const hash = canonicalHash({ act: "copy.sealed", urn: i.urn, destination: i.toSpace, fields: [...sealed].sort() });
        return copyRecord({ sourceChain: chainFor(from, person, meta), destChain: chainFor(i.toSpace, person, meta), urn: i.urn, destType: i.destType, copy_sealed: sealed, presence: sealed.length ? proofFrom(meta, hash, now()) : undefined }, deps);
      }),
    });

    ctx.tool("bridges.project", {
      description: "Deliver one event through a projection: only the allowed fields cross, the origin's ids and ordering do not. For the projection consumer, never a person or a model.",
      input: { type: "object", required: ["projection", "event"], properties: { projection: str, event: { type: "object" } } },
      run: guard(async i => projectEvent({ projectionId: i.projection, event: i.event }, deps)),
    });

    ctx.tool("bridges.kit.export", {
      description: "Package definitions (types, fields, stages, Flows, views, role templates) as a Kit. Refuses anything that looks like records, ids, references or sealed values.",
      input: { type: "object", required: ["definitions"], properties: { definitions: { type: "object" } } },
      run: guard(async i => kitExport(i.definitions)),
    });
    ctx.tool("bridges.kit.plan", {
      description: "List everything installing a Kit would add to a Space. Nothing is applied.",
      input: { type: "object", required: ["space", "kit"], properties: { person: PERSON, space: str, kit: { type: "object" } } },
      run: guard(async (i, meta) => {
        if (!(await liveMember(i.space, (await personOf(i, meta))))) throw new BridgeError("not_found", "no such space");
        return kitInstallPlan(i.kit, await deps.installedState(i.space));
      }),
    });
    ctx.tool("bridges.kit.install", {
      description: "Install a Kit into a Space after the person approved exactly this plan (its plan_hash). Adds definitions only.",
      input: { type: "object", required: ["space", "kit", "approved_plan_hash"], properties: { person: PERSON, space: str, kit: { type: "object" }, approved_plan_hash: str } },
      run: guard(async (i, meta) => installKit({ chain: chainFor(i.space, (await personOf(i, meta)), meta), kit: i.kit, approved_plan_hash: i.approved_plan_hash }, deps)),
    });

    ctx.tool("bridges.continue", {
      callers: BRIDGE_CALLERS,
      description: "Hand work over to another Space as a task that points back at records here by reference. A model's hand-off is held for approval.",
      input: { type: "object", required: ["fromSpace", "toSpace", "summaryRefs"], properties: { person: PERSON, fromSpace: str, toSpace: str, summaryRefs: strs, title: str } },
      run: guard(async (i, meta) => continueIn({ fromSpace: i.fromSpace, toSpace: i.toSpace, by: chainFor(i.fromSpace, (await personOf(i, meta)), meta), summaryRefs: i.summaryRefs, title: i.title }, deps)),
    });

    ctx.tool("bridges.session.policy", {
      description: "The rules of a session whose context draws on these Spaces: drafts only for writes, an Ask that names every Space, labels from all sources, the strictest residency.",
      input: { type: "object", required: ["person", "spaces"], properties: { person: PERSON, spaces: { type: "array", items: str, minItems: 1 } } },
      run: guard(async i => {
        const entries = [];
        for (const s of i.spaces) {
          if (!(await liveMember(s, i.person))) throw new BridgeError("not_found", "no such space");
          entries.push({ space: s, residency: await policyOf(s) });
        }
        return sessionPolicy(entries);
      }),
    });

    ctx.tool("bridges.merge.links", {
      description: "For a device that merges Spaces itself: one entry per Space the person belongs to, { space, name, color, link }. The device reads each link through that Space's own gateway and merges on the device; no server joins data across Spaces.",
      input: { type: "object", required: [], properties: { person: PERSON, spaces: strs } },
      run: guard(async (i, meta) => {
        const person = (await personOf(i, meta));
        const out = [];
        for (const s of await spacesOf(person, i.spaces)) {
          if (!(await liveMember(s.space, person))) continue;
          out.push({ space: s.space, name: s.name, color: s.color, link: s.link || `https://${s.space}.vyre.run` });
        }
        return out;
      }),
    });

    return { async stop() {} };
  },
};
