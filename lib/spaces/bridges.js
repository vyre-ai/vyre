// @ts-check
// Bridges between Spaces (contract 10, R4-14 to R4-16, R5-9 to R5-12). Pure library: everything impure is
// injected through `deps`. One shared lifecycle for every bridge act: a grant at the SOURCE naming what may cross,
// the DESTINATION's acceptance (a record plus an Ask card there), arrival labelled `external`, sealed fields
// excluded by default, an event in BOTH logs, expiry and instant revocation.
//
// deps (every member optional unless a function says otherwise):
//   authorize(chain, action, resource) -> { effect, reason } | boolean        (kernel authorize)
//   emit(spaceId, type, payload)                                              (event log of one Space)
//   now() -> ms                          newId(prefix) -> string              (clock and ids)
//   records(spaceId) -> { read(type,id), query(type,spec), create(type,id,data,meta), define?(diff) }
//   schema(spaceId, type) -> { fields: { [name]: { red, kind, sealed, free_text } } }
//   policy(spaceId) -> residency policy { inference: 'space_only'|'any'|string[], secrets }
//   bridges: bridge store { get(id), put(b), list() }   (see createMemoryBridgeStore)
//   ask(spaceId, card) -> card id                                             (Ask card in the destination)
//   task: { request(chain, task) }       destinationChain(chain, space)       (continue in another space)
//   vault: { copySealed(...) }           validateInbound(space, rows)         limits { max_rows, max_bytes }
//   refCache: see createRefCache         verifyPresence(proof, hash)

import { createHash, randomUUID } from "node:crypto";
import { REDACTION_ORDER, PRESENCE_SIGNERS, TASK_SOURCES, TRUST_ORDER, RISKS } from "../../kernel/contracts/index.js";

/** @typedef {"not_accepted"|"expired"|"revoked"|"forbidden"|"sealed"|"wrong_space"|"needs_presence"|"bad_input"|"not_found"} BridgeCode */

export const BRIDGE_CODES = Object.freeze(["not_accepted", "expired", "revoked", "forbidden", "sealed", "wrong_space", "needs_presence", "bad_input", "not_found"]);

export class BridgeError extends Error {
  /** @param {BridgeCode} code @param {string} message @param {any} [details] */
  constructor(code, message, details) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
const fail = (/** @type {BridgeCode} */ code, /** @type {string} */ msg, details) => new BridgeError(code, msg, details);

/** The closed list of bridge acts (SPEC 10.7) and the actions they authorize. Declared once, risk outward.share unless it reads. */
export const BRIDGE_KINDS = Object.freeze(["reference", "view", "copy", "projection", "kit", "session"]);
export const BRIDGE_ACTIONS = Object.freeze([
  { action: "references.share", resource_type: "bridge", risk: "outward.share", label: "let another Space resolve references", gloss: "Let another Space show the names of chosen records here, nothing more." },
  { action: "references.resolve", resource_type: "record", risk: "read", label: "resolve a reference", gloss: "Look up the name of a record that another Space shared." },
  { action: "views.share", resource_type: "bridge", risk: "outward.share", label: "share a view", gloss: "Let another Space read chosen fields of chosen records, live and read-only." },
  { action: "views.read", resource_type: "bridge", risk: "read", label: "read a shared view", gloss: "Read a view another Space shared with this one." },
  { action: "records.copy", resource_type: "record", risk: "outward.share", label: "copy a record to another Space", gloss: "Make a copy of a record in another Space you belong to." },
  { action: "copy.sealed", resource_type: "record", risk: "outward.share", label: "copy sealed values", gloss: "Copy sealed fields too. Needs you in person." },
  { action: "events.project", resource_type: "bridge", risk: "outward.share", label: "project events to another Space", gloss: "Send chosen fields of chosen events to another Space." },
  { action: "kits.install", resource_type: "kit", risk: "grant", label: "install a Kit", gloss: "Add the types, fields, stages and Flows of a Kit." },
  { action: "tasks.continue", resource_type: "task", risk: "outward.share", label: "continue in another Space", gloss: "Hand work to another Space as a task that points back here." },
  { action: "bridges.accept", resource_type: "bridge", risk: "grant", label: "accept a share", gloss: "Accept what another Space wants to share with this one." },
  { action: "bridges.revoke", resource_type: "bridge", risk: "grant", label: "stop a share", gloss: "Stop a share at once." },
]);

const KIND_ACTION = { reference: "references.share", view: "views.share", projection: "events.project" };
const DAY = 86_400_000;

// ---------------------------------------------------------------- small helpers

const stableStringify = (/** @type {any} */ v) => {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
};
const sha = (/** @type {string} */ s) => createHash("sha256").update(s).digest();
const b64u = (/** @type {Buffer} */ b) => b.toString("base64url");
export const canonicalHash = (/** @type {any} */ v) => b64u(sha(stableStringify(v)));

const redIdx = (/** @type {string} */ r) => REDACTION_ORDER.indexOf(/** @type {any} */ (r));
const isStr = (/** @type {any} */ v) => typeof v === "string" && v.length > 0;
const nowOf = (/** @type {any} */ deps) => (typeof deps?.now === "function" ? deps.now() : Date.now());
const idOf = (/** @type {any} */ deps, /** @type {string} */ prefix) => (typeof deps?.newId === "function" ? deps.newId(prefix) : `${prefix}_${randomUUID()}`);

function need(/** @type {any} */ deps, /** @type {string} */ name) {
  const v = deps?.[name];
  if (v === undefined || v === null) throw fail("bad_input", `missing dependency: ${name}`);
  return v;
}
const recordsOf = (/** @type {any} */ deps, /** @type {string} */ space) => {
  const r = need(deps, "records")(space);
  if (!r) throw fail("bad_input", `no record reader for ${space}`);
  return r;
};

/** The last hop as `<kind>:<id>@<space>`. */
export function actorString(/** @type {any} */ chain) {
  const hops = chain?.hops;
  if (!Array.isArray(hops) || hops.length === 0) throw fail("bad_input", "chain has no hops");
  const a = hops[hops.length - 1].actor;
  return `${a.kind}:${a.id}@${a.space}`;
}
/** True only for a chain of exactly one hop and that hop is a person (a model anywhere in the chain makes this false). */
export const chainIsExactlyOnePerson = (/** @type {any} */ chain) => Array.isArray(chain?.hops) && chain.hops.length === 1 && chain.hops[0]?.actor?.kind === "person";
function chainIn(/** @type {any} */ chain, /** @type {string} */ space, what = "act") {
  if (!chain || !Array.isArray(chain.hops)) throw fail("bad_input", "a chain is required");
  if (chain.space !== space) throw fail("wrong_space", `${what} must be made in ${space}`);
}

const REASON_CODE = { expired: "expired", revoked: "revoked", wrong_space: "wrong_space", needs_presence: "needs_presence", sealed: "sealed", not_found: "not_found", bad_input: "bad_input", chain_not_person: "forbidden" };
/** Run authorize. allow passes; ask means the Ask card is not answered yet (not_accepted); deny maps its reason. */
async function authz(/** @type {any} */ deps, /** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ resource) {
  const fn = need(deps, "authorize");
  const out = await fn(chain, action, resource);
  const effect = out === true ? "allow" : out === false ? "deny" : out?.effect;
  if (effect === "allow") return out;
  if (effect === "ask") throw fail("not_accepted", `${action} needs an answer to its Ask card`, { action });
  const reason = typeof out === "object" ? out?.reason : undefined;
  // @ts-ignore
  throw fail(REASON_CODE[reason] ?? "forbidden", `${action} was refused`, { action, reason });
}

/** Both logs get the event. Payloads carry ids, counts and field names, never record values. */
async function emitBoth(/** @type {any} */ deps, /** @type {any} */ b, /** @type {string} */ type, /** @type {any} */ extra = {}) {
  const emit = need(deps, "emit");
  const base = { bridge: b.id, kind: b.kind, source: b.source, destination: b.destination, at: nowOf(deps), ...extra };
  await emit(b.source, type, { ...base, side: "source" });
  await emit(b.destination, type, { ...base, side: "destination" });
}

// ---------------------------------------------------------------- references: URN

const SPACE_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const TYPE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Strict parse of `vyre://<space>/<type>/<id>`. No path, no query, no uppercase space or type. */
export function parseUrn(/** @type {any} */ urn) {
  if (typeof urn !== "string") throw fail("bad_input", "a URN is a string");
  const m = /^vyre:\/\/([^/?#\s]+)\/([^/?#\s]+)\/([^/?#\s]+)$/.exec(urn);
  if (!m || !SPACE_RE.test(m[1]) || !TYPE_RE.test(m[2]) || !ID_RE.test(m[3])) throw fail("bad_input", "not a valid vyre:// reference");
  return { space: m[1], type: m[2], id: m[3] };
}
export function formatUrn(/** @type {{space:string,type:string,id:string}} */ p) {
  if (!p || !SPACE_RE.test(p.space ?? "") || !TYPE_RE.test(p.type ?? "") || !ID_RE.test(p.id ?? "")) throw fail("bad_input", "cannot format a reference from these parts");
  return `vyre://${p.space}/${p.type}/${p.id}`;
}

// ---------------------------------------------------------------- residency

/** @typedef {{inference:"space_only"|"any"|string[], secrets:"space_only"|"any"|string[]}} Residency */
/** A missing policy fails closed (`space_only`): only an explicit `any` opens a Space to providers. */
export function normalizeResidency(/** @type {any} */ p) {
  const one = (/** @type {any} */ v) => (v === "any" ? "any" : Array.isArray(v) ? [...new Set(v.filter(isStr))].sort() : "space_only");
  return /** @type {Residency} */ ({ inference: one(p?.inference), secrets: one(p?.secrets) });
}
const strictestOne = (/** @type {any[]} */ vs) => {
  let acc = /** @type {any} */ ("any");
  for (const v of vs) {
    if (v === "space_only") return "space_only";
    if (v === "any") continue;
    acc = acc === "any" ? v : acc.filter((/** @type {string} */ x) => v.includes(x));
  }
  return acc;
};
/** The strictest wins: any `space_only` blocks all; lists intersect. An allow-list that intersects to empty blocks all. */
export function strictestResidency(/** @type {any[]} */ policies) {
  const ns = policies.map(normalizeResidency);
  const fix = (/** @type {any} */ v) => (Array.isArray(v) && v.length === 0 ? "space_only" : v);
  return /** @type {Residency} */ ({ inference: fix(strictestOne(ns.map(n => n.inference))), secrets: fix(strictestOne(ns.map(n => n.secrets))) });
}
/** The destination's inference door asks this for a provider; `space_only` refuses every model. */
export function inferenceAllowed(/** @type {any} */ residency, /** @type {string} */ provider) {
  const inf = normalizeResidency(residency).inference;
  return inf === "any" ? true : Array.isArray(inf) ? inf.includes(provider) : false;
}

// ---------------------------------------------------------------- field classification

const isSealedValue = (/** @type {any} */ v) => !!v && typeof v === "object" && !Array.isArray(v) && typeof v.sealed === "string";
async function schemaOf(/** @type {any} */ deps, /** @type {string} */ space, /** @type {string} */ type) {
  return typeof deps?.schema === "function" ? (await deps.schema(space, type)) ?? null : null;
}
/** Class, sealed and free-text status of one field. Unknown fields default to `pii`: conservative. */
function fieldMeta(/** @type {any} */ schema, /** @type {string} */ name, /** @type {any} */ value) {
  const def = schema?.fields?.[name];
  const sealed = !!(def?.sealed || def?.kind === "sealed" || def?.seal || isSealedValue(value));
  const kind = def?.kind;
  const free_text = def?.free_text ?? (kind === "text" || kind === "rich_text");
  const red = sealed ? "privileged" : REDACTION_ORDER.includes(def?.red) ? def.red : "pii";
  return { sealed, red, free_text: !!free_text, known: !!def };
}
const placeholderOf = (/** @type {any} */ v) => ({ sealed: String(v?.sealed ?? "free"), present: v?.present !== false && v != null, valid_format: v?.valid_format !== false });

// ---------------------------------------------------------------- presence

/** The payload a presence proof must be bound to when proposing a bridge. */
export function proposalHash(/** @type {string} */ kind, /** @type {any} */ input) {
  const n = normalizeProposal(kind, input);
  return canonicalHash({ kind, source: input.source, destination: input.destination, spec: n.spec, max_red: n.max_red, expires_at: input.expires_at });
}
async function checkPresence(/** @type {any} */ deps, /** @type {any} */ chain, /** @type {any} */ proof, /** @type {string} */ hash) {
  if (!chainIsExactlyOnePerson(chain)) throw fail("forbidden", "this act needs a chain of exactly one person");
  if (!proof || typeof proof !== "object") throw fail("needs_presence", "this act needs the person in presence");
  if (!PRESENCE_SIGNERS.includes(proof.signer)) throw fail("needs_presence", "presence must be signed by a hardware key");
  if (!(proof.expires_at > nowOf(deps))) throw fail("needs_presence", "presence proof has expired");
  if (proof.payload_hash !== hash) throw fail("needs_presence", "presence proof is for a different payload");
  if (typeof deps?.verifyPresence === "function" && !(await deps.verifyPresence(proof, hash))) throw fail("needs_presence", "presence proof did not verify");
}

// ---------------------------------------------------------------- the shared lifecycle

/** In-memory bridge store for tests and single-process use. The kernel supplies a durable one. */
export function createMemoryBridgeStore() {
  const m = new Map();
  return {
    async get(/** @type {string} */ id) { const v = m.get(id); return v ? structuredClone(v) : null; },
    async put(/** @type {any} */ b) { m.set(b.id, structuredClone(b)); return b; },
    async list() { return [...m.values()].map(v => structuredClone(v)); },
  };
}

function normalizeProposal(/** @type {string} */ kind, /** @type {any} */ input) {
  const strs = (/** @type {any} */ a, /** @type {string} */ what) => {
    if (!Array.isArray(a) || a.length === 0 || !a.every(isStr)) throw fail("bad_input", `${what} must be a non-empty list of names (default deny)`);
    return [...new Set(/** @type {string[]} */ (a))].sort();
  };
  const max_red = input.max_red ?? "public";
  if (!REDACTION_ORDER.includes(max_red)) throw fail("bad_input", "unknown redaction class");
  if (redIdx(max_red) >= redIdx("privileged")) throw fail("bad_input", "privileged and secret content never cross");
  if (redIdx(max_red) > redIdx("internal") && input.owner_confirmed !== true) throw fail("forbidden", "a class above internal needs the owner's confirmation");
  let spec;
  if (kind === "view") {
    if (!isStr(input.type)) throw fail("bad_input", "a view names a record type");
    spec = {
      type: input.type, filter: input.filter ?? null, sort: input.sort ?? null, fields: strs(input.fields, "the field allow-list"),
      sealed_placeholder: input.sealed_placeholder === true, destination_cache: input.destination_cache === true,
    };
    if (spec.sealed_placeholder && input.owner_confirmed !== true) throw fail("forbidden", "a sealed placeholder needs the owner's confirmation");
  } else if (kind === "reference") {
    spec = { types: strs(input.types, "the allowed types"), label_fields: Array.isArray(input.label_fields) ? [...new Set(/** @type {string[]} */ (input.label_fields.filter(isStr)))].sort() : [], cache_label: input.cache_label === true };
  } else if (kind === "projection") {
    spec = { types: strs(input.types, "the event types"), subject_prefix: isStr(input.subject_prefix) ? input.subject_prefix : null, fields: strs(input.fields, "the field allow-list"), free_text_confirmed: input.free_text_confirmed === true };
    if (spec.free_text_confirmed && input.owner_confirmed !== true) throw fail("forbidden", "free text crosses only with the owner's confirmation");
  } else throw fail("bad_input", `unknown bridge kind ${kind}`);
  return { spec, max_red };
}

/** Propose any lifecycle bridge (view, reference, projection). Source side: authorize plus a presence proof. */
async function propose(/** @type {string} */ kind, /** @type {any} */ input, /** @type {any} */ deps) {
  const { chain, presence, source, destination } = input ?? {};
  if (!isStr(source) || !isStr(destination) || source === destination) throw fail("bad_input", "a bridge joins two different Spaces");
  chainIn(chain, source, "a proposal");
  const now = nowOf(deps);
  if (!Number.isFinite(input.expires_at) || input.expires_at <= now) throw fail("bad_input", "a bridge needs an expiry in the future");
  const { spec, max_red } = normalizeProposal(kind, input);
  if (kind === "projection" && !spec.free_text_confirmed) {
    for (const t of spec.types) {
      const schema = await schemaOf(deps, source, t);
      for (const f of spec.fields) if (fieldMeta(schema, f, undefined).free_text && schema?.fields?.[f]) throw fail("forbidden", `field ${f} is free text and needs the owner's confirmation`);
    }
  }
  await checkPresence(deps, chain, presence, proposalHash(kind, input));
  const id = idOf(deps, "br");
  // @ts-ignore
  await authz(deps, chain, KIND_ACTION[kind], `vyre://${source}/bridge/${id}`);
  const salt = b64u(sha(`${id}:${idOf(deps, "salt")}`)).slice(0, 22);
  const b = { id, kind, source, destination, status: "proposed", created_at: now, expires_at: input.expires_at, proposed_by: actorString(chain), max_red, owner_confirmed: input.owner_confirmed === true, spec, salt, delivered: 0 };
  await need(deps, "bridges").put(b);
  // the destination's side: a record there, and an Ask card. Until it is accepted nothing flows.
  await recordsOf(deps, destination).create("bridge_offer", id, { bridge: id, kind, from: source, status: "offered", fields: spec.fields ?? spec.label_fields ?? [], types: spec.types ?? [spec.type], max_red, expires_at: b.expires_at }, { labels: { trust: "external", red: "internal", source_spaces: [source] } });
  if (typeof deps.ask === "function") await deps.ask(destination, { kind: "bridge_accept", bridge: id, bridge_kind: kind, from: source, expires_at: b.expires_at, title: `${source} wants to share with this Space`, lines: describeBridge(b) });
  await emitBoth(deps, b, `${kind}.proposed`, { by: b.proposed_by, expires_at: b.expires_at });
  return b;
}
function describeBridge(/** @type {any} */ b) {
  const s = b.spec;
  const lines = [`Kind: ${b.kind}`, `Highest class: ${b.max_red}`, `Until: ${new Date(b.expires_at).toISOString()}`];
  if (s.fields) lines.push(`Fields: ${s.fields.join(", ")}`);
  if (s.types) lines.push(`Types: ${s.types.join(", ")}`);
  if (s.type) lines.push(`Type: ${s.type}`);
  if (s.label_fields?.length) lines.push(`Labels from: ${s.label_fields.join(", ")}`);
  lines.push("What arrives is marked external and checked by this Space's own rules.");
  return lines;
}

export const proposeView = (/** @type {any} */ input, /** @type {any} */ deps) => propose("view", input, deps);
export const proposeReference = (/** @type {any} */ input, /** @type {any} */ deps) => propose("reference", input, deps);
export const proposeProjection = (/** @type {any} */ input, /** @type {any} */ deps) => propose("projection", input, deps);

async function load(/** @type {any} */ deps, /** @type {string} */ id, /** @type {string} */ kind) {
  if (!isStr(id)) throw fail("not_found", "no such share");
  const b = await need(deps, "bridges").get(id);
  if (!b || (kind && b.kind !== kind)) throw fail("not_found", "no such share");
  return b;
}
/** The live check every act runs: revoked, then expired, then not accepted. */
function assertLive(/** @type {any} */ b, /** @type {number} */ now) {
  if (b.status === "revoked") throw fail("revoked", "this share was stopped");
  if (now >= b.expires_at) throw fail("expired", "this share has expired");
  if (b.status !== "accepted") throw fail("not_accepted", "the destination has not accepted this share");
}

/** The destination accepts: a record there, an event in both logs. Until this runs nothing flows. */
export async function acceptBridge(/** @type {{chain:any, bridgeId:string}} */ input, /** @type {any} */ deps) {
  const b = await load(deps, input?.bridgeId, "");
  chainIn(input.chain, b.destination, "acceptance");
  if (b.status === "revoked") throw fail("revoked", "this share was stopped");
  if (nowOf(deps) >= b.expires_at) throw fail("expired", "this share has expired");
  if (b.status === "accepted") throw fail("bad_input", "already accepted");
  await authz(deps, input.chain, "bridges.accept", `vyre://${b.destination}/bridge/${b.id}`);
  b.status = "accepted"; b.accepted_at = nowOf(deps); b.accepted_by = actorString(input.chain);
  await need(deps, "bridges").put(b);
  await recordsOf(deps, b.destination).create("bridge_acceptance", b.id, { bridge: b.id, from: b.source, accepted_by: b.accepted_by, accepted_at: b.accepted_at }, { labels: { trust: "member", red: "internal", source_spaces: [b.destination] } });
  await emitBoth(deps, b, `${b.kind}.accepted`, { by: b.accepted_by });
  return b;
}
export const acceptView = acceptBridge;
export const acceptReference = acceptBridge;
export const acceptProjection = acceptBridge;

/** Either side stops it at once. Wipes any cached labels for the grant. Idempotent. */
export async function revokeBridge(/** @type {{chain:any, bridgeId:string, reason?:string}} */ input, /** @type {any} */ deps) {
  const b = await load(deps, input?.bridgeId, "");
  if (!input.chain || (input.chain.space !== b.source && input.chain.space !== b.destination)) throw fail("wrong_space", "only the source or the destination may stop a share");
  if (b.status === "revoked") return b;
  await authz(deps, input.chain, "bridges.revoke", `vyre://${input.chain.space}/bridge/${b.id}`);
  b.status = "revoked"; b.revoked_at = nowOf(deps); b.revoked_by = actorString(input.chain);
  await need(deps, "bridges").put(b);
  if (deps.refCache) wipeCacheFor(b.id, deps);
  await emitBoth(deps, b, `${b.kind}.revoked`, { by: b.revoked_by, reason: input.reason ?? "" });
  return b;
}
export const revokeView = revokeBridge;

// ---------------------------------------------------------------- reference resolution + label cache

/** A device-side label cache, keyed by URN, tagged with the grant that allowed it. */
export function createRefCache() {
  const m = new Map();
  return {
    put(/** @type {string} */ grantId, /** @type {string} */ urn, /** @type {any} */ entry) { m.set(urn, { grantId, urn, ...entry }); },
    get(/** @type {string} */ urn) { const e = m.get(urn); return e ? { ...e } : null; },
    wipeFor(/** @type {string} */ grantId) { let n = 0; for (const [k, v] of m) if (v.grantId === grantId) { m.delete(k); n++; } return n; },
    get size() { return m.size; },
  };
}
/** Remove every cached label that came from a grant. Returns how many entries went. */
export function wipeCacheFor(/** @type {string} */ grantId, /** @type {any} */ deps) {
  return deps?.refCache ? deps.refCache.wipeFor(grantId) : 0;
}

function unresolvedChip(/** @type {string} */ urn, /** @type {string} */ space) {
  return { resolved: false, urn, type: null, label: null, cacheable: false, grant: null, labels: { trust: "external", red: "public", source_spaces: [space] }, residency: null };
}

/**
 * Resolve a reference. Resolving is a read authorized by the owning Space. A viewer without a grant, a revoked or
 * expired grant, a type the grant does not name, and a thing that does not exist all return the SAME unresolved chip
 * (no existence oracle). Only a malformed URN throws.
 * @param {string} urn @param {{chain:any}} viewer @param {any} deps
 */
export async function resolveReference(urn, viewer, deps) {
  const p = parseUrn(urn);
  const chip = unresolvedChip(urn, p.space);
  try {
    const chain = viewer?.chain;
    if (!chain || !Array.isArray(chain.hops)) return chip;
    const same = chain.space === p.space;
    /** @type {any} */ let bridge = null;
    if (!same) {
      const now = nowOf(deps);
      const all = await need(deps, "bridges").list();
      bridge = all.find((/** @type {any} */ b) => b.kind === "reference" && b.source === p.space && b.destination === chain.space && b.status === "accepted" && now < b.expires_at && b.spec.types.includes(p.type));
      if (!bridge) return chip;
    }
    await authz(deps, chain, "references.resolve", urn);
    const rec = await recordsOf(deps, p.space).read(p.type, p.id);
    if (!rec || rec.deleted_at) return chip;
    const schema = await schemaOf(deps, p.space, p.type);
    const wanted = bridge ? bridge.spec.label_fields : ["name", "title"];
    const ceiling = bridge ? bridge.max_red : "pii";
    let label = null; let labelRed = "public";
    for (const f of wanted) {
      const v = rec.data?.[f];
      const m = fieldMeta(schema, f, v);
      if (typeof v === "string" && v && !m.sealed && redIdx(m.red) <= redIdx(ceiling)) { label = v; labelRed = m.red; break; }
    }
    const cacheable = !!bridge && bridge.spec.cache_label === true && label !== null;
    if (cacheable && deps.refCache) deps.refCache.put(bridge.id, urn, { type: p.type, label });
    const residency = normalizeResidency(typeof deps.policy === "function" ? await deps.policy(p.space) : undefined);
    const out = { resolved: true, urn, type: p.type, label, cacheable, grant: bridge ? bridge.id : null, labels: { trust: same ? "member" : "external", red: labelRed, source_spaces: [p.space] }, residency };
    if (bridge) await emitBoth(deps, bridge, "reference.resolved", { by: actorString(chain), urn_type: p.type });
    return out;
  } catch (e) {
    if (e instanceof BridgeError || e?.name === "BridgeError") return chip;
    throw e;
  }
}

// ---------------------------------------------------------------- shared views

const filterFields = (/** @type {any} */ f, /** @type {Set<string>} */ out = new Set()) => {
  if (!f || typeof f !== "object") return out;
  if (Array.isArray(f.and)) f.and.forEach((/** @type {any} */ x) => filterFields(x, out));
  else if (Array.isArray(f.or)) f.or.forEach((/** @type {any} */ x) => filterFields(x, out));
  else if (f.not) filterFields(f.not, out);
  else if (typeof f.field === "string") out.add(f.field);
  return out;
};

/** The fields that may cross for this bridge right now: allow-list, class ceiling, not sealed. */
function crossingFields(/** @type {any} */ b, /** @type {any} */ schema) {
  const allowed = []; const sealedAllowed = [];
  for (const f of b.spec.fields) {
    const m = fieldMeta(schema, f, undefined);
    if (m.sealed) { sealedAllowed.push(f); continue; }
    if (redIdx(m.red) <= redIdx(b.max_red)) allowed.push(f);
  }
  return { allowed, sealedAllowed };
}

/** Run the destination's own size and rule checks on arriving rows. Arrival is `external`. */
async function validateArrival(/** @type {any} */ deps, /** @type {string} */ space, /** @type {any[]} */ rows) {
  const limits = { max_rows: 200, max_bytes: 1_000_000, ...(deps?.limits ?? {}) };
  if (rows.length > limits.max_rows) throw fail("bad_input", "too many rows for this Space's limit");
  if (Buffer.byteLength(JSON.stringify(rows)) > limits.max_bytes) throw fail("bad_input", "arriving data is larger than this Space's limit");
  if (typeof deps?.validateInbound === "function") {
    const r = await deps.validateInbound(space, rows);
    if (r === false || (r && r.ok === false)) throw fail("bad_input", "arriving data failed this Space's rules", r?.errors);
  }
}

/**
 * Read a shared view at query time through the source's reader. The destination's chain is `query.chain`.
 * @param {string} shareId @param {{chain:any, filter?:any, sort?:any[], limit?:number, cursor?:string}} query @param {any} deps
 */
export async function readView(shareId, query, deps) {
  const b = await load(deps, shareId, "view");
  chainIn(query?.chain, b.destination, "a view read");
  assertLive(b, nowOf(deps));
  await authz(deps, query.chain, "views.read", `vyre://${b.source}/bridge/${b.id}`);
  const schema = await schemaOf(deps, b.source, b.spec.type);
  const { allowed, sealedAllowed } = crossingFields(b, schema);
  const ok = new Set(allowed);
  // the destination can narrow the view but never widen it, and cannot filter or sort by a field it may not read
  for (const f of filterFields(query.filter)) if (!ok.has(f)) throw fail("bad_input", `cannot filter by ${f}`);
  for (const s of query.sort ?? []) if (!ok.has(s?.field)) throw fail("bad_input", `cannot sort by ${s?.field}`);
  const filters = [b.spec.filter, query.filter].filter(Boolean);
  const spec = {
    filter: filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : { and: filters },
    sort: query.sort ?? b.spec.sort ?? undefined,
    page: { limit: Math.max(1, Math.min(Number.isFinite(query.limit) ? /** @type {number} */ (query.limit) : 50, 200)), cursor: query.cursor },
  };
  const page = await recordsOf(deps, b.source).query(b.spec.type, spec);
  const rows = [];
  for (const r of page.rows ?? []) {
    if (r.deleted_at) continue;
    /** @type {Record<string, any>} */ const data = {};
    for (const f of allowed) if (f in (r.data ?? {})) data[f] = r.data[f];
    if (b.spec.sealed_placeholder) for (const f of sealedAllowed) if (f in (r.data ?? {})) data[f] = placeholderOf(r.data[f]);
    rows.push({ id: r.id, urn: formatUrn({ space: b.source, type: b.spec.type, id: r.id }), version: r.version, data });
  }
  await validateArrival(deps, b.destination, rows);
  const residency = normalizeResidency(typeof deps.policy === "function" ? await deps.policy(b.source) : undefined);
  await emitBoth(deps, b, "view.read", { by: actorString(query.chain), rows: rows.length, fields: allowed });
  return {
    share: b.id, type: b.spec.type, rows, next_cursor: page.next_cursor, read_only: true, fields: allowed,
    labels: { trust: "external", red: b.max_red, source_spaces: [b.source] },
    residency, cacheable: b.spec.destination_cache === true,
  };
}

// ---------------------------------------------------------------- copy to my space

/**
 * Copy a record into another Space the same person belongs to. Its own action (`records.copy`), separate from read.
 * No live link. Sealed fields are never copied (empty plus a note) unless `copy_sealed` names them and a presence-
 * protected `copy.sealed` grant exists, which only a chain of exactly one person can use.
 * @param {{sourceChain:any, destChain:any, urn:string, destType?:string, copy_sealed?:string[], presence?:any}} input @param {any} deps
 */
export async function copyRecord(input, deps) {
  const p = parseUrn(input?.urn);
  chainIn(input.sourceChain, p.space, "a copy (source side)");
  const dest = input.destChain?.space;
  if (!isStr(dest) || dest === p.space) throw fail("wrong_space", "a copy goes to a different Space");
  chainIn(input.destChain, dest, "a copy (destination side)");
  const wantSealed = Array.isArray(input.copy_sealed) ? input.copy_sealed.filter(isStr) : [];
  if (wantSealed.length) {
    if (!chainIsExactlyOnePerson(input.sourceChain) || !chainIsExactlyOnePerson(input.destChain)) throw fail("sealed", "sealed values copy only for one person, never through a model or a service");
    await checkPresence(deps, input.sourceChain, input.presence, canonicalHash({ act: "copy.sealed", urn: input.urn, destination: dest, fields: [...wantSealed].sort() }));
  }
  // reading is checked first and a refusal looks like absence
  try { await authz(deps, input.sourceChain, "records.read", input.urn); } catch (e) { if (e instanceof BridgeError) throw fail("not_found", "no such record"); throw e; }
  const rec = await recordsOf(deps, p.space).read(p.type, p.id);
  if (!rec || rec.deleted_at) throw fail("not_found", "no such record");
  await authz(deps, input.sourceChain, "records.copy", input.urn);
  const newId = idOf(deps, "rec");
  const destType = input.destType ?? p.type;
  await authz(deps, input.destChain, "records.create", `vyre://${dest}/${destType}/${newId}`);
  if (wantSealed.length) await authz(deps, input.sourceChain, "copy.sealed", input.urn);
  const schema = await schemaOf(deps, p.space, p.type);
  /** @type {Record<string, any>} */ const data = {}; const notes = []; let red = "public";
  for (const [k, v] of Object.entries(rec.data ?? {})) {
    const m = fieldMeta(schema, k, v);
    if (m.sealed) {
      if (wantSealed.includes(k)) {
        const vault = need(deps, "vault");
        data[k] = await vault.copySealed({ urn: input.urn, field: k, destination: dest, by: actorString(input.destChain) });
        red = "privileged";
      } else { data[k] = null; notes.push({ field: k, note: "sealed value not copied" }); }
      continue;
    }
    data[k] = v;
    if (redIdx(m.red) > redIdx(red)) red = m.red;
  }
  const source_policy = normalizeResidency(typeof deps.policy === "function" ? await deps.policy(p.space) : undefined);
  const provenance = { from: input.urn, at: nowOf(deps), by: actorString(input.destChain), source_version: rec.version, source_policy };
  const meta = { provenance, notes, red, residency: source_policy, live_link: false, labels: { trust: "external", red, source_spaces: [p.space] } };
  const created = await recordsOf(deps, dest).create(destType, newId, data, meta);
  const ev = { id: `copy_${newId}`, kind: "copy", source: p.space, destination: dest };
  await emitBoth(deps, ev, "record.copied", { by: provenance.by, from: input.urn, to: formatUrn({ space: dest, type: destType, id: newId }), sealed_copied: wantSealed, sealed_skipped: notes.map(n => n.field) });
  return { id: newId, type: destType, urn: formatUrn({ space: dest, type: destType, id: newId }), record: created, provenance, notes, red, residency: source_policy, labels: meta.labels };
}

// ---------------------------------------------------------------- event projections

const scoped = (/** @type {string} */ salt, /** @type {string} */ id) => "px_" + sha(`${salt}:${id}`).toString("hex").slice(0, 24);

/**
 * The projection consumer: kernel code, its allow-list enforced here and not in any module. Returns the projected
 * item as written to the destination, or null when the event is outside the selector. Origin ids and ordering never cross.
 * @param {{projectionId:string, event:any}} input @param {any} deps
 */
export async function projectEvent(input, deps) {
  const b = await load(deps, input?.projectionId, "projection");
  const ev = input.event;
  if (!ev || ev.space !== b.source) throw fail("wrong_space", "the event is not from the projection's source Space");
  assertLive(b, nowOf(deps));
  if (!b.spec.types.includes(ev.type)) return null;
  if (b.spec.subject_prefix && !(typeof ev.subject === "string" && ev.subject.startsWith(b.spec.subject_prefix))) return null;
  const schema = await schemaOf(deps, b.source, ev.type);
  /** @type {Record<string, any>} */ const data = {}; const dropped = [];
  for (const f of b.spec.fields) {
    if (!(f in (ev.data ?? {}))) continue;
    const m = fieldMeta(schema, f, ev.data[f]);
    if (m.sealed || redIdx(m.red) > redIdx(b.max_red) || (m.free_text && !b.spec.free_text_confirmed)) { dropped.push(f); continue; }
    data[f] = ev.data[f];
  }
  let subject = null;
  try { const s = parseUrn(ev.subject); subject = formatUrn({ space: s.space, type: s.type, id: scoped(b.salt, s.id) }); } catch { subject = null; }
  b.delivered += 1;
  const id = scoped(b.salt, ev.id);
  const row = { id, type: ev.type, subject, cause: typeof ev.cause === "string" ? scoped(b.salt, ev.cause) : null, seq: b.delivered, delivered_at: nowOf(deps), data, trust: "external", source_spaces: [b.source], projection: b.id };
  await validateArrival(deps, b.destination, [row]);
  await need(deps, "bridges").put(b);
  await recordsOf(deps, b.destination).create("projected_event", id, row, { labels: { trust: "external", red: b.max_red, source_spaces: [b.source] } });
  await emitBoth(deps, b, "projection.delivered", { item: id, fields: Object.keys(data), dropped });
  return row;
}

// ---------------------------------------------------------------- kits: definitions, never data

const KIT_KEYS = new Set(["name", "label", "description", "version", "types", "flows", "views", "roles", "rules", "sample"]);
const KIT_STRIP = new Set(["space", "owner", "created_at", "updated_at", "version_hash", "created_by"]);
const DATA_KEYS = new Set(["records", "rows", "data", "record_ids", "ids", "values", "entries", "record", "urn", "urns", "ref", "refs", "sealed_value"]);
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const UUIDISH = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
function luhn(/** @type {string} */ d) { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; }
function looksLikeData(/** @type {any} */ v, /** @type {string} */ path, /** @type {string[]} */ bad, /** @type {boolean} */ inSample) {
  if (v == null) return;
  if (typeof v === "string") {
    if (v.includes("vyre://")) bad.push(`${path}: a reference to a record`);
    if (UUIDISH.test(v)) bad.push(`${path}: looks like a record id`);
    if (SSN.test(v)) bad.push(`${path}: looks like a sealed value`);
    for (const m of v.match(/\b\d[\d -]{11,22}\d\b/g) ?? []) { const d = m.replace(/\D/g, ""); if (d.length >= 13 && d.length <= 19 && luhn(d)) bad.push(`${path}: looks like a card number`); }
    return;
  }
  if (typeof v !== "object") return;
  if (isSealedValue(v) || (v.sealed !== undefined && v.ref !== undefined)) { bad.push(`${path}: a sealed value or reference`); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => looksLikeData(x, `${path}[${i}]`, bad, inSample)); return; }
  for (const [k, x] of Object.entries(v)) {
    if (DATA_KEYS.has(k) && !(inSample && k === "data")) bad.push(`${path}.${k}: records or data do not belong in a Kit`);
    if ((k === "id" || k.endsWith("_id")) && inSample) bad.push(`${path}.${k}: sample data carries no ids`);
    looksLikeData(x, `${path}.${k}`, bad, inSample);
  }
}

/** Export definitions as a Kit. Refuses anything that looks like data; seed data only inside a labelled `sample` section. */
export function kitExport(/** @type {any} */ definitions) {
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) throw fail("bad_input", "a Kit is an object of definitions");
  if (!isStr(definitions.name)) throw fail("bad_input", "a Kit needs a name");
  const kit = /** @type {Record<string, any>} */ ({});
  for (const [k, v] of Object.entries(definitions)) {
    if (KIT_STRIP.has(k)) continue;
    if (!KIT_KEYS.has(k)) throw fail("bad_input", `${k} is not a Kit section`);
    kit[k] = v;
  }
  const bad = /** @type {string[]} */ ([]);
  for (const [k, v] of Object.entries(kit)) if (k !== "sample") looksLikeData(v, k, bad, false);
  if (kit.sample !== undefined) {
    const s = kit.sample;
    if (!s || s.is_sample !== true || s.label !== "sample") bad.push("sample: must be labelled { label: 'sample', is_sample: true }");
    else {
      if (!Array.isArray(s.records) || !s.records.every((/** @type {any} */ r) => r && isStr(r.type) && r.data && typeof r.data === "object")) bad.push("sample.records: each is { type, data }");
      else looksLikeData(s.records, "sample.records", bad, true);
    }
  }
  if (bad.length) throw fail("bad_input", "a Kit carries definitions, never data", { problems: bad });
  return Object.freeze({ format: "vyre-kit", v: 1, ...structuredClone(kit), labels: { trust: "external" } });
}

/** Everything installing would add, for the Ask card. Nothing is applied. */
export function kitInstallPlan(/** @type {any} */ kit, /** @type {any} */ destinationState) {
  if (!kit || kit.format !== "vyre-kit") throw fail("bad_input", "not a Kit");
  const st = destinationState ?? {};
  const have = new Map((st.types ?? []).map((/** @type {any} */ t) => typeof t === "string" ? [t, new Set()] : [t.name, new Set((t.fields ?? []).map((/** @type {any} */ f) => f.name))]));
  const stagesHave = new Map((st.types ?? []).map((/** @type {any} */ t) => [typeof t === "string" ? t : t.name, new Set((t.stages ?? []).map((/** @type {any} */ s) => s.name))]));
  const names = (/** @type {any[]|undefined} */ a) => new Set((a ?? []).map(x => typeof x === "string" ? x : x.name));
  const flowsHave = names(st.flows), viewsHave = names(st.views), rolesHave = names(st.roles);
  const adds = { types: /** @type {any[]} */ ([]), fields: /** @type {any[]} */ ([]), stages: /** @type {any[]} */ ([]), flows: /** @type {string[]} */ ([]), views: /** @type {string[]} */ ([]), roles: /** @type {string[]} */ ([]) };
  const lines = [];
  for (const t of kit.types ?? []) {
    if (!have.has(t.name)) {
      adds.types.push({ name: t.name, fields: (t.fields ?? []).map((/** @type {any} */ f) => f.name), stages: (t.stages ?? []).map((/** @type {any} */ s) => s.name) });
      lines.push(`New type ${t.name} with ${(t.fields ?? []).length} fields`);
    } else {
      for (const f of t.fields ?? []) if (!have.get(t.name).has(f.name)) { adds.fields.push({ type: t.name, field: f.name }); lines.push(`New field ${f.name} on ${t.name}`); }
      for (const s of t.stages ?? []) if (!stagesHave.get(t.name).has(s.name)) { adds.stages.push({ type: t.name, stage: s.name }); lines.push(`New stage ${s.name} on ${t.name}`); }
    }
  }
  for (const f of kit.flows ?? []) if (!flowsHave.has(f.name)) { adds.flows.push(f.name); lines.push(`New Flow ${f.name}`); }
  for (const v of kit.views ?? []) if (!viewsHave.has(v.name)) { adds.views.push(v.name); lines.push(`New view ${v.name}`); }
  for (const r of kit.roles ?? []) if (!rolesHave.has(r.name ?? r)) { adds.roles.push(r.name ?? r); lines.push(`New role template ${r.name ?? r}`); }
  const sample = kit.sample?.records?.length ?? 0;
  if (sample) lines.push(`${sample} sample records, labelled as sample`);
  const plan_hash = canonicalHash({ name: kit.name, version: kit.version ?? null, adds });
  const total = adds.types.length + adds.fields.length + adds.stages.length + adds.flows.length + adds.views.length + adds.roles.length;
  return { kit: kit.name, adds, sample_records: sample, total, plan_hash, ask: { kind: "grant", risk: "grant", grant_to: "installer", title: `Install ${kit.name}`, lines }, automatic: false };
}

/** Install is a grant to the installer: it needs the Ask card's answer for exactly this plan, never automatic. */
export async function installKit(/** @type {{chain:any, kit:any, approved_plan_hash:string}} */ input, /** @type {any} */ deps) {
  const space = input?.chain?.space;
  chainIn(input?.chain, space, "an install");
  const st = typeof deps.installedState === "function" ? await deps.installedState(space) : {};
  const plan = kitInstallPlan(input.kit, st);
  if (input.approved_plan_hash !== plan.plan_hash) throw fail("not_accepted", "the install card for this exact plan has not been approved");
  await authz(deps, input.chain, "kits.install", `vyre://${space}/kit/${String(input.kit.name)}`);
  const add_types = (input.kit.types ?? []).filter((/** @type {any} */ t) => plan.adds.types.some((/** @type {any} */ a) => a.name === t.name));
  const change_types = (input.kit.types ?? []).filter((/** @type {any} */ t) => plan.adds.fields.some((/** @type {any} */ a) => a.type === t.name) || plan.adds.stages.some((/** @type {any} */ a) => a.type === t.name));
  const store = recordsOf(deps, space);
  const result = typeof store.define === "function" ? await store.define({ add_types, change_types }) : null;
  await need(deps, "emit")(space, "kit.installed", { kit: input.kit.name, by: actorString(input.chain), added: plan.total, at: nowOf(deps) });
  return { plan, result };
}

// ---------------------------------------------------------------- continue in another space + multi-Space sessions

/**
 * Create a TASK in the destination that carries references, not copies. `by` is the person's chain in `fromSpace`;
 * the kernel supplies the destination chain through deps.destinationChain.
 * @param {{fromSpace:string, toSpace:string, by:any, summaryRefs:string[], title?:string}} input @param {any} deps
 */
export async function continueIn(input, deps) {
  const { fromSpace, toSpace, by } = input ?? {};
  if (!isStr(fromSpace) || !isStr(toSpace) || fromSpace === toSpace) throw fail("bad_input", "continue goes to a different Space");
  chainIn(by, fromSpace, "continue in another Space");
  if (!TASK_SOURCES.includes("continue_in_space")) throw fail("bad_input", "task source missing from contracts");
  if (!Array.isArray(input.summaryRefs) || input.summaryRefs.length === 0) throw fail("bad_input", "continue carries at least one reference");
  const refs = input.summaryRefs.map((/** @type {string} */ u) => { const p = parseUrn(u); if (p.space !== fromSpace) throw fail("bad_input", "references must point at the Space you continue from"); return u; });
  await authz(deps, by, "tasks.continue", `vyre://${fromSpace}/space/${toSpace}`);
  const destChain = await need(deps, "destinationChain")(by, toSpace);
  chainIn(destChain, toSpace, "the task");
  const task = await need(deps, "task").request(destChain, {
    title: isStr(input.title) ? input.title : `Continue from ${fromSpace}`,
    source: "continue_in_space", doer: by.hops[0].actor, inputs: refs, output: { kind: "note" }, how: "person",
  });
  const ev = { id: `cont_${task?.id ?? ""}`, kind: "session", source: fromSpace, destination: toSpace };
  await emitBoth(deps, ev, "task.continued", { by: actorString(by), task: task?.id ?? null, refs: refs.length });
  return { task, refs };
}

const trustMin = (/** @type {string[]} */ ts) => ts.reduce((a, t) => (TRUST_ORDER.indexOf(/** @type {any} */ (t)) < TRUST_ORDER.indexOf(/** @type {any} */ (a)) ? t : a), "system");

/** The labels a derived item carries: weakest trust, strongest class, every source Space. */
export function deriveLabels(/** @type {any[]} */ items) {
  const ls = items.map(i => i?.labels ?? i).filter(Boolean);
  const spaces = [...new Set(ls.flatMap(l => l.source_spaces ?? []))].sort();
  const red = ls.reduce((a, l) => (redIdx(l.red ?? "public") > redIdx(a) ? l.red : a), "public");
  return { trust: ls.length ? trustMin(ls.map(l => l.trust ?? "external")) : "system", red, source_spaces: spaces };
}

/**
 * The rules of a session whose context draws on these Spaces (10.6). Entries are Space ids or `{space, residency}`.
 * @param {(string|{space:string, residency?:any})[]} spaces
 */
export function sessionPolicy(spaces) {
  if (!Array.isArray(spaces) || spaces.length === 0) throw fail("bad_input", "a session needs at least one Space");
  const list = spaces.map(s => (typeof s === "string" ? { space: s, residency: undefined } : s));
  if (!list.every(s => isStr(s.space))) throw fail("bad_input", "bad Space entry");
  const source_spaces = [...new Set(list.map(s => s.space))].sort();
  const multi = source_spaces.length > 1;
  return Object.freeze({
    multi, source_spaces,
    persistent_writes: multi ? "drafts" : "direct",
    ask: Object.freeze({ for: ["outward.*", "grant"], must_name: multi ? source_spaces : [] }),
    residency: strictestResidency(list.map(s => s.residency)),
    labels: Object.freeze({ source_spaces }),
  });
}
/** A persistent write from a multi-Space session must be a draft for a human to approve. */
export function checkSessionWrite(/** @type {any} */ policy, /** @type {{persistent:boolean, draft?:boolean}} */ write) {
  if (policy.multi && write.persistent && write.draft !== true) throw fail("forbidden", "a session that holds more than one Space writes drafts only");
  return true;
}
/** An outward or grant act from a multi-Space session needs an Ask that names every Space involved. */
export function checkSessionAct(/** @type {any} */ policy, /** @type {{risk:string, ask?:{spaces:string[]}}} */ act) {
  if (!RISKS.includes(/** @type {any} */ (act.risk))) throw fail("bad_input", "unknown risk");
  const gated = act.risk === "grant" || act.risk.startsWith("outward.");
  if (!gated || !policy.multi) return true;
  const named = new Set(act.ask?.spaces ?? []);
  if (!policy.source_spaces.every((/** @type {string} */ s) => named.has(s))) throw fail("not_accepted", "the Ask card must name every Space in this session", { must_name: policy.source_spaces });
  return true;
}
/** The residency door: the strictest policy of every Space in the context applies to the provider. */
export function checkSessionProvider(/** @type {any} */ policy, /** @type {string} */ provider) {
  if (!inferenceAllowed(policy.residency, provider)) throw fail("forbidden", `a Space in this context does not allow ${provider}`);
  return true;
}
/** Derived output must carry every source Space of its inputs. */
export function assertNoCrossSpacePaste(/** @type {any} */ output, /** @type {any[]} */ inputs) {
  const have = new Set(output?.labels?.source_spaces ?? output?.source_spaces ?? []);
  const want = deriveLabels(inputs).source_spaces;
  const missing = want.filter(s => !have.has(s));
  if (missing.length) throw fail("forbidden", "derived output is missing source Space labels", { missing });
  return true;
}
/** Content that carries another Space's label may not be written into this Space without a bridge act. */
export function assertNoForeignContent(/** @type {any} */ labels, /** @type {string} */ targetSpace) {
  const foreign = (labels?.source_spaces ?? []).filter((/** @type {string} */ s) => s !== targetSpace);
  if (foreign.length) throw fail("forbidden", "content from another Space needs a bridge act before it is written here", { foreign });
  return true;
}
