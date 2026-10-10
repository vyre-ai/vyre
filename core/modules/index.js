// @ts-check
// modules — find modules, check their manifests, start them in order, and run their tools.
//
// Everything in Vyre is a module on one contract (docs/SPEC.md, section 5): core services,
// Harness pieces, surfaces and whatever a user installs. A module declares five things in
// module.json (does, watches, shows, needs, teaches) and exports start(ctx). The loader is the
// only place that knows how modules are wired together, which is what lets a new one appear
// everywhere it belongs without special cases.
//
// A module that fails to start is disabled and reported. It never takes the daemon down: one
// broken watcher runtime should not cost someone their search.

import { sandboxDoor } from "./sandbox-ctx.js";
import { setupToolAllowed } from "../../lib/setup-gate.js";
import { idOfCaller } from "../../lib/outside.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { OPEN as AGENT_OPEN, ASK_FIRST as AGENT_ASK_FIRST, WEB_REACH, SETUP_REACH } from "./agent-reach.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate, open as openStore } from "../store/index.js";
import { Idempotency } from "./idempotency.js";
import { PERSON_ONLY, machineSelf, core as coreHolder, format as formatProof } from "../presence/index.js";
import { validateDecls } from "../config/settings.js";
import * as config from "../config/index.js";
import { toolEntries, checkManifestFull, flowTriggers } from "../../packages/module-sdk/manifest.js";
import { isPerson, deviceIdOf, yesDeviceOf } from "../../lib/caller.js";
import { projectRecordIdOf } from "../../lib/project-id.js";
import { holdFields } from "../../lib/hold-fields.js";
import { COVERED } from "../../lib/covered.js";
import { yes, momentOf, signOf, yesFieldsOf, createReuse, REUSE_OPS, admitCard, AGENT_PENDS } from "../../lib/one-yes.js";
import { CONTRACT, supports, moduleContract, adapterFor } from "../../packages/module-sdk/contract.js";
import { PERSON_SURFACES } from "../../lib/person-surfaces.js";
import { within } from "../../lib/within.js";

/** Features ctx.api.has() answers true for in this loader, inside the running contract. */
const LOADER_FEATURES = ["modules.status"];

/** Tools a tailnet device reaches without a person session: signing in, and the first passkey. */
// wink.server.adopt, wink.server.release and wink.phone.wait are the pairing steps a device takes before it has any person session: each checks its own caller and the owner's presence (core/wink/pairing.js).
// relay.devices.path is a device reporting its own connection path (it names no one but its caller), made on every connect, before any sign-in.
// presence.person.status is how a surface learns whether anyone is signed in at all, so it must answer before sign-in.
/** The sign-in tools: they authenticate a person (a passkey or the device's own key) and open a person session; the presence verifier still checks that proof. */
const SIGN_IN = new Set(["presence.person.start"]);
export const PERSON_FREE = new Set(["presence.person.start", "presence.enroll", "wink.server.adopt", "wink.server.release", "wink.phone.wait", "relay.devices.path", "presence.person.status"]);

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
/** Vyre's own modules live here; a module installed into a home never does. */
const CORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Vyre's own modules are the ones shipped in the repo (core, local, modules); a home's never are. */
const REPO_DIR = path.resolve(CORE_DIR, "..");
const SHIPPED = ["core", "local", "modules"].map(x => path.join(REPO_DIR, x));
/**
 * Shipped with Vyre: a module folder directly in the repo's core/, local/ or modules/, and never
 * one inside the home, even a dev home kept inside a checkout (VYRE_HOME=<repo>/.dev): a home
 * module is the person's or a third party's, whatever folder it sits in (e2e review).
 * @param {string} dir
 */
export const firstParty = dir => {
  const d = path.resolve(dir);
  if (!SHIPPED.includes(path.dirname(d))) return false;
  const home = config.home();
  return !(home !== REPO_DIR && (d + path.sep).startsWith(home + path.sep));
};
/**
 * The only caller labels a module may call under, and who may. A person's labels ("cli", "deck")
 * are never here: a module that could call as one would act as the person. The link on a Mac types
 * into a session for the person at the box as "link:box" (docs/adr/0021-box-reads-the-mac.md).
 * @type {Record<string, string[]>}
 */
// settings passes a person's change on to the module that keeps the value, as that person.
/** How long an asked tool's target (and the thread lineage) may take to answer before the call is not_asked. */
const TARGET_MS = 2000;
/** The tools the agents module may call as the asking person: agents.ask's words and tags, heard by threads.send, and giving the keyboard back (threads.release) once the ask is answered, which only lets go of the asker's own lease. @param {string} tool */
export const agentsMayRelay = tool => tool === "threads.send" || tool === "threads.release";
/** The per-call check on the agents module's relay: throws for any tool but threads.send. @param {string} tool @param {string} as */
export function checkAgentsRelay(tool, as) {
  if (!agentsMayRelay(tool)) throw new Error(`agents may not call ${tool} as ${as}: it relays a person to threads.send and threads.release only`);
}
/** @type {Record<string, any>} */
/**
 * What a first-party module that relays a person (`as`) may relay: connectors writes a person's api-credential (vault.put), deletes a connection's own (vault.delete of conn-<id>) and runs one of its operations (vault.request by operation); appmods
 * makes and removes the Connection of an app the person installed or removed (connectors.connection.create and .delete). Anything else is refused. Called before the relayed call is made.
 * @param {string} module @param {string} tool @param {any} input @param {string} as
 */
export function checkRelayTool(module, tool, input, as) {
  const obj = input && typeof input === "object";
  if (module === "connectors" && !(tool === "vault.put" && obj && input.kind === "api-credential") && !(tool === "vault.delete" && obj && /^conn-[a-z0-9-]+$/.test(String(input.name)))
    // and runs one operation of a Connection as the person who asked (a view over a wrapped app): vault.request of that Connection's own credential, by operation. The send/change/delete gate judges the operation there.
    && !(tool === "vault.request" && obj && /^conn-[a-z0-9-]+$/.test(String(input.credential)) && typeof input.operation === "string" && input.operation !== "request" && input.url === undefined && input.method === undefined)) throw new Error(`connectors may not call ${tool} as ${as}: it relays a person to vault.put for an api-credential, to vault.delete for a connection's own conn-<id> credential, and to vault.request of a connection's own credential by operation, only`);
  if (module === "appmods" && !["connectors.connection.create", "connectors.connection.delete"].includes(tool)) throw new Error(`appmods may not call ${tool} as ${as}: it relays an installing person to the app's own Connection (create and delete) only`);
}

const CALL_AS = { agents: (/** @type {string} */ as) => isPerson(as), link: ["link:box"], settings: ["cli", "local", "deck", "capsule"], mentions: (/** @type {string} */ as) => isPerson(as) || as === "module:sessions" || as === "module:assistant",
  // capsule runs a view's declared tool as the asking person (first party modules) or as the added module itself, never as anyone else.
  capsule: (/** @type {string} */ as) => isPerson(as) || /^module:[a-z][a-z0-9-]*$/.test(as),
  // appmods relays the person who installed or removed an app to the Connection of that app and to nothing else (connectors.connection.create and .delete: a vault api-credential is a person's to write); checked per call below.
  appmods: (/** @type {string} */ as) => isPerson(as),
  views: (/** @type {string} */ as) => isPerson(as) || /^module:[a-z][a-z0-9-]*$/.test(as),
  // connectors relays the person who asked to one thing: writing an api-credential (a module cannot write one on its own); checked per call below.
  connectors: (/** @type {string} */ as) => isPerson(as),
  // stream asks threads.get as the very caller of stream.open (a person's surface or device, or an assistant), so a session's read is decided under that caller's own authority, never the module's.
  stream: (/** @type {string} */ as) => isPerson(as) || agentClaim(as) !== null,
  // pluginagent.revoke is the person's own act (presence): the plugin agent it made is deleted as the revoking person, agents.delete's person-only rule deciding; checked per call below.
  pluginagent: (/** @type {string} */ as) => isPerson(as),
  // term asks threads.get as the person who opened the terminal, so a session's folder and its terminal are decided under that person's own authority.
  term: (/** @type {string} */ as) => isPerson(as) };
/**
 * A manifest still says `"roles": ["box"]` or `["local"]` (forty-plus modules across every
 * team; ADR 0039 keeps that vocabulary rather than renaming it everywhere). `start()` is called
 * with `config.machine` -- the person's actual choice, "solo", "server" or "device" -- and this
 * is where the two meet: which manifest buckets are active for it. A raw "box" or "local" (a
 * caller, mostly tests, that still passes one directly) passes straight through unchanged.
 * @param {string} role @returns {string[]}
 */
export function roleBuckets(role, platform = process.platform) {
  if (role === "box" || role === "local") return [role];
  // Module API 1 (ADR 0047): a manifest's "mac" or "windows" is "local" on that OS only.
  if (role === "mac") return platform === "darwin" ? ["local"] : [];
  if (role === "windows") return platform === "win32" ? ["local"] : [];
  const out = [];
  if (config.isServer(role)) out.push("box");
  // A Mac chosen as the server is still, often, someone's own desk: Capsule, voice and the
  // rest of the local core stay (team-lead, 28 Sep). A Linux box never had those anyway.
  if (config.isDevice(role) || (role === "server" && platform === "darwin")) out.push("local");
  return out;
}
export { holdFields };
const TOOL = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/;
/** Who may call a tool (ADR 0047), and what an outward tool does as the person. */
const REACHES = ["anyone", "asked", "person", "modules", "hook"];
const OUTWARD = ["send", "post", "pay", "delete"]; // `outward: true` is the plain mark (one yes): leaves Vyre and reaches someone outside your spaces and devices; a word names the Gate kind


/**
 * The SDK's added-module check, as a load reads it: the graces applied first, so only the 1.0
 * rules that keep a module inside its doors are problems (person reach, presence-free tools,
 * built in only keys, wildcards, replaces, outward on a hidden reach, the schema).
 * @param {any} m @returns {{ problems: string[], warnings: string[] }}
 */
export function addedCheck(m) {
  if (!m || typeof m !== "object" || typeof m.name !== "string") return { problems: [], warnings: [] };
  const graced = [];
  const g = { ...m };
  if (g.vyre === undefined && g.apiVersion === undefined) g.vyre = "1";
  if (g.description === undefined) { g.description = m.name; graced.push("description is missing; add one plain sentence for the install card"); }
  if (g.does && typeof g.does === "object" && Array.isArray(g.does.tools) && g.does.tools.some(t => typeof t === "string")) {
    g.does = { ...g.does, tools: g.does.tools.map(t => (typeof t === "string" ? { name: t } : t)) };
    graced.push("string tool entries are deprecated; write each as { \"name\": ..., \"reach\": ... } (vyre module upgrade does it)");
  }
  const r = checkManifestFull(g, { firstParty: false });
  return { problems: r.problems, warnings: [...graced, ...r.warnings] };
}

/** The modules a manifest requires: a list of names, or the keys of { name: range } (ADR 0047). @param {any} m */
export const requiresOf = m => (Array.isArray(m && m.requires) ? m.requires : m && m.requires && typeof m.requires === "object" ? Object.keys(m.requires) : []);

/** A version as [major, minor, patch], or null. @param {string} v */
const semver = v => { const x = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim()); return x ? [Number(x[1]), Number(x[2] || 0), Number(x[3] || 0)] : null; };
const cmp = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether a version meets a range: comparators (>=, >, <=, <, =, ^, ~, or a bare version) joined by
 * spaces, all of which must hold, or * for any. null when the range can't be read.
 * @param {string} version @param {string} range @returns {boolean | null}
 */
export function satisfies(version, range) {
  const v = semver(version);
  const parts = String(range).trim().split(/\s+/).filter(Boolean);
  if (!v) return false;
  let ok = true;
  for (const part of parts) {
    if (part === "*" || part === "x") continue;
    const x = /^(>=|<=|>|<|=|\^|~)?(v?\d+(?:\.\d+){0,2})$/.exec(part);
    if (!x) return null;
    const want = /** @type {number[]} */ (semver(x[2])), c = cmp(v, want);
    const op = x[1] || "=";
    const upper = op === "^" ? (want[0] > 0 ? [want[0] + 1, 0, 0] : [0, want[1] + 1, 0]) : [want[0], want[1] + 1, 0];
    const hold = op === ">=" ? c >= 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : op === "<" ? c < 0 : op === "=" ? c === 0 : c >= 0 && cmp(v, upper) < 0;
    ok = ok && hold;
  }
  return ok;
}
const VERBS = ["does", "watches", "shows", "needs", "teaches"];
/** Use counts reach vyre.db at most this often; nothing is written while nothing was used. */
const USE_FLUSH = 60_000;
/** How long one module's own stop() may take before Registry.stop() gives up on it and moves on
 * to the next (matches core/daemon/index.js's DRAIN_MS for the same reason: a hang in one place
 * must never become a hang everywhere). */
const MODULE_STOP_MS = 5_000;

/**
 * Check a manifest. Returns a list of problems; empty means valid. `firstParty` is true for a
 * module shipped with Vyre; a module from anywhere else is held to more (its settings' stores).
 * @param {any} m @param {{ firstParty?: boolean }} [opts]
 */
/**
 * Event families only their first-party owners may declare: device sync is federation's, and the
 * Gate, push, presence, said and memory families make other modules act on the person's data or
 * trust, so an added module can't emit push.proactive, gate.held and the like.
 */
export const RESERVED_EVENTS = {
  sync: ["sync"], gate: ["gate"], push: ["push", "assistant"], presence: ["presence"],
  said: ["assistant"], memory: ["memory"], "artifact-links": ["artifacts"],
  // thread.deleted wipes a chat history: only the session modules that own threads emit thread.*.
  thread: ["threads", "harness", "link", "projects", "sessions", "artifacts", "previews", "ask"],
};

/** Event nouns Vyre's own modules act on. An added module never emits these, whatever it is named: a module named "device" or "devices" must not say device.paired. */
export const SHARED_EVENT_NOUNS = new Set(["device", "wink", "name", "relay", "vault", "turn", "settings", "spaces", "space", "chat", "task", "record", "records", "flow", "file", "files", "identity", "person", "kernel", "module", "approval", "stream", "network"]);

/**
 * Tools an added module can never name, whatever its needs.tools say: pairing, admitting or dropping devices, and setup change who can reach the server. A whole family is closed
 * (relay, link, wink, presence) except the read-only status tools below; the list is checked at add time (`vyre module check`) and again on every ctx.call.
 */
const NEVER_FAMILIES = /^(relay|link|wink|presence)\./;
const NEVER_EXCEPT = new Set(["relay.status", "relay.setup.status", "relay.devices.all", "relay.devices.list", "link.status", "link.health", "link.macs", "link.peers", "link.pending", "link.events", "wink.network.status"]);
/** @param {string} tool */
export const addedNever = tool => NEVER_FAMILIES.test(String(tool)) && !NEVER_EXCEPT.has(String(tool));

export function validate(m, { firstParty = false } = {}) {
  const out = [];
  if (!m || typeof m !== "object") return ["module.json is not an object"];
  // A contract this Vyre doesn't speak is the one problem, and the module's code is never imported
  // (ADR 0047 section 8). Naming none reads as "1"; unknown keys are ignored, never a problem.
  const speaks = supports(moduleContract(m), { name: typeof m.name === "string" ? m.name : "this module" });
  if (!speaks.ok) return [speaks.message];
  // A module not shipped with Vyre is held to the added-module rules wherever it sits: added with
  // `vyre module add`, or placed in <home>/modules by hand (reviews/platform.md CR-H3). The graces
  // of a load (ADR 0047 section 8) stay: no "vyre" reads as "1", and what is only deprecated
  // (string tool entries, a missing description) warns through addedWarnings(), never fails.
  if (!firstParty) out.push(...addedCheck(m).problems);
  if (!firstParty && m.needs && Array.isArray(m.needs.tools)) for (const t of m.needs.tools) if (typeof t === "string" && addedNever(t)) out.push(`needs.tools "${t}": an added module can never use a tool that pairs, admits or drops a device or sets the server up`);
  if (!NAME.test(String(m.name || ""))) out.push(`name "${m.name}" must be lowercase letters, digits and dashes`);
  // the kernel's own service hop is the one that may write a kernel-owned field (a task's status): no module takes that name
  if (String(m.name) === "kernel") out.push('name "kernel" is reserved for the kernel itself');
  if (!/^\d+\.\d+\.\d+/.test(String(m.version || ""))) out.push(`version "${m.version}" must be semver`);
  if (m.roles && (!Array.isArray(m.roles) || m.roles.some(r => !["box", "local", "mac", "windows"].includes(r)))) out.push("roles must be a list of box, local, mac and windows");
  if (m.requires && !Array.isArray(m.requires)) {
    // Module API 1: { name: range }, each range checked against the dependency's version at start.
    if (typeof m.requires !== "object") out.push("requires must be a list or { name: range }");
    else for (const [n, r] of Object.entries(m.requires)) {
      if (!NAME.test(n)) out.push(`requires "${n}" must be a module name`);
      if (typeof r !== "string" || satisfies("0.0.0", r) === null) out.push(`requires "${n}": "${r}" is not a version range`);
    }
  }
  for (const v of VERBS) if (m[v] !== undefined && (typeof m[v] !== "object" || Array.isArray(m[v]))) out.push(`${v} must be an object`);
  for (const e of (m.does && m.does.tools) || []) {
    // A name, or the object form of module API 1 (ADR 0047): { name, summary?, reach?, outward?, cost? }.
    const t = e && typeof e === "object" && !Array.isArray(e) ? e.name : e;
    if (typeof t !== "string") { out.push("a tool entry must be a name or { name, reach?, outward? }"); continue; }
    if (!TOOL.test(t)) out.push(`tool "${t}" must look like module.verb`);
    else if (!t.startsWith(m.name + ".")) out.push(`tool "${t}" must start with "${m.name}."`);
    if (typeof e === "object" && e.reach !== undefined && !REACHES.includes(e.reach)) out.push(`tool "${t}": reach must be one of ${REACHES.join(", ")}`);
    if (typeof e === "object" && e.outward !== undefined && e.outward !== true && !OUTWARD.includes(e.outward)) out.push(`tool "${t}": outward must be one of ${OUTWARD.join(", ")} (or true)`);
  }
  for (const e of (m.watches && m.watches.emits) || []) {
    if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(e)) out.push(`event "${e}" must look like noun.past-verb`);
    // Events that make other modules act on the person's data (sync.deleted forgets a device's
    // history) come only from the first-party module that owns them.
    const owners = RESERVED_EVENTS[e.split(".")[0]];
    if (owners && !(firstParty && owners.includes(String(m.name)))) out.push(`event "${e}" is reserved for ${owners.join(" or ")}`);
    // Allowlist, not a denylist: other modules act on device.*, wink.*, name.*, relay.*, vault.*, turn.*, settings.* and spaces.* events, so an added module may emit only events named for itself
    // (`<its name>.verb`, the singular of it ("notes" says `note.added`) or `<its name>-x.verb`). A first-party module keeps the rule above.
    else if (!firstParty && SHARED_EVENT_NOUNS.has(e.split(".")[0])) out.push(`event "${e}": ${e.split(".")[0]}.* events are Vyre's own; an added module can't emit them`);
    else if (!firstParty) { const noun = e.split(".")[0], own = String(m.name); if (noun !== own && noun !== own.replace(/s$/, "") && !noun.startsWith(`${own}-`)) out.push(`event "${e}": a module that is not Vyre's own may emit only events named for itself ("${m.name}.…")`); }
  }
  out.push(...validateDecls(String(m.name), m.settings, { firstParty, tools: toolEntries(m).map(t => t.name) }));
  // Session providers (ADR 0030): drivers the Switchboard can run a session on, besides Claude.
  const providers = m.does && m.does.providers;
  if (providers !== undefined && (!Array.isArray(providers) || providers.some(p => !NAME.test(String(p))))) out.push("does.providers must be a list of lowercase names");
  out.push(...checkCredentials(m.needs && m.needs.credentials));
  if (m.needs && m.needs.kernel !== undefined) {
    const k = m.needs.kernel;
    if (!k || typeof k !== "object" || Array.isArray(k)) out.push("needs.kernel must be an object like { records: [type, ...] }");
    else if (k.records !== undefined && (!Array.isArray(k.records) || k.records.some((/** @type {any} */ t) => typeof t !== "string" || !/^[a-z][a-z0-9_]{0,40}$/.test(t)))) out.push("needs.kernel.records must be a list of record type names (lowercase, letters, digits, underscores)");
    else if (k.files !== undefined && (!Array.isArray(k.files) || k.files.some((/** @type {any} */ f) => typeof f !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.\/-]{0,120}$/.test(f) || f.includes("..")))) out.push("needs.kernel.files must be a list of Drive folders like Clients/Contracts");
  }
  // setupTools: this module's own tools the setup channel may call (built in only, see addedCheck).
  if (m.setupTools !== undefined) {
    const own = new Set(toolEntries(m).map(t => t.name));
    if (!Array.isArray(m.setupTools) || m.setupTools.some(/** @param {any} t */ t => typeof t !== "string")) out.push("setupTools must be a list of tool names");
    else for (const t of m.setupTools) if (!own.has(t)) out.push(`setupTools "${t}" is not a tool this module declares in does.tools`);
  }
  // An asked tool's target: one internal tool of this module, answering what one call acts on (built in only, see addedCheck).
  for (const e of toolEntries(m)) {
    if (!e.target) continue;
    const own = toolEntries(m).find(x => x.name === e.target);
    if (e.reach !== "asked") out.push(`tool "${e.name}": target is for an asked tool`);
    else if (!own || !String(e.target).startsWith(String(m.name) + ".")) out.push(`tool "${e.name}": target "${e.target}" is not a tool this module declares in does.tools`);
    else if (own.reach !== "modules") out.push(`tool "${e.name}": target "${e.target}" must be reach modules, an internal tool`);
  }
  // mentions: the # picker's kinds, each naming this module's own search and resolve tools (built in only, see addedCheck).
  if (Array.isArray(m.mentions)) {
    const own = new Set(toolEntries(m).map(t => t.name));
    const kinds = new Set();
    for (const e of m.mentions) {
      if (!e || typeof e !== "object") continue;
      if (typeof e.kind !== "string" || !/^[a-z][a-z0-9-]{1,24}$/.test(e.kind)) out.push(`mentions kind ${JSON.stringify(e.kind)} must be lowercase letters, digits and dashes, 2 to 25 characters`);
      if (typeof e.label !== "string" || !e.label || e.label.length > 40) out.push(`mentions "${e.kind}" needs a label of up to 40 characters`);
      if (e.icon !== undefined && (typeof e.icon !== "string" || !/^[a-z][a-z0-9-]{0,24}$/.test(e.icon))) out.push(`mentions "${e.kind}" icon must be a short lowercase slug`);
      if (kinds.has(e.kind)) out.push(`mentions kind "${e.kind}" is declared twice`);
      kinds.add(e.kind);
      for (const f of ["search", "resolve"]) if (typeof e[f] === "string" && !own.has(e[f])) out.push(`mentions "${e.kind}" ${f} "${e[f]}" is not a tool this module declares in does.tools`);
    }
  }
  // ADR 0047, reviews/platform.md H2: an added module replaces nothing in 0.2.
  if (!firstParty && m.replaces !== undefined) out.push("replaces: an added module can't replace one of Vyre's modules; the 0.2 allowlist of replaceable modules is empty");
  return out;
}

const NEED = /^[a-z][a-z0-9_-]{0,40}$/;
/**
 * needs.credentials (ADR 0028, decision 9a): what a module needs from the Vault, which the vault
 * lists and fills. The kind and provider words are the vault's to check; this checks the shape.
 * @param {any} list
 */
function checkCredentials(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ["needs.credentials must be a list"];
  const out = [], ids = new Set();
  for (const [i, c] of list.entries()) {
    const at = `needs.credentials[${i}]`;
    if (!c || typeof c !== "object" || Array.isArray(c)) { out.push(`${at} must be an object`); continue; }
    if (!NEED.test(String(c.id ?? ""))) out.push(`${at}.id must be a lowercase name`);
    else if (ids.has(c.id)) out.push(`${at}.id ${c.id} is declared twice`);
    ids.add(c.id);
    for (const k of ["kind", "provider", "purpose"]) if (typeof c[k] !== "string" || !c[k]) out.push(`${at}.${k} must be a string`);
    if (c.item !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(String(c.item))) out.push(`${at}.item must be a vault item name`);
    if (c.group !== undefined && !NEED.test(String(c.group))) out.push(`${at}.group must be a lowercase name`);
    if (c.optional !== undefined && typeof c.optional !== "boolean") out.push(`${at}.optional must be true or false`);
    // multiple: one item per account, named <module>-<label> when the person connects it.
    if (c.multiple !== undefined && typeof c.multiple !== "boolean") out.push(`${at}.multiple must be true or false`);
    if (c.multiple === true && c.item !== undefined) out.push(`${at}.item cannot be set with multiple: each item is named <module>-<label>`);
  }
  return out;
}

/**
 * A module hands something UP to the daemon by a fixed name: the vault's `credentialsPort`, the switchboard's `accountKey` and the few names listed below. The vault may provide again (a crash restart, a disable and enable) and the new port replaces
 * the old, so the registry never holds a port that closes over a stopped vault; no one else can provide at all. (Exported for the test that proves the refusals.)
 * @param {Record<string, any>} deps the registry's dependencies @param {string} module @param {string} name @param {any} value
 */
export function provideOnce(deps, module, name, value) {
  if (!((name === "credentialsPort" && module === "vault") || (module === "threads" && name === "accountKey") || (module === "spaces" && name === "memberRemote") || (module === "wink" && (name === "winkSessionFor" || name === "remoteKernel" || name === "winkInviteeSessionFor" || name === "winkHolds")))) throw new Error(`${module} may not provide ${String(name).slice(0, 40)}`);
  deps[name] = value;
}

/** The vault items a module's needs.credentials names: `item`, or `<module>-<id>`. @param {any} m */
export const credentialItems = m => (Array.isArray(m && m.needs && m.needs.credentials) ? m.needs.credentials : [])
  .filter(c => !(c && c.multiple === true)).map(c => (c && c.item) || `${m.name}-${c && c.id}`);

/** Whether an item is one of a `multiple` need's items: `<module>-<label>`. @param {any} m @param {string} name */
export const multipleItem = (m, name) => (Array.isArray(m && m.needs && m.needs.credentials) ? m.needs.credentials : [])
  .some(c => c && c.multiple === true) && String(name).startsWith(`${m.name}-`);

/**
 * Whether a module folder sits directly in one of the given roots: the firstPartyRoots an
 * in-process caller (a test standing in for Vyre's own modules) hands discover() and the Registry.
 * @param {string} dir @param {string[] | undefined} roots
 */
const inRoots = (dir, roots) => Array.isArray(roots) && roots.some(r => typeof r === "string" && path.isAbsolute(r) && path.dirname(path.resolve(dir)) === path.resolve(r));

/**
 * Every folder under the given roots that holds a module.json. firstPartyRoots: folders whose
 * modules count as Vyre's own, for tests whose fixtures stand in for a built in module. Only
 * in-process code passes it (core/daemon start's own option); config.json, the environment and
 * the command line never reach it, and vyred's own start passes none.
 * @param {string[]} roots @param {{ firstPartyRoots?: string[] }} [o]
 */
export function discover(roots, { firstPartyRoots = [] } = {}) {
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const file = path.join(dir, "module.json");
      if (!fs.existsSync(file)) continue;
      let manifest = null, problems = [], warnings = [];
      try {
        manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        const fp = firstParty(dir) || inRoots(dir, firstPartyRoots);
        problems = validate(manifest, { firstParty: fp });
        if (!fp && !problems.length) warnings = addedCheck(manifest).warnings;
      } catch (err) { problems = ["module.json unreadable: " + /** @type {Error} */ (err).message]; }
      found.push({ dir, manifest, problems, warnings });
    }
  }
  return found;
}

/** Order modules so each starts after what it requires. Cycles and missing deps are problems. */
export function order(mods) {
  const byName = new Map(mods.map(m => [m.manifest.name, m]));
  const out = [], seen = new Set(), stack = new Set(), problems = new Map();
  const visit = (m, trail) => {
    const n = m.manifest.name;
    if (seen.has(n)) return true;
    if (stack.has(n)) { problems.set(n, `requires a cycle: ${[...trail, n].join(" → ")}`); return false; }
    stack.add(n);
    for (const dep of requiresOf(m.manifest)) {
      const d = byName.get(dep);
      if (!d) { problems.set(n, `requires "${dep}", which is not available`); stack.delete(n); return false; }
      const range = Array.isArray(m.manifest.requires) ? null : m.manifest.requires[dep];
      if (range && !satisfies(d.manifest.version, range)) { problems.set(n, `requires "${dep}" ${range}, but ${dep} is ${d.manifest.version}`); stack.delete(n); return false; }
      if (!visit(d, [...trail, n])) { if (!problems.has(n)) problems.set(n, `requires "${dep}", which could not start`); stack.delete(n); return false; }
    }
    stack.delete(n); seen.add(n); out.push(m);
    return true;
  };
  for (const m of mods) visit(m, []);
  return { ordered: out, problems };
}

/**
 * A tiny JSON-schema check for tool input: types, required keys, enums. Enough to reject a bad
 * call with a readable error; a tool's own run() still validates anything subtle.
 */
export function checkInput(schema, value, where = "input") {
  if (!schema) return [];
  const out = [];
  const type = schema.type;
  const is = { object: v => v && typeof v === "object" && !Array.isArray(v), array: Array.isArray,
    string: v => typeof v === "string", number: v => typeof v === "number", integer: Number.isInteger,
    boolean: v => typeof v === "boolean" };
  if (type && is[type] && !is[type](value)) return [`${where} must be ${type}`];
  if (schema.enum && !schema.enum.includes(value)) out.push(`${where} must be one of ${schema.enum.join(", ")}`);
  if (type === "object") {
    for (const k of schema.required || []) if (value[k] === undefined) out.push(`${where}.${k} is required`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (value[k] !== undefined) out.push(...checkInput(s, value[k], `${where}.${k}`));
  }
  if (type === "array" && schema.items) value.forEach((v, i) => out.push(...checkInput(schema.items, v, `${where}[${i}]`)));
  return out;
}

/**
 * "module:notes" is a module; every other caller is its own kind: "cli", "local", "mcp". A caller
 * that names an agent ("mcp:agent:kit", "harness:agent:kit") is the kind before the name, so an
 * agent's MCP server is still "mcp" to every allowlist and rule. vyred has already checked the name.
 */
/**
 * The surfaces' own labels: the person at a terminal (cli, local), their Deck and Capsule, and
 * the phone app (mobile). The one list; a module that trusts a surface's label imports it rather
 * than keeping its own copy. On the socket every such label is only a claim, and vyred takes any
 * label but a model's own (mcp, harness) from under a `claude` or a thread as that session's
 * (core/daemon asTaken), whether or not it is listed here.
 */
/**
 * The meta of the tool call now running, as the registry dispatched it. The kernel reads the running turn's own session token from here (`ctx.kernel.audienceFor`), so a
 * module cannot hand it another turn's token: whatever it passes, the room is the one of the call the registry is running for it.
 */
const PLACEHOLDER = /\{\{field:[^}]+\}\}/;
const callStore = new AsyncLocalStorage();
/** The running call's meta, or null: once the call has returned, work it started (a timer, a floating promise) no longer sees it, so a turn's token cannot outlive the turn. */
/**
 * The mark a nested call rides, when the card that covers the running call names this tool in `covers` and the caller is the module that owns the covered tool (or one it already passed the mark to).
 * The mark gains the module the nested tool belongs to, so the Gate lets that module present it; the card is still used once, by the Gate, for the one send.
 * @param {Map<string, any>} tools @param {any} cur @param {string} tool @param {string} caller @returns {any}
 */
export function coveredRide(tools, cur, tool, caller) {
  const mark = cur && cur[COVERED];
  if (!mark) return null;
  const root = tools.get(String(mark.tool));
  const who = String(caller).slice(7), at = new Set([String(mark.tool).split(".")[0], ...(mark.via || [])]);
  if (!root || !Array.isArray(root.covers) || !root.covers.includes(tool) || !at.has(who)) return null;
  const mod = tool.split(".")[0];
  return { ...mark, via: [...new Set([...(mark.via || []), mod])] };
}
export const currentCall = () => { const b = callStore.getStore(); return b && b.live ? b.meta : null; };
/** The caller class the running call came from, past module hops, or undefined when nothing is running (a timer, a start). A module that stores work to do later stores this beside it. */
export const captureOrigin = () => { const m = currentCall(); if (!m) return undefined; return m.origin || (m.caller && !String(m.caller).startsWith("module:") ? m.caller : undefined); };
/** Run `f` as the call `origin` came from (the origin a module stored with a job or an event), so what it calls is judged as that caller class. With no origin it is a plain call. @param {string | undefined} origin @param {() => any} f */
export const withOrigin = (origin, f) => (origin ? runInTurn({ ...(currentCall() || {}), origin }, async () => f()) : f());
const runInTurn = async (/** @type {any} */ meta, /** @type {() => Promise<any>} */ f) => {
  // A module the running turn calls (ctx.call) is still in that turn: it inherits the outer turn's token unless the call brought its own from the daemon.
  const outer = callStore.getStore();
  let inherited = outer && outer.live && typeof outer.meta.token === "string" && typeof meta.token !== "string" ? { ...meta, token: outer.meta.token } : meta;
  // a module a cross-space call reaches (ctx.call) is still in that Space: the registry sets these only from callInSpace, so inheriting them from the running turn is as trusted as the turn
  if (outer && outer.live && typeof outer.meta.in_space === "string" && typeof inherited.in_space !== "string") inherited = { ...inherited, in_space: outer.meta.in_space, in_space_chain: outer.meta.in_space_chain };
  const box = { meta: inherited, live: true };
  try { return await callStore.run(box, f); } finally { box.live = false; }
};

/** The person's own surfaces: the one list (lib/person-surfaces.js). A label here still has to be measured (core/daemon asTaken); it is never a person by name. */
export const SURFACE_LABELS = PERSON_SURFACES;
/** The old phone label. NOT a surface and never a person: the phone arrives as its paired device. It stays a known label that may reach the tools whose callers lists still name it (test/one-person-surfaces.json), so nothing changes for them; each owner drops it from their list. */
const LEGACY_PHONE = "mobile";

/** The first word of every caller label the registry recognises: the person's surfaces, plus the other classes a listener, the loader or the daemon builds. A first word that is none of these is refused on every tool, one open to any caller included. test/reach-classes.test.js checks it against the labels the code builds. */
export const KNOWN_LABELS = new Set([...SURFACE_LABELS, LEGACY_PHONE, "mcp", "harness", "hook", "onboard", "anonymous", "module", "tailnet", "tailnet-guest", "invitee", "device", "space", "agent", "web", "setup", "ext", "assistant", "runner", "link", "relay", "server", "home", "unknown", "core", "vault"]);

/** Who may call a reach "person" tool: the person's own surfaces, and the owner's own devices (callerAllowed). */
const PERSON_CALLERS = Object.freeze([...SURFACE_LABELS, LEGACY_PHONE, "tailnet", "device", "space", "agent"]);
/** The caller classes that stand for the person on a module hop: their own surfaces and devices, and nothing else: no pre-owner exception (a server with no owner takes only pairing). */
const ORIGIN_PERSON = Object.freeze([...PERSON_CALLERS]);

/**
 * The once-only registry default (reviewer-2's group D audit, the lead's ruling 4 Oct): a tool that changes state and declares no `callers` list is the person's own surfaces and modules
 * only, so an agent is refused until the tool's owner declares who else may call it; a missing declaration is a refused call, the safe failure. A tool says what it is with `effect: "read"`
 * or `"write"` (manifest entry or `ctx.tool` definition); undeclared, a tool whose last name segment is a plain read verb is a read and everything else is a write.
 */
const READ_VERBS = new Set(["get", "list", "status", "show", "read", "search", "find", "info", "check", "peek", "tail", "whoami", "me", "describe", "explain", "preview", "count", "has", "query", "history", "view", "inspect", "doctor", "detect", "lookup", "resolve", "verify", "stats", "summary", "ls", "cat", "available", "enabled", "tools", "types", "url", "version", "health", "ping", "events", "log", "logs", "whois", "targets", "pending", "mine", "current", "overview"]);
/** The tools a module hop must not reach on behalf of a model: credentials, names, grants and devices. */
const ORIGIN_CHECKED = Object.freeze([/^vault\.(put|get|release|fetch|import|export|pass\.|account\.|agent\.|emergency\.)/, /^names\.claim$/, /^grants\./, /^spaces\.devices\./, /^spaces\.(create|host-here|retire-here|invites?\.|members?\.|roles?\.)/]);
/** The caller class a call came from, past any module hops: `meta.origin` when a module relayed it, else the caller itself. For a tool with an explicit callers list that wants to check it. @param {any} meta */
export const originClass = (meta) => (meta && (meta.origin || meta.caller)) || "unknown";
export const effectOf = (/** @type {string} */ name, /** @type {any} */ declared, /** @type {string} */ reach = "anyone") => (declared === "read" || declared === "write" ? declared : reach === "person" && READ_VERBS.has(String(name).split(".").pop() || "") ? "read" : "write");
/** The tools a module's manifest says change nothing (`does.reads`). @param {any} m */
const readsOf = (m) => new Set(m && m.does && Array.isArray(m.does.reads) ? m.does.reads.filter((/** @type {any} */ x) => typeof x === "string") : []);

export const callerKind = caller => {
  const c = String(caller);
  // "mcp:agent:<name>" and "mcp:thread:<id>" (a Vyre-owned session, ADR 0030) are both "mcp".
  // a browser `web:<id>` and a setup page `setup:<id>` (the relay listener, BR-2) are classes of their own, named only by a tool that lists them; so is an outside agent `ext:<id>` (core/outside)
  return c.startsWith("module:") ? "module" : /^web:[a-z2-7]{16}$/.test(c) ? "web" : /^setup:[a-z2-7]{16}$/.test(c) ? "setup" : idOfCaller(c) ? "ext" : c.replace(/[\s:](agent|thread):.*$/s, "");
};

/**
 * The agent name a caller claims, in any transport shape: "mcp:agent:kit", "harness:agent:kit",
 * "cli:agent:kit", "module:agent:kit", or just "agent:kit". Null when the caller makes no such
 * claim. computers, hands-desktop and sight each used to write their own version of this regex;
 * one of them (hands-desktop's resolveAgent) matched only the narrower "mcp:agent:" shape, so a
 * claim shaped "cli:agent:kit" fell through to full trust instead of being checked at all (e2e
 * review, 2026-09-28). One parser here, so a fix to it reaches every caller at once and a new
 * module never re-derives it. This only says what the caller *claims*; the daemon's own socket
 * layer is what actually refuses an unvouched claim (ADR 0031's agent-claim work).
 *
 * A claim with no name or an odd one ("cli agent:", "cli agent:???") still counts as a claim: it
 * must never come back as "" or another value every caller's `if (claim)` treats as no claim at
 * all, which would make an empty-named claim fully trusted instead of refused (e2e review,
 * 2026-09-28: the daemon's own socket vouch fails such a claim today, but an in-process caller
 * does not go through that layer, so this helper has to fail closed on its own).
 */
export const AGENT_CLAIM = /(?:^|[\s:])agent:([A-Za-z0-9_-]*)/;
export const agentClaim = caller => {
  const m = AGENT_CLAIM.exec(String(caller ?? ""));
  return m ? m[1] || "(unnamed)" : null;
};

/**
 * Person reach and the person's assistant (the user's ruling, 4 Oct 2026; core/modules/agent-reach.js holds the three lists with a reason for each entry). A caller that
 * carries an agent or thread claim, on any surface, is an assistant. A `reach: person` tool is OPEN to it unless it is on the person-only list (or on no list yet: a new tool
 * is refused until someone classifies it). It then runs under the person's own narrowed grants like any other call. An ASK_FIRST tool is open but held for a one-tap task
 * exactly like an outward one. An assistant reaches an open person tool from any of cli, local, mcp or harness: the surface label is not what decides it.
 * Safe only because the claim is assigned by the daemon from the session's own socket (L-1), never self-declared on the person's own socket.
 */
const claimsAgent = (/** @type {any} */ caller) => agentClaim(caller) !== null || /(?:^|[\s:])thread:/.test(String(caller ?? ""));
const AGENT_SURFACES = new Set(["mcp", "harness", "cli", "local"]);
/**
 * The assistant claim is PROVEN only when the daemon bound the call to a session: `meta.thread` is set by a session's own socket, or by a vouched agent key or session, and by
 * nothing a client can say. A label such as `mcp:thread:fake` or `cli:agent:kit` sent on the person's own socket proves nothing, so an unproven claim reaches no person-reach
 * tool at all (reviewer-2 R-1), while the open and ask-first lists apply to a proven one.
 */
const proven = (/** @type {any} */ meta) => Boolean(meta && typeof meta.thread === "string" && meta.thread);
export const personRefusesAgent = (/** @type {string} */ tool, /** @type {any} */ d, /** @type {any} */ caller, /** @type {any} */ meta) => d.reach === "person" && claimsAgent(caller) && (!proven(meta) || (!AGENT_OPEN.has(tool) && !AGENT_ASK_FIRST.has(tool)));
/** A person-reach tool that is open to this PROVEN assistant even though the surface label is not one of the person's own. */
export const agentOpensPerson = (/** @type {string} */ tool, /** @type {any} */ d, /** @type {any} */ caller, /** @type {any} */ meta) => d.reach === "person" && claimsAgent(caller) && proven(meta) && AGENT_SURFACES.has(callerKind(caller)) && (AGENT_OPEN.has(tool) || AGENT_ASK_FIRST.has(tool));
/** An open-but-ask-first tool called by an assistant (proven or not): held for a one-tap task, like an outward one, and never run unproven. */
export const agentAskFirst = (/** @type {string} */ tool, /** @type {any} */ caller) => AGENT_ASK_FIRST.has(tool) && claimsAgent(caller);

/**
 * The reach of the classes that are not the person's, and of a label nobody recognises: `false` for an unknown label (every tool, `callers: null` included), the class's own list for `web:<id>` and
 * `setup:<id>` (WEB_REACH, SETUP_REACH in agent-reach.js; a call that names no tool reaches nothing), and `null` for everyone else, who go on to the tool's `callers` list.
 * @param {string} caller @param {string} [tool] @param {() => string[]} [setupExtra] the tools shipped modules declare under setupTools (the registry's own list, read only for a setup caller)
 */
export const classReach = (caller, tool, setupExtra) => {
  const c = String(caller);
  if (!KNOWN_LABELS.has(c.split(/[\s:]/)[0])) return false;
  // an invitee's channel (core/relay) reaches no tool at all: its one door is the invitee peer stream
  if (c.split(/[\s:]/)[0] === "invitee") return false;
  // an outside agent (`ext:<id>`, core/outside), or anything that starts like one, reaches no registry tool: it speaks MCP at /agents-mcp, where the kernel decides under its own grants. Fail closed.
  if (c.split(/[\s:]/)[0] === "ext") return false;
  const k = callerKind(c);
  if (k === "web") return tool !== undefined && WEB_REACH.has(tool);
  if (k === "setup") return tool !== undefined && (SETUP_REACH.has(tool) || setupToolAllowed(tool, setupExtra === undefined ? [] : setupExtra()));
  return null;
};

/**
 * May this caller use a tool with this callers list? On a box the Deck is served at the tailnet
 * address, where the names listener admits only the owner and labels the call "tailnet:<login>"
 * (ADR 0002). That is the owner's own Deck, so a tool open to "deck" is open to it; an agent's own
 * node ("tailnet:agent:<name>") is not. A "tailnet" entry opens a tool to the owner's devices only,
 * such as the phone (ADR 0018). The bare word is never a caller itself: a socket client could send
 * it as a label.
 * @param {string[]|null|undefined} callers
 */
export const callerAllowed = (callers, caller, tool, setupExtra) => classReach(caller, tool, setupExtra) ?? (!callers || (callers.includes(callerKind(caller)) && !CLASS_ONLY.has(callerKind(caller)))
  || (callers.includes("deck") && ownerDevice(caller))
  || (callers.includes("tailnet") && ownerDevice(caller))
  || (callers.includes("device") && deviceLabel(caller)));

/**
 * Caller classes that exist only as an entry in a tool's `callers` list, never as a caller: a socket client could send the bare word as its label. "device" opens a tool to the owner's
 * paired devices (`device:<id>`, deviceLabel), the same devices a "tailnet" or "deck" entry already admits through ownerDevice. "space" (a visiting person, `space:<person>@<space>`) and
 * "agent" (`agent:<id>`) are declared next to "tailnet" so a later step can drop it, but nothing admits them yet: whether a visitor or an agent reaches a tool is the core contract's
 * to decide, not this list's.
 */
const CLASS_ONLY = new Set(["tailnet", "device", "space", "agent"]);

/**
 * The box's owner on their own device at the box's address: the tailnet listener names only the
 * verified owner `tailnet:<login>` (core/names/service.js); a guest is `tailnet-guest:` and an
 * agent's node `tailnet:agent:`. The owner's Deck and phone always arrive this way on a box.
 */
export const ownerOverTailnet = caller => /^tailnet:(?!agent:)./.test(String(caller));

/**
 * The owner on one of their own devices, however it reached the box: over the tailnet
 * (`tailnet:<owner>`), or a device paired through the relay (`device:<id>`, ADR 0026), which only
 * the relay module's listener names. A person who may ask; presence still decides every
 * human-only call. A guest, an agent's node and a socket label are never one.
 */
export const ownerDevice = caller => ownerOverTailnet(caller) || deviceLabel(caller);

/** A device paired through Wink or the relay, exactly `device:<id>` (the id is 16 base32 characters). Case, spacing, a prefix or a suffix is never one. */
export const deviceLabel = caller => /^device:[a-z2-7]{16}$/.test(String(caller));

/** A visiting person in a Space, exactly `space:<person>@<space>` (SPEC-wink-network 5.2). The caller of a Space they visit, never the owner's own device. */
export const spaceLabel = caller => /^space:[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(caller));

/** Shipped in the repo (core, local, modules), not added to a home's modules folder. @param {string} dir @param {any} paths */
const inRepo = (dir, paths) => {
  const d = path.resolve(dir), home = paths && paths.modules ? path.resolve(paths.modules) + path.sep : null;
  return d.startsWith(path.dirname(CORE_DIR) + path.sep) && !(home && d.startsWith(home));
};

/** Set only by Registry.callInSpace: a symbol key cannot arrive over the wire, so a call never claims to run in another Space by its own meta. */
const IN_SPACE = Symbol("vyre.in_space");
/** The person whose click on a module view authorises the FIRST hop only: that person may run this module's own tool as the view declares it. It is not an origin: nothing the tool calls inherits it. */
const VIEW_FOR = Symbol("vyre.view_for");
/** Set only by the views and capsule modules, beside `asked`: the person's own confirmation of exactly these words (a fresh preview and its hash). A symbol key cannot come over the wire. */
const VIEW_ASK = Symbol("vyre.view_ask");
/** Set only by Registry.callFlow, after the Flows host has spent the task approval a person gave for exactly this act: the call then counts as the person's own yes, as a redeemed card does. A symbol key cannot come over the wire. */
const FLOW_ACT = Symbol("vyre.flow_act");
/** Set only by a module's `ctx.call(tool, input, { relay: true })`: the running call's proven person (its `kernelFacts` or session `token`) carried into the next call. A symbol key cannot come over the wire. */
const RELAY = Symbol("vyre.relay");
/**
 * Which first-party module may relay the person it is acting for, and to which tools (a name, or a prefix ending in a dot). The Personal to My Cloud upgrade runs as the person in both Spaces: the spaces
 * module relays them to the chat and memory ports, and those relay them on to the per-member storage. Nothing else is open, and a relay needs a running call that has a person.
 */
const RELAY_ALLOWED = Object.freeze({
  spaces: ["work.chat.upgrade-plan", "work.chat.upgrade-move", "memory.upgrade.plan", "memory.upgrade.move"],
  memory: ["spaces.storage."],
  work: ["spaces.storage.", "vault.uses.for"], // vault.uses.for: the timeline asks, as the person looking
  publish: ["previews.folder"], // a files preview card publishes its own folder, as the person who pressed it
  vault: ["flows.connections"], // which Flows use a Connection, as the person looking at the credential (R031-70)
  // a terminal opened on a session resolves the thread as the person at it (threads.get answers for the chats that person is in)
  term: ["threads.get"],
  // appmods proposes the Kit an app ships (its record type and its Flow) as the installing person; the owner's yes in Now is what defines anything
  appmods: ["flows.kit.propose"],
});

export class Registry {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, events: any, config: any, log: (m: string, x?: any) => void,
   *           rules?: (call: { tool: string, input: any, caller: string }) => Promise<{ allow: boolean, reason?: string }>,
   *           handler?: (policy: any) => (req: any, res: any, caller: string) => Promise<void>, paths?: any,
   *           upgrader?: (policy: any) => (req: any, socket: any, head: any, caller: string) => void,
   *           presence?: import("../presence/index.js").Presence, coreKeys?: any, spaceDir?: (space: string) => string }} deps
   */
  constructor(deps) {
    this.deps = deps;
    /** Folders an in-process caller says hold Vyre's own modules (discover's firstPartyRoots). */
    this.firstPartyRoots = Array.isArray(deps && deps.firstPartyRoots) ? deps.firstPartyRoots.filter(r => typeof r === "string" && path.isAbsolute(r)) : [];
    /** @type {Map<string, { module: string, description: string, input: any, run: Function }>} */
    this.tools = new Map();
    /** @type {Map<string, { manifest: any, dir: string, state: string, error?: string, handle?: any }>} */
    this.modules = new Map();
    /** @type {Map<string, { module: string, handler: Function }>} WebSocket paths, keyed "<module>/<name>". */
    this.upgrades = new Map();
    /** @type {Map<string, (req: any, res: any, at: { caller: string, url: URL }) => any>} */
    this.routes = new Map();
    /** What each route declared: read-only, or the writing methods it answers. @type {Map<string, { readOnly: boolean, methods: string[] }>} */
    this.routeInfo = new Map();
    /** @type {Map<string, { module: string, driver: any }>} session providers (ADR 0030), by name */
    this.providers = new Map();
    /** A retried write runs once (ADR 0029, R2). */
    this.idempotency = deps && deps.db ? new Idempotency(deps.db) : null;
    /** The five-minute reuse windows a yes opened (lib/one-yes.js createReuse), and the old header methods already logged as deprecated. */
    this.reuse = createReuse();
    /** @type {Set<string>} */ this.legacySaid = new Set();
    // How often each module's tools were used by a person, a surface or a model (never by another
    // module or a webhook), and when last: what the hub and `vyre modules` show beside each one.
    // Kept in memory, loaded from and written to one kernel table. The loader owns it, so it is
    // not one module's migration.
    /** @type {Map<string, { calls: number, lastUsed: number }>} */
    this.use = new Map();
    /** @type {Set<string>} modules whose count changed since the last write */
    this.dirty = new Set();
    /** @type {NodeJS.Timeout | null} */
    this.flushTimer = null;
    if (deps && deps.db) {
      try {
        deps.db.exec("CREATE TABLE IF NOT EXISTS modules_use (module TEXT PRIMARY KEY, calls INTEGER NOT NULL, last_used INTEGER)");
        for (const r of /** @type {any[]} */ (deps.db.prepare("SELECT module, calls, last_used FROM modules_use").all())) {
          this.use.set(String(r.module), { calls: Number(r.calls) || 0, lastUsed: Number(r.last_used) || 0 });
        }
      } catch (e) { deps.log && deps.log(`module use counts unavailable: ${/** @type {Error} */ (e).message}`); }
    }
  }

  /** Vyre's own: shipped in the repo, or in a firstPartyRoots folder an in-process caller named. @param {string} dir */
  isFirstParty(dir) {
    // With a signed-release check wired (kernel/modules/firstparty.js, from the kernel boot) a module is first party only by signature: not by where it sits and not by its name.
    if (this.deps.firstPartyCheck) return this.deps.firstPartyCheck(dir) === true;
    return firstParty(dir) || inRoots(dir, this.firstPartyRoots);
  }

  /**
   * Count one use of a module's tool. The write waits: one timer, armed by the first change and
   * cleared by the write, so an idle vyred has nothing scheduled at all.
   * @param {string} module
   */
  countUse(module) {
    const u = this.use.get(module) || { calls: 0, lastUsed: 0 };
    this.use.set(module, { calls: u.calls + 1, lastUsed: Date.now() });
    this.dirty.add(module);
    if (!this.flushTimer && this.deps && this.deps.db) {
      this.flushTimer = setTimeout(() => this.flushUse(), USE_FLUSH);
      this.flushTimer.unref();
    }
  }

  /** Write the changed use counts. A closed or read-only database only costs the counts since. */
  flushUse() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const db = this.deps && this.deps.db;
    if (!db || !this.dirty.size) return;
    const names = [...this.dirty];
    this.dirty.clear();
    try {
      const put = db.prepare("INSERT INTO modules_use (module, calls, last_used) VALUES (?, ?, ?) ON CONFLICT(module) DO UPDATE SET calls = excluded.calls, last_used = excluded.last_used");
      for (const n of names) { const u = this.use.get(n); if (u) put.run(n, u.calls, u.lastUsed || null); }
    } catch { /* the counts stay in memory for status(); the next change tries again */ }
  }

  /** Start every discovered module that is enabled for this machine's role. `platform` is
   * injectable (default process.platform) so a test can cover the darwin server case on any CI
   * machine, same as roleBuckets() and core/config's defaults(). */
  async start(found, { role, enable = [], disable = [], platform = process.platform }) {
    /** @type {Map<string, string>} the # kinds offered so far, by module */
    const mentionKinds = new Map();
    // The names of the modules shipped with Vyre in this start, on or off on this machine: an added module can
    // never load under one, so it can't answer another module's tools (names.*, network.*) from first party code.
    // A name the release's signed list holds stays reserved even for a folder that fails it (`deps.reservedName`): that folder is refused, never loaded as an added module.
    const shipped = new Set(found.filter(x => x && x.manifest && typeof x.manifest.name === "string" && (this.isFirstParty(x.dir) || (this.deps.reservedName && this.deps.reservedName(x.manifest.name)))).map(x => x.manifest.name));
    for (const f of found) {
      const name = f.manifest && f.manifest.name;
      // A module with a problem never starts, but it never disappears without a word either: it
      // used to (a camelCase tool or event name failed validate() and the whole module just
      // was not there, with no line in the log to say why - found only by calling discover() by
      // hand). Every problem, and the two below, are logged at warn level as they happen, and
      // status() (vyre modules, /v1/modules) already carries the same reason for later.
      // Warnings (unknown keys, deprecated usages) are said once per start and never stop a load.
      for (const w of f.warnings || []) this.deps.log(`warn: module ${name || f.dir}: ${w}`);
      if (name && shipped.has(name) && !this.isFirstParty(f.dir)) {
        const error = `name "${name}" belongs to a module shipped with Vyre; an added module can't load under it, on or off`;
        this.modules.set(`${name}@${f.dir}`, { manifest: f.manifest, dir: f.dir, state: "invalid", error });
        this.deps.log(`warn: module ${name}@${f.dir} invalid: ${error}`);
        continue;
      }
      if (f.problems.length) {
        const error = f.problems.join("; ");
        // An invalid copy never takes the row of a module already loaded under its name, and one that shares a shipped module's name never gets here in any order (the shipped-names rule above).
        this.modules.set(name && !this.modules.has(name) ? name : name ? `${name}@${f.dir}` : f.dir, { manifest: f.manifest, dir: f.dir, state: "invalid", error });
        this.deps.log(`warn: module ${name || f.dir} invalid: ${error}`);
        continue;
      }
      const roles = f.manifest.roles || ["box", "local"];
      // "mac" and "windows" are "local" on that OS only (roleBuckets); box and local are themselves.
      const here = roleBuckets(role, platform);
      const on = !disable.includes(name) && (roles.some(r => (r === "mac" || r === "windows" ? roleBuckets(r, platform) : [r]).some(b => here.includes(b))) || enable.includes(name));
      // Two modules with one name: the first found wins (Vyre's own folders come before the
      // user's), and the other is reported, never silently dropped. A user's module named like a
      // core one once vanished without a word, and so did every tool it offered.
      // The exception is a name two of Vyre's own modules share on purpose for different machines
      // (the box's chrome and the Mac's chrome): a copy that is not on for this machine steps aside
      // for one that is, and stays listed as off, so which one runs never depends on folder order.
      if (this.modules.has(name)) {
        const prev = this.modules.get(name);
        const mine = this.isFirstParty(f.dir), theirs = this.isFirstParty(prev.dir);
        /** @param {{ manifest: any, dir: string }} rec @param {string} error */
        const reject = (rec, error) => { this.modules.set(`${name}@${rec.dir}`, { manifest: rec.manifest, dir: rec.dir, state: "invalid", error }); this.deps.log(`warn: module ${name}@${rec.dir} invalid: ${error}`); };
        // The two "added vs Vyre" branches below cannot be reached today: the shipped-names check at the top of the loop already sends an added copy of a
        // shipped name to `name@dir` as invalid, in either folder order. They stay as defence in depth; the invariant lives in that top check.
        if (mine && !theirs) {
          // Vyre's own module always owns its name, whatever the folder order: an added module found first steps aside.
          reject(prev, `a Vyre module named ${name} owns that name; this one is ignored`);
          this.modules.delete(name);
        } else if (!mine && theirs) {
          // An added module never takes or replaces a Vyre module's name, whether that one is on or off here.
          reject({ manifest: f.manifest, dir: f.dir }, `a Vyre module named ${name} owns that name; this one is ignored`);
          continue;
        } else if (!on) {
          this.modules.set(`${name}@${f.dir}`, { manifest: f.manifest, dir: f.dir, state: "off" });
          continue;
        } else if (mine && theirs && prev.state === "off") {
          this.modules.set(`${name}@${prev.dir}`, prev);
        } else {
          reject({ manifest: f.manifest, dir: f.dir }, `a module named ${name} is already loaded from ${prev.dir}; this one is ignored`);
          continue;
        }
      }
      // One provider per # kind: the first module found keeps it, and a later one that claims it fails.
      const taken = (Array.isArray(f.manifest.mentions) ? f.manifest.mentions : []).map(e => [e && e.kind, mentionKinds.get(e && e.kind)]).find(([, by]) => by && by !== name);
      if (taken) {
        const error = `mentions kind "${taken[0]}" is already offered by ${taken[1]}`;
        this.modules.set(name, { manifest: f.manifest, dir: f.dir, state: "invalid", error });
        this.deps.log(`warn: module ${name} invalid: ${error}`);
        continue;
      }
      for (const e of Array.isArray(f.manifest.mentions) ? f.manifest.mentions : []) if (e && e.kind) mentionKinds.set(e.kind, name);
      this.modules.set(name, { manifest: f.manifest, dir: f.dir, state: on ? "pending" : "off" });
    }
    const candidates = found.filter(f => { const r = this.modules.get(f.manifest && f.manifest.name); return r?.state === "pending" && r.dir === f.dir; });
    const { ordered, problems } = order(candidates);
    for (const [n, why] of problems) { Object.assign(this.modules.get(n), { state: "failed", error: why }); this.deps.log(`warn: module ${n} invalid: ${why}`); }
    for (const f of ordered) await this.startOne(f);
    return this.status();
  }

  async startOne(f) {
    const m = f.manifest, rec = this.modules.get(m.name);
    const failedDep = requiresOf(m).find(d => this.modules.get(d)?.state !== "running");
    if (failedDep) { Object.assign(rec, { state: "failed", error: `requires "${failedDep}", which is not running` }); return; }
    try {
      const entry = path.join(f.dir, m.main || "index.js");
      // Every module goes through the adapter for the contract it names (compat/v<major>.js, the
      // identity for contract 1 today), so a later major can keep it running unchanged.
      rec.contract = moduleContract(m);
      const adapter = adapterFor(rec.contract);
      if (m.apiVersion !== undefined) this.deps.log(`warn: module ${m.name} uses apiVersion, which is deprecated; use "vyre": "${m.apiVersion}"`);
      // K6: with a module host wired (kernel/modules/host.js), a module that is not first party never runs in this process. It runs under the
      // supervisor (no network, no files beyond its folder, no child process), its tools call into it, and it has no ctx: only its tool handlers
      // and the egress proxy. Without the supervisor the host refuses and the module fails to start. Off until the kernel default-on path.
      if (this.deps.moduleHost && !this.isFirstParty(f.dir)) {
        const ctx = this.context(m);
        // The module's ctx is this host-side one; the sandbox reaches each door by message (core/modules/sandbox-ctx.js), so an added module runs the same contract as a built-in one.
        const door = sandboxDoor({ name: m.name, ctx, dataDir: path.join((this.deps.paths && this.deps.paths.root) || os.tmpdir(), "data", m.name) });
        await this.deps.moduleHost.install({ name: m.name, dir: f.dir, entry: m.main || "index.js", manifest: m }, { approved_hosts: this.deps.moduleApprovals ? this.deps.moduleApprovals(m.name) : [], ctx: door });
        for (const e of toolEntries(m)) ctx.tool(e.name, { description: e.description || "", run: (/** @type {any} */ input, /** @type {any} */ meta) => this.deps.moduleHost.call(m.name, e.name, input, meta ? { caller: meta.caller, who: meta.who, agent: meta.agent, thread: meta.thread, project: meta.project } : undefined) });
        rec.handle = { stop: async () => { door.close(); await this.deps.moduleHost.uninstall(m.name); } };
        rec.sandboxed = true;
        rec.state = "running"; delete rec.error;
        this.deps.log(`module ${m.name} ${m.version} running (sandboxed)`);
        return;
      }
      const mod = (await import(pathToFileURL(entry).href)).default;
      if (!mod || typeof mod.start !== "function") throw new Error("entry file must export default { start(ctx) }");
      rec.handle = await mod.start(adapter.context(this.context(adapter.manifest(m))));
      rec.state = "running"; delete rec.error;
      this.deps.log(`module ${m.name} ${m.version} running`);
    } catch (e) {
      Object.assign(rec, { state: "failed", error: /** @type {Error} */ (e).message });
      // A module that failed only because the Space's record store is still starting is started again when the store joins (startStoreWaiting).
      if (/** @type {any} */ (e) && /** @type {any} */ (e).code === "unavailable") rec.waitsForStore = true; else delete rec.waitsForStore;
      for (const [t, def] of this.tools) if (def.module === m.name) this.tools.delete(t);
      for (const [k, u] of this.upgrades) if (u.module === m.name) this.upgrades.delete(k);
      for (const [k] of this.routes) if (k.startsWith(`/v1/${m.name}/`)) { this.routes.delete(k); this.routeInfo.delete(k); }
      this.deps.log(`module ${m.name} failed to start: ${/** @type {Error} */ (e).message}`, { at: String(/** @type {Error} */ (e).stack || "").split("\n").slice(1, 4).map(l => l.trim().replace(/^at /, "")).join(" < ") });
    }
  }

  /** The record store has joined: start again every module that failed because it was away, then the ones that failed for needing one of them. */
  async startStoreWaiting() {
    const failed = () => [...this.modules.values()].filter((/** @type {any} */ r) => r.state === "failed");
    const again = failed().filter((/** @type {any} */ r) => r.waitsForStore);
    for (const r of again) await this.startOne({ manifest: r.manifest, dir: r.dir });
    const up = new Set(again.filter((/** @type {any} */ r) => r.state === "running").map((/** @type {any} */ r) => r.manifest.name));
    for (const r of failed()) {
      const dep = String(/** @type {any} */ (r).error || "").match(/^requires "([^"]+)", which is not running$/);
      if (dep && up.has(dep[1])) await this.startOne({ manifest: r.manifest, dir: r.dir });
    }
  }

  /**
   * `ctx.kernel.for(space).call(tool, input, chain)`: run a module tool in a hosted Space's own instance, under the chain the caller holds THERE (`kernel.chainIn(space, meta)`), after that
   * Space's own `authorize` allows the action the tool declares (`crossSpace` in its manifest entry, a kernel action name). Modules only: the handle is a first-party module's ctx, never on the
   * wire. A tool that declares no `crossSpace` is refused, and the other Space's store is never read from here: the tool runs, routed by `meta.in_space`, in that Space's instance.
   * @param {any} m the calling module's manifest @param {any} h its kernel handle
   */
  withCrossSpace(m, h) {
    const reg = this;
    const forSpace = (/** @type {string} */ id) => {
      const base = h.for(id);
      if (!base || base.hosted !== true || !base.gateway) return base; // a remote Space is reached by its own client, not by a module tool here
      return Object.freeze({ ...base, call: (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ chain) => reg.callInSpace(m, id, base, tool, input, chain) });
    };
    // an own-key copy, getters kept live (`owner` follows an adoption), so the handle shows exactly the keys the kernel gave it (kernel/home.test.js)
    return Object.freeze(Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(h), for: { value: forSpace, enumerable: true } }));
  }

  /**
   * The Space the running call is for: `meta.in_space` (set only by callInSpace, or inherited from the turn that was), or null for the home's own Space. A Space that is not hosted here is null too,
   * so a call can never reach a store this home does not keep.
   * @param {any} home the module's home kernel handle
   */
  spaceOfCall(home) {
    const c = currentCall();
    const sp = c && typeof c.in_space === "string" ? c.in_space : null;
    if (!sp || !home || sp === home.space) return null;
    const base = home.for(sp);
    return base && base.hosted === true ? sp : null;
  }

  /**
   * The module's store (ctx.store): `db` and `dir` follow the Space the running call is for. The home's own Space keeps vyre.db as ever; every other hosted Space gets the module its OWN SQLite file
   * (`<home>/kernel/spaces/<space>/modules/<module>.db`, the module's own migrations replayed into it) and its own data folder, so two Spaces' rows never touch. A module reaches the right one by
   * calling `ctx.store.db` inside the call (a statement prepared once at start belongs to the home's Space).
   * @param {any} m @param {any} db the home database @param {() => any} homeOf the module's home kernel handle (undefined for a module with no kernel)
   */
  routedStore(m, db, homeOf) {
    const reg = this;
    /** @type {string[][]} */ const lists = [];
    /** @type {Map<string, any>} */ const opened = reg.spaceDbs || (reg.spaceDbs = new Map());
    const dbFor = (/** @type {string} */ sp) => {
      const key = `${sp}/${m.name}`;
      let d = opened.get(key);
      if (!d) {
        if (typeof reg.deps.spaceDir !== "function") throw new Error("this home keeps no per-Space module stores");
        d = openStore(path.join(reg.deps.spaceDir(sp), "modules", `${m.name}.db`));
        for (const steps of lists) migrate(d, m.name, steps);
        opened.set(key, d);
      }
      return d;
    };
    const current = () => { const sp = reg.spaceOfCall(homeOf()); return sp ? dbFor(sp) : db; };
    const routed = new Proxy({}, {
      get: (_t, k) => { const real = current(); const v = real[k]; return typeof v === "function" ? v.bind(real) : v; },
      has: (_t, k) => k in current(),
    });
    return {
      db: routed,
      // Async, the same shape an added module reaches its own file with (core/modules/sandbox-ctx.js), so one module source runs in either place.
      exec: async (/** @type {string} */ sql, /** @type {any[]} */ params = []) => { const r = current().prepare(String(sql)).run(...params); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params = []) => current().prepare(String(sql)).all(...params).map((/** @type {any} */ r) => ({ ...r })),
      migrate: (/** @type {string[]} */ steps) => { lists.push(steps); migrate(db, m.name, steps); for (const [key, d] of opened) if (key.endsWith(`/${m.name}`)) migrate(d, m.name, steps); },
      /** The module's own data folder for a Space (the running call's by default), created on first use. @param {string} [space] */
      dir: (/** @type {string | undefined} */ space) => {
        const sp = space ?? reg.spaceOfCall(homeOf());
        const base = sp && typeof reg.deps.spaceDir === "function" ? path.join(reg.deps.spaceDir(sp), "modules", m.name) : path.join(reg.deps.paths && reg.deps.paths.root ? reg.deps.paths.root : ".", "modules", m.name);
        fs.mkdirSync(base, { recursive: true, mode: 0o700 });
        return base;
      },
    };
  }

  /**
   * The module's kernel handle (ctx.kernel), following the Space the running call is for: the home's own handle normally, a hosted Space's own (`kernelFor` of THAT Space's kernel: its own records,
   * log, grants and service chain for this module) when the call runs there. Everything else about the handle is the home's, as ever.
   * @param {any} m @param {any} home
   */
  routedKernel(m, home) {
    const reg = this;
    /** @type {Map<string, any>} */ const hostedHandles = new Map();
    const current = () => {
      const sp = reg.spaceOfCall(home);
      if (!sp) return home;
      let h = hostedHandles.get(sp);
      if (!h) {
        const k = home.for(sp).kernel;
        if (!k || typeof k.kernelFor !== "function") return home;
        h = reg.withCrossSpace(m, k.kernelFor(m));
        hostedHandles.set(sp, h);
      }
      return h;
    };
    return new Proxy({}, {
      get: (_t, k) => current()[k],
      has: (_t, k) => k in current(),
      ownKeys: () => Reflect.ownKeys(home),
      getOwnPropertyDescriptor: (_t, k) => (k in home ? { value: current()[k], enumerable: true, configurable: true, writable: false } : undefined),
    });
  }

  /** @param {any} m @param {string} space @param {any} base the hosted handle @param {string} tool @param {any} input @param {any} chain */
  async callInSpace(m, space, base, tool, input, chain) {
    const def = this.tools.get(tool);
    if (!def) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    if (!def.crossSpace) return { error: { code: "not_declared", message: `${tool} does not declare that it may run in another Space` } };
    if (!chain || typeof chain !== "object" || !Array.isArray(chain.hops) || chain.space !== space) return { error: { code: "denied", message: "the chain is not for that Space" } };
    let verdict = null;
    try { verdict = await base.gateway.authorize({ chain, action: def.crossSpace, resource: `vyre://${space}/tool/${tool}` }); } catch { verdict = null; }
    if (!verdict || verdict.effect !== "allow") return { error: { code: "denied", message: "you have no right to do that in that Space" } };
    // judged as the caller class the running call came from, as ctx.call does: a module acting for a person is the person's reach, never more
    const origin = captureOrigin();
    return this.call(tool, input, `module:${m.name}`, { ...(origin ? { origin } : {}), [IN_SPACE]: { space, chain } });
  }

  /** What a module gets. It sees only what its manifest declared. */
  context(m) {
    const { db, events, config, log, paths } = this.deps;
    // The kernel handle (kernel/home.js `kernelFor`): only for a first-party module, and only when the daemon runs with the kernel on.
    // An added module that declared `needs.kernel.records` (the record types it may make, read and change) gets narrow verbs, never the handle: they run under the person who installed it, with the module
    // beside them as an external hop, and only on the declared types (the daemon's `moduleKernel` builds them). The rest of the kernel is not a door.
    const addedKernel = (() => {
      const r = this.modules.get(m.name), nk = m.needs && m.needs.kernel;
      if (!nk || !r || this.isFirstParty(r.dir) || !this.deps.moduleKernel) return undefined;
      const strs = (/** @type {any} */ v) => (Array.isArray(v) ? v.filter((/** @type {any} */ t) => typeof t === "string") : []);
      const want = { records: strs(nk.records), files: strs(nk.files) };
      return want.records.length || want.files.length ? this.deps.moduleKernel.doors(m.name, want) : undefined;
    })();
    const homeKernel = (() => { const r = this.modules.get(m.name); return this.deps.kernelFor && r && this.isFirstParty(r.dir) ? this.withCrossSpace(m, this.deps.kernelFor(m)) : undefined; })();
    const kernelHandle = homeKernel ? this.routedKernel(m, homeKernel) : undefined;
    // Tool names from either form of does.tools, with the reach and outward an object entry declares.
    const entries = new Map(toolEntries(m).map(e => [e.name, e]));
    const objectForm = new Set(((m.does && m.does.tools) || []).filter(e => e && typeof e === "object").map(e => e.name));
    const declared = new Set(entries.keys());
    const needs = m.needs || {};
    /** A door used without its one declaration (ADR 0047 section 3). @param {string} why */
    const undeclared = why => Object.assign(new Error(`${m.name}: ${why}`), { code: "undeclared" });
    const firstPartyRec = () => { const r = this.modules.get(m.name); return Boolean(r && this.isFirstParty(r.dir)); };
    /**
     * A ctx door onto its owning tool, as module:<name>. The door has checked its own declaration,
     * so default-deny doesn't apply. When the owner isn't running on this Vyre, the answer is
     * { error: { code: "not_available" } } naming the tool, never a crash.
     * @param {string} tool @param {any} input
     */
    const door = async (tool, input) => {
      const r = await this.call(tool, input, `module:${m.name}`, { door: true });
      if (r.error && r.error.code === "no_such_tool") return { error: { code: "not_available", message: `${tool} isn't running on this Vyre yet` } };
      return r;
    };
    /** The same, for a member that answers a value: a refusal throws, with its code. @param {string} tool @param {any} input */
    const doorValue = async (tool, input) => {
      const r = await door(tool, input);
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.data;
    };
    const spendDeclared = member => { if (!needs.spend) throw undeclared(`${member}, but needs.spend declares no daily cap`); };
    // The ctx members that reach outside the module (ADR 0047 section 3), each held to its one
    // declaration and made as a call onto the tool that owns it. Until that owner ships, the
    // member answers not_available (docs/MODULES.md marks which are there now).
    const setting = key => {
      const d = (Array.isArray(m.settings) ? m.settings : []).find(x => x && x.key === key);
      if (!d) throw undeclared(`used setting ${key}, which its manifest does not declare`);
      return d;
    };
    const doors = {
      // Its own declared settings, through the settings hub; without the hub, the declared default.
      settings: {
        get: async (key, o = {}) => {
          const d = setting(key);
          const r = await door("settings.get", { key, ...(o.project ? { project: o.project } : {}) });
          if (r.error && r.error.code === "not_available") return d.default;
          if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
          return r.data && r.data.value !== undefined ? r.data.value : d.default;
        },
        set: async (key, value, o = {}) => {
          const d = setting(key);
          if (d.confirm !== undefined || d.security !== undefined) throw Object.assign(new Error(`${key} asks the person before a change; a module can't set it`), { code: "denied" });
          await doorValue("settings.write", { key, value, ...(o.project ? { project: o.project } : {}) });
        },
        on: (key, fn) => {
          setting(key);
          return events.on("settings.changed", e => { const p = e && e.payload; if (p && p.key === key) { try { fn(p.value, { key, ...(p.project ? { project: p.project } : {}) }); } catch {} } });
        },
      },
      push: {
        offer: async n => {
          if (!n || typeof n.kind !== "string" || !((m.shows && m.shows.notices) || []).includes(n.kind)) throw undeclared(`ctx.push.offer a ${n && n.kind} notice, which shows.notices does not list`);
          const r = await doorValue("push.offer", { ...n, from: `module:${m.name}` });
          return r === "deferred" || (r && r.deferred) ? "deferred" : "sent";
        },
      },
      undo: { record: async e => door("undo.record", { ...e, from: `module:${m.name}` }) },
      connections: {
        call: async (provider, tool, input = {}) => {
          if (!((needs.connections) || []).some(c => c && c.provider === provider)) throw undeclared(`called the ${provider} connection, which needs.connections does not declare`);
          return door("mcp.call", { server: provider, tool, arguments: input });
        },
      },
      // Uncredentialed reads need the module host's resolver (private addresses refused after DNS
      // and on every redirect, ADR 0047 section 5). Until the host lands there is no safe way to
      // make one from vyred, so fetch refuses: not_available.
      fetch: async (url, init = {}) => {
        const method = String((init && init.method) || "GET").toUpperCase();
        if (!["GET", "HEAD"].includes(method) || (init && init.body !== undefined)) throw Object.assign(new Error("ctx.fetch sends GET or HEAD with no body; to send data use ctx.vault.request or an outward tool"), { code: "method_not_allowed" });
        let host = "";
        try { host = new URL(url).hostname; } catch {}
        if (!((needs.network) || []).some(h => { const n = String(h).split(":")[0]; return n.startsWith("*.") ? host.endsWith(n.slice(1)) : host === n; })) throw undeclared(`fetched ${host}, which needs.network does not list`);
        throw Object.assign(new Error("a module's fetch arrives with the module host; it isn't available in this Vyre yet; wait for an update"), { code: "not_available" });
      },
      ask: async (prompt, o = {}) => {
        spendDeclared("ctx.ask");
        // Every ask is billed against the module's cap, so without core/spend there is no ask.
        const check = await door("spend.check", { module: m.name, purpose: o.purpose, capUsd: needs.spend.dailyUsd });
        if (check.error) return check;
        if (check.data && check.data.ok === false) return { error: { code: "capped", message: `${m.name} reached its daily cap` } };
        const r = await door("threads.quick", { purpose: "helper", prompt: String(prompt) });
        if (r.error) return r;
        const usd = Number(r.data && r.data.cost_usd) || 0;
        await door("spend.record", { module: m.name, usd, purpose: `module:${m.name}/${o.purpose}` });
        return { text: String((r.data && r.data.text) || ""), usd };
      },
      spend: {
        record: async e => { spendDeclared("ctx.spend.record"); return doorValue("spend.record", { ...e, module: m.name }); },
        check: async purpose => { spendDeclared("ctx.spend.check"); return doorValue("spend.check", { module: m.name, purpose, capUsd: needs.spend.dailyUsd }); },
      },
      gate: {
        request: async req => {
          if (!((needs.tools) || []).includes("gate.request")) throw undeclared("ctx.gate.request, but needs.tools does not list gate.request");
          return doorValue("gate.request", req);
        },
      },
    };
    /** vault.request: a vendor call with a credential it never sees (vault P5). @param {string} id @param {any} req */
    const vaultRequest = async (id, req = {}) => {
      if (!((needs.credentials) || []).some(c => c && c.id === id)) throw undeclared(`asked the vault for ${id}, which needs.credentials does not declare`);
      // module and credential come last, so nothing in the request can name another (reviews N1).
      return doorValue("vault.request", { ...req, module: m.name, credential: id });
    };
    return {
      name: m.name, version: m.version, config, paths,
      // The contract this Vyre speaks, and feature tests for additions inside the major.
      api: { version: CONTRACT.current, has: (/** @type {string} */ f) => LOADER_FEATURES.includes(String(f)) },
      // Every running module's declared settings (module.json "settings"), for the settings
      // module to serve. Manifests are public; a module switched off takes its settings with it.
      declaredSettings: () => [...this.modules.entries()].filter(([, r]) => r.state === "running" && r.manifest && Array.isArray(r.manifest.settings))
        // module and firstParty come from the loader, after the declaration, so a manifest can't claim them.
        .flatMap(([name, r]) => r.manifest.settings.map(d => ({ ...d, module: name, firstParty: this.isFirstParty(r.dir) }))),
      // The tools shipped modules put on the pre-claim setup channel (module.json "setupTools"),
      // for the relay to build its allowlist from. Only a shipped module's field counts, only for a
      // tool it declares and owns, and never a relay, presence or vault tool: an added module's field is ignored.
      declaredSetupTools: () => this.declaredSetupTools(),
      // Every running module's teaches.tips, for the tips module to choose from (core/tips). Tips
      // are plain text a module chose to show; the tips module checks them, never this loader.
      // firstParty: shipped in the repo, so its tips follow Vyre's version, not the module's own.
      declaredTips: () => [...this.modules.entries()]
        .filter(([, r]) => r.state === "running" && r.manifest && r.manifest.teaches && Array.isArray(r.manifest.teaches.tips))
        .map(([name, r]) => ({ module: name, version: r.manifest.version, firstParty: inRepo(r.dir, paths), tips: r.manifest.teaches.tips })),
      // The module's namespace in vyre.db: migrations are bound to its name, so its tables must
      // carry that name. Reads may join any table; writes to another module's tables go through
      // that module's tools.
      store: this.routedStore(m, db, () => homeKernel),
      // A function for built in callers, with the levels module API 1 names (ADR 0047 section 3).
      log: Object.assign((msg, extra) => log(`[${m.name}] ${msg}`, extra), {
        info: (msg, extra) => log(`[${m.name}] ${msg}`, extra),
        warn: (msg, extra) => log(`warn: [${m.name}] ${msg}`, extra),
        error: (msg, extra) => log(`error: [${m.name}] ${msg}`, extra),
        debug: (msg, extra) => log(`debug: [${m.name}] ${msg}`, extra),
      }),
      events: {
        emit: (type, payload, where) => {
          const allowed = (m.watches && m.watches.emits) || [];
          if (!allowed.includes(type)) throw new Error(`${m.name} emitted ${type}, which its manifest does not declare under watches.emits`);
          return events.emit(m.name, type, payload, where);
        },
        // A handler hears the event as the call that raised it was made (RG-2): a model-originated call that emits an event does not become the module's own authority in the handler.
        on: (pattern, fn) => events.on(pattern, (/** @type {any} */ ev) => { const o = captureOrigin(); if (!o) return fn(ev); const r = withOrigin(o, () => fn(ev)); if (r && typeof r.catch === "function") r.catch(() => {}); }),
        origin: () => captureOrigin(),
        withOrigin: (/** @type {string | undefined} */ o, /** @type {() => any} */ f) => withOrigin(o, f),
        since: (id, opts) => events.since(id, opts),
        // One thread's own events, oldest first (an indexed read of the log).
        ofThread: (thread, opts) => events.ofThread(thread, opts),
        // Delete every event of a thread (what the person asked for when they deleted it, whichever module said it): the threads module's alone.
        eraseThread: (thread) => { if (m.name !== "threads") throw new Error("only the threads module deletes a thread's events"); return events.eraseThread(thread); },
        // The cursor a read is current to (ADR 0029 R1): a view that loads through a tool, then
        // follows the stream from this id, has no gap.
        latestId: () => events.latestId(),
        // Delete this module's own redundant events (see Events.prune): only types it declares
        // under watches.emits, and only rows it emitted itself.
        prune: (type, opts = {}) => {
          const allowed = (m.watches && m.watches.emits) || [];
          if (!allowed.includes(type)) throw new Error(`${m.name} pruned ${type}, which its manifest does not declare under watches.emits`);
          return events.prune({ ...opts, type, source: m.name });
        },
      },
      // Vault items, one at a time, only those the manifest declares under needs.vault. The value
      // comes from the vault module's internal vault.release tool, which only modules can call,
      // and which sees which module asked. A "per-<thing>" entry ("per-watcher", "per-agent",
      // "per-sender") declares a module that fetches on behalf of things it runs, whose items are
      // named at run time; it must check each one's own declaration, and the grant still decides.
      // `field` picks one field of an item (a login's password, say); `watcher` is for the
      // watcher runtime, whose grants are per watcher.
      ...doors,
      vault: {
        request: vaultRequest,
        fetch: async (name, { field, watcher, deployment } = {}) => {
          const declared = [...((m.needs && m.needs.vault) || []), ...credentialItems(m)];
          if (!declared.includes(name) && !declared.some(d => d.startsWith("per-")) && !multipleItem(m, name)) throw new Error(`${m.name} asked the vault for ${name}, which its manifest does not declare under needs.vault or needs.credentials`);
          const r = await this.call("vault.release", { name, ...(field ? { field } : {}), ...(watcher ? { watcher } : {}), ...(deployment ? { deployment } : {}) }, `module:${m.name}`, { door: true });
          if (r.error) throw new Error(r.error.code === "no_such_tool" ? "the vault is not running on this machine" : r.error.message);
          return r.data && r.data.value;
        },
      },
      // Facts for the curator's queue, of the kinds declared under teaches.memory. Memory decides
      // what to keep; a module never writes Memory's tables. Without Memory running, a no-op.
      memory: {
        // A memory row through iq's memory.write, of a kind declared under teaches.memory. vyred
        // sets from, and an added module's rows are always untrusted (ADR 0047 section 3).
        write: async row => {
          const kind = row && row.kind;
          if (!((m.teaches && m.teaches.memory) || []).includes(kind)) throw undeclared(`ctx.memory.write a ${kind}, which teaches.memory does not list`);
          const fp = firstPartyRec();
          return door("memory.write", { ...row, from: `module:${m.name}`, ...(fp ? {} : { untrusted: true }) });
        },
        teach: async (kind, fact) => {
          const declared = (m.teaches && m.teaches.memory) || [];
          if (!declared.includes(kind)) throw new Error(`${m.name} taught ${kind}, which its manifest does not declare under teaches.memory`);
          const r = await this.call("memory.teach", { kind, fact, from: m.name }, `module:${m.name}`, { door: true });
          return !r.error;
        },
      },
      // Another module's tool, through the same path as every caller: input checked, rules run.
      // This is the only way one module uses another; never import its files.
      // `as` calls under another caller label: only a core module, and only a label CALL_AS
      // gives it. A manifest cannot grant this, so a module installed into a home never can.
      call: (tool, input, opts) => {
        const as = opts && opts.as;
        const rec = this.modules.get(m.name);
        // firstParty: the loader's word that this module ships in the repo, for a tool that must
        // trust a first-party caller only (a home module could take a free name). Same mechanism
        // as memory-iq's 2ecf79ba (reviewer-cleared, 0.1.1 batch) — kept identical, not a second one.
        const fp = Boolean(rec && this.isFirstParty(rec.dir));
        // An added module calls only what needs.tools names, one by one: module.* is for Vyre's
        // own. Its own tools need no entry (reviews/platform.md CR-H2, as testing.js does).
        // A context with no registry row (the docs harvest builds one to read tool schemas) is no
        // module the registry started; every started module has its row before start() runs.
        if (!as && rec && !fp && addedNever(tool)) {
          return Promise.reject(Object.assign(new Error(`${m.name} called ${tool}, which an added module can never use: leave that call out of the module`), { code: "denied" }));
        }
        if (!as && rec && !fp && !declared.has(tool) && !((m.needs && m.needs.tools) || []).includes(tool)) {
          return Promise.reject(Object.assign(new Error(`${m.name} called ${tool}, which needs.tools does not list`), { code: "undeclared" }));
        }
        // opts.onPartial: a tool that streams (threads.quick with stream: true) hands its partial text to
        // this function, on this call only. Never the events bus, and never over a connection.
        if (opts && opts.relay === true) {
          const allow = /** @type {Record<string, string[]>} */ (RELAY_ALLOWED)[m.name];
          if (!fp || !allow || !allow.some(a => tool === a || (a.endsWith(".") && tool.startsWith(a)))) return Promise.reject(Object.assign(new Error(`${m.name} may not relay the person to ${tool}`), { code: "undeclared" }));
          const cur = currentCall();
          if (!cur || (!cur.kernelFacts && typeof cur.token !== "string")) return Promise.reject(Object.assign(new Error("there is no person on this call to relay: have the person start the call from their own session"), { code: "denied" }));
          const origin = captureOrigin();
          return this.call(tool, input, `module:${m.name}`, { ...(origin ? { origin } : {}), [RELAY]: { kernelFacts: cur.kernelFacts, token: cur.token } });
        }
        if (!as) {
          // A module hop carries the caller class the running call came from (reviewer-2's group D, 2): a tool the registry defaulted to person-only checks the ORIGINAL caller, so a module acting
          // for an agent is still an agent call. A call with no running call (a timer, a start) has no origin and is the module's own.
          const origin = captureOrigin();
          return this.call(tool, input, `module:${m.name}`, { firstParty: fp, ...(origin ? { origin } : {}), ...(opts && typeof opts.onPartial === "function" ? { partial: opts.onPartial } : {}) });
        }
        // The capsule module sits in local/capsule (the Mac app's), and is first party there.
        const core = Boolean(rec && (path.resolve(rec.dir).startsWith(CORE_DIR + path.sep) || (m.name === "capsule" && fp)));
        const allowed = /** @type {any} */ (CALL_AS)[m.name];
        if (!core || !(typeof allowed === "function" ? allowed(String(as)) : (allowed || []).includes(String(as)))) throw new Error(`${m.name} may not call ${tool} as ${as}`);
        // mentions replays the asking person to a provider's search tool, never to any other tool.
        checkRelayTool(m.name, tool, input, String(as));
        if (m.name === "pluginagent" && tool !== "agents.delete") throw new Error(`pluginagent may not call ${tool} as ${as}: it relays the revoking person to agents.delete only`);
        // agents relays the asking person to threads.send alone (agents.ask's tags), never to any other tool.
        if (m.name === "agents") checkAgentsRelay(tool, String(as));
        // A screen of the space's own (core/design) is its own declaration: the owner said yes to the screen and the tools it names, so the views module may run them as the person who opened it.
        const spaceScreen = m.name === "views" && opts && opts.space === true && !String(as).startsWith("module:");
        if ((m.name === "capsule" || m.name === "views") && !spaceScreen && !this.capsuleMayCall(String(as), tool)) throw new Error(`capsule may not call ${tool} as ${as}: no Capsule view of that module declares it`);
        if (m.name === "mentions" && !this.mentionTools(String(as).startsWith("module:") ? "resolve" : "search").has(tool)) throw new Error(`mentions may not call ${tool} as ${as}: no first-party provider names it`);
        // settings relays a person only to the tools first-party modules declared as their own
        // settings' getters and setters, never to any other tool (e2e review, HIGH 2).
        if (m.name === "settings" && !this.settingTools().has(tool)) throw new Error(`settings may not call ${tool} as ${as}: no first-party setting names it`);
        // pluginagent relays the revoking person to agents.delete WITH that person's own verified facts and proof (the ones its own revoke call arrived with), so the agent's reach grants are taken back in the person's own act
        const relayed = m.name === "pluginagent" && tool === "agents.delete" && opts && opts.relay && typeof opts.relay === "object" ? { ...(opts.relay.kernelFacts ? { kernelFacts: opts.relay.kernelFacts } : {}), ...(opts.relay.kernel_proof ? { kernel_proof: opts.relay.kernel_proof } : {}) } : {};
        // agents relays the asking person to threads.send and threads.release WITH that person's own verified facts (the ones their agents.ask arrived with): the chat gate judges the person, and a
        // relay without them would be refused for every person who asks an agent from a device.
        const cur = m.name === "agents" && agentsMayRelay(tool) ? currentCall() : null;
        const asked = cur ? { ...(cur.kernelFacts ? { kernelFacts: cur.kernelFacts } : {}), ...(typeof cur.token === "string" ? { token: cur.token } : {}) } : {};
        // A view the person opened authorises ONE hop: this person may run this module's own tool as the view declares it, so a tool with no declared reach is judged as the person's click and not as a timer
        // (RG-2). Inside that tool every ctx.call is judged as the module with no person origin: an added module cannot reach a person-only tool through it.
        const viewFor = (m.name === "capsule" || m.name === "views") && String(as).startsWith("module:") ? captureOrigin() : undefined;
        // the link on a Mac types or answers for the person at its paired box as `link:box` AFTER checking the box (the pinned key's assertion, the pinned channel): the Mac's own chat gate then judges that call as the Mac's owner
        const boxPerson = m.name === "link" && String(as) === "link:box" && typeof this.deps.linkBoxFacts === "function" ? { kernelFacts: this.deps.linkBoxFacts() } : {};
        return this.call(tool, input, String(as), { ...boxPerson, ...((m.name === "capsule" || m.name === "views") && opts.asked && typeof opts.asked === "object" ? { asked: opts.asked, [VIEW_ASK]: opts.asked } : {}), ...(viewFor ? { [VIEW_FOR]: viewFor } : {}), ...relayed, ...asked });
      },
      // A long-lived connection (a WebSocket) at /v1/streams/<module>/<name>, for what a tool call
      // cannot carry: Glass streams a screen this way. The name must be declared under
      // shows.streams. The handler gets the raw upgrade (req, socket, head) and the caller, and
      // owns the socket from then on, including closing it when the module stops.
      upgrade: (name, handler) => {
        const declared = (m.shows && m.shows.streams) || [];
        if (!declared.includes(name)) throw new Error(`${m.name} registered stream ${name}, which its manifest does not declare under shows.streams`);
        if (typeof handler !== "function") throw new Error(`stream ${name} needs a handler`);
        this.upgrades.set(`${m.name}/${name}`, { module: m.name, handler });
      },
      // vyred's router, for a module that opens a listener of its own (names, onboard). The module
      // establishes the caller; the policy limits what that listener can reach. See ADR 0002.
      // What every module is, read only: the rows GET /v1/modules gives, including what each
      // declares (commands, connections, suggest, notices, emits) and how much it is used. A copy,
      // so nothing a module does to it changes the registry.
      modules: {
        status: () => structuredClone(this.status()),
        // The tools a caller may use, as GET /v1/tools gives them to it. For a module that lists
        // what a surface can run (commands.list), never for deciding a call: the registry does that.
        tools: caller => structuredClone(this.listTools(caller ? String(caller) : undefined)),
        // Is this tool marked `outward` in its module.json? The one place the outward moment is decided (internal tools included).
        isOutward: name => Boolean((this.tools.get(String(name)) || {}).outward),
      },
      // The box's keys held by vyre-core (lib/vyre-core-keys.js), for the relay module alone: its dh
      // and signature would let any module that held them speak as the box. Null where core has none.
      coreKeys: m.name === "relay" && firstParty(String((this.modules.get(m.name) || {}).dir || "")) ? this.deps.coreKeys || null : null,
      handler: policy => { if (!this.deps.handler) throw new Error("this vyred has no router to hand out"); return this.deps.handler(policy); },
      // The same for WebSocket upgrades (/v1/streams/...): (req, socket, head, caller). Without it
      // a module's listener cannot carry a stream, and Glass over the tailnet never connected.
      upgrader: policy => { if (!this.deps.upgrader) throw new Error("this vyred has no stream router to hand out"); return this.deps.upgrader(policy); },
      // A tool on the user's box, from a module on the Mac: the link module carries it over the
      // tailnet. Resolves like call(), and to { error: { code: "box_unreachable" } } when the
      // box cannot be reached, so a caller can fall back to what this machine has.
      remote: async (tool, input = {}) => {
        // Only Vyre's own modules reach another machine. An added module gets an answer, not a forward.
        if (!firstPartyRec()) return { error: { code: "denied", message: "only Vyre's own modules may reach another machine" } };
        const r = await this.call("link.remote", { tool, input }, `module:${m.name}`, { door: true });
        return r.error && r.error.code === "no_such_tool" ? { error: { code: "no_link", message: "this machine is not linked to a box" } } : r.data && r.data.result ? r.data.result : r;
      },
      // A raw HTTP route on vyred's socket at /v1/<module>/<name>, for what a tool cannot carry:
      // a stream. The route sees the caller the router established; it never reads one itself.
      // `opts` is required: { readOnly: true } for a route that only reads (a GET answers with no side effect), or { methods: ["PUT"] } for
      // one that writes and answers only those methods, never GET. A route is reached with whatever a request carries, and a GET
      // can be made by any page the person opens, so one that changes something must not answer GET (reviews/platform.md, fetch-site rule).
      route: (name, fn, opts) => {
        if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`route ${name} must be lowercase letters, digits and dashes`);
        const writes = opts && Array.isArray(opts.methods) && opts.methods.length > 0 && opts.methods.every(x => ["POST", "PUT", "PATCH", "DELETE"].includes(x));
        if (!(opts && (opts.readOnly === true || writes))) throw new Error(`route ${m.name}/${name} must say { readOnly: true } or { methods: ["PUT"] }`);
        if (opts.readOnly === true && writes) throw new Error(`route ${m.name}/${name} is read-only or writes, not both`);
        const at = `/v1/${m.name}/${name}`;
        if (this.routes.has(at)) throw new Error(`route ${at} is already registered`);
        this.routes.set(at, fn);
        this.routeInfo.set(at, { readOnly: opts.readOnly === true, methods: writes ? [...opts.methods] : ["GET", "HEAD"] });
      },
      // A session provider: a driver the Switchboard runs sessions on (core/sessions/provider.js).
      // Declared under does.providers; it must pass core/sessions/conformance.js.
      provider: (name, driver) => {
        const mine = (m.does && m.does.providers) || [];
        if (!mine.includes(name)) throw new Error(`${m.name} registered provider ${name}, which its manifest does not declare under does.providers`);
        if (this.providers.has(name)) throw new Error(`provider ${name} is already registered`);
        if (!driver || typeof driver.run !== "function") throw new Error(`provider ${name} needs a run function`);
        this.providers.set(name, { module: m.name, driver });
      },
      // What every module is, read only: the rows GET /v1/modules gives, including what each
      // declares (commands, connections, suggest, notices, emits) and how much it is used. A copy,
      // so nothing a module does to it changes the registry.
      modules: {
        status: () => structuredClone(this.status()),
        // The tools a caller may use, as GET /v1/tools gives them to it. For a module that lists
        // what a surface can run (commands.list), never for deciding a call: the registry does that.
        tools: caller => structuredClone(this.listTools(caller ? String(caller) : undefined)),
        // Is this tool marked `outward` in its module.json? The one place the outward moment is decided (internal tools included).
        isOutward: name => Boolean((this.tools.get(String(name)) || {}).outward),
      },
      providers: {
        get: name => { const p = this.providers.get(String(name)); return p ? p.driver : null; },
        list: () => [...this.providers.keys()],
      },
      ...(kernelHandle ? { kernel: kernelHandle } : (addedKernel ? { kernel: addedKernel } : {})),
      // The home's peer door for a paired device's stream, set by the daemon (core/daemon/peer-door.js); only the relay module bridges it.
      // This device's open peer session to a server it paired (`sessionFor(serverId)` -> { call, close }) and the kernel's remote client over it, handed up by the wink module; only the modules that
      // reach a paired server's kernel are given them (spaces: where a space is hosted; runner: lending), late-bound because wink starts after them.
      ...(["spaces", "runner", "files"].includes(m.name) ? {
        sessionForReady: () => typeof (/** @type {any} */ (this.deps)).winkSessionFor === "function",
        sessionFor: (/** @type {string} */ id) => { const f = (/** @type {any} */ (this.deps)).winkSessionFor; if (typeof f !== "function") throw Object.assign(new Error("this device has no way to reach a paired server yet: pair it with a server first"), { code: "unavailable" }); return f(id); },
        // an invitee's session to the home a space's directory record names (the spaces module only; the hello is signed by the invitee's identity)
        ...(m.name === "spaces" ? { inviteeSessionFor: (/** @type {any} */ channel, /** @type {any} */ hello, /** @type {any} */ about) => { const f = (/** @type {any} */ (this.deps)).winkInviteeSessionFor; if (typeof f !== "function") throw Object.assign(new Error("this device has no way to reach that space yet: accept the invitation to it on this device first"), { code: "unavailable" }); return f(channel, hello, about); } } : {}),
        remoteKernel: (/** @type {string} */ id, /** @type {string} */ space) => { const f = (/** @type {any} */ (this.deps)).remoteKernel; if (typeof f !== "function") throw Object.assign(new Error("this device has no way to reach a paired server yet: pair it with a server first"), { code: "unavailable" }); return f(id, space); },
      } : {}),
      // the presence module confirms a local yes with the daemon's own verifier (Touch ID, the terminal code), the one the registry's floor already holds
      ...(m.name === "presence" && (/** @type {any} */ (this.deps)).presence ? { verifier: (/** @type {any} */ (this.deps)).presence } : {}),
      ...(m.name === "relay" || m.name === "wink" ? { peerDoor: () => (/** @type {any} */ (this.deps)).peerDoor ? (/** @type {any} */ (this.deps)).peerDoor() : undefined } : {}),
      // What a module hands UP to the daemon and the other launcher modules, by a fixed name and once: the vault provides `credentialsPort` (the session launcher's way to a provider sign-in
      // token) at its own start. Anyone else, or a second time, is refused, so the port cannot be taken by whatever starts later.
      provide: (/** @type {string} */ name, /** @type {any} */ value) => provideOnce(this.deps, m.name, name, value),
      // What only the daemon can hand a module comes by DECLARATION, not by a name: a first-party module lists it under needs.daemon and gets exactly that on ctx. kernelSession is the
      // maker of a Vyre-started session's kernel credential, sandbox the confined spawner for those sessions (the runner's home sandbox, composed by the daemon because core/sessions
      // cannot import core/runner), flowsHost the Flows assembly (core/daemon/flows-host.js).
      ...Object.fromEntries((Array.isArray(m.needs && m.needs.daemon) ? m.needs.daemon : []).filter((/** @type {string} */ n) => ["kernelSession", "chatFor", "agentActor", "listModels", "kernelThreads", "sandbox", "flowsHost", "credentials", "modulesListReset", "modulesListResetPayload", "dataStores", "devStandIn", "cliSigninPayload", "cliSigninCheck", "cliSessions", "tunnelEnd"].includes(n) && this.deps[n]).map((/** @type {string} */ n) => [n, this.deps[n]])),
      tool: (name, def) => {
        if (!declared.has(name)) throw new Error(`${m.name} registered tool ${name}, which its manifest does not declare under does.tools`);
        if (this.tools.has(name)) throw new Error(`tool ${name} is already registered`);
        if (typeof def.run !== "function") throw new Error(`tool ${name} needs a run function`);
        // internal: only other modules may call it (never Claude, the CLI or a surface), and it is
        // left out of every listing. vault.release is the reason this exists.
        // callers: the kinds of caller that may use it ("cli", "local", "mcp", "module"); a
        // tool is refused to, and left out of the listing for, any other. Omitted means all.
        // hook: reachable only as vyred's webhook route POST /v1/<module>/<name>/hook (caller
        // "hook"), and left out of every listing. The tool checks its own secret.
        // core: vyre-core answers it on this Mac and checks its proof itself (ADR 0040 phase 2);
        // only a first-party module may say so, since it turns vyred's own presence check off.
        if (def.core && !(this.modules.get(m.name)?.dir && this.isFirstParty(/** @type {string} */ (this.modules.get(m.name)?.dir)))) throw new Error(`${m.name} is not one of Vyre's own modules, so ${name} can't be a vyre-core tool`);
        // A declared reach (ADR 0047) sets the same checks: modules is internal, hook is the webhook
        // route, and person is the person's own surfaces and devices only. anyone and asked stay
        // open here; the asked check and outward routing are later build steps (plans/platform.md).
        const e = entries.get(name), reach = e ? e.reach : "anyone";
        // RG-1: every tool open to anyone declares what it does. `does.reads` names the tools that change nothing (or `effect` on a tool entry, or on `ctx.tool`); a tool that declares nothing is a WRITE,
        // so it is the person's surfaces and modules until its owner says otherwise. The read-verb guess survives only for a person-reach tool, which is person-only anyway.
        const declaredEffect = def.effect || (e && e.effect) || (readsOf(m).has(name) ? "read" : undefined);
        const effect = effectOf(name, declaredEffect, reach);
        // the once-only default: a state-changing tool open to anyone that declares no callers list is the person's surfaces and modules, with the original caller checked on a module hop
        const defaulted = reach === "anyone" && !Array.isArray(def.callers) && effect === "write" && !def.hook && !def.internal;
        this.tools.set(name, { module: m.name, description: def.description || "", input: def.input || { type: "object" }, run: def.run, effect, defaulted, effectDeclared: Boolean(declaredEffect),
          internal: Boolean(def.internal) || reach === "modules",
          // a `person` tool is open to the person's classes only; the one class a tool may add by name is `web` (a browser, `web:<id>`: BR-2), never `device`, `space` or `agent`
          callers: reach === "person" ? [...PERSON_CALLERS, ...(Array.isArray(def.callers) ? def.callers.filter(c => c === "web") : [])] : Array.isArray(def.callers) ? def.callers : defaulted ? [...ORIGIN_PERSON] : null,
          hook: Boolean(def.hook) || reach === "hook", presence: def.presence || false, core: Boolean(def.core),
          reach, outward: (e && e.outward) || null, flowStep: e && e.flowStep ? (this.isFirstParty(/** @type {string} */ (this.modules.get(m.name)?.dir)) || e.flowStep.risk === "outward" ? e.flowStep : { ...e.flowStep, risk: "outward", forced: true }) : null, asks: Boolean(e && e.asks), covers: e && Array.isArray(e.covers) && this.isFirstParty(/** @type {string} */ (this.modules.get(m.name)?.dir)) ? e.covers.filter((/** @type {any} */ x) => typeof x === "string" && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(x)).slice(0, 4) : [], target: (e && e.target) || null, projectArg: (e && e.projectArg) || null, cwdArg: (e && e.cwdArg) || null, projectIsRecord: Boolean(e && e.projectIsRecord), declaredReach: objectForm.has(name), crossSpace: e && typeof e.crossSpace === "string" && /^[a-z][a-z0-9_.]{1,63}$/.test(e.crossSpace) ? e.crossSpace : null });
      },
    };
  }

  /** The tools a Flow's call step may run, with their risk and typed fields: `[{ name, risk: "read" | "outward", summary, inputs, outputs }]`. Declared by the module (`flow.steps` in its manifest), never by a Flow. */
  flowTools() {
    return [...this.tools.entries()].filter(([, d]) => d.flowStep && !d.internal).map(([name, d]) => ({ name, risk: d.flowStep.risk, summary: d.flowStep.label || d.description || "", inputs: d.flowStep.inputs || {}, outputs: d.flowStep.outputs || {}, covers: Array.isArray(d.covers) ? d.covers : [] }));
  }

  /** The ways a running module offers to start a Flow (`flow.triggers`): `[{ name, label, trigger: { on: "event", event } | { on: "watcher", watcher }, inputs }]`. A Flow stores the `trigger`, a kind that already exists. */
  flowTriggers() {
    return [...this.modules.values()].filter(r => r.state === "running" && r.manifest).flatMap(r => flowTriggers(r.manifest));
  }

  /**
   * Run a flow.steps tool for a Flow, as the person whose Flow it is (`token` is their kernel session, so the module's own `ctx.kernel.chain(meta)` is that person). The host calls this
   * only for a read tool or after it spent the Flow's one approval for exactly this act (the kernel's task approval, bound to the input): the tool's own outward hold is the same yes, never a second.
   * Nothing a tool or a client sends can reach this: only the daemon's flows host holds the registry. @param {string} tool @param {any} input @param {{ token: string, task?: string }} o (`task`: the approved task the host just spent for this act)
   */
  async callFlow(tool, input, o) {
    const def = this.tools.get(tool);
    if (!def || !def.flowStep) return { error: { code: "no_such_tool", message: `${tool} is not a step a Flow can run` } };
    if (def.flowStep.risk === "outward" && !def.outward && !def.flowStep.forced) return { error: { code: "denied", message: `${tool} says it is an outward step but is not marked outward` } };
    if (!o || typeof o.token !== "string" || !o.token) return { error: { code: "denied", message: "a Flow step runs as a person: it needs that person's session" } };
    return this.call(tool, input, "module:flows", { origin: "deck", token: o.token, ...(typeof o.task === "string" && def.outward === true ? { [FLOW_ACT]: { task: o.task } } : {}) });
  }

  /**
   * Did the person's own words ask for this tool (reach "asked")? Asks vault.said.match, which
   * matches the person's turn in this thread or its lineage, or a standing permission, and uses a
   * plain ask up. Fails closed: no vault, a locked vault, an error or no thread answers no.
   * A tool with a `target` (an internal tool of its own module) binds the yes to what the call acts on: the target
   * answers { to: [string] } for this call's input, and that answer is the whole `to` of the match (each entry a
   * composite key of the tool and the thing it acts on). An error or an empty answer is no.
   * @param {string} tool @param {{ thread?: string, agent?: string }} meta @param {any} [def] @param {any} [input]
   */
  async saidMatch(tool, meta, def, input) {
    if (!this.tools.has("vault.said.match")) return false;
    try {
      /** @type {string[]} */ let to = [tool];
      if (def && def.target) {
        // The target is a module's own code answering for a call that may not be the person's: late is no.
        const t = await within(this.call(def.target, { tool, input }, "module:vyred", { door: true, ...(/** @type {any} */ (meta).granted !== undefined ? { granted: /** @type {any} */ (meta).granted } : {}) }), TARGET_MS);
        if (!t) return false;
        const extra = t && t.data && Array.isArray(t.data.to) ? t.data.to.filter((/** @type {any} */ x) => typeof x === "string" && x) : [];
        if (!extra.length) return false;
        to = extra;
      }
      const thread = typeof meta.thread === "string" ? meta.thread : undefined;
      let lineage;
      if (thread && this.tools.has("threads.lineage")) {
        const l = await within(this.call("threads.lineage", { thread }, "module:vyred", { door: true }), TARGET_MS);
        if (!l) return false;
        if (l.data && Array.isArray(l.data.lineage)) lineage = l.data.lineage;
      }
      const r = await this.call("vault.said.match", { kind: "act_out", via: tool.split(".")[0], to, consume: true, ...(thread ? { thread } : {}), ...(lineage ? { lineage } : {}), ...(meta.agent ? { agent: meta.agent } : {}) }, "module:vyred", { door: true });
      return Boolean(r.data && r.data.matched === true);
    } catch { return false; }
  }

  /**
   * Run a tool. Every call goes through the rules before it runs, whoever made it: Claude through
   * MCP, a surface through HTTP, or the CLI. That is the point of having one path.
   */
  /**
   * @param {string} tool @param {any} [input] @param {string} [caller]
   * @param {{ thread?: string, agent?: string, peer?: any, proof?: any, call?: string }} [meta] what vyred verified about the
   *   caller: the live thread (session id) it is calling from, the agent it is, and the tailnet
   *   node a network listener established. A tool gets these beside the caller; a claim in the
   *   input is not verified and must not be treated as if it were. `proof` is the presence proof
   *   the request carried, checked here and not passed on. `call` is the chat's id for this
   *   tool call (X-Vyre-Call-Id, only on a session's own paths): an unverified claim a tool may
   *   keep to link what it shows (a Glass step) to the chat's tool row, and never use for any
   *   decision. `granted` (with `agentKind`) is the verified agent's stored project grant, "*" or
   *   slugs, read by vyred from the agents module; a tool that scopes by project trusts it, never an
   *   input filter. Any other key a caller of this method adds reaches the tool the same way.
   */
  /** The tools shipped modules put on the pre-claim setup channel: only a shipped module's field, only for a tool it declares and owns, never a relay, presence or vault tool. */
  declaredSetupTools() {
    return [...this.modules.entries()]
        .filter(([, r]) => r.state === "running" && r.manifest && Array.isArray(r.manifest.setupTools) && this.isFirstParty(r.dir))
        .flatMap(([name, r]) => r.manifest.setupTools.filter((/** @type {any} */ t) => typeof t === "string" && t.startsWith(name + ".") && toolEntries(r.manifest).some(e => e.name === t) && !/^(relay|presence|vault)\./.test(t)));
  }

  /**
   * What the older outward kind words (send, post, pay, delete) and the ask-first agent tools do for a caller who is not the person: the held answer (placeholders resolved first, the held card told the field
   * names), or null when this is not such a call. One place, used by the registry's own gates and by the kernel retrofit gates (kernel/retrofit/gates.js), so both give the same answer.
   * @param {{ tool: string, def: any, caller: string, input: any, meta: any }} o
   */
  async outwardRefusal({ tool, def, caller, input, meta }) {
    if (!(((typeof def.outward === "string" && def.outward) || agentAskFirst(tool, caller)) && !isPerson(caller))) return null;
    // What a held act will carry: any `{{field:...}}` the assistant put in its input is resolved NOW, for the person the turn is for, so a value they cannot read refuses the action
    // before anything is held, and the approver is shown which fields (names only here, never the values) will be filled in and which sealed ones the door will merge at the send.
    /** @type {any} */ let held = {};
    if (def.outward && PLACEHOLDER.test(JSON.stringify(input))) {
      try {
        if (!this.deps.resolveFields || typeof meta.token !== "string") throw Object.assign(new Error("a placeholder in an outward action needs the session it came from"), { code: "placeholder_unreadable" });
        const r = await this.deps.resolveFields({ tool, input, meta });
        held = { resolved: r.resolved, slots: r.slots, bound: r.bound };
      } catch (e) {
        // One refusal for every reason (RF-2): the model must not learn that a record exists, that a field is readable or which ones are sealed.
        return { error: { code: "placeholder_unreadable", message: "a value this action names is not readable by the person it is for, so nothing was sent" } };
      }
      // The field names, the sealed slots and the hash of what was resolved reach the approver through the held card only (the Gate's `held` hook), never through the model's answer.
      if (typeof this.deps.held === "function") { try { await this.deps.held({ tool, caller, thread: meta.thread, ...held }); } catch { /* the hold is the same either way */ } }
  }
  return { error: { code: "held_unavailable", message: `${tool} acts as you outside. A call from anyone but you is held at the Gate, and that routing lands with the Gate wiring; until then it runs only from your own surface.` } };
  }

  async call(tool, input = {}, caller = "unknown", { proof = null, yes: yesProof = null, terminal = null, idempotencyKey = undefined, door = false, ...meta } = {}) {
    const def = this.tools.get(tool);
    if (!def) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    // `origin` is set only by a module's own ctx.call (the caller class the running call came from); nothing a client sends is ever one.
    if (!String(caller).startsWith("module:")) delete meta.origin;
    delete meta.relayedBy; // set below, by the registry relay alone
    delete meta[COVERED]; // set below, only by a card this call just redeemed
    const flowAct = meta[FLOW_ACT]; delete meta[FLOW_ACT]; // set by callFlow alone (below it becomes the same mark a redeemed card makes)
    const viewAsk = meta[VIEW_ASK]; delete meta[VIEW_ASK]; // set by the views and capsule modules alone: the person confirmed these exact words
    // `in_space` and `in_space_chain` say the call is running in another hosted Space's instance, after that Space's authorize allowed it (callInSpace). Only the symbol that method sets can
    // make them: whatever a client or a module sends under those names is dropped here.
    delete meta.in_space; delete meta.in_space_chain;
    // A relayed call is the RELAYED PERSON's call (reviewer-5): it is judged as that person with firstParty false everywhere, so a gate that lets first-party callers through (the switchboard chat gate) never lets
    // a relayed person into what they are not in. The module's name stays on the call for audit only (`relayedBy`).
    let relayed = false;
    { const relay = meta[RELAY]; delete meta[RELAY]; if (relay && String(caller).startsWith("module:")) { relayed = true; meta.relayedBy = String(caller); delete meta.kernelFacts; delete meta.token; if (relay.kernelFacts) meta.kernelFacts = relay.kernelFacts; if (typeof relay.token === "string") meta.token = relay.token; } }
    { const cross = meta[IN_SPACE]; delete meta[IN_SPACE]; if (cross && String(caller).startsWith("module:")) { meta.in_space = cross.space; meta.in_space_chain = cross.chain; } }
    // `meta.terminal`: the login terminal the daemon measured for this call (atTerminal), or null; only the daemon's own `terminal` argument sets it, never anything a client or a module sends in meta.
    delete meta.terminal;
    if (terminal && (typeof terminal === "string" || typeof terminal === "object")) meta.terminal = terminal;
    // An approval id (a card the owner's phone answered, core/approvals) rides beside the call, never in its input: it is taken out here so no tool sees it, and only a device caller's is read.
    let approval = typeof meta.approval === "string" && /^ap_[A-Za-z0-9_-]{6,40}$/.test(meta.approval) ? meta.approval : null;
    delete meta.approval;
    // the retry of a held act carries `approval: <id>` as an input field too (the shape the apps build to): taken out here unless the tool declares a property of that name
    if (!approval && input && typeof input === "object" && !Array.isArray(input) && typeof input.approval === "string" && !(def.input && def.input.properties && Object.hasOwn(def.input.properties, "approval"))) {
      if (/^ap_[A-Za-z0-9_-]{6,40}$/.test(input.approval)) approval = input.approval;
      const { approval: _drop, ...rest } = input; input = rest;
    }
    // `standalone` says the caller is the standalone Chrome runtime's own MCP session (local/hands-chrome-mac/standalone/runtime.js hands it to a tool directly, never through here): nothing that comes
    // through the registry, from a client or a module, may claim it.
    delete meta.standalone;
    // A tool the registry defaulted to person-only is reached by a module only when the module is acting FOR a person (the call it relays came from one): a module with no origin (a timer, a start,
    // a direct call) is not that person, and must have its tool declare `callers: ["module"]` to be allowed (RG-2). The daemon's own calls (module:vyred) are the daemon.
    const viewFor = typeof meta[VIEW_FOR] === "string" && String(caller).startsWith("module:") ? meta[VIEW_FOR] : null;
    delete meta[VIEW_FOR];
    const hop = def.defaulted && String(caller).startsWith("module:") && caller !== "module:vyred";
    const gateCaller = hop ? (meta.origin || viewFor || "module-without-origin") : caller;
    // An agent that only proposes (the Engineer: agents.scope names its `only` list, vyred puts it on meta.agentOnly from the stored row, never from the call) reaches those tools and no others. This is
    // judged before the static gates, whichever of the two paths below decides them: it used to sit inside the path without the kernel retrofit, so a daemon with the kernel on never applied it.
    if (Array.isArray(meta.agentOnly) && !meta.agentOnly.includes(tool)) return { error: { code: "denied", message: `${tool} is not one of the tools this assistant works with: it drafts and proposes, and a person approves` } };
    // The static permission gates, up to the input schema. With deps.gates (the kernel retrofit, kernel/retrofit/gates.js)
    // they are decided by `authorize` over grants compiled from the rules below; without it the rules below run as written.
    // The golden set (kernel/golden) proves the two give the same answer for every tool, caller and world.
    if (this.deps.gates) {
      const refused = await this.deps.gates.before({ tool, def, caller: gateCaller, meta, input, door });
      if (refused) return refused;
    } else {
      // Default-deny for an added module (ADR 0047, reviews/platform.md H4): it reaches only a tool
      // whose reach is declared, and never one declared for Vyre's own modules. `door` is the
      // loader's own ctx doors (vault.fetch, memory.teach, remote), which check their own declarations.
      if (!door && String(caller).startsWith("module:")) {
        const from = this.modules.get(String(caller).slice(7));
        // A module's own tools are its own business, in either form.
        if (from && from.dir && def.module !== from.manifest?.name && !this.isFirstParty(from.dir) && (!def.declaredReach || def.reach === "modules")) {
          return { error: { code: "not_declared", message: `${tool} is not open to added modules` } };
        }
      }
      // Fail closed until the Gate's routing and the P17 match are wired into the registry
      // (reviews/platform.md CR-H1): an outward tool runs only from the person's own surface or
      // device, and an asked tool never runs for a model, the harness or a module, since nothing
      // here can yet tell that the person's own words asked for it.
      // The plain mark `outward: true` is what the one-yes moment reads (isOutward); a tool so marked keeps its own held flow for an agent (publish's requests, github's asked, apps.send's proof,
      // vault's Gate sender), which this fail-closed stand-in would pre-empt. Only the older kind words (send, post, pay, delete) are held here.
      { const held = await this.outwardRefusal({ tool, def, caller, input, meta }); if (held) return held; }
      if (def.internal && !String(caller).startsWith("module:")) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
      if (Boolean(def.hook) !== (caller === "hook")) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
      // a browser (`web:<id>`) and a setup page (`setup:<id>`) are none of the person's classes (BR-2): each reaches only its own short list (WEB_REACH, SETUP_REACH), whatever a tool's `callers` says, and a label nobody
      // recognises reaches nothing. The relay's setup gate (core/relay/setup.js) still holds the setup channel to its own list first.
      if (classReach(gateCaller, tool, () => this.declaredSetupTools()) === false) return ["web", "setup"].includes(callerKind(gateCaller)) ? { error: { code: "no_such_tool", message: `no tool ${tool}` } } : { error: { code: "denied", message: `${tool} is not available to ${callerKind(caller)} callers` } };
      if (!(callerAllowed(def.callers, gateCaller, tool, () => this.declaredSetupTools()) || agentOpensPerson(tool, def, gateCaller, meta)) || personRefusesAgent(tool, def, gateCaller, meta)) return { error: { code: "denied", message: `${tool} is not available to ${callerKind(caller)} callers` } };
      // A guest from another tailnet is never a person proving they are here, whatever proof it
      // carries: presence is the owner's (ADR 0014 part 8), and so is the keyboard of an agent's
      // computer, which needs no proof (PERSON_ONLY). The router already hides these tools.
      if (String(caller).startsWith("tailnet-guest:") && (PERSON_ONLY.has(tool) || (this.deps.presence ? this.deps.presence.required(tool, def, input) : def.presence))) {
        return { error: { code: "denied", message: `${tool} is the owner's; a guest never approves or proves presence` } };
      }
      // Over the tailnet a node signed in as the owner, and over the relay a paired device
      // (`device:<id>`), is the owner's device, and so is any script on it (ADR 0032). The person's
      // own actions there need the person's session too (core/presence/person.js): every tool that declares `reach: person` is one (an owner's app device that has not signed in gets
      // no deck-like surface from its label alone),
      // which only vyred's router sets, from a cookie or a signed bearer token. Signing in is the one
      // way to get it, and the first passkey is enrolled with onboarding's code.
      if (ownerDevice(caller) && !meta.person && !PERSON_FREE.has(tool) && !machineSelf(tool, input)
        && (PERSON_ONLY.has(tool) || def.reach === "person" || (this.deps.presence ? this.deps.presence.required(tool, def, input) : Boolean(def.presence)))) {
        return { error: { code: "person_session_required", message: `${tool} is the person's own action: sign in on this device with your passkey first` } };
      }
    }
    // The tools that hand out credentials, names, access or devices check the ORIGINAL caller on a module hop whatever their callers list says (a module relaying for an agent is not the person).
    // Owners of other tools read `meta.origin` themselves (`originClass(meta)`); a loader door call (vault.fetch for a tool's own credential) is its own check.
    if (!door && String(caller).startsWith("module:") && meta.origin && ORIGIN_CHECKED.some(re => re.test(tool)) && !callerAllowed(ORIGIN_PERSON, meta.origin)) {
      return { error: { code: "denied", message: `${tool} is the person's own: a module acting for ${callerKind(meta.origin)} callers may not use it` } };
    }
    const problems = checkInput(def.input, input);
    if (problems.length) return { error: { code: "bad_input", message: problems.join("; ") } };
    // Undeclared input keys are refused (reviewer-2's group D, 3): a tool that lists its properties takes those and no others, so a handler that spreads the rest of its input into something
    // stronger (threads.start into launch) is never handed a key its schema did not name. A schema with no properties list, or one that says additionalProperties, is taken as written; a module's
    // own call is not held to it (a module knows its tool's real keys), and the loader's door calls are not either.
    if (!door && !String(caller).startsWith("module:") && def.input && def.input.type === "object" && def.input.properties && def.input.additionalProperties === undefined && input && typeof input === "object") {
      const extra = Object.keys(input).filter(k => !Object.hasOwn(def.input.properties, k));
      if (extra.length) return { error: { code: "bad_input", message: `${tool} does not take ${extra.slice(0, 5).join(", ")}` } };
    }
    // One keying scheme: a project is named by its Project record's id (or its vyre:// address). The tools behind the project tabs still work on the short name, so a declared projectArg given as
    // an id or an address is turned into the short name here, once, for every module alike; a short name goes through as it is (a person at a terminal types it). An id Records does not know is not_found.
    /** @type {Record<string, any> | null} what a record-keyed tool is handed back after the grant check, which judges the short name */
    let recordKept = null;
    if (def.projectArg && input && typeof input === "object") {
      for (const arg of (Array.isArray(def.projectArg) ? def.projectArg : [def.projectArg])) {
        const v = input[arg];
        const ids = (Array.isArray(v) ? v : [v]).map(x => projectRecordIdOf(x));
        if (!ids.some(Boolean)) continue;
        const slugs = [];
        for (const [k, x] of (Array.isArray(v) ? v : [v]).entries()) {
          if (!ids[k]) { slugs.push(x); continue; }
          const ref = await within(this.call("work.project.ref", { project: ids[k] }, "module:vyred", { door: true }), TARGET_MS);
          if (!ref || ref.error || !ref.data || typeof ref.data.slug !== "string") return { error: { code: "not_found", message: "no such project" } };
          slugs.push(ref.data.slug);
        }
        if (def.projectIsRecord) (recordKept ||= {})[arg] = v;
        input = { ...input, [arg]: Array.isArray(v) ? slugs : slugs[0] };
      }
    }
    // A tool that takes a project declares projectArg, and one that takes a folder declares cwdArg. An agent's call for a
    // project it is not granted (or a folder in one) is refused here, once, for every module alike: the one door is
    // projects.reach (owner's revokes and the assistant's rule included). not_found, so a refusal never says whether the
    // project exists. What was checked is what runs: a named project is rewritten to the canonical slug that was authorized.
    // The tool gets meta.reach for what it lists; with no answer on the agent's grant it gets nothing (fail closed).
    if ((def.projectArg || def.cwdArg) && agentClaim(caller) !== null) {
      const fields = (/** @type {any} */ spec) => (spec ? (Array.isArray(spec) ? spec : [spec]) : []);
      const valuesOf = (/** @type {string} */ arg) => {
        const v = input && typeof input === "object" ? input[arg] : undefined;
        return v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v];
      };
      const refuse = { error: { code: "not_found", message: "no such project" } };
      const named = fields(def.projectArg).flatMap(valuesOf);
      const folders = fields(def.cwdArg).flatMap(valuesOf);
      const r = await within(this.call("projects.reach", { caller: String(caller), kind: "content", ...(meta && (meta.thread || meta.agent) ? { thread: meta.thread || "", claim: meta.agent || null } : {}) }, "module:vyred", { door: true }), TARGET_MS);
      const reach = r && r.data && typeof r.data === "object" ? r.data : null;
      if (!reach) {
        if (named.length || folders.length) return refuse;
        meta = { ...meta, reach: { all: false, projects: [] } };
      } else {
        const granted = reach.all ? null : (Array.isArray(reach.projects) ? reach.projects : []).filter((/** @type {any} */ p) => p && typeof p.slug === "string");
        if (granted) {
          // A name or a slug, exactly; a slug first. Anything else (an object, a number) is no.
          const canon = (/** @type {any} */ v) => typeof v !== "string" ? null : (granted.find((/** @type {any} */ p) => p.slug === v) || granted.find((/** @type {any} */ p) => p.name === v) || {}).slug || null;
          if (named.some(v => canon(v) === null)) return refuse;
          let rewritten = input;
          for (const arg of fields(def.projectArg)) {
            const v = input && typeof input === "object" ? input[arg] : undefined;
            if (v === undefined || v === null || v === "") continue;
            rewritten = { ...rewritten, [arg]: Array.isArray(v) ? v.map(canon) : canon(v) };
          }
          input = rewritten;
          // A folder belongs to the project that owns it; one in no project is refused for an agent with an explicit list.
          if (folders.length) {
            let scoped = null;
            /** @type {Map<string, string>} the folder as given -> the real folder projects.of judged */
            const canonical = new Map();
            for (const cwd of folders) {
              const o = typeof cwd === "string" ? await within(this.call("projects.of", { cwd }, "module:vyred", { door: true }), TARGET_MS) : null;
              const slug = o && o.data && typeof o.data.slug === "string" ? o.data.slug : null;
              if (slug) {
                if (!granted.some((/** @type {any} */ p) => p.slug === slug)) return refuse;
                // What was judged is what runs: the tool gets the real folder (no `..`, no symlink), not the string it was sent.
                if (typeof o.data.folder === "string" && o.data.folder) canonical.set(cwd, o.data.folder);
                continue;
              }
              if (scoped === null) {
                const sc = await within(this.call("agents.scope", { name: String(agentClaim(caller)) }, "module:vyred", { door: true }), TARGET_MS);
                const who = sc && sc.data ? sc.data : null;
                scoped = !who || (who.kind !== "assistant" && who.projects !== "*");
              }
              if (scoped) return refuse;
            }
            if (canonical.size) {
              const swap = (/** @type {any} */ v) => (typeof v === "string" && canonical.has(v) ? canonical.get(v) : v);
              for (const arg of fields(def.cwdArg)) {
                const v = input && typeof input === "object" ? input[arg] : undefined;
                if (v === undefined || v === null) continue;
                input = { ...input, [arg]: Array.isArray(v) ? v.map(swap) : swap(v) };
              }
            }
          }
        }
        meta = { ...meta, reach: reach.all ? { all: true } : { all: false, projects: (Array.isArray(reach.projects) ? reach.projects : []).map((/** @type {any} */ p) => p && p.slug).filter(Boolean) } };
      }
    }
    if (recordKept) input = { ...input, ...recordKept };
    if (this.deps.rules) {
      const verdict = await this.deps.rules({ tool, input, caller });
      if (!verdict.allow) return { error: { code: "denied", message: verdict.reason || "denied by rules" } };
    }
    // The one yes (DESIGN-one-yes, inventory item 4 step B). A tool the floor guards is one of two kinds. One of the THREE MOMENTS (momentOf: pairing or widening reach, a vault secret, an outward send)
    // takes a yes, and nothing else: an approved card, a device's signed yes, a reuse window a yes opened, or a 0.3.0 client's old header turned into a card at the edge (admitLegacy). Every other tool the floor
    // used to guard needs the PERSON and no proof: the callers list and the person-session checks above are what judge that, and an agent, a module acting for one or a guest is refused here.
    const presence = this.deps.presence;
    const isOut = (/** @type {string} */ n) => Boolean((this.tools.get(n) || {}).outward);
    const moment = momentOf(tool, isOut);
    // The person's own switch (Settings > Privacy: confirm.pairing, confirm.vault, confirm.outward, on by default): with one off, that person's OWN call for that moment goes through without the yes. Only a
    // person's own caller counts (never a model, an agent, a module or a guest: those are held or refused as before), and only the three moments; making or handing over an owner has no switch.
    const switchedOff = Boolean(moment && isPerson(String(caller)) && this.deps.config && this.deps.config.confirm && this.deps.config.confirm[{ pair: "pairing", vault: "vault", outward: "outward" }[moment]] === false);
    if (switchedOff) meta = { ...meta, presence: { method: "switch", keyId: null } };
    // A tool vyre-core answers on this Mac (def.core, ADR 0040 phase 2): core checks the proof
    // itself, over the exact input, so vyred passes it through untouched rather than checking (and
    // spending) it first. Only when core is linked; everywhere else the floor below applies.
    if (def.core && coreHolder.link) {
      meta = { ...meta, coreProof: proof ? formatProof(proof) : undefined };
    } else if (presence && !switchedOff && (this.deps.gates ? await this.deps.gates.needsPresence({ tool, def, caller, meta, input }) : callerKind(caller) !== "module" && presence.required(tool, def, input))) {
      if (SIGN_IN.has(tool)) {
        // Signing in is authentication, not one of the three moments: the passkey or device key that opens a person session is checked by the presence verifier, as before (BACKLOG 0.3.2: move sign-in to the yes form too).
        const v = await presence.verify({ tool, input, caller, proof, def, meta, peer: meta.peer || null, terminal: null });
        if (!v.ok) return { error: { code: v.code === "no_dialog" ? "no_dialog" : "presence_required", message: v.message, methods: v.methods } };
        meta = { ...meta, presence: { method: v.method, keyId: v.keyId ?? null, ...(v.where ? { where: v.where } : {}) } };
      } else if (!moment) {
        if (!isPerson(String(caller))) return { error: { code: "presence_required", message: `${tool} is the person's own action`, methods: [] } };
        meta = { ...meta, presence: { method: "person", keyId: null } };
      } else if (AGENT_PENDS.includes(tool) && !isPerson(String(caller))) {
        // an agent asking for a grant or a pass only files a request: the tool keeps it pending for a person, whose approval (vault.approve) is the moment
        meta = { ...meta, presence: { method: "pending", keyId: null } };
      } else {
        const got = await this.yesFloor({ tool, moment, caller, meta, input, approval, proof, yesProof, presence, def });
        if (got.error) return got;
        meta = { ...meta, presence: got.presence };
      }
    }
    // One yes: any other caller of a tool marked `outward: true` (an agent, a model, the harness, a module acting for one, a guest) is HELD as a card in the one approvals queue and the tool runs only when
    // that caller retries with the card the person's phone answered (bound to this exact call by a digest of its input). A tool that already holds non-person callers through its own ask flow says
    // `asks: true` in its module.json and keeps that flow for RC1; no outward tool runs for a non-person without one of the two.
    // A first-party module's tool that the person's card already covers files a nested outward tool it names in `covers` (comms.send files mail.send): that is the same act, so it rides the same yes.
    const rideMark = String(caller).startsWith("module:") ? coveredRide(this.tools, currentCall(), tool, caller) : null;
    if (def.outward === true && !def.asks && !door && !rideMark && !isPerson(String(caller).startsWith("module:") ? String(meta.origin || "") : caller)) {
      const asker = `${caller}${meta.origin ? `>${meta.origin}` : ""}`;
      let fields = holdFields(input);
      if (approval) {
        // A card the person EDITED covers the edited call, and that is the call that runs: the approvals queue hands it back only for a card this asker holds for this tool that the phone has already approved.
        const edited = this.tools.get("approvals.card-input");
        if (edited) {
          try {
            const c = await edited.run({ id: approval, tool, from: asker }, { caller: "module:registry" });
            if (c && c.input && typeof c.input === "object") {
              const bad = checkInput(def.input, c.input);
              if (bad.length) return { error: { code: "bad_input", message: `the edited call is not valid: ${bad.join("; ")}` } };
              input = c.input; fields = holdFields(input);
            }
          } catch { /* the card is the card as it was held */ }
        }
        const r = await yes("outward", { op: tool, fields, device: asker }, { card: approval });
        if (!r.ok) return { error: { code: "approval_refused", message: `that approval does not cover this call (${r.reason}); ask again` } };
        // This call is the one the person approved on their phone: the card was bound to exactly this input and was redeemed just now. A first-party module this call files a send through the Gate for carries
        // the mark, and the Gate checks it with the approvals queue before it skips its own hold (lib/covered.js), so the person is not asked for the same yes twice.
        meta = { ...meta, [COVERED]: { card: approval, tool, input_sha256: fields.input_sha256, asker } };
      } else {
        const hold = this.tools.get("approvals.hold");
        if (!hold) return { error: { code: "held_unavailable", message: `${tool} acts as you outside, and this server has no approvals queue to hold it in` } };
        let card;
        try { card = await hold.run({ tool, fields, from: asker, input }, { caller: "module:registry" }); }
        catch (e) { return { error: { code: "held_unavailable", message: `${tool} could not be held for your yes: ${String((e && /** @type {any} */ (e).message) || e).slice(0, 160)}` } }; }
        return { error: { code: "held_for_approval", approval: card.id, line: card.line, ...(card.group ? { group: card.group } : {}), message: `${tool} acts as you outside, so it waits for your yes on your phone (approval ${card.id}). Nothing ran. After you approve, call it again with the same input and approval: ${card.id}` } };
      }
    }
    // A Flow's call step: the Flows host spent the person's approval for exactly this act (bound to this input) before it got here, so the act is the person's own yes, and a send the tool files at the Gate
    // can show it as a redeemed card does. The receipt is recorded with the approvals queue (one use, the card's life); without one the send is held at the Gate as before.
    // The same holds for a person's own click in a view: the preview showed them these exact words and they confirmed (a fresh, hash-bound confirmation only the views and capsule modules can pass on).
    const viewCard = viewAsk && isPerson(String(caller)) && Number.isFinite(viewAsk.at) && Date.now() - viewAsk.at >= -5_000 && Date.now() - viewAsk.at <= 60_000 && typeof viewAsk.hash === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(viewAsk.hash) ? `viewask:${viewAsk.hash}` : null;
    const flowCard = flowAct && String(caller) === "module:flows" && typeof flowAct.task === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(flowAct.task) ? `flowtask:${flowAct.task}` : null;
    if ((flowCard || viewCard) && def.outward === true) {
      const receipt = this.tools.get("approvals.receipt");
      const asker = `${caller}${meta.origin ? `>${meta.origin}` : ""}`, card = /** @type {string} */ (flowCard || viewCard), sha = holdFields(input).input_sha256;
      if (receipt) { try { await receipt.run({ card, tool, input_sha256: sha, asker }, { caller: "module:registry" }); meta = { ...meta, [COVERED]: { card, tool, input_sha256: sha, asker } }; } catch { /* held at the Gate as before */ } }
    }
    // A call that carries an Idempotency-Key runs once per key; a retry gets the first answer.
    // The key reaches the tool too, so a tool that hands work on can carry it (threads.send uses
    // it as the Agent SDK message uuid, ADR 0030), and a retry after a restart is still one turn.
    // A tool that ran counts as a use of its module, whether it succeeded or threw; a refusal
    // above never ran, and neither does a replayed answer. One module calling another is plumbing,
    // not use, and nor is a webhook.
    const counted = !["module", "hook"].includes(callerKind(caller));
    // meta.firstParty: the caller is one of Vyre's own modules, by the loader's one rule
    // (firstParty above). Set here, over anything a caller passed, so no module can claim it.
    const rec = String(caller).startsWith("module:") ? this.modules.get(String(caller).slice(7)) : null;
    const fp = !relayed && Boolean(rec && rec.dir && this.isFirstParty(rec.dir));
    // An asked tool runs for a model, the harness or a module only when the person's own words asked for it. This is the
    // LAST gate before the tool runs, and inside the once-per-key run: the match uses the ask up (consume), so a call
    // refused above (bad input, a rule, a proof) and a retry that only replays the stored answer must never spend it.
    const askedGate = this.deps.gates ? await this.deps.gates.needsAsk({ tool, def, caller, meta, input }) : def.reach === "asked" && (["mcp", "harness", "module"].includes(callerKind(caller)) || agentClaim(caller) !== null);
    const run = async () => {
      if (askedGate && !(await this.saidMatch(tool, meta, def, input))) {
        return { error: { code: "not_asked", message: `${tool} runs for an agent only when your own words asked for it; tell the person what you would do` } };
      }
      // `{{field:<urn>#<name>}}` in an OUTWARD tool's input (what a group chat's session saw instead of a value the room may not read) is resolved here, before the tool runs, from the record
      // under the person the turn is for (the kernel's resolveFields, handed in by the daemon): the value goes into the action, a sealed one stays a slot for the sealing door, and a value
      // that person cannot read refuses the whole action. With no resolver, or no session to resolve for, a placeholder in an outward action is refused rather than sent as text.
      let toInput = input, resolvedMeta = {};
      if (def.outward && PLACEHOLDER.test(JSON.stringify(input))) {
        try {
          if (!this.deps.resolveFields || typeof meta.token !== "string") throw Object.assign(new Error("a placeholder in an outward action needs the session it came from"), { code: "placeholder_unreadable" });
          const r = await this.deps.resolveFields({ tool, input, meta });
          toInput = r.input; resolvedMeta = { resolved: r.resolved, slots: r.slots, bound: r.bound };
        } catch (e) { return { error: { code: "placeholder_unreadable", message: "a value this action names is not readable by the person it is for, so nothing was sent" } }; }
      }
      // a card the running turn spent covers one send a module files for it; the nested call is handed that, by reference, so it can be used once
      const cur = currentCall();
      try { return await this.run(def, toInput, { ...meta, ...resolvedMeta, ...(String(caller).startsWith("module:") && cur && cur[COVERED] ? { [COVERED]: coveredRide(this.tools, cur, tool, caller) || cur[COVERED] } : {}), caller, firstParty: fp, ...(idempotencyKey ? { idempotencyKey } : {}), ...(terminal ? { terminal } : {}) }); }
      finally { if (counted) this.countUse(def.module); }
    };
    const result = idempotencyKey && this.idempotency ? await this.idempotency.once({ caller, tool, key: idempotencyKey, input }, run) : await run();
    return result;
  }

  /**
   * The yes for one of the three moments, from whichever form it came in (the order is the order they are tried): an approved card (`approval`), a device's signed yes (`yesProof`, or a 0.3.0 client's
   * `x-vyre-presence: yes proof=`), a reuse window an earlier yes opened (five minutes, one device, a reveal, a copy or a code), and a 0.3.0 client's old header (`proof`), which is turned into an approved card
   * at the edge (admitLegacy, deprecated, deleted in 0.3.2) so that yes() is the only thing that ever says ok. Answers { presence } for the tool to read, or { error }.
   * @param {{ tool: string, moment: "pair" | "vault" | "outward", caller: string, meta: any, input: any, approval: string | null, proof: any, yesProof: any, presence: any, def: any }} a
   */
  async yesFloor({ tool, moment, caller, meta, input, approval, proof, yesProof, presence, def }) {
    const c = String(caller);
    const plain = yesFieldsOf(input);
    const dev = yesDeviceOf(c);
    const person = String((meta.person && meta.person.id) || "owner");
    const isOut = (/** @type {string} */ n) => Boolean((this.tools.get(n) || {}).outward);
    const agent = !isPerson(c);
    const open = (/** @type {any} */ r, /** @type {string} */ method) => {
      // a yes that asked for it (a card or a signed request carrying reuse) opens the five-minute window for this device and person, for a reveal, a copy or a code only
      if (r.reuse === true && dev && REUSE_OPS.includes(tool) && !agent) this.reuse.grant(dev, person);
      return { presence: { method, keyId: null } };
    };
    // `sign`: the exact act (name, Space, fields) a device's key signs for a direct yes (x-vyre-yes); only where this home has a Space and the call's fields are plain
    const sign = plain && typeof this.deps.homeSpace === "string" ? (() => { const g = signOf(moment, { op: tool, fields: plain }); return { op: g.op, space: this.deps.homeSpace, fields: g.fields }; })() : null;
    const refuse = async (/** @type {string} */ message, code = "presence_required") => ({ error: { code, message, methods: presence && typeof presence.methods === "function" ? await presence.methods().catch(() => []) : [], moment, ...(plain ? { request: { op: tool, fields: plain } } : {}), ...(sign ? { sign } : {}) } });
    if (c.startsWith("module:") || !plain) return refuse(`${tool} needs your yes, and this call cannot carry one`);
    // 1. a card the person's phone or this device's own confirmation approved
    if (approval && dev) { const r = await yes(moment, { op: tool, fields: plain, device: dev }, { card: approval }); if (r.ok) return open(r, "approval"); }
    // 2. a device's signed yes over exactly this call, in the owner's chain (a development build takes a software key; a release build answers software_key)
    let signed = yesProof;
    if (!signed && proof && proof.method === "yes" && proof.proof) signed = String(proof.proof);
    if (signed && typeof this.deps.ownerChain === "function") {
      /** @type {any} */ let decoded = null;
      try { decoded = JSON.parse(Buffer.from(String(signed), "base64url").toString("utf8")); } catch { /* not a proof */ }
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
        const chain = await this.deps.ownerChain();
        let r = await yes(moment, { chain, op: tool, fields: plain }, decoded);
        let reuse = false;
        // the same yes, signed over the call AND the wish to reuse it: the signed fields say so, so a replayed plain yes can never open a window
        if (!r.ok && REUSE_OPS.includes(tool)) { r = await yes(moment, { chain, op: tool, fields: { ...plain, reuse: true } }, decoded); reuse = r.ok; }
        if (r.ok) return open({ ...r, reuse }, r.strength === "real" ? "yes" : "software");
        return { error: { code: r.reason === "software_key" ? "software_key" : "presence_required", message: r.reason === "software_key" ? "this key is software; approve this in Vyre on your phone" : `that approval does not stand (${r.reason})`, methods: [], moment } };
      }
    }
    // 3. the reuse window
    if (dev && !agent && this.reuse.ok(dev, person, tool)) return { presence: { method: "reuse", keyId: null } };
    // 4. a 0.3.0 client's old header: verified by the old verifier, then admitted as a card and redeemed through yes() like any other
    if (proof && proof.method !== "yes" && presence && dev) {
      const v = await presence.verify({ tool, input, caller, proof, def, meta, peer: meta.peer || null, terminal: null });
      if (!v.ok) return { error: { code: v.code === "no_dialog" ? "no_dialog" : "presence_required", message: v.message, methods: v.methods, moment } };
      if (!this.legacySaid.has(v.method)) { this.legacySaid.add(v.method); this.deps.log?.(`presence: a client sent the old x-vyre-presence header (${v.method}); it is turned into a yes at the edge and will stop working in 0.3.2`); }
      const id = admitCard({ moment, op: tool, fields: plain, device: dev });
      const r = await yes(moment, { op: tool, fields: plain, device: dev }, { card: id });
      if (r.ok) return { presence: { method: v.method, keyId: v.keyId ?? null, ...(v.where ? { where: v.where } : {}) } };
    }
    return refuse(`${tool} needs your yes: approve it in Vyre on your phone, or confirm it on this computer`);
  }

  /** @param {any} def @param {any} input @param {any} meta */
  async run(def, input, meta) {
    // The caller is passed on, so a tool like vault.release can check which module is asking.
    try { return { data: await runInTurn(meta, () => def.run(input, meta)) }; }
    catch (e) {
      // A tool may throw an error carrying a code the caller can act on (a presence refusal, a
      // conflict, a missing grant). Pass a short lowercase code through; anything else is "failed".
      const err = /** @type {any} */ (e);
      const code = typeof err?.code === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(err.code) ? err.code : "failed";
      return { error: { code, message: err?.message || String(e), ...(err?.detail && typeof err.detail === "object" ? { detail: err.detail } : {}) } };
    }
  }

  /**
   * May the capsule module call `tool` as `as`? Only a tool a running module's shows.capsule declares
   * (a view's list, detail, action or form submit, or the older results: and action: keys). As the
   * person's surface: a first party module's. As module:<name>: that module's own, and only its own
   * tools or the ones it listed in needs.tools.
   * @param {string} as @param {string} tool
   */
  capsuleMayCall(as, tool) {
    const named = as.startsWith("module:") ? as.slice(7) : null;
    // The hub's own tools: the Capsule lists a server's tools and runs one as the person (a write is held at the Gate).
    if (!named && ["mcp.servers", "mcp.tools", "mcp.call"].includes(tool)) return true;
    for (const [name, r] of this.modules.entries()) {
      if (r.state !== "running" || !r.manifest) continue;
      const sc = r.manifest.shows && r.manifest.shows.capsule;
      const cap = sc && typeof sc === "object" && !Array.isArray(sc) ? sc : {};
      // `views` is the key (the app and the Capsule draw the same declaration); shows.capsule's `view:<id>` entries are the older name for it.
      const vs = r.manifest.views && typeof r.manifest.views === "object" && !Array.isArray(r.manifest.views) ? r.manifest.views : {};
      if (!Object.keys(cap).length && !Object.keys(vs).length) continue;
      const fp = this.isFirstParty(r.dir);
      if (named ? named !== name : !fp) continue;
      const declared = new Set();
      /** @param {any} e */
      // A view may name a Connection operation where a tool goes (withOperations in core/views/frames.js): that is the one tool connectors.operation.run.
      const toolOf = (/** @type {any} */ x) => (x && x.tool) || (x && typeof x.connection === "string" && typeof x.operation === "string" ? "connectors.operation.run" : undefined);
      /** @param {any} e */
      const viewTools = e => {
        for (const part of [e.list, e.board, e.summary]) {
          const l = part || {};
          if (toolOf(l)) declared.add(toolOf(l));
          if (l.detail && toolOf(l.detail)) declared.add(toolOf(l.detail));
          for (const a of Array.isArray(l.actions) ? l.actions : []) if (a && toolOf(a)) declared.add(toolOf(a));
        }
        for (const f of Object.values(e.forms || {})) if (f && /** @type {any} */ (f).submit && toolOf(/** @type {any} */ (f).submit)) declared.add(toolOf(/** @type {any} */ (f).submit));
        // A screen in the design language: every block's data tool, its row detail and its actions, and the screen's forms.
        const sc = e.screen && typeof e.screen === "object" ? e.screen : null;
        if (sc) {
          for (const b of Object.values(sc.blocks || {})) {
            const blk = /** @type {any} */ (b) || {};
            if (blk.data && toolOf(blk.data)) declared.add(toolOf(blk.data));
            if (blk.detail && toolOf(blk.detail)) declared.add(toolOf(blk.detail));
            for (const a of Array.isArray(blk.actions) ? blk.actions : []) if (a && toolOf(a)) declared.add(toolOf(a));
          }
          for (const f of Object.values(sc.forms || {})) if (f && /** @type {any} */ (f).submit && toolOf(/** @type {any} */ (f).submit)) declared.add(toolOf(/** @type {any} */ (f).submit));
        }
      };
      for (const [key, v] of Object.entries(cap)) {
        if (key.startsWith("results:")) declared.add(key.slice(8));
        else if (key.startsWith("action:")) declared.add(key.slice(7).split("#")[0]);
        else if (key.startsWith("view:") && v && typeof v === "object") viewTools(/** @type {any} */ (v));
      }
      for (const v of Object.values(vs)) if (v && typeof v === "object") viewTools(/** @type {any} */ (v));
      if (!declared.has(tool)) continue;
      if (!named) return true;
      const needs = r.manifest.needs && Array.isArray(r.manifest.needs.tools) ? r.manifest.needs.tools : [];
      // connectors.operation.run checks for itself that the module reaches only the Connection of its own app and only that Connection's declared operations.
      if (tool.startsWith(name + ".") || needs.includes(tool) || tool === "connectors.operation.run") return true;
    }
    return false;
  }

  /** The search (or resolve) tools running first-party modules offer the # picker: mentions calls search as the asking person and resolve as sessions or the assistant, nothing else. @param {"search" | "resolve"} [which] */
  mentionTools(which = "search") {
    const out = new Set();
    for (const r of this.modules.values()) {
      if (r.state !== "running" || !r.manifest || !Array.isArray(r.manifest.mentions)) continue;
      // An added module offers its own tools too (its manifest check holds them to its own name and to reads); the picker cuts what resolve gives back.
      for (const e of r.manifest.mentions) if (e && typeof e[which] === "string" && (this.isFirstParty(r.dir) || (e[which].startsWith(`${r.manifest.name}.`) && String(e.kind).startsWith(String(r.manifest.name))))) out.add(e[which]);
    }
    return out;
  }

  /** The getter and setter tools first-party modules name in their settings' tool stores. */
  settingTools() {
    const out = new Set();
    for (const r of this.modules.values()) {
      if (r.state !== "running" || !r.manifest || !Array.isArray(r.manifest.settings) || !this.isFirstParty(r.dir)) continue;
      for (const d of r.manifest.settings) {
        const t = d && d.store && d.store.tool;
        if (t && t.get && t.get.tool) out.add(String(t.get.tool));
        if (t && t.set && t.set.tool) out.add(String(t.set.tool));
      }
    }
    return out;
  }

  status() {
    // `shows` says which surfaces a module offers itself to (SPEC 5.1): the Capsule reads
    // shows.capsule here for the results and actions it lists. What else a manifest declares for
    // the surfaces rides beside it as given (ADR 0033): its CLI verbs, the tools that answer for
    // its connections and for suggest, the notice kinds it raises and the events it emits.
    return [...this.modules.entries()].map(([name, r]) => {
      const m = r.manifest || {}, u = this.use.get(name);
      return { name, version: r.manifest && r.manifest.version, state: r.state, error: r.error,
        ...(m.shows ? { shows: m.shows } : {}),
        ...(m.does && m.does.commands ? { commands: m.does.commands } : {}),
        ...(m.does && m.does.connections ? { connections: m.does.connections } : {}),
        ...(m.does && m.does.suggest ? { suggest: m.does.suggest } : {}),
        ...(Array.isArray(m.mentions) ? { mentions: m.mentions } : {}),
        ...(Array.isArray(m.screens) ? { screens: m.screens } : {}),
        ...(() => {
          // One declaration for the app and the Capsule: `views`, with shows.capsule's `view:<id>` entries (the older name) folded in; `views` wins on an id.
          const sc = m.shows && m.shows.capsule && typeof m.shows.capsule === "object" && !Array.isArray(m.shows.capsule) ? m.shows.capsule : {};
          const merged = { ...Object.fromEntries(Object.entries(sc).filter(([k, v]) => k.startsWith("view:") && v && typeof v === "object").map(([k, v]) => [k.slice(5), v])), ...(m.views && typeof m.views === "object" && !Array.isArray(m.views) ? m.views : {}) };
          return Object.keys(merged).length ? { views: merged } : {};
        })(),
        firstParty: this.isFirstParty(r.dir),
        ...(m.needs && Array.isArray(m.needs.tools) ? { needsTools: m.needs.tools.filter((/** @type {any} */ t) => typeof t === "string") } : {}),
        ...(m.needs && Array.isArray(m.needs.slots) ? { needsSlots: m.needs.slots.filter((/** @type {any} */ t) => typeof t === "string") } : {}),
        ...(m.shows && m.shows.notices ? { notices: m.shows.notices } : {}),
        ...(m.watches && m.watches.emits ? { emits: m.watches.emits } : {}),
        ...(m.needs && Array.isArray(m.needs.credentials) ? { credentials: m.needs.credentials } : {}),
        use: { calls: u ? u.calls : 0, lastUsed: u && u.lastUsed ? u.lastUsed : null } };
    });
  }

  /** Tools the given caller may use. Without a caller, every tool that is neither internal nor a hook. */
  listTools(caller, meta) {
    const needs = (name, d) => (this.deps.presence ? this.deps.presence.required(name, d) : Boolean(d.presence));
    return [...this.tools.entries()].filter(([name, d]) => !d.internal && !d.hook && (!caller || ((callerAllowed(d.callers, caller, name, () => this.declaredSetupTools()) || agentOpensPerson(name, d, caller, meta)) && !personRefusesAgent(name, d, caller, meta))))
      .map(([name, d]) => ({ name, module: d.module, description: d.description, input: d.input, ...(needs(name, d) ? { presence: true } : {}),
        // Module API 1: what an object entry declared, for the capability manifest.
        ...(d.declaredReach ? { reach: d.reach } : {}), ...(d.outward ? { outward: d.outward } : {}) }));
  }

  /** Start a presence proof that needs a challenge (tty, passkey) for one call of a tool. */
  async presenceChallenge(tool, input = {}, method, extra = {}) {
    const def = this.tools.get(tool);
    if (!def || def.internal || def.hook) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    if (!this.deps.presence) return { error: { code: "bad_input", message: "presence is not checked on this registry" } };
    const r = await this.deps.presence.challenge({ ...extra, tool, input, method, def });
    return r.error ? { error: r.error } : { data: r };
  }

  async stop() {
    for (const d of /** @type {Map<string, any>} */ (this.spaceDbs || new Map()).values()) { try { d.close(); } catch { /* closed */ } }
    this.spaceDbs = null;
    for (const [name, r] of [...this.modules.entries()].reverse()) {
      if (r.state === "running" && r.handle && typeof r.handle.stop === "function") {
        try {
          // A module whose own stop() never settles (an open handle, an awaited promise nothing
          // ever resolves) used to hang every caller of this method forever, with nothing to say
          // why: a real vyred shutdown, and any test that starts one in-process (core/settings/
          // settings.test.js, among others) and stops it in t.after. Race it against the same
          // bound the daemon already gives its own drain (DRAIN_MS), and say so loudly rather
          // than hang silently at 0% CPU.
          const timedOut = await within(r.handle.stop().then(() => false), MODULE_STOP_MS, true);
          if (timedOut) this.deps.log(`warn: module ${name} did not stop within ${MODULE_STOP_MS}ms; moving on`);
        } catch {}
      }
    }
    // Last, so a call a module made while stopping is counted too. vyred closes the database after.
    this.flushUse();
  }
}
