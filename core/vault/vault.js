// @ts-check
// vault — items, grants, passes and the audit trail, behind one class the tools call.
//
// The shape of the whole thing is in docs/adr/0001-vault-crypto.md. Three habits run through
// every method here:
//   - A value is opened only at the moment it is handed to the one thing allowed to have it (a
//     granted module, a `vyre vault run` child, a relayed request) and is never returned from
//     anything else. Listings, errors, events and audit rows carry names.
//   - Every release, refusal and relay is an audit row, so "who used what" has an answer after
//     the fact, not only in theory.
//   - Giving access needs a person; taking it away never does. An agent's grants and passes
//     wait as pending until someone approves them.

import { BUILD_KIND } from "../../lib/build-kind.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  openItem, newIdentity, sealFor, openFrom, canonical, same, keyObject, newVaultKey, wrapVaultKey, unwrapVaultKey,
  sealItemV2, openItemV2, macKey, rowMac, newAccountId, formatSecretKey, parseSecretKey, accountUnlockKey,
  passwordKdf, clampKdf, ARGON2, AUK_SCRYPT, MIN_PASSWORD,
} from "./crypto.js";
import { keystore, defaultKind, secretKeyStore } from "./keys.js";
import { isRealHome } from "../config/dialogs.js";
import {
  ensureDir, writeSealed, readSealed, removeSealed, promoteSealed, stagedIds, STAGED, writeJsonFile, readJsonFile,
} from "./store.js";
import * as relay from "./relay.js";
import { enclaveCall, wrapAuk, unwrapAuk } from "./touchid.js";
import { Helper } from "./mac/helper.js";
import * as history from "./history.js";
import { callerKind, ownerDevice } from "../modules/index.js";
import { normalize as normalizeApiCredential } from "./api-request.js";
import { parseFile as parseImport, plan as planImport } from "./import.js";
import { REMIND_MIGRATION } from "./remind.js";
import { KINDS, PERSONAL_KINDS, defaultField, checkFields, cleanDetails, derivedDetails } from "../../lib/vault-kinds/kinds.js";
import { findEnvFiles, readEnv, rewriteEnv, isEnvName, gitState } from "./envfiles.js";
import { FILL_MIGRATION, FILL_KEY_MIGRATION } from "./fill.js";
import { totp } from "./totp.js";
import { generate } from "./generate.js";
import { Share, SHARE_MIGRATIONS } from "./share.js";
import { Shared, SHARED_MIGRATIONS } from "./shared.js";
import { Devices, DEVICE_MIGRATIONS } from "./devices.js";
import { AgentGrants, AGENT_GRANTS_MIGRATION, AUDIT_WHERE_MIGRATION, AGENT_GRANT_MACED } from "./agents.js";
import { ACCESS_REQUESTS_MIGRATION, CONVERSIONS_MIGRATION } from "./access.js";
import { Release, RELEASE_BODY_MIGRATION } from "./release.js";
import { MCP_PASSES_MIGRATION } from "./passmcp.js";
import { Links } from "./links.js";
import { Emergency, EMERGENCY_MIGRATION, EMERGENCY_MACED } from "./emergency.js";
import { SAID_MIGRATION, SAID_MACED } from "./said.js";
import { CONNECTIONS_MIGRATION, CONNECTIONS_PICKER_MIGRATION, CONNECTION_MACED, DEFAULT_SUGGEST_MIGRATION } from "./connections.js";
import { newId as newUuid } from "../../lib/id.js";

/**
 * A module grant may name the one project it is good for, so the same module (a shared teammate,
 * say) does not carry one project's credentials into another's (docs/design/session-credentials.md,
 * cohesion audit finding 1). "" means every project, as every grant meant before this column
 * existed - kept out of the string a NULL would be (SQLite treats every NULL as distinct, which
 * would silently stop deduplicating a project-less grant). The table is rebuilt because the old
 * UNIQUE (item, module, watcher) has to widen to include it, the same shape share.js's vault_held
 * migration uses. vault_agent_grants (one agent signing in to one site, ADR 0028 decision 2) gets
 * the column too, inert for now: nothing scopes an agent login to a project yet.
 */
export const GRANT_PROJECT_MIGRATION = `CREATE TABLE vault_grants_v2 (
     id TEXT PRIMARY KEY, item TEXT NOT NULL, module TEXT NOT NULL, watcher TEXT NOT NULL DEFAULT '',
     project TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, mac TEXT,
     UNIQUE (item, module, watcher, project)
   );
   INSERT INTO vault_grants_v2 (id, item, module, watcher, status, by, at, mac)
     SELECT id, item, module, watcher, status, by, at, mac FROM vault_grants;
   DROP TABLE vault_grants;
   ALTER TABLE vault_grants_v2 RENAME TO vault_grants;
   ALTER TABLE vault_agent_grants ADD COLUMN project TEXT;`;

export const MIGRATIONS = [
  `CREATE TABLE vault_items (
     id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
     fields TEXT NOT NULL, url TEXT, hosts TEXT NOT NULL DEFAULT '[]', origin TEXT, rotate TEXT,
     created INTEGER NOT NULL, updated INTEGER NOT NULL
   );
   CREATE TABLE vault_grants (
     id TEXT PRIMARY KEY, item TEXT NOT NULL, module TEXT NOT NULL, watcher TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (item, module, watcher)
   );
   CREATE TABLE vault_audit (
     id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, name TEXT, who TEXT NOT NULL,
     ok INTEGER NOT NULL, why TEXT
   );
   CREATE INDEX vault_audit_name ON vault_audit (name, id);
   CREATE TABLE vault_people (
     name TEXT PRIMARY KEY, sign TEXT NOT NULL, box TEXT NOT NULL, relay TEXT, added INTEGER NOT NULL
   );
   CREATE TABLE vault_passes (
     id TEXT PRIMARY KEY, holder TEXT NOT NULL, holder_sign TEXT NOT NULL, holder_box TEXT NOT NULL,
     items TEXT NOT NULL, mode TEXT NOT NULL, hosts TEXT, expires INTEGER, note TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL, by TEXT NOT NULL, created INTEGER NOT NULL, issued INTEGER, revoked INTEGER
   );
   CREATE TABLE vault_held (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, relay TEXT NOT NULL, owner_sign TEXT NOT NULL,
     items TEXT NOT NULL, mode TEXT NOT NULL, expires INTEGER, accepted INTEGER NOT NULL
   );`,
  FILL_MIGRATION,
  // A pass can be bound to the holder's Tailscale login as well as their device key.
  `ALTER TABLE vault_people ADD COLUMN login TEXT;
   ALTER TABLE vault_passes ADD COLUMN holder_login TEXT;`,
  // ADR 0006: item versions and vault classes, the meta sealed with each item, and row MACs.
  `ALTER TABLE vault_items ADD COLUMN ver INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE vault_items ADD COLUMN vault TEXT NOT NULL DEFAULT 'agents';
   ALTER TABLE vault_items ADD COLUMN apps TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE vault_items ADD COLUMN reprompt INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE vault_items ADD COLUMN mac TEXT;
   ALTER TABLE vault_grants ADD COLUMN mac TEXT;
   ALTER TABLE vault_passes ADD COLUMN mac TEXT;
   ALTER TABLE vault_devices ADD COLUMN mac TEXT;`,
  ...SHARE_MIGRATIONS,
  ...SHARED_MIGRATIONS,
  ...DEVICE_MIGRATIONS,
  history.HISTORY_MIGRATION,
  // Made here now, with a mac column; tools/cli.js used to make them on the fly.
  `CREATE TABLE IF NOT EXISTS vault_ssh_keys (name TEXT PRIMARY KEY, type TEXT NOT NULL, fingerprint TEXT NOT NULL, public TEXT NOT NULL, at INTEGER NOT NULL, mac TEXT);
   CREATE TABLE IF NOT EXISTS vault_marks (name TEXT PRIMARY KEY, stale TEXT, at INTEGER NOT NULL, mac TEXT);`,
  // ADR 0028, decision 2: agent logins, and where each use happened.
  AGENT_GRANTS_MIGRATION,
  AUDIT_WHERE_MIGRATION,
  // ADR 0028: typed credentials. What the list shows beside a name (a PAT's scopes and expiry,
  // the provider); listable, so neither sealed nor MACed, and never a value.
  `ALTER TABLE vault_items ADD COLUMN details TEXT NOT NULL DEFAULT '{}';`,
  // ADR 0028, decision 4: which Watchtower reasons already have a planner todo.
  REMIND_MIGRATION,
  // ADR 0028, decision 8: emergency access, a sealed ticket in escrow behind a waiting period.
  EMERGENCY_MIGRATION,
  // ADR 0028, decision 5: a phone's device key opens a fill window.
  FILL_KEY_MIGRATION,
  // ADR 0028, decision 9b: connections, and which surfaces may use each.
  CONNECTIONS_MIGRATION,
  // The account picker's ranking: the default per capability, and when each was last used.
  CONNECTIONS_PICKER_MIGRATION,
  // Suggest a default once a capability has two or more ready connections, ever, not per surface.
  DEFAULT_SUGGEST_MIGRATION,
  // A grant may be scoped to one project (docs/design/session-credentials.md), so a teammate
  // shared across two projects does not carry one client's credentials into the other's. Null
  // means every project, as every grant meant before this column existed.
  GRANT_PROJECT_MIGRATION,
  // P17: what the person's own turn asked to go out, so the Gate can tell an asked-for send from an unasked one.
  SAID_MIGRATION,
  // The one grant model: an assistant's request to lend a login waits here for a person; who may use a login is a kernel grant (access.js).
  ACCESS_REQUESTS_MIGRATION,
  // The one grant model, module release: a grant in the kernel's shape beside the older columns, and the requests an assistant made (release.js).
  RELEASE_BODY_MIGRATION,
  // The Vault MCP: passes made for outside agents, and what they asked to see (passmcp.js).
  MCP_PASSES_MIGRATION,
  // What was converted once to kernel grants (a credential's scope): so it is made, and logged, once (access.js).
  CONVERSIONS_MIGRATION,
];

/** The two classes of vault (ADR 0006 decision 1), and the key version each is on. */
export const AGENTS = "agents", PERSONAL = "personal";
const KV = 1;
/** What goes in the personal vault once there is an account: these kinds, and anything with a TOTP seed. */

/**
 * The columns of each row that decide what a value may do: where it goes, who may have it, and
 * which sealed version is current. A module that writes vyre.db cannot change them without the
 * MAC failing, and a row whose MAC fails is ignored and audited.
 */
/** The columns vault_grants was signed over before the grant body existed: a row is converted only if it passes this. */
const GRANTS_LEGACY = ["id", "item", "module", "watcher", "status"];
export const MACED = {
  vault_items: ["id", "name", "kind", "url", "hosts", "origin", "rotate", "vault", "ver", "apps", "reprompt", "relay"],
  vault_grants: ["id", "item", "module", "watcher", "status", "body"],
  vault_agent_grants: AGENT_GRANT_MACED,
  vault_passes: ["id", "holder", "holder_sign", "holder_box", "holder_login", "items", "mode", "hosts", "methods", "paths", "expires", "status", "issued", "revoked"],
  vault_devices: ["id", "name", "token_hash", "revoked"],
  // A phone's device key, which opens a fill window (fill.js).
  vault_device_keys: ["device", "key"],
  vault_history: ["id", "item", "ver", "name", "vault", "at", "by", "changed", "fh"],
  // The ssh agent's record of each key's public half (what a signing prompt names), and the
  // marks that say a login must be rotated. Keyed by item name, made by tools/cli.js.
  vault_ssh_keys: ["name", "type", "fingerprint", "public"],
  vault_marks: ["name", "stale"],
  // Who may ask for emergency access, how long they wait, and where each request stands.
  vault_emergency: EMERGENCY_MACED,
  // Which connection a row is, what it can do, and which surfaces may use it (ADR 0028, 9b).
  vault_connections: CONNECTION_MACED,
  // What the person said to send, post or pay, and whether it still stands (said.js).
  vault_said_intents: SAID_MACED,
};
/** The key column of each MACed table, where it is not `id`. */
const KEY_COL = { vault_ssh_keys: "name", vault_marks: "name", vault_device_keys: "device" };
/** Tables MACed after the v2 upgrade: their rows from before are signed once, then checked. */
const LATE_MACED = ["vault_ssh_keys", "vault_marks"];

/**
 * Tables tools/cli.js made before they were numbered migrations have no mac column; add it.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function ensureMacColumns(db) {
  for (const t of LATE_MACED) {
    const cols = /** @type {any[]} */ (db.prepare(`PRAGMA table_info(${t})`).all()).map(c => c.name);
    if (cols.length && !cols.includes("mac")) db.exec(`ALTER TABLE ${t} ADD COLUMN mac TEXT`);
  }
}

const ACCOUNT = "account.json";
const TOUCHID = "touchid.json";
/** The wrong-password count and the end of a lock-out, kept in the vault folder so a restart or a crash does not hand out five fresh tries. */
const THROTTLE = "unlock-throttle.json";
const AGENT_VK = path.join("vaults", "agents.json");
const STATE = "state.json";
const vkAad = (cls, kv, acct = "") => `vyre:vk:v2:${cls}:${acct ? acct + ":" : ""}${kv}`;
const locked = message => Object.assign(new Error(message), { code: "locked" });
const isShared = cls => String(cls || "").startsWith("shared:");

export { KINDS };
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODULE = /^[a-z][a-z0-9-]{1,40}$/;
/** Is this a module name a grant may name? (index.js checks every grant on a put BEFORE anything is written.) */
export const validModuleName = /** @param {unknown} m */ m => typeof m === "string" && MODULE.test(m);
const PERSON = /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$/;
const MAX_VALUE = 64 * 1024;
const IDENTITY = "identity";
/** The device identity is sealed in the agent vault at a fixed version: it is written once, or by a restore. */
const IDENTITY_AT = { vault: "agents", kv: 1, id: IDENTITY, ver: 1, name: IDENTITY };

const now = () => Date.now();
const newId = () => newUuid();
// Binds an import preview to the file it read. Random per process and never stored, so a token is
// not forgeable from vyre.db and says nothing about the file's contents (ADR 0028, decision 1).
const IMPORT_TOKEN_KEY = crypto.randomBytes(32);
const IMPORT_KINDS = ["login", "note", "card", "secret", "api-key", "env-set", "authenticator", "address", "identity", "wifi"];
const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };

/** A caller's kind, as the registry sees it. */
const kindOf = callerKind;
/**
 * The provider sign-in tokens Vyre already stores: core/onboard makes them (from `claude setup-token`, or an Anthropic key pasted on the setup page) and sessions chooses between
 * them per session. One mechanism: these items, handed to the session launcher through the credentials port in index.js.
 * @type {Record<string, { item: string, kind: string }>}
 */
export const LAUNCHER_ITEMS = Object.freeze({ claude: { item: "claude-setup-token", kind: "secret" }, anthropic: { item: "anthropic-api-key", kind: "api-key" } });
const LAUNCHER_NAMES = new Set(Object.values(LAUNCHER_ITEMS).map(x => x.item));
export const launcherItem = /** @param {string} name */ name => LAUNCHER_NAMES.has(name);
const moduleOf = c => (String(c).startsWith("module:") ? String(c).slice(7) : null);

/** "30d", "12h", "90m", an ISO date or ms since epoch, to ms since epoch. */
export function parseExpiry(v, from = now()) {
  if (v === undefined || v === null || v === "") return from + 30 * 86400_000;
  if (typeof v === "number") return v;
  const m = /^(\d+)\s*([mhdw])$/.exec(String(v).trim());
  if (m) return from + Number(m[1]) * { m: 60_000, h: 3600_000, d: 86400_000, w: 7 * 86400_000 }[m[2]];
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) throw new Error(`expires "${v}" is not a duration like 30d or a date`);
  return t;
}

/** An origin ("https://api.example.com") from anything that parses as an http(s) URL. */
export function origin(u) {
  try { const x = new URL(String(u)); return ["http:", "https:"].includes(x.protocol) ? x.origin : null; } catch { return null; }
}

/** The token for an import file: an HMAC, under a per-process key, of its SHA-256 and size. @param {Buffer} bytes */
function importToken(bytes) {
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  return crypto.createHmac("sha256", IMPORT_TOKEN_KEY).update(`${digest}:${bytes.length}`).digest("base64url");
}

/**
 * Read every .env file in a folder (or one .env file) for an import. The token binds to each
 * file's path and bytes, so any file changing, appearing or going away since the preview is
 * refused. Names that two files would share get -2, -3 here, before the vault's own renames.
 * @param {string} root
 */
function scanEnv(root) {
  const found = findEnvFiles(root);
  const isFile = found.files.length === 1 && found.files[0] === root;
  const h = crypto.createHash("sha256");
  const items = [], skipped = [], envFiles = [];
  const names = new Set();
  for (const f of found.files) {
    const bytes = fs.readFileSync(f);
    h.update(`${f}\0${crypto.createHash("sha256").update(bytes).digest("hex")}\0`);
    const r = readEnv(bytes.toString("utf8"), isFile ? { file: f } : { file: f, root });
    let item = r.item;
    if (item) {
      let name = item.name;
      for (let n = 2; names.has(name); n++) name = `${item.name.slice(0, 120)}-${n}`;
      names.add(name);
      item = { ...item, name };
      items.push(item);
    }
    for (const s of r.skipped) skipped.push(`${path.basename(f)}: ${s}`);
    envFiles.push({ path: f, item: item ? item.name : null, secrets: item ? Object.keys(item.fields) : [], vars: r.vars, kept: r.kept,
      git: gitState(f), state: item ? "add" : "nothing" });
  }
  for (const f of found.large) skipped.push(`${f}: larger than 1 MB`);
  const token = importToken(Buffer.from(h.digest("hex") + ":" + found.files.length));
  return { token, envFiles, parsed: { format: /** @type {const} */ ("env"), items, skipped, templates: found.templates, truncated: found.truncated } };
}

/** What a preview shows for one .env file: names, types and git state, never a value. */
const envFileOut = f => ({ file: f.path, item: f.item, state: f.state, vars: f.vars, kept: f.kept, ...(f.git ? { git: f.git } : {}) });

/** Replace a file in one step, keeping its mode. No copy of the old contents is left behind. */
function writeAtomic(file, text) {
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.vyre-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.writeFileSync(tmp, text, { mode, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

/** The next step after an import, in words the person can act on. */
function importAdvice(p, envFiles, rewrite, rewritten, committed) {
  if (!envFiles) return `Delete ${p} now. It still holds every value in plain text, and nothing needs it again.`;
  const parts = [];
  if (rewrite && rewritten.length) parts.push(`${rewritten.length === 1 ? "The file now holds" : `${rewritten.length} files now hold`} vault references. Run your app with vyre run -- <command> in its folder.`);
  else parts.push("The .env files still hold their values. Import again with rewrite to swap them for vault references, or delete them.");
  if (committed.length) parts.push(`${committed.length === 1 ? "One file is" : `${committed.length} files are`} committed to git, so the old values stay in its history: change them at the provider.`);
  return parts.join(" ");
}

/** @param {string} a @param {string} b */
function sameToken(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class Vault {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, dir: string, config: any, emit: (type: string, payload: object) => void, log?: (m: string) => void, testKdf?: any }} deps
   *   testKdf: tests only, a cheap password KDF (`{ kdf: "argon2id", m, t, p }`) used for a new
   *   account and allowed on unlock. Nothing outside a test passes it; the defaults never drop.
   */
  constructor({ db, dir, config, emit, log = () => {}, testKdf = null, clock = Date.now, buildKind = BUILD_KIND }) {
    this.db = db; this.dir = dir; this.log = log;
    /** Set by sync (devices.js): told of every event, so a local write can be pushed. */
    /** @type {((type: string, payload: any) => void) | null} */ this.onEmit = null;
    this.emit = (type, payload) => { emit(type, payload); try { this.onEmit?.(type, payload); } catch {} };
    const opts = (config && config.vault) || {};
    this.name = (config && config.name) || "vyre";
    // vault.keychain is a keychain file (tests), or true: this home may use the login keychain.
    // Only ~/.vyre may use it without saying so; `vyre up` on a real install writes true. A dev
    // world, demo or stress home that picks no keystore gets the file keystore, so it never
    // leaves an item in the person's login keychain or asks them for their password.
    const file = typeof opts.keychain === "string" ? opts.keychain : undefined;
    this.login = !file && (opts.keychain === true || isRealHome(path.dirname(dir)));
    this.kind = opts.keystore || (defaultKind() === "keychain" && !file && !this.login ? "file" : defaultKind());
    const loginRefused = this.kind === "keychain" && !file && (!this.login || Boolean(process.env.NODE_TEST_CONTEXT));
    this.guarded = loginRefused;
    // On a Mac the keychain is written by a hash-checked helper that is the only app on each
    // item's access list (ADR 0006 finding 1); elsewhere there is no keychain keystore.
    const kcHelper = this.kind === "keychain" && !loginRefused && process.platform === "darwin" ? new Helper({ name: "keychain", dir: path.join(dir, "helpers") }) : null;
    this.keys = keystore({ dir, kind: this.kind, keychain: file, helper: kcHelper, login: !loginRefused });
    this.secretKeys = secretKeyStore({ dir, kind: this.kind === "keychain" ? "keychain" : "file", keychain: file, helper: kcHelper, login: !loginRefused });
    this.testKdf = testKdf;
    /** The agent vault's key, the personal vault's key while unlocked, and the row MAC key. All KeyObjects. */
    /** @type {import("node:crypto").KeyObject|null} */ this.vk = null;
    /** @type {import("node:crypto").KeyObject|null} */ this.pvk = null;
    /** @type {import("node:crypto").KeyObject|null} */ this.mkey = null;
    /** @type {Promise<import("node:crypto").KeyObject>|null} */ this.opening = null;
    /** Set by stop(): no key is opened or made after it, so nothing writes into the folder. */
    this.stopping = false;
    /** Syncs started by a timer (later()), and the timers still waiting, for stop() to settle. */
    /** @type {Set<Promise<any>>} */ this.inflight = new Set();
    /** @type {Set<NodeJS.Timeout>} */ this.timers = new Set();
    /** Rows already reported as failing their MAC, so one bad row is one audit entry per run. */
    this.flagged = new Set();
    /** People, signed cards and tickets, relay guards (share.js). */
    this.share = new Share(this);
    /** Shared vaults: manifests, sync, and the keys of `shared:<id>` classes (shared.js). */
    this.shared = new Shared(this);
    /** This person's other devices: join, approve, and syncing items between them (devices.js). */
    this.devices = new Devices(this);
    /** The time agent grants expire by; tests pass a fake one instead of sleeping. */
    this.clock = clock;
    /** Agent logins: what a grant is checked against, the words, the log of uses (ADR 0028, decision 2). Who may use a login is `access`. */
    this.agents = new AgentGrants(this);
    /** Who may use a login: kernel grants (access.js), set by index.js where there is a kernel. @type {import("./access.js").Access | null} */ this.access = null;
    /** The Vault MCP for outside agents (passmcp.js), set by index.js. @type {import("./passmcp.js").PassMcp | null} */ this.mcp = null;
    /** Which module may be handed which item (release.js): kernel grants on a server, the same grants in this vault's own table in vyre-core. */
    this.releases = new Release(this);
    this.links = new Links(this);
    /** @type {import("./used-by.js").UsedBy | null} Everything that uses one credential (R031-70), set by index.js with the module context. */ this.usedBy = null;
    /** @type {Set<Promise<any>>} what was lent of an item just deleted, being taken back */ this.revoking = new Set();
    /** Emergency access: a sealed ticket in escrow, released after a wait (ADR 0028, decision 8). */
    this.emergency = new Emergency(this);
    /** Set by index.js once the relay listener is up. */
    this.relayUrl = opts.relay && opts.relay.url ? String(opts.relay.url) : null;
    /** "tailscale": the relay listener sits behind tailscale serve and trusts its identity header. */
    // "tailscale": the login comes from `tailscale serve`'s header. "whois": the listener binds the
    // tailnet itself (the box, ADR 0002) and the login comes from `tailscale whois` of the peer.
    this.relayIdentity = opts.relay && ["tailscale", "whois"].includes(opts.relay.identity) ? opts.relay.identity : null;
    // "require": a relayed request also needs the tailnet policy to grant the calling peer
    // vyre.run/cap/vault for the item (ADR 0014, part 7). Only whois carries caps, so under any
    // other identity every relayed request is refused. The grant narrows; it never stands in for a pass.
    // vault.launcherOnly: once the session launcher reads the sign-in tokens through the credentials port, no module may be granted them. On by default now that sessions reads through the port and onboard no longer attaches grants (`vault.launcherOnly: false` turns it off).
    // `launcherOnly: false` is honoured only in a development build (lib/build-kind.js): a packaged release always has it on, whatever a config file says (reviewer-2 VP-6).
    this.launcherOnly = opts.launcherOnly !== false || buildKind !== "development";
    if (opts.launcherOnly === false && buildKind !== "development") log("vault.launcherOnly: false in the config is ignored: this is a packaged build, which always keeps it on");
    this.relayGrants = opts.relay && opts.relay.grants === "require" ? "require" : "off";
    /** What each login's node carried at its last relay contact since start: { caps, node, at }. Never decides access. */
    /** @type {Map<string, { caps: Record<string, any[]>, node: string, at: number }>} */ this.seenCaps = new Map();
    /** Set by index.js in whois mode: whois of the online node signed in as a login, or null. */
    /** @type {((login: string) => Promise<any>) | null} */ this.lookupPeer = null;
    /** This person's Tailscale login, put on the card so passes to them can be bound to it. */
    this.login = opts.login ? String(opts.login) : null;
    ensureDir(dir);
  }

  // ---- keys -----------------------------------------------------------------------------

  /**
   * The agent vault's key, loaded (or made, the first time) on first use. The keystore holds a
   * device key; the device key unwraps the agent VK; the first load after an upgrade also
   * re-seals v1 items and signs the rows that were there before MACs existed.
   */
  async key() {
    if (this.stopping) throw Object.assign(new Error("the vault is stopping"), { code: "stopping" });
    if (this.vk) return this.vk;
    if (!this.opening) this.opening = this.openAgents().finally(() => { this.opening = null; });
    return this.opening;
  }

  async openAgents() {
    // Under node --test, and for any home but ~/.vyre that has not opted in, the login keychain
    // is out of bounds: a home that asked for it must fail loudly, not quietly write a key there.
    if (this.guarded) {
      if (process.env.NODE_TEST_CONTEXT) throw new Error("under tests the keychain keystore needs vault.keychain (a temporary keychain file)");
      throw new Error("the login keychain is only for ~/.vyre: set vault.keystore to file, or vault.keychain to true to use it for this home");
    }
    let raw;
    if (await this.keys.exists()) {
      raw = await this.keys.load();
      if (!raw) throw locked("the vault is locked · vyre vault unlock");
    } else {
      if (this.kind === "passphrase") throw locked("the vault has no passphrase yet · vyre vault unlock sets one");
      raw = await this.keys.create();
      this.log(`vault key created in the ${this.kind} keystore`);
    }
    const vk = this.adopt(raw);
    await this.sealRelayRules();
    return vk;
  }

  /** Take a device key (raw bytes, zeroed here), open the agent VK with it, and bring the home up to v2. */
  adopt(raw) {
    const dk = keyObject(raw);
    const w = readJsonFile(this.dir, AGENT_VK);
    let vk;
    if (w) {
      try { vk = unwrapVaultKey(dk, w, vkAad(AGENTS, KV)); } catch { throw new Error("the device key does not open this vault's agent key"); }
    } else {
      if (readJsonFile(this.dir, STATE)) throw new Error("this vault's agent key file is missing; restore it or a backup");
      vk = newVaultKey();
      writeJsonFile(this.dir, AGENT_VK, wrapVaultKey(dk, vk, vkAad(AGENTS, KV)));
    }
    this.vk = vk;
    this.mkey = macKey(vk);
    // A failed upgrade leaves the vault closed, so the next key() runs it again.
    try { this.upgrade(dk); } catch (e) { this.vk = null; this.mkey = null; throw e; }
    // Release grants the older table held become the grants they always were, in place (release.js).
    this.releases.convert().catch(e => this.log(`vault: older grants were not converted yet: ${e.message}`));
    return vk;
  }

  async unlock(passphrase) {
    if (this.kind !== "passphrase") { await this.key(); return { unlocked: true, keystore: this.kind }; }
    const raw = (await this.keys.exists()) ? await this.keys.load({ passphrase }) : await this.keys.create({ passphrase });
    if (raw) this.adopt(raw);
    return { unlocked: true, keystore: this.kind };
  }

  /** For autofill: is this the vault passphrase? A yes also unlocks, since filling needs the key. */
  async checkPassphrase(passphrase) {
    if (this.kind !== "passphrase" || !(await this.keys.exists())) return false;
    try { const raw = await this.keys.load({ passphrase }); if (!raw) return false; this.adopt(raw); return true; } catch { return false; }
  }

  /** Drop every key this process holds. The agent vault reopens on its own; the personal one needs the password. */
  lock() {
    this.vk = null; this.pvk = null; this.mkey = null;
    return { locked: true, keystore: this.kind, relocks: this.kind !== "passphrase" };
  }

  /**
   * Run fn in ms, unless the vault stops first. What it returns is awaited by stop(), so a sync a
   * timer started cannot write into the folder after the vault (or a test's home) is gone.
   * @param {() => Promise<any>} fn
   */
  later(fn, ms) {
    if (this.stopping) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.stopping) return;
      const p = Promise.resolve().then(fn).finally(() => { this.inflight.delete(p); });
      this.inflight.add(p);
    }, ms);
    t.unref();
    this.timers.add(t);
  }

  /** Stop: cancel waiting syncs, let running ones settle, refuse new keys, then lock. */
  async stop() {
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await Promise.allSettled([...this.inflight, ...(this.opening ? [this.opening] : [])]);
    this.lock();
  }

  async locked() {
    if (this.vk) return false;
    return this.kind === "passphrase";
  }

  // ---- the upgrade to v2 ------------------------------------------------------------------

  /**
   * Run once per key load. Staged copies left by a crash are finished or dropped. On the first
   * v2 start: rows that predate MACs are signed (they are trusted once, at upgrade), v1 items are
   * re-sealed as v2 in the agent vault, and a state file marks it done, after which a v1 file is
   * refused rather than migrated, so an old file put back cannot come in that way.
   * @param {import("node:crypto").KeyObject} dk the device key, which opened v1 items
   */
  upgrade(dk) {
    this.recoverStaged();
    const state = readJsonFile(this.dir, STATE);
    if (state) {
      if (!state.mac || !same(state.mac, this.stateMac())) this.flag("state", "vault", null);
      this.relaySealed = Boolean(state.relay && same(state.relay, this.relayMac()));
      // Tables MACed after this home went v2: their older rows are trusted once, like at upgrade.
      if (!state.late || !same(state.late, this.lateMac())) {
        for (const t of LATE_MACED) for (const r of /** @type {any[]} */ (this.db.prepare(`SELECT * FROM ${t} WHERE mac IS NULL`).all())) this.sign(t, r.name);
        writeJsonFile(this.dir, STATE, { ...state, late: this.lateMac() });
      }
      return;
    }
    this.relaySealed = true;
    for (const [table] of Object.entries(MACED)) {
      for (const r of /** @type {any[]} */ (this.db.prepare(`SELECT * FROM ${table} WHERE mac IS NULL`).all())) this.sign(table, r[KEY_COL[table] || "id"]);
    }
    this.migrateV1(dk);
    writeJsonFile(this.dir, STATE, { v: 2, mac: this.stateMac(), relay: this.relayMac(), late: this.lateMac() });
  }

  lateMac() { return rowMac(/** @type {any} */ (this.mkey), "state", { late: LATE_MACED }); }

  relayMac() { return rowMac(/** @type {any} */ (this.mkey), "state", { relaySealed: true }); }

  /**
   * Once per home: items whose relay rules were set before rules were sealed get a new version
   * with the rules in their meta. Until that is done for every item, open() does it on the way;
   * after, a row whose rules differ from the sealed copy is refused like any other mismatch.
   */
  async sealRelayRules() {
    if (this.relaySealed !== false) return;
    let pending = 0;
    for (const r of /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_items WHERE relay IS NOT NULL").all())) {
      if (!this.rowOk("vault_items", r)) continue;
      if (r.vault === PERSONAL && !this.pvk) { pending++; continue; }
      try { await this.open(r); } catch { /* refused or missing: nothing to bring forward */ }
    }
    if (pending) return;
    this.relaySealed = true;
    const state = readJsonFile(this.dir, STATE) || { v: 2, mac: this.stateMac() };
    writeJsonFile(this.dir, STATE, { ...state, relay: this.relayMac() });
  }

  stateMac() { return rowMac(/** @type {any} */ (this.mkey), "state", { v: 2 }); }

  /** Re-seal every v1 item as v2 in the agent vault; v1 files go only after every v2 copy verifies. */
  migrateV1(dk) {
    const vk = /** @type {import("node:crypto").KeyObject} */ (this.vk);
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_items").all());
    const staged = [];
    for (const r of rows) {
      const sealed = readSealed(this.dir, r.id);
      if (!sealed || sealed.v !== 1) continue;
      let fields;
      try { fields = openItem(dk, r.id, r.name, sealed); }
      catch { this.audit("migrate", r.name, "vault", false, "the v1 copy did not open"); continue; }
      const next = { ...r, ver: Number(r.ver || 0) + 1, vault: AGENTS };
      writeSealed(this.dir, r.id + STAGED, sealItemV2(vk, this.at(next), { meta: this.meta(next), fields }));
      staged.push({ next, fields });
    }
    const ident = readSealed(this.dir, IDENTITY);
    let identity = null;
    if (ident && ident.v === 1) {
      try {
        identity = openItem(dk, IDENTITY, IDENTITY, ident);
        writeSealed(this.dir, IDENTITY + STAGED, sealItemV2(vk, IDENTITY_AT, { meta: { kind: IDENTITY }, fields: identity }));
      } catch { this.audit("migrate", IDENTITY, "vault", false, "the v1 identity did not open"); identity = null; }
    }
    // Verify every staged copy before any row or v1 file changes.
    for (const { next, fields } of staged) {
      const back = openItemV2(vk, this.at(next), readSealed(this.dir, next.id + STAGED));
      if (canonical(back.fields) !== canonical(fields)) throw new Error(`the v2 copy of ${next.name} did not verify; nothing was changed`);
    }
    if (identity) openItemV2(vk, IDENTITY_AT, readSealed(this.dir, IDENTITY + STAGED));
    this.tx(() => {
      for (const { next } of staged) {
        this.db.prepare("UPDATE vault_items SET ver=?, vault=? WHERE id=?").run(next.ver, AGENTS, next.id);
        this.sign("vault_items", next.id);
      }
    });
    for (const { next } of staged) promoteSealed(this.dir, next.id);
    if (identity) promoteSealed(this.dir, IDENTITY);
    if (staged.length) this.log(`vault: ${staged.length} items re-sealed as v2`);
  }

  /** Finish or drop staged copies: a copy that opens against its row's current version is the one the row names. */
  recoverStaged() {
    for (const id of stagedIds(this.dir)) {
      const sealed = readSealed(this.dir, id + STAGED);
      let good = false;
      try {
        if (id === IDENTITY) { openItemV2(/** @type {any} */ (this.vk), IDENTITY_AT, sealed); good = true; }
        else {
          const r = this.db.prepare("SELECT * FROM vault_items WHERE id = ?").get(id);
          const k = r && (r.vault === PERSONAL ? this.pvk : this.vk);
          if (r && !k) continue; // a personal item while locked: sort it out on unlock
          if (r) { openItemV2(/** @type {any} */ (k), this.at(r), sealed); good = true; }
        }
      } catch { good = false; }
      if (good) promoteSealed(this.dir, id); else removeSealed(this.dir, id + STAGED);
    }
  }

  tx(fn) {
    this.db.exec("BEGIN");
    try { fn(); this.db.exec("COMMIT"); } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  // ---- row MACs ---------------------------------------------------------------------------

  /** @param {keyof typeof MACED} table @param {any} r */
  macOf(table, r) {
    const f = {};
    for (const c of MACED[table]) f[c] = r[c] ?? null;
    return rowMac(/** @type {any} */ (this.mkey), table, f);
  }

  /** Sign one row as it is now. Only code that just wrote it, or verified it, calls this. */
  sign(table, id) {
    if (!this.mkey) return;
    const col = KEY_COL[table] || "id";
    const r = this.db.prepare(`SELECT * FROM ${table} WHERE ${col} = ?`).get(id);
    if (r) this.db.prepare(`UPDATE ${table} SET mac = ? WHERE ${col} = ?`).run(this.macOf(/** @type {any} */ (table), r), id);
  }

  /**
   * Whether a row is one this vault wrote. Without the key there is nothing to check against;
   * every path that hands out a value loads the key first, so it always checks.
   * @param {keyof typeof MACED} table @param {any} r
   */
  rowOk(table, r) {
    if (!r) return false;
    if (!this.mkey) return true;
    if (r.mac && same(r.mac, this.macOf(table, r))) return true;
    this.flag(table, r[KEY_COL[table] || "id"], r.mac);
    return false;
  }

  /** A vault_grants row signed before the grant body existed (its older columns); true when it passes. @param {"vault_grants"} _t @param {any} r */
  rowOkLegacy(_t, r) {
    if (!this.mkey) return true;
    const f = {};
    for (const c of GRANTS_LEGACY) f[c] = r[c] ?? null;
    // Signed over the older columns, or by the upgrade that signs rows from before MACs existed (which signs the current columns, the body empty).
    return Boolean(r.mac) && (same(r.mac, rowMac(/** @type {any} */ (this.mkey), "vault_grants", f)) || same(r.mac, this.macOf("vault_grants", r)));
  }

  flag(table, id, mac) {
    const k = `${table}:${id}:${mac}`;
    if (this.flagged.has(k)) return;
    this.flagged.add(k);
    const name = table === "vault_items" ? /** @type {any} */ (this.db.prepare("SELECT name FROM vault_items WHERE id = ?").get(id))?.name : null;
    this.audit("tamper", name ?? null, "vault", false, `${table} row ${id} failed its check and is ignored`);
  }

  // ---- the account and the personal vault -------------------------------------------------

  hasAccount() { return Boolean(readJsonFile(this.dir, ACCOUNT)); }

  /** Password KDF parameters for a new account: Argon2id, or scrypt where node lacks it. */
  kdfParams() {
    if (this.testKdf) return { ...this.testKdf };
    return passwordKdf() === "argon2id" ? { kdf: "argon2id", ...ARGON2 } : { kdf: "scrypt", ...AUK_SCRYPT };
  }

  /**
   * Set the account password: a new account id and Secret Key, and a personal vault whose key
   * is wrapped under the account unlock key. Returns the Secret Key once, for the recovery kit.
   * @param {{ password: string }} input
   */
  async createAccount({ password }, who = "cli") {
    if (this.hasAccount()) throw new Error("this vault already has an account password · vyre vault account unlock");
    if (typeof password !== "string" || password.normalize("NFKC").length < MIN_PASSWORD) throw new Error(`a vault password is at least ${MIN_PASSWORD} characters`);
    await this.key();
    const acct = newAccountId();
    const sk = crypto.randomBytes(16);
    const params = clampKdf(this.kdfParams(), { test: Boolean(this.testKdf) });
    const salt = crypto.randomBytes(16);
    const secretKey = formatSecretKey(acct, sk);
    const auk = accountUnlockKey({ password, secretKey: sk, acct, salt, params });
    sk.fill(0);
    const pvk = newVaultKey();
    // The Secret Key is stored before the account file, so a crash never leaves an account
    // whose Secret Key is nowhere.
    await this.secretKeys.put(secretKey);
    writeJsonFile(this.dir, ACCOUNT, { v: 2, acct, ...params, salt: salt.toString("base64"), personal: { kv: KV, ...wrapVaultKey(auk, pvk, vkAad(PERSONAL, KV, acct)) } });
    this.pvk = pvk;
    const moved = await this.migratePersonal();
    this.audit("account-create", null, who, true, `${moved} items moved into the personal vault`);
    this.emit("vault.unlocked", { vault: PERSONAL });
    return { acct, secretKey, moved };
  }

  /** Open the personal vault with the password and this device's Secret Key. */
  /**
   * The account unlock key from the password and this device's Secret Key. A wrong password
   * throws in words and is audited.
   */
  deriveAuk(password, who) {
    // One attempt at a time: the throttle below is checked before an attempt and counted after it, so parallel guesses would all pass the
    // check before the first failure was counted. Each waits for the one before it, then meets the throttle as it stands.
    const run = (this.aukQueue || Promise.resolve()).then(() => this.deriveAukNow(password, who));
    this.aukQueue = run.catch(() => {});
    return run;
  }

  /** @private one attempt, with the guess limit; call deriveAuk. */
  async deriveAukNow(password, who) {
    // Every password attempt comes through here (unlock and enrolling Touch ID), so the guess limit lives here. The password is its own
    // proof (no separate presence prompt), so after 5 wrong tries in a row every try is refused for 30 s, doubling to 15 minutes; a right
    // password resets it. A refused try is not tested against the key at all.
    const f = this.unlockFails || (this.unlockFails = (() => { try { const j = readJsonFile(this.dir, THROTTLE); return j && Number.isFinite(j.n) && Number.isFinite(j.until) ? { n: Math.max(0, j.n), until: j.until } : { n: 0, until: 0 }; } catch { return { n: 0, until: 0 }; } })());
    const persist = () => { try { writeJsonFile(this.dir, THROTTLE, { n: f.n, until: f.until }); } catch { /* the in-memory count still holds */ } };
    const t0 = now();
    if (t0 < f.until) {
      this.audit("account-unlock", null, who, false, "throttled after wrong passwords");
      throw Object.assign(new Error(`too many wrong passwords in a row · try again in ${Math.ceil((f.until - t0) / 1000)} seconds`), { code: "throttled", detail: { retry_after_s: Math.ceil((f.until - t0) / 1000) } });
    }
    const rec = readJsonFile(this.dir, ACCOUNT);
    if (!rec) throw Object.assign(new Error("this vault has no account password yet: run vyre vault account create"), { code: "no_account" });
    await this.key();
    const params = clampKdf(rec, { test: Boolean(this.testKdf) });
    const text = await this.secretKeys.read();
    if (!text) throw Object.assign(new Error("this device has no Secret Key for the account: use your recovery kit"), { code: "no_secret_key" });
    const { acct, bytes } = parseSecretKey(text);
    if (acct !== rec.acct) { bytes.fill(0); throw Object.assign(new Error("the Secret Key on this device belongs to another account"), { code: "wrong_account" }); }
    // The try is counted BEFORE it is tested and written down (a crash in the middle is a wrong try, not a free one); a right password resets the count.
    f.n++;
    if (f.n >= 5) f.until = now() + Math.min(30_000 * 2 ** (f.n - 5), 15 * 60_000);
    persist();
    try {
      const auk = accountUnlockKey({ password: String(password ?? ""), secretKey: bytes, acct, salt: Buffer.from(String(rec.salt), "base64"), params });
      unwrapVaultKey(auk, rec.personal, vkAad(PERSONAL, Number(rec.personal && rec.personal.kv), acct));
      f.n = 0; f.until = 0; persist();
      return { auk, rec, acct };
    } catch {
      this.audit("account-unlock", null, who, false, `wrong password (${f.n} in a row)`);
      throw Object.assign(new Error("that password does not open your personal vault"), { code: "wrong_password" });
    } finally { bytes.fill(0); }
  }

  /**
   * Open the personal vault with the password, or with Touch ID once enrolled on this Mac.
   * @param {{ password?: string, method?: "password"|"touchid" }} input
   */
  async unlockAccount({ password, method = "password" }, who = "cli") {
    let auk, rec, acct;
    if (method === "touchid") ({ auk, rec, acct } = await this.touchIdAuk(who));
    else ({ auk, rec, acct } = await this.deriveAuk(password, who));
    this.pvk = unwrapVaultKey(auk, rec.personal, vkAad(PERSONAL, Number(rec.personal && rec.personal.kv), acct));
    this.recoverStaged();
    const moved = await this.migratePersonal();
    await this.sealRelayRules();
    // Emergency tickets are snapshots; an unlock is when every personal item can be opened, so
    // they are rebuilt here, at most once a day each. A failure is audited, never an unlock error.
    await this.emergency.autoRefresh(who).catch(() => {});
    this.audit("account-unlock", null, who, true, [method === "touchid" ? "touch id" : null, moved ? `${moved} items moved into the personal vault` : null].filter(Boolean).join(", ") || null);
    this.emit("vault.unlocked", { vault: PERSONAL });
    return { unlocked: true, acct, method };
  }

  /**
   * Turn on Touch ID unlock on this Mac: a Secure Enclave key, and the AUK wrapped to it. Needs
   * the password, since the AUK is made from it. Enrolling again replaces the old wrap.
   */
  async enrollTouchId({ password }, who = "cli") {
    if (!this.enclave) throw new Error("Touch ID unlock needs a Mac with a Secure Enclave");
    const { auk, acct } = await this.deriveAuk(password, who);
    const made = await enclaveCall(this.enclave, { op: "create" });
    if (!made || !made.ok) throw new Error(`the Secure Enclave did not make a key: ${(made && made.message) || "no answer"}`);
    const { ephPub, wrapped } = wrapAuk(auk, made.pub, acct);
    writeJsonFile(this.dir, TOUCHID, { v: 2, acct, blob: made.blob, sePub: made.pub, ephPub, wrapped });
    this.audit("touchid-enroll", null, who, true, null);
    return { enrolled: true };
  }

  /** The AUK through the enclave: one Touch ID dialog, and only this Mac's enclave can answer it. */
  async touchIdAuk(who) {
    const rec = readJsonFile(this.dir, ACCOUNT);
    if (!rec) throw new Error("this vault has no account password yet: run vyre vault account create");
    const t = readJsonFile(this.dir, TOUCHID);
    if (!t || t.acct !== rec.acct) throw new Error("Touch ID unlock is not set up on this Mac · vyre vault account enroll-touchid");
    if (!this.enclave) throw new Error("Touch ID unlock needs a Mac with a Secure Enclave");
    await this.key();
    const r = await enclaveCall(this.enclave, { op: "derive", blob: t.blob, peerPub: t.ephPub, reason: "unlock your personal vault" });
    if (!r || !r.ok) {
      this.audit("account-unlock", null, who, false, r && r.code === "refused" ? "touch id refused" : "touch id failed");
      throw new Error(r && r.code === "refused" ? "Touch ID was not confirmed" : "Touch ID unlock no longer works on this Mac (were fingerprints changed?) · unlock with your password and enroll again");
    }
    try { return { auk: unwrapAuk(Buffer.from(String(r.shared), "base64"), t, rec.acct), rec, acct: rec.acct }; }
    catch { this.audit("account-unlock", null, who, false, "touch id wrap did not open"); throw new Error("the Touch ID wrap does not open · unlock with your password and enroll again"); }
  }

  /**
   * `vyre vault migrate-key`: move keychain items a gone helper build wrote to this build. The
   * one keychain path that may ask the person to allow access, so only a person starts it.
   */
  async migrateKey(who = "cli") {
    const out = { key: false, secretKey: false };
    if (typeof this.keys.migrate === "function") out.key = (await this.keys.migrate()).moved;
    if (typeof this.secretKeys.migrate === "function") out.secretKey = (await this.secretKeys.migrate()).moved;
    this.audit("migrate-key", null, who, true, `key ${out.key ? "moved" : "unchanged"}, secret key ${out.secretKey ? "moved" : "unchanged"}`);
    return out;
  }

  /** Whether there is an account, whether it is unlocked, and whether Touch ID is set up here. */
  accountStatus() {
    const rec = readJsonFile(this.dir, ACCOUNT);
    const t = readJsonFile(this.dir, TOUCHID);
    return { account: Boolean(rec), unlocked: Boolean(this.pvk), touchid: Boolean(rec && t && t.acct === rec.acct), ...(rec ? { acct: rec.acct } : {}) };
  }

  /** Close the personal vault. The agent vault stays open: agents keep working. */
  lockAccount(who = "cli") {
    const was = Boolean(this.pvk);
    this.pvk = null;
    if (was) { this.audit("account-lock", null, who); this.emit("vault.locked", { vault: PERSONAL }); }
    return { locked: true };
  }

  /**
   * A joining device takes the agent key of the device that approved it (devices.js). Only on a
   * fresh home: no items and no account. The device identity is re-sealed under the new key and
   * every MACed row is signed again, since the MAC key comes from the agent key.
   * @param {Buffer} raw the agent VK, zeroed here
   */
  async replaceAgentKey(raw) {
    await this.key();
    const n = Number(/** @type {any} */ (this.db.prepare("SELECT COUNT(*) AS n FROM vault_items").get()).n);
    if (n || this.hasAccount()) { raw.fill(0); throw new Error("only a fresh vault can join another device: this one already holds items or an account"); }
    if (this.kind === "passphrase") { raw.fill(0); throw new Error("a passphrase vault cannot join another device yet; use the keychain or file keystore"); }
    const id = await this.identity();
    const dkRaw = await this.keys.load();
    if (!dkRaw) { raw.fill(0); throw locked("the vault is locked"); }
    const dk = keyObject(dkRaw);
    dkRaw.fill(0);
    const vk = keyObject(raw);
    raw.fill(0);
    writeJsonFile(this.dir, AGENT_VK, wrapVaultKey(dk, vk, vkAad(AGENTS, KV)));
    this.vk = vk;
    this.mkey = macKey(vk);
    await this.writeIdentity(id);
    for (const table of Object.keys(MACED)) {
      const col = KEY_COL[table] || "id";
      for (const r of /** @type {any[]} */ (this.db.prepare(`SELECT ${col} AS k FROM ${table}`).all())) this.sign(table, r.k);
    }
    this.relaySealed = true;
    writeJsonFile(this.dir, STATE, { v: 2, mac: this.stateMac(), relay: this.relayMac(), late: this.lateMac() });
  }

  /**
   * A joining full device takes the account: the Secret Key into this device's store, and the
   * account record (the personal VK wrapped under the password and Secret Key). The password
   * never travels; the person types it here to unlock.
   * @param {{ secretKey: string, account: any }} a
   */
  async adoptAccount({ secretKey, account }) {
    if (this.hasAccount()) throw new Error("this vault already has an account");
    const { acct, bytes } = parseSecretKey(secretKey);
    bytes.fill(0);
    if (!account || account.acct !== acct) throw new Error("the account record does not match its Secret Key");
    await this.secretKeys.put(secretKey);
    writeJsonFile(this.dir, ACCOUNT, account);
  }

  /** The account record, for a device being approved. Holds the personal VK wrapped, never open. */
  accountRecord() { return readJsonFile(this.dir, ACCOUNT); }

  /** The agent VK's raw bytes, for a device being approved. The caller seals and zeroes it. */
  async agentKeyBytes() { return (await this.key()).export(); }

  /** The Secret Key on this device, formatted, for the recovery kit. Internal: no tool returns it yet. */
  async secretKey() {
    const text = await this.secretKeys.read();
    if (!text) throw new Error("this device has no Secret Key");
    return text;
  }

  /** Which vault an item belongs in: personal for logins, cards, notes and TOTP seeds once there is an account, unless granted. */
  classFor(kind, fieldNames, name) {
    if (!this.hasAccount()) return AGENTS;
    if (name && this.grantedNames().has(name)) return AGENTS;
    return PERSONAL_KINDS.includes(kind) || fieldNames.includes("totp") ? PERSONAL : AGENTS;
  }

  grantedNames() {
    // A login lent to an agent (a kernel grant) is filled while nobody is here, so it stays in the agent vault too.
    return new Set([...(this.access ? this.access.items() : []), ...this.releases.items()]);
  }

  /** Move agent-vault items that belong in the personal vault there. Needs it unlocked. */
  async migratePersonal() {
    if (!this.pvk) return 0;
    let n = 0;
    for (const r of /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_items WHERE vault = ?").all(AGENTS))) {
      if (!this.rowOk("vault_items", r)) continue;
      if (this.classFor(r.kind, json(r.fields, []), r.name) !== PERSONAL) continue;
      try { await this.reseal(r, PERSONAL); n++; }
      catch { this.audit("migrate", r.name, "vault", false, "could not move into the personal vault"); }
    }
    return n;
  }

  /** Re-seal one item into another vault class, as a new version. */
  async reseal(r, cls) {
    const { meta, fields } = await this.open(r);
    const next = { ...r, ver: Number(r.ver || 0) + 1, vault: cls };
    const k = cls === PERSONAL ? this.pvk : await this.key();
    if (!k) throw locked("your personal vault is locked · vyre vault account unlock");
    writeSealed(this.dir, r.id + STAGED, sealItemV2(k, this.at(next), { meta, fields }));
    const hist = await this.historyStep(r, r, next, fields, "vault", now(), fields);
    this.tx(() => {
      this.db.prepare("UPDATE vault_items SET ver=?, vault=? WHERE id=?").run(next.ver, cls, r.id);
      this.sign("vault_items", r.id);
      hist.commit();
    });
    promoteSealed(this.dir, r.id);
    hist.prune();
  }

  /**
   * Change sealed details of an item (relay rules today) as a new version, so the row and the
   * sealed meta always agree. @param {string} name @param {{ relay?: string|null }} changes
   */
  async setMeta(name, changes, why = "details") {
    const r = this.mustRow(name);
    const { fields } = await this.open(r);
    await this.writeVersion(this.mustRow(name), changes, fields, "vault");
    this.audit("change", name, "vault", true, why);
  }

  /** Seal the same fields again as a new version of `r` with `changes` to its sealed columns. */
  async writeVersion(r, changes, fields, by) {
    const next = { ...r, ...changes, ver: Number(r.ver || 0) + 1 };
    const k = next.vault === PERSONAL ? this.pvk : await this.key();
    if (!k) throw locked("your personal vault is locked · vyre vault account unlock");
    writeSealed(this.dir, r.id + STAGED, sealItemV2(k, this.at(next), { meta: this.meta(next), fields }));
    const hist = await this.historyStep(r, r, next, fields, by, now(), fields);
    this.tx(() => {
      this.db.prepare("UPDATE vault_items SET ver=?, relay=? WHERE id=?").run(next.ver, next.relay ?? null, r.id);
      this.sign("vault_items", r.id);
      hist.commit();
    });
    promoteSealed(this.dir, r.id);
    hist.prune();
  }

  // ---- history ----------------------------------------------------------------------------

  /**
   * Before a new version replaces an item: keep the current sealed file as history, and make
   * the new version's history row. `commit` runs inside the put's transaction, `prune` after.
   * @param {any} raw the row now (or null) @param {any} old the same row if it passed its MAC
   * @param {any} next the new row values @param {Record<string,string>} fields the new fields
   */
  async historyStep(raw, old, next, fields, by, at, prevFields = null) {
    const mkey = /** @type {any} */ (this.mkey);
    const fh = history.fieldHashes(mkey, next.id, fields);
    let prev = null;
    if (old) {
      const h = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_history WHERE item = ? AND ver = ?").get(old.id, Number(old.ver || 0)));
      if (h && this.rowOk("vault_history", h)) prev = json(h.fh, null);
      else if (prevFields) prev = history.fieldHashes(mkey, next.id, prevFields);
      else { try { prev = history.fieldHashes(mkey, next.id, (await this.open(old)).fields); } catch { prev = null; } }
      const sealed = readSealed(this.dir, old.id);
      if (sealed && sealed.v === 2) {
        history.keepVersion(this.dir, old.id, Number(old.ver || 0), sealed);
        // A version made before history existed gets its row now, so it can be listed and read.
        if (!h) {
          const hid = `${old.id}:${Number(old.ver || 0)}`;
          this.db.prepare("INSERT OR REPLACE INTO vault_history (id, item, ver, name, vault, at, by, changed, fh) VALUES (?,?,?,?,?,?,?,?,?)")
            .run(hid, old.id, Number(old.ver || 0), old.name, old.vault || AGENTS, Number(old.updated || at), "", "[]", JSON.stringify(prev || {}));
          this.sign("vault_history", hid);
        }
      }
    }
    const changed = raw && !old ? Object.keys(fields).sort() : history.changedFields(prev, fh);
    const hid = `${next.id}:${next.ver}`;
    return {
      commit: () => {
        this.db.prepare("INSERT OR REPLACE INTO vault_history (id, item, ver, name, vault, at, by, changed, fh) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(hid, next.id, next.ver, next.name, next.vault, at, String(by), JSON.stringify(changed), JSON.stringify(fh));
        this.sign("vault_history", hid);
      },
      prune: () => {
        const floor = Number(next.ver) - history.KEEP;
        for (const h of /** @type {any[]} */ (this.db.prepare("SELECT ver FROM vault_history WHERE item = ? AND ver < ?").all(next.id, floor))) history.dropVersion(this.dir, next.id, h.ver);
        this.db.prepare("DELETE FROM vault_history WHERE item = ? AND ver < ?").run(next.id, floor);
      },
    };
  }

  /** An item's versions, newest first: when, who, which fields changed. Never a value. */
  history({ name, field }) {
    const r = this.mustRow(name);
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_history WHERE item = ? ORDER BY ver DESC").all(r.id))
      .filter(h => this.rowOk("vault_history", h) && h.ver <= r.ver);
    const entries = rows.map(h => ({ version: h.ver, at: h.at, by: h.by, changed: json(h.changed, []), current: h.ver === r.ver,
      readable: h.ver === r.ver || Boolean(history.readVersion(this.dir, r.id, h.ver)) }));
    const shown = field ? entries.filter(e => e.changed.includes(String(field))) : entries;
    return {
      name, entries: shown,
      // The Deck's shape: versions, and the passwords this login has had before the current one.
      versions: shown.map(e => ({ ver: e.version, at: e.at, by: e.by, fields: e.changed })),
      passwords: entries.filter(e => e.version > 1 && e.changed.includes("password")).map(e => ({ at: e.at })),
    };
  }

  /** One version's fields: the current one, or a kept older one, under the key it was sealed with. */
  async versionFields(r, ver) {
    const v = Number(ver);
    if (!Number.isInteger(v) || v < 1) throw new Error("a version is a whole number from vault.history");
    if (v === Number(r.ver)) return this.fields(r);
    const vk = await this.key();
    if (!this.rowOk("vault_items", r)) throw new Error(`the record for ${r.name} failed its check and is ignored`);
    const h = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_history WHERE item = ? AND ver = ?").get(r.id, v));
    if (!h || !this.rowOk("vault_history", h) || v > Number(r.ver)) throw new Error(`${r.name} has no version ${v} kept`);
    const sealed = history.readVersion(this.dir, r.id, v);
    if (!sealed) throw new Error(`version ${v} of ${r.name} is no longer kept`);
    const k = h.vault === PERSONAL ? this.pvk : vk;
    if (!k) throw locked(`version ${v} of ${r.name} was sealed in your personal vault, which is locked · vyre vault account unlock`);
    try { return openItemV2(k, { vault: h.vault, kv: KV, id: r.id, ver: v, name: h.name }, sealed).fields; }
    catch { this.audit("open", r.name, "vault", false, `kept version ${v} did not open`); throw new Error(`version ${v} of ${r.name} does not open`); }
  }

  /** Put an older version's fields back, as a new version. The item's details stay as they are now. */
  async revert({ name, version }, who) {
    const r = this.mustRow(name);
    const fields = await this.versionFields(r, version);
    await this.put({ name, kind: r.kind, description: r.description, fields, url: r.url || undefined, hosts: json(r.hosts, []), origin: r.origin || undefined, apps: json(r.apps, []), reprompt: Boolean(r.reprompt) }, who);
    this.audit("revert", name, who, true, `to version ${version}`);
    return { name, version: this.row(name).ver, from: Number(version) };
  }

  // ---- audit ----------------------------------------------------------------------------

  /** @param {{ origin?: string|null, surface?: string|null }} [where] where a use happened, for vault.uses */
  audit(action, name, who, ok = true, why = null, where = {}) {
    this.db.prepare("INSERT INTO vault_audit (at, action, name, who, ok, why, origin, surface) VALUES (?,?,?,?,?,?,?,?)")
      .run(now(), action, name ?? null, String(who), ok ? 1 : 0, why, where.origin ?? null, where.surface ?? null);
  }

  /**
   * A refused attempt, as a record of its own (distinct from a write): who tried, what, which item and why, never a value. One audit row (ok false, "refused: ...") and one `vault.refused` event, so an
   * owner can see that something tried, for instance, to attach a module grant to a provider sign-in token.
   * @param {string} action @param {string | null} name @param {string} who @param {string} why
   */
  refuse(action, name, who, why) {
    const w = String(why).slice(0, 200), n = name === null || name === undefined ? null : String(name).slice(0, 128);
    this.audit(action, n, who, false, `refused: ${w}`);
    this.emit("vault.refused", { action, name: n, who: String(who).slice(0, 80), why: w });
  }

  auditTrail({ name, limit = 100 } = {}) {
    const rows = name
      ? this.db.prepare("SELECT * FROM vault_audit WHERE name = ? ORDER BY id DESC LIMIT ?").all(name, Math.min(1000, limit))
      : this.db.prepare("SELECT * FROM vault_audit ORDER BY id DESC LIMIT ?").all(Math.min(1000, limit));
    return { entries: rows.map(r => ({ at: r.at, action: r.action, name: r.name, who: r.who, ok: Boolean(r.ok), why: r.why,
      ...(r.origin ? { origin: r.origin } : {}), ...(r.surface ? { surface: r.surface } : {}) })) };
  }

  // ---- items ----------------------------------------------------------------------------

  /** The row for a name, or undefined, including when the row fails its MAC. */
  row(name) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_items WHERE name = ?").get(String(name)));
    return r && this.rowOk("vault_items", r) ? r : undefined;
  }

  /** What the row says about an item: exactly what is sealed as `meta` with it, and checked on open. */
  meta(r) {
    const relayRules = json(r.relay, null);
    return { kind: r.kind, url: r.url ?? null, hosts: json(r.hosts, []), apps: json(r.apps, []), reprompt: Boolean(r.reprompt),
      // Relay rules decide what a relayed value may be put into, so they are sealed like hosts.
      ...(relayRules && relayRules.body === true ? { relay: { body: true } } : {}) };
  }

  /** Where a row's sealed copy sits in the key hierarchy. */
  at(r) { return { vault: r.vault || AGENTS, kv: isShared(r.vault) ? this.shared.kvOf(r.vault) : KV, id: r.id, ver: Number(r.ver || 0), name: r.name }; }

  mustRow(name) {
    const r = this.row(name);
    if (!r) throw new Error(`no item named ${name}`);
    return r;
  }

  /**
   * An item's fields, opened. Only the methods that hand a value to its one recipient call this.
   * An api-credential is never handed out (reviewer M11): reveal, copy, fill, env, a pass, a
   * relay and every other path that reaches a value through here is refused. Only the sealed
   * backup (`sealed`) and vault.request itself, which opens it in-process, are let past.
   * @param {any} r @param {{ sealed?: boolean }} [o]
   */
  async fields(r, o = {}) {
    if (r && r.kind === "api-credential" && !o.sealed) throw new Error(`${r.name} is an api-credential; it is used only by vault.request and is never handed out`);
    return (await this.open(r)).fields;
  }

  /**
   * The api-credential `name`, opened for vault.request and nothing else: its checked config and
   * its own sealed secret, if it has one. In-process only; no tool returns this.
   * @param {string} name
   * @returns {Promise<{ row: any, config: ReturnType<typeof normalizeApiCredential>, secret: string|undefined }>}
   */
  async apiCredential(name) {
    await this.key();
    const row = this.row(name);
    if (!row) throw new Error(`no item named ${String(name).slice(0, 80)}`);
    if (row.kind !== "api-credential") throw new Error(`${row.name} is not an api-credential`);
    const { fields } = await this.open(row);
    let raw;
    try { raw = JSON.parse(fields.config); } catch { throw new Error(`${row.name} has a config that is not JSON`); }
    return { row, config: normalizeApiCredential(raw), secret: fields.secret };
  }

  /** The names of the api-credential items: names only, for the connector list a Flow sees. @returns {Promise<string[]>} */
  async apiCredentialNames() {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_items WHERE kind = 'api-credential' ORDER BY name").all());
    // no such item, no key needed: the connector list is asked for at start-up, and a home with none must not get a key made for it
    if (!rows.length) return [];
    await this.key();
    return rows.filter(r => this.rowOk("vault_items", r)).map(r => String(r.name));
  }

  /**
   * A provider's session sign-in token, for the session launcher and nothing else (the credentials port in index.js is the one caller; no tool returns it). The items are the
   * ones core/onboard already makes and sessions already chooses between (LAUNCHER_ITEMS); this reads whichever the provider has. @param {string} provider @returns {Promise<string | null>}
   */
  async providerToken(provider) {
    const spec = Object.hasOwn(LAUNCHER_ITEMS, String(provider)) ? LAUNCHER_ITEMS[String(provider)] : null; if (!spec) return null;
    await this.key();
    const row = this.row(spec.item); if (!row) return null;
    const f = await this.fields(row);
    const v = ["value", "api-key", "token"].map(k => f[k]).find(x => typeof x === "string" && x);
    if (!v) return null;
    this.audit("provider-token", row.name, "launcher", true, "handed to the session launcher");
    return v;
  }

  /**
   * The key of an API-key account (kind "api-key": what `sessions.accounts.key` stores), for the Space's lent-computer credential route and nothing else (the credentials port in index.js is the one caller;
   * no tool returns it). One request at a time, never cached by the caller. A sign-in token, a password or any other kind of item is not an API key and answers null. @param {string} name @returns {Promise<string | null>}
   */
  async apiKeyValue(name) {
    await this.key();
    const row = this.row(String(name)); if (!row || row.kind !== "api-key") return null;
    const f = await this.fields(row);
    const v = ["value", "api-key", "token"].map(k => f[k]).find(x => typeof x === "string" && x);
    if (!v) return null;
    this.audit("api-key-use", row.name, "lent", true, "handed to the lent-computer credential route");
    return v;
  }

  /** Which launcher sign-in tokens are stored and when each was added or last changed: names and times, never a value. */
  providerTokens() {
    return Object.entries(LAUNCHER_ITEMS).flatMap(([provider, spec]) => { const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_items WHERE name = ?").get(spec.item)); return r && this.rowOk("vault_items", r) ? [{ provider, item: spec.item, stored: true, added: r.updated }] : []; });
  }

  /**
   * The sealed secret of an oauth api-credential, replaced: what a sign-in stores and what a refresh
   * rotates. Only the secret changes; the person-written config is carried over untouched. In-process
   * only (a tool that calls this decides who may), so it is the one write to an api-credential that
   * does not come from a person's surface.
   * @param {string} name @param {string} secret
   */
  async setApiSecret(name, secret) {
    const { row, config } = await this.apiCredential(name);
    if (config.auth.type !== "oauth") throw new Error(`${row.name} is not an oauth credential, so it has no sign-in to store`);
    const { fields } = await this.open(row);
    await this.writeVersion(row, {}, { ...fields, secret: String(secret) }, "vault");
    this.audit("sign-in", row.name, "vault", true, "tokens stored");
  }

  /**
   * Open an item: `{ meta, fields }`. The row must pass its MAC, the file must be the version
   * the row names, and the sealed meta must match the row, or it is refused and audited.
   */
  async open(r) {
    const vk = await this.key();
    if (!this.rowOk("vault_items", r)) throw new Error(`the record for ${r.name} failed its check and is ignored`);
    const k = r.vault === PERSONAL ? this.pvk : isShared(r.vault) ? await this.shared.keyFor(r.vault) : vk;
    if (!k) throw locked(`${r.name} is in your personal vault, which is locked · vyre vault account unlock`);
    const sealed = readSealed(this.dir, r.id);
    if (!sealed) throw new Error(`the sealed copy of ${r.name} is missing`);
    let body;
    try { body = openItemV2(k, this.at(r), sealed); }
    catch { this.audit("open", r.name, "vault", false, "the sealed copy is not the version its record names"); throw new Error(`the sealed copy of ${r.name} does not open: it was replaced or is an older version`); }
    if (canonical(body.meta) !== canonical(this.meta(r))) {
      // Relay rules set before they were sealed lived only in the (MACed) row. A copy whose one
      // difference is that is brought up to date, as a new version, rather than refused.
      const { relay: _r, ...rest } = this.meta(r);
      if (this.relaySealed === false && !("relay" in body.meta) && _r && canonical(body.meta) === canonical(rest)) {
        await this.writeVersion(r, {}, body.fields, "vault");
        return { meta: this.meta(r), fields: body.fields };
      }
      this.audit("open", r.name, "vault", false, "vyre.db details do not match the sealed copy");
      throw new Error(`the details of ${r.name} in vyre.db do not match its sealed copy, so it is refused`);
    }
    return body;
  }

  /**
   * Add or replace an item. The fields arrive from the CLI's hidden prompt, an import file or a
   * sealed pass; the tool layer refuses them from Claude.
   */
  async put({ name, kind = "secret", description = "", fields, url, hosts, origin: from, apps, reprompt, relay: relayRules, details }, who) {
    if (!NAME.test(String(name || ""))) throw new Error("a name is letters, digits, dot, dash and underscore, up to 128");
    if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("fields must be an object");
    const clean = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === "") continue;
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) throw new Error(`field name "${k}" is not allowed`);
      if (typeof v !== "string") throw new Error(`field ${k} must be text`);
      if (v.length > MAX_VALUE) throw new Error(`field ${k} is larger than 64 KB`);
      clean[k] = v;
    }
    // Replacing only the key of an api-credential the person already made keeps everything they wrote into it (hosts, endpoints, readers,
    // scope): a put with a secret and no config carries the stored config over. The mirror: a put with a config and no secret carries the
    // stored secret over (and with it an oauth sign-in's sealed tokens), so who may use a connection can change without anyone knowing the
    // secret. Only a person's own surface may; the check below still refuses the rest, and a new name with no secret is still refused.
    if (kind === "api-credential" && (["cli", "local", "deck", "capsule"].includes(callerKind(who)) || ownerDevice(who))) {
      const had = /** @type {any} */ (this.db.prepare("SELECT kind FROM vault_items WHERE name = ?").get(String(name)));
      if (had && had.kind === "api-credential") {
        if (clean.config === undefined && (clean.secret !== undefined || clean.value !== undefined)) clean.config = JSON.stringify((await this.apiCredential(String(name))).config);
        else if (clean.config !== undefined && clean.secret === undefined && clean.value === undefined) {
          const before = await this.apiCredential(String(name));
          // The stored secret goes along only when what decides where and how it is sent is unchanged (hosts and the whole auth: token and
          // authorize addresses, header, format, item, client, scopes). A config that points the key somewhere else needs the key again.
          let next;
          try { next = normalizeApiCredential(JSON.parse(clean.config)); } catch { next = null; }
          const where = c => JSON.stringify({ auth: c.auth, hosts: [...c.hosts].sort() });
          if (next && where(next) !== where(before.config)) throw new Error("this changes where or how the key is sent, so give the key again (fields.secret)");
          if (typeof before.secret === "string" && before.secret) clean.secret = before.secret;
        }
      }
    }
    checkFields(kind, clean);
    // An api-credential's hosts and endpoints decide what runs unasked and what holds, so only a
    // person's own surface writes or replaces one (reviewer N4), whatever it was before.
    const prior = /** @type {any} */ (this.db.prepare("SELECT kind FROM vault_items WHERE name = ?").get(String(name)));
    // A provider's sign-in token (claude-setup-token, anthropic-api-key) is the person's own: only they, or the setup page that runs `claude setup-token` for them (core/onboard), add or
    // replace one, and nothing may attach a module's read grant to it once the launcher takes it through the credentials port (config vault.launcherOnly).
    if (launcherItem(String(name))) {
      if (!(["cli", "local", "deck", "capsule"].includes(callerKind(who)) || ownerDevice(who) || who === "module:onboard")) throw new Error(`${name} is a provider sign-in token: only you, or the setup page for you, add or replace it`);
    }
    if (kind === "api-credential" || (prior && prior.kind === "api-credential")) {
      if (!(["cli", "local", "deck", "capsule"].includes(callerKind(who)) || ownerDevice(who))) throw new Error("an api-credential is made and changed only from your own surfaces, never by a module, a watcher or an agent");
      if (kind !== "api-credential") throw new Error(`${name} is an api-credential; delete it before using the name for another kind`);
      if (clean.value !== undefined && clean.secret === undefined) { clean.secret = clean.value; delete clean.value; }
      let cfg;
      try { cfg = JSON.parse(clean.config); } catch { throw new Error("config must be JSON: { auth, hosts, endpoints? }"); }
      const n = normalizeApiCredential(cfg);
      if (n.auth.type !== "oauth" && n.auth.type !== "browser" && !n.auth.item && !clean.secret) throw new Error("give the credential its secret (fields.secret), or name the vault item that holds it (auth.item)");
      clean.config = JSON.stringify(n);
    }
    if (!Object.keys(clean).length) throw new Error("an item needs at least one field");
    // An expiry may be written as "90d" or a date, as grants' are.
    const given = cleanDetails(details && typeof details === "object" && typeof details.expires === "string" && details.expires
      ? { ...details, expires: parseExpiry(details.expires) } : details);
    if (kind === "env-set") for (const k of Object.keys(clean)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`env-set field ${k} is not an environment variable name`);
    const u = url ? String(url) : null;
    let h = Array.isArray(hosts) ? hosts.map(origin) : [];
    if (h.includes(null)) throw new Error("hosts must be origins such as https://api.example.com");
    if (!h.length && u && origin(u)) h = [/** @type {string} */ (origin(u))];

    if (apps !== undefined && (!Array.isArray(apps) || apps.some(a => typeof a !== "string" || a.length > 200))) throw new Error("apps must be a list of app ids");

    await this.key();
    // A row that failed its MAC is replaced, not trusted: its id and version are reused so the
    // new copy supersedes whatever file is there.
    const raw = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_items WHERE name = ?").get(String(name)));
    const old = raw && this.rowOk("vault_items", raw) ? raw : null;
    const id = raw ? raw.id : newId();
    const cls = this.classFor(kind, Object.keys(clean), name);
    const k = cls === PERSONAL ? this.pvk : this.vk;
    if (!k) throw locked("your personal vault is locked · vyre vault account unlock");
    const next = {
      id, name, kind, url: u, hosts: JSON.stringify(h), vault: cls, ver: Number(raw ? raw.ver || 0 : 0) + 1,
      apps: JSON.stringify(apps ?? (old ? json(old.apps, []) : [])),
      reprompt: (reprompt ?? (old ? Boolean(old.reprompt) : kind === "card")) ? 1 : 0,
      relay: relayRules !== undefined ? this.share.checkRelayRules(relayRules) : (old ? old.relay ?? null : null),
    };
    writeSealed(this.dir, id + STAGED, sealItemV2(k, this.at(next), { meta: this.meta(next), fields: clean }));
    const t = now();
    const hist = await this.historyStep(raw, old, next, clean, who, t);
    // Details the caller left out are kept from before, then filled from the fields.
    const det = JSON.stringify({ ...derivedDetails(kind, clean), ...(old ? json(old.details, {}) : {}), ...given });
    this.tx(() => {
      if (raw) {
        // Putting an item again is how it is rotated, so the rotate mark goes.
        this.db.prepare("UPDATE vault_items SET kind=?, description=?, fields=?, url=?, hosts=?, origin=?, rotate=NULL, updated=?, ver=?, vault=?, apps=?, reprompt=?, relay=?, details=? WHERE id=?")
          .run(kind, String(description || (old && old.description) || ""), JSON.stringify(Object.keys(clean)), u, next.hosts, from || (old && old.origin) || null, t, next.ver, cls, next.apps, next.reprompt, next.relay, det, id);
      } else {
        this.db.prepare("INSERT INTO vault_items (id, name, kind, description, fields, url, hosts, origin, created, updated, ver, vault, apps, reprompt, relay, details) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(id, name, kind, String(description || ""), JSON.stringify(Object.keys(clean)), u, next.hosts, from || null, t, t, next.ver, cls, next.apps, next.reprompt, next.relay, det);
      }
      this.sign("vault_items", id);
      hist.commit();
    });
    promoteSealed(this.dir, id);
    hist.prune();
    this.audit(old ? "change" : "add", name, who);
    this.emit(old ? "vault.item-changed" : "vault.item-added", { name, kind });
    return { name, kind, created: !old };
  }

  list({ filter } = {}) {
    const f = filter ? String(filter).toLowerCase() : "";
    const grants = this.releases.views();
    const items = this.db.prepare("SELECT * FROM vault_items ORDER BY name").all()
      .filter(r => this.rowOk("vault_items", r))
      .filter(r => !f || String(r.name).toLowerCase().includes(f) || String(r.description).toLowerCase().includes(f))
      .map(r => ({
        name: r.name, kind: r.kind, description: r.description, fields: json(r.fields, []),
        ...(r.url ? { url: r.url } : {}), hosts: json(r.hosts, []), rotate: Boolean(r.rotate), ...(r.rotate ? { why: r.rotate } : {}),
        ...(r.origin ? { origin: r.origin } : {}), updated: r.updated, vault: r.vault || AGENTS,
        ...(r.details && r.details !== "{}" ? { details: json(r.details, {}) } : {}),
        grants: grants.filter(g => g.item === r.name).map(g => ({ module: g.module, ...(g.watcher ? { watcher: g.watcher } : {}), ...(g.project ? { project: g.project } : {}) })),
      }));
    const personal = this.hasAccount() ? (this.pvk ? "unlocked" : "locked") : "none";
    return { locked: this.kind === "passphrase" && !this.vk, keystore: this.kind, personal, items };
  }

  remove({ name }, who) {
    // A row that fails its check can still be deleted: removing is always safe.
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_items WHERE name = ?").get(String(name)));
    if (!r) throw new Error(`no item named ${name}`);
    if (isShared(r.vault)) throw new Error(`${name} is in a shared vault; deleting from a shared vault is not built yet`);
    if (launcherItem(String(name)) && !(["cli", "local", "deck", "capsule"].includes(callerKind(who)) || ownerDevice(who) || who === "module:onboard")) throw new Error(`${name} is a provider sign-in token: only you, or the setup page for you, remove it`);
    const inPass = this.activePasses().find(p => p.items.includes(name));
    if (inPass) throw new Error(`${name} is in pass ${inPass.id}; revoke the pass first`);
    removeSealed(this.dir, r.id);
    history.dropHistory(this.dir, r.id);
    this.db.prepare("DELETE FROM vault_history WHERE item = ?").run(r.id);
    this.db.prepare("DELETE FROM vault_items WHERE id = ?").run(r.id);
    const gone = this.releases.dropItem(name).catch(e => this.log(`vault: what was granted of ${name} was not taken back: ${e.message}`));
    this.revoking.add(gone);
    gone.finally(() => this.revoking.delete(gone));
    if (this.access) { const q = this.access.revokeDeployments(name).catch(e => this.log(`vault: what deployments held of ${name} was not taken back: ${e.message}`)); this.revoking.add(q); q.finally(() => this.revoking.delete(q)); }
    if (this.access) { const p = this.access.revokeItem(name, String(who)).catch(e => this.log(`vault: what was lent of ${name} was not taken back: ${e.message}`)); this.revoking.add(p); p.finally(() => this.revoking.delete(p)); }
    this.audit("delete", name, who);
    this.emit("vault.item-deleted", { name });
    return { deleted: name };
  }

  /** Logins for a page, for autofill: names and hosts only. */
  match({ url }) {
    const o = origin(url);
    if (!o) return { logins: [] };
    const host = new URL(o).hostname;
    const logins = this.db.prepare("SELECT * FROM vault_items WHERE kind = 'login'").all()
      .filter(r => this.rowOk("vault_items", r))
      .filter(r => json(r.hosts, []).includes(o) || (r.url && origin(r.url) && new URL(/** @type {string} */ (origin(r.url))).hostname === host))
      .map(r => ({ name: r.name, description: r.description, url: r.url }));
    return { logins };
  }

  // ---- grants and release ---------------------------------------------------------------

  /**
   * @param {{ name: string, module: string, watcher?: string, project?: string }} input
   *   project: this grant is good for one project only (docs/design/session-credentials.md);
   *   omitted or "" means every project, as every grant meant before this existed.
   */
  async grant({ name, module, watcher = "", project = "" }, caller) {
    await this.key();
    const item = this.mustRow(name);
    if (launcherItem(String(name)) && this.launcherOnly) { const why = `${name} is a provider sign-in token; no module is granted it, the session launcher is handed it by the box itself`; this.refuse("grant", name, caller, `${why} (module ${String(module).slice(0, 40)})`); throw new Error(why); }
    // A module grants only items it put itself (index.js lets it do so only through vault.put).
    if (kindOf(caller) === "module" && item.origin !== caller) throw new Error(`${moduleOf(caller)} may grant only items it put`);
    if (!MODULE.test(String(module))) throw new Error(`"${module}" is not a module name`);
    if (project && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(project))) throw new Error("project is a project id");
    const pending = kindOf(caller) === "mcp";
    if (pending) {
      // Claude asking waits as a request that carries no authority; only a person's approval makes the grant.
      if (this.releases.views().some(v => v.item === name && v.module === module && v.watcher === watcher && v.project === project)) return { grant: this.grantOut({ id: "", item: name, module, watcher, project, status: "active" }) };
      const old = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_grant_requests WHERE item=? AND module=? AND watcher=? AND project=?").get(name, module, watcher, project));
      const id = old ? old.id : "g_" + newId();
      if (!old) this.db.prepare("INSERT INTO vault_grant_requests (id, item, module, watcher, project, by, at) VALUES (?,?,?,?,?,?,?)").run(id, name, module, watcher, project, String(caller), now());
      this.audit("grant-requested", name, caller, true, watcher ? `${module}/${watcher}` : module);
      this.emit("grant.requested", { name, module, ...(watcher ? { watcher } : {}), ...(project ? { project } : {}) });
      return { grant: this.grantOut({ id, item: name, module, watcher, project, status: "pending" }) };
    }
    // A module uses an item while nobody is here, so a granted item lives in the agent vault.
    if (item.vault === PERSONAL) await this.reseal(item, AGENTS);
    const g = await this.releases.put({ name, module, watcher, project }, caller);
    this.audit("grant", name, caller, true, watcher ? `${module}/${watcher}` : module);
    this.emit("vault.granted", { name, module, ...(watcher ? { watcher } : {}), ...(project ? { project } : {}) });
    return { grant: this.grantOut({ ...g, status: "active" }) };
  }

  /** Write one use of an item to the audit trail, with its origin and surface (see agents.js). */
  recordUse(u) { return this.agents.recordUse(u); }

  grantOut(g) { return { id: g.id, name: g.item, module: g.module, ...(g.watcher ? { watcher: g.watcher } : {}), ...(g.project ? { project: g.project } : {}), status: g.status }; }

  async revoke({ name, module, watcher, project }, caller, { onlyPendingBy = null } = {}) {
    // A named agent or another module may only withdraw a request it made itself, never an active grant (reviewer-2 M-V4).
    const asked = (/** @type {string} */ extra, /** @type {any[]} */ args) => this.db.prepare(`DELETE FROM vault_grant_requests WHERE item=? AND module=?${project !== undefined ? " AND project=?" : ""}${watcher !== undefined ? " AND watcher=?" : ""}${extra}`)
      .run(...[name, module, ...(project !== undefined ? [project] : []), ...(watcher !== undefined ? [watcher] : []), ...args]);
    if (onlyPendingBy) {
      const n = Number(asked(" AND by=?", [onlyPendingBy]).changes);
      this.audit("revoke", name, caller, true, `${watcher ? `${module}/${watcher}` : module} (own pending request)`);
      return { revoked: n };
    }
    const n = Number(asked("", []).changes) + await this.releases.remove({ name, module, watcher, project });
    this.audit("revoke", name, caller, true, watcher ? `${module}/${watcher}` : module);
    if (n) this.emit("vault.revoked", { name, module, ...(watcher ? { watcher } : {}), ...(project ? { project } : {}) });
    return { revoked: n };
  }

  /**
   * Is this item granted to this module (and, for a watcher, to exactly that watcher)? The one check: `release` asks it before it hands a value over, and a caller that only needs the answer
   * (a watcher reading through a service the vault does not hold the token of) asks it through `vault.granted`. A grant to the module as a whole is not a grant to a watcher.
   * @param {{ name: string, module: string, watcher?: string, project?: string }} q
   */
  granted({ name, module, watcher = "", project }) { return this.releases.allowed({ name, module, watcher, project }); }

  /**
   * Hand one value to one module. The grant is the boundary: the loader's needs.vault check is
   * only a courtesy, since a module could reach this tool through ctx.call directly.
   */
  /**
   * @param {{ name: string, field?: string, watcher?: string, project?: string }} input
   *   project: the caller's own project, when it has one; a grant scoped to a different project
   *   never matches, and one scoped to no project (still the default) matches any (docs/design/
   *   session-credentials.md). Nothing passes this yet - modules run process-wide, not scoped to
   *   one project - so today it is always absent and this filters nothing.
   */
  async release({ name, field, watcher = "", project, deployment }, caller) {
    const mod = moduleOf(caller);
    const who = watcher ? `${caller}/${watcher}` : deployment ? `${caller}/${deployment}` : String(caller);
    if (!mod) { this.audit("release", name, who, false, "not a module"); throw new Error("only modules may ask the vault for a value"); }
    await this.key();
    // Publish asks for a deployment, and a deployment holds its secret as its own kernel grant: that grant, and not a grant to the module, is what lets the value out (R032-11).
    const g = mod === "publish" ? Boolean(deployment && this.access && this.access.deploymentMay(String(name), String(deployment))) : this.granted({ name, module: mod, watcher, project });
    if (!g) {
      this.audit("release", name, who, false, "no grant");
      throw new Error(mod === "publish" ? `${name} is not granted to this deployment · give it from the deployment's secrets` : `${name} is not granted to ${watcher ? `${mod}/${watcher}` : mod} · vyre vault grant ${name} ${mod}${watcher ? ` --watcher ${watcher}` : ""}`);
    }
    const r = this.row(name);
    if (!r) { this.audit("release", name, who, false, "no such item"); throw new Error(`no item named ${name}`); }
    if (r.kind === "ssh-key") { this.audit("release", name, who, false, "ssh key"); throw new Error(`${name} is an ssh key; it signs through the vault's ssh agent and is never handed out`); }
    if (r.kind === "passkey") { this.audit("release", name, who, false, "passkey"); throw new Error(`${name} is a passkey; it signs inside the vault and is never handed out`); }
    if (r.kind === "api-credential") { this.audit("release", name, who, false, "api-credential"); throw new Error(`${name} is an api-credential; it is used only by vault.request and is never handed out`); }
    const f = await this.fields(r);
    const want = field || defaultField(r.kind, json(r.fields, []));
    if (!want) { this.audit("release", name, who, false, "no field named"); throw new Error(`${name} is ${r.kind === "env-set" ? "an env-set" : `a ${r.kind}`}; name the field you want`); }
    if (!(want in f)) { this.audit("release", name, who, false, `no field ${want}`); throw new Error(`${name} has no field ${want}`); }
    this.audit("release", name, who, true, field ? `field ${field}` : null);
    this.emit("vault.released", { name, module: mod, ...(watcher ? { watcher } : {}) });
    return { value: f[want] };
  }

  /** Values for `vyre vault run`: env var name to value. Only the CLI and local clients get here. */
  async inject({ items }, caller, envName) {
    const env = {};
    for (const it of items) {
      const r = this.row(it.name);
      if (!r) { this.audit("inject", it.name, caller, false, "no such item"); throw new Error(`no item named ${it.name}`); }
      if (r.kind === "ssh-key") throw new Error(`${it.name} is an ssh key; it signs through the vault's ssh agent and is never handed out`);
      if (r.kind === "passkey") throw new Error(`${it.name} is a passkey; it signs inside the vault and is never handed out`);
      if (r.kind === "api-credential") { this.audit("inject", it.name, caller, false, "api-credential"); throw new Error(`${it.name} is an api-credential; it is used only by vault.request and is never handed out`); }
      const f = await this.fields(r);
      if (r.kind === "env-set" && !it.field) Object.assign(env, f);
      else {
        const want = it.field || defaultField(r.kind, json(r.fields, []));
        if (!want || !(want in f)) throw new Error(`${it.name} has no field ${want || "(name one)"}`);
        env[it.env || envName(it.name)] = f[want];
      }
      this.audit("inject", it.name, caller);
      this.emit("vault.released", { name: it.name, module: "run" });
    }
    return { env };
  }

  async code({ name }, caller) {
    await this.key();
    const r = this.mustRow(name);
    const mod = moduleOf(caller);
    await this.key();
    if (mod && !this.releases.holds(name, mod)) {
      this.audit("totp", name, caller, false, "no grant");
      throw new Error(`${name} is not granted to ${mod}`);
    }
    const f = await this.fields(r);
    if (!f.totp) throw new Error(`${name} has no one-time password`);
    const c = totp(f.totp);
    // The next code too, so a code about to roll over is never a guess (ADR 0028).
    const next = totp(f.totp, { at: Date.now() + c.remaining * 1000 }).code;
    this.audit("totp", name, caller);
    return { code: c.code, next, period: c.period, remaining: c.remaining };
  }

  async generate({ length, words, symbols, name, description }, caller) {
    const g = generate({ length, words, symbols });
    if (!name) return { value: g.value, bits: g.bits };
    const r = this.row(name);
    if (r && r.kind === "login") {
      const f = await this.fields(r);
      await this.put({ name, kind: "login", description: r.description, fields: { ...f, password: g.value }, url: r.url, hosts: json(r.hosts, []) }, caller);
    } else if (r) {
      throw new Error(`${name} already exists; generate into a new name or a login`);
    } else {
      await this.put({ name, kind: "secret", description: description || "generated", fields: { value: g.value } }, caller);
    }
    return { bits: g.bits, stored: name };
  }

  /**
   * Read an export file, parse it, and plan it against what is already here (ADR 0028,
   * decision 1). Existing logins are opened to compare origin, username and password, so the
   * personal vault must be open. Nothing returned here leaves this class with a value in it.
   */
  async importPlan({ file, format, content, filename }) {
    let token, parsed, envFiles = null;
    // The app sends the bytes of a file the person picked (their computer is not always this box): the same parser, no path, and no .env rewrite (there is no file here to rewrite).
    const given = content !== undefined && content !== null;
    const p = given ? "the exported file" : path.resolve(String(file));
    const st = given ? null : fs.statSync(p);
    if (given) {
      if (typeof content !== "string") throw new Error("content is the file's bytes as base64");
      const bytes = Buffer.from(content, "base64");
      if (!bytes.length) throw new Error("the file is empty");
      if (bytes.length > 20 * 1024 * 1024) throw new Error("the file is larger than 20 MB");
      token = importToken(bytes);
      parsed = parseImport(bytes, { format, filename: filename ? path.basename(String(filename)) : undefined });
      if (parsed.error) throw new Error(parsed.error);
    } else if (st && (st.isDirectory() || (st.isFile() && (format === "env" || (!format && isEnvName(path.basename(p))))))) {
      // A folder is scanned for .env files, and a .env file is read the same way, so both can be
      // rewritten to references afterwards (ADR 0028, decision 1).
      ({ token, parsed, envFiles } = scanEnv(p));
    } else if (st) {
      if (!st.isFile()) throw new Error(`${p} is not a file or a folder`);
      if (st.size > 20 * 1024 * 1024) throw new Error(`${p} is larger than 20 MB`);
      const bytes = fs.readFileSync(p);
      token = importToken(bytes);
      parsed = parseImport(bytes, { format, filename: path.basename(p) });
      if (parsed.error) throw new Error(parsed.error);
    }
    await this.key();
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_items").all());
    if (!this.pvk && rows.some(r => r.kind === "login" && r.vault === PERSONAL))
      throw locked("your personal vault is locked, and an import compares against the logins in it · vyre vault account unlock");
    /** @type {import("./import.js").Existing[]} */
    const existing = [];
    for (const r of rows) {
      const e = { name: String(r.name), kind: String(r.kind) };
      if ((r.kind === "login" || (r.kind === "env-set" && envFiles)) && this.rowOk("vault_items", r)) {
        try {
          const f = await this.fields(r);
          if (r.kind === "env-set") Object.assign(e, { fields: f });
          else {
            const o = json(r.hosts, [])[0] || (r.url ? origin(r.url) : "") || "";
            Object.assign(e, { origin: o, username: f.username ?? "", password: f.password ?? "" });
          }
        } catch (err) {
          if (/** @type {any} */ (err).code === "locked") throw err;
          // An item that does not open is judged by its name alone.
        }
      }
      existing.push(e);
    }
    const plan = planImport(existing, parsed.items);
    if (envFiles) {
      // A file's item may have been renamed around a name already taken; its references follow.
      const to = new Map(plan.renamed.map(r => [r.from, r.to]));
      const state = new Map([...plan.add.map(i => [i.name, "add"]), ...plan.same.map(n => [n, "same"]), ...plan.conflicts.map(c => [c.name, "conflict"])]);
      for (const f of envFiles) if (f.item) { f.state = state.get(f.item) ?? "add"; f.item = to.get(f.item) ?? f.item; }
    }
    return { p, token, parsed, plan, envFiles };
  }

  /** What an import would do: names and counts, never a value, plus a token bound to the file. */
  async importPreview({ file, format, content, filename }, caller) {
    const { token, parsed, plan, envFiles } = await this.importPlan({ file, format, content, filename });
    const counts = Object.fromEntries(IMPORT_KINDS.map(k => [k, 0]));
    for (const it of parsed.items) if (it.kind in counts) counts[it.kind]++;
    this.audit("import-preview", null, caller, true, `${parsed.format}: ${parsed.items.length} items, ${plan.add.length} new, ${plan.same.length} same, ${plan.conflicts.length} conflicts`);
    return {
      format: parsed.format, token, counts,
      add: plan.add.map(i => i.name), same: plan.same,
      conflicts: plan.conflicts.map(c => ({ name: c.name, existing: c.existing })),
      renamed: plan.renamed, skipped: parsed.skipped,
      ...(envFiles ? { files: envFiles.map(envFileOut), templates: parsed.templates, ...(parsed.truncated ? { truncated: true } : {}) } : {}),
    };
  }

  /**
   * Read an export file and add what is new. With a token from importPreview, a file that changed
   * since is refused. A conflict is skipped, or with conflicts "update" put into the existing
   * item as a new version, so history keeps the old password. The file is left as it is; the
   * user deletes it.
   */
  async import({ file, format, token, conflicts = "skip", rewrite = false, content, filename }, caller) {
    if (conflicts !== "skip" && conflicts !== "update") throw new Error(`conflicts is "skip" or "update"`);
    const { p, token: current, parsed, plan, envFiles } = await this.importPlan({ file, format, content, filename });
    if (rewrite && !envFiles) throw new Error("rewrite is for .env files and folders of them");
    if (token !== undefined && token !== null && !sameToken(String(token), current)) throw new Error("the file changed since the preview; preview it again");
    const from = `import:${parsed.format}`;
    const added = [], updated = [], skipped = [...parsed.skipped];
    for (const it of plan.add) {
      try { await this.put({ ...it, origin: from }, caller); added.push(it.name); }
      catch (e) { skipped.push(`${it.name}: ${/** @type {Error} */ (e).message}`); }
    }
    const conflicted = [];
    for (const c of plan.conflicts) {
      if (conflicts !== "update") { conflicted.push(c.name); continue; }
      const r = this.row(c.existing);
      if (!r) { skipped.push(`${c.name}: ${c.existing} is no longer here`); continue; }
      try {
        // Fields the export lacks (a TOTP seed added here, say) are kept; the export's win.
        const kept = await this.fields(r);
        await this.put({ ...c.item, name: c.existing, description: r.description, fields: { ...kept, ...c.item.fields }, origin: from }, caller);
        updated.push(c.existing);
      } catch (e) { skipped.push(`${c.name}: ${/** @type {Error} */ (e).message}`); }
    }
    // The rewrite follows the import: a file is rewritten only when every value it held is now in
    // the vault under the name its references use, so a skipped conflict leaves its file alone.
    const rewritten = [], left = [];
    if (rewrite && envFiles) {
      const stored = new Set([...added, ...updated, ...plan.same]);
      for (const f of envFiles) {
        if (!f.item) continue;
        if (!stored.has(f.item)) { left.push(f.path); continue; }
        try { writeAtomic(f.path, rewriteEnv(fs.readFileSync(f.path, "utf8"), f.item, f.secrets)); rewritten.push(f.path); }
        catch { left.push(f.path); }
      }
    }
    this.audit("import", null, caller, true,
      `${parsed.format}: ${added.length} added, ${updated.length} updated, ${plan.same.length} same, ${conflicted.length} conflicts skipped, ${plan.renamed.length} renamed, ${skipped.length} not imported` +
      (rewrite ? `, ${rewritten.length} files rewritten` : ""));
    const committed = envFiles ? envFiles.filter(f => f.item && f.git && f.git.tracked).map(f => f.path) : [];
    return { format: parsed.format, added, updated, same: plan.same, conflicts: conflicted, renamed: plan.renamed, skipped,
      // Older callers read `duplicate`: everything that was here already.
      duplicate: [...plan.same, ...conflicted],
      ...(envFiles ? { rewritten, ...(rewrite ? { unchanged: left } : {}), ...(committed.length ? { committed } : {}) } : {}),
      advice: importAdvice(p, envFiles, rewrite, rewritten, committed) };
  }

  // ---- identity -------------------------------------------------------------------------

  async identity() {
    const vk = await this.key();
    if (!readSealed(this.dir, IDENTITY)) await this.writeIdentity(newIdentity());
    return openItemV2(vk, IDENTITY_AT, readSealed(this.dir, IDENTITY)).fields;
  }

  /** Seal a device identity in the agent vault (new, or from a backup). */
  async writeIdentity(id) {
    const vk = await this.key();
    writeSealed(this.dir, IDENTITY, sealItemV2(vk, IDENTITY_AT, { meta: { kind: IDENTITY }, fields: id }));
  }

  async card() { return this.share.myCard(); }

  // ---- passes: the owner's side ---------------------------------------------------------

  activePasses() {
    const t = now();
    return this.db.prepare("SELECT * FROM vault_passes WHERE status='active' AND revoked IS NULL").all()
      .filter(p => this.rowOk("vault_passes", p)).map(p => this.passOut(p)).filter(p => !p.expires || p.expires > t);
  }

  passOut(p) {
    return { id: p.id, holder: p.holder, items: json(p.items, []), mode: p.mode, ...(p.hosts ? { hosts: json(p.hosts, []) } : {}),
      ...(p.methods ? { methods: json(p.methods, []) } : {}), ...(p.paths ? { paths: json(p.paths, []) } : {}),
      expires: p.expires, note: p.note, status: p.revoked ? "revoked" : p.status, created: p.created, ...(p.revoked ? { revoked: p.revoked } : {}) };
  }

  async createPass({ holder, card, items, mode = "relayed", hosts, expires, note = "", methods, paths }, caller) {
    await this.key();
    if (!PERSON.test(String(holder || ""))) throw new Error("a holder is a person's name");
    if (!Array.isArray(items) || !items.length) throw new Error("a pass needs at least one item");
    if (!["relayed", "sealed"].includes(mode)) throw new Error("mode is relayed or sealed");
    // Everything that can refuse is checked BEFORE a card is pinned or a row written (a refused pass must change nothing).
    const narrowed0 = Array.isArray(hosts) && hosts.length ? hosts.map(origin) : null;
    if (narrowed0 && narrowed0.includes(null)) throw new Error("hosts must be origins such as https://api.example.com");
    const ms0 = Array.isArray(methods) && methods.length ? methods.map(m => String(m).toUpperCase()) : null;
    if (ms0 && !ms0.every(m => /^[A-Z]{3,10}$/.test(m))) throw new Error("methods are HTTP methods such as GET or POST");
    const ps0 = Array.isArray(paths) && paths.length ? paths.map(String) : null;
    if (ps0 && !ps0.every(x => x.startsWith("/"))) throw new Error("paths start with /, such as /v1/charges");
    if (mode === "sealed" && (ms0 || ps0)) throw new Error("methods and paths narrow a relayed pass; a sealed pass hands the value over");
    for (const n of items) {
      const r = this.mustRow(n);
      if (mode === "relayed" && !json(r.hosts, []).filter(h => !narrowed0 || narrowed0.includes(h)).length) throw new Error(`${n} has no hosts it may be sent to, so it cannot be relayed · put it again with --host, or pass it sealed`);
    }
    if (card) {
      // An agent's new or changed card waits for a person, and so does the pass that needs it.
      const added = await this.share.addPerson({ card, name: holder }, caller);
      if ("pending" in added) throw Object.assign(new Error(`${holder}'s card waits for a person to approve it (vyre vault approve ${added.pending.id}); then ask for the pass again`), { code: "pending" });
    }
    const person = this.share.trusted(holder);
    const narrowed = Array.isArray(hosts) && hosts.length ? hosts.map(origin) : null;
    if (narrowed && narrowed.includes(null)) throw new Error("hosts must be origins such as https://api.example.com");
    const ms = Array.isArray(methods) && methods.length ? methods.map(m => String(m).toUpperCase()) : null;
    if (ms && !ms.every(m => /^[A-Z]{3,10}$/.test(m))) throw new Error("methods are HTTP methods such as GET or POST");
    const ps = Array.isArray(paths) && paths.length ? paths.map(String) : null;
    if (ps && !ps.every(x => x.startsWith("/"))) throw new Error("paths start with /, such as /v1/charges");
    if (mode === "sealed" && (ms || ps)) throw new Error("methods and paths narrow a relayed pass; a sealed pass hands the value over");
    for (const n of items) {
      const r = this.mustRow(n);
      if (mode === "relayed") {
        const allowed = json(r.hosts, []).filter(h => !narrowed || narrowed.includes(h));
        if (!allowed.length) throw new Error(`${n} has no hosts it may be sent to, so it cannot be relayed · put it again with --host, or pass it sealed`);
      }
    }
    const id = "p_" + newId();
    const status = kindOf(caller) === "mcp" ? "pending" : "active";
    this.db.prepare("INSERT INTO vault_passes (id, holder, holder_sign, holder_box, holder_login, items, mode, hosts, methods, paths, expires, note, status, by, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, holder, person.sign, person.box, person.login || null, JSON.stringify(items), mode, narrowed ? JSON.stringify(narrowed) : null,
        ms ? JSON.stringify(ms) : null, ps ? JSON.stringify(ps) : null, parseExpiry(expires), String(note), status, String(caller), now());
    this.sign("vault_passes", id);
    this.audit(status === "active" ? "pass" : "pass-requested", null, caller, true, `${id} to ${holder}: ${items.join(", ")} (${mode})`);
    // The pass is made either way; a gap in the tailnet policy is something to say, not a refusal.
    const gap = await this.grantGap(holder, person.login || null, items, mode);
    const warned = out => (gap ? { ...out, warning: gap } : out);
    if (status === "pending") {
      this.emit("pass.requested", { pass: id, holder, items, mode });
      return warned({ pass: this.passOut(this.db.prepare("SELECT * FROM vault_passes WHERE id=?").get(id)) });
    }
    return warned(await this.issue(id));
  }

  /**
   * A login's caps toward this node: whois of their node if it is online on this tailnet now,
   * else what it carried at its last relay contact, else nothing known. Read on demand only.
   * @returns {Promise<{ who: any, source: "whois"|"relay"|null, at: number|null }>}
   */
  async peerCaps(login) {
    const live = this.lookupPeer && login ? await this.lookupPeer(login).catch(() => null) : null;
    if (live && live.login === login) return { who: live, source: "whois", at: now() };
    const seen = login ? this.seenCaps.get(login) : null;
    return seen ? { who: seen, source: "relay", at: seen.at } : { who: null, source: null, at: null };
  }

  /** With grants required, the warning a new relayed pass carries when the policy does not yet cover it, or null. */
  async grantGap(holder, login, items, mode) {
    if (this.relayGrants !== "require" || mode !== "relayed") return null;
    if (!login) return `${holder}'s card names no Tailscale login, so the tailnet policy cannot grant them ${relay.VAULT_CAP}; relayed requests will be refused until their card carries one and the policy grants it`;
    const { who } = await this.peerCaps(login);
    const missing = items.filter(n => !relay.grantCovers(who, n, mode));
    return missing.length ? `the tailnet policy does not grant ${login} ${relay.VAULT_CAP} for ${missing.join(", ")} yet; relayed requests will be refused until it does` : null;
  }

  /**
   * For vault.grants.status: the mode, and per person with live passes, whether their caps (by
   * whois now or as last seen) cover each pass. Names and logins only, never a value.
   */
  async grantsStatus() {
    const t = now();
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_passes WHERE status='active' AND revoked IS NULL ORDER BY created").all())
      .filter(p => this.rowOk("vault_passes", p) && (!p.expires || p.expires > t));
    /** @type {Map<string, any[]>} */
    const byHolder = new Map();
    for (const p of rows) byHolder.set(p.holder, [...(byHolder.get(p.holder) || []), p]);
    const people = [];
    for (const [holder, passes] of byHolder) {
      const login = passes.find(p => p.holder_login)?.holder_login || this.share.row(holder)?.login || null;
      const { who, source, at } = await this.peerCaps(login);
      const out = passes.map(p => {
        const items = json(p.items, []);
        // A sealed pass never comes through the relay, so a grant has nothing to narrow there.
        const missing = p.mode === "relayed" ? items.filter(n => !relay.grantCovers(who, n, p.mode)) : [];
        return { id: p.id, items, mode: p.mode, covered: p.mode !== "relayed" || (who ? !missing.length : null), ...(missing.length ? { missing } : {}) };
      });
      people.push({ holder, login, seen: source, at, grants: who && who.caps && Array.isArray(who.caps[relay.VAULT_CAP]) ? who.caps[relay.VAULT_CAP] : [], covered: out.every(p => p.covered === true), passes: out });
    }
    return { mode: this.relayGrants, identity: this.relayIdentity, people };
  }

  /**
   * Make the signed ticket for an active pass. For a sealed pass this is when the items leave.
   * The holder's pinned key is checked again, since a pass approved later may have waited
   * through a key change.
   */
  async issue(id) {
    const p = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_passes WHERE id=?").get(id));
    const person = this.share.trusted(p.holder);
    if (person.sign !== p.holder_sign || person.box !== p.holder_box) throw new Error(`${p.holder}'s key changed after this pass was asked for · create it again`);
    if (!this.rowOk("vault_passes", p)) throw new Error(`pass ${id} failed its check and is ignored`);
    const items = json(p.items, []);
    if (p.mode !== "sealed" && !this.relayUrl) throw new Error("this Vyre has no relay address, so a relayed pass cannot reach it · set vault.relay in config.json");
    const ticket = await this.ticketFor({ pass: p.id, holder: p.holder, holderSign: p.holder_sign, holderBox: p.holder_box, items, mode: p.mode, expires: p.expires });
    this.db.prepare("UPDATE vault_passes SET issued=? WHERE id=?").run(now(), id);
    this.sign("vault_passes", id);
    this.emit("pass.created", { pass: p.id, holder: p.holder, items, mode: p.mode });
    return { pass: this.passOut(p), ticket };
  }

  /**
   * A signed ticket for one holder. A sealed one carries each item sealed to the holder's box key
   * under `vyre:pass:v1:<pass>:<item>`, which is what accept() opens. Pass issue and emergency
   * access (emergency.js) both build their tickets here, so the two can never drift apart.
   * @param {{ pass: string, holder: string, holderSign: string, holderBox: string, items: string[], mode: "relayed"|"sealed", expires: number|null }} t
   * @returns {Promise<string>}
   */
  async ticketFor({ pass, holder, holderSign, holderBox, items, mode, expires }) {
    const me = await this.identity();
    /** @type {any} */
    const ticket = { pass, owner: this.name, relay: this.relayUrl || "", ownerSign: me.sign.public, ownerCard: (await this.share.myCard()).card,
      holder, holderSign, items, mode, expires };
    if (mode === "sealed") {
      ticket.sealed = {};
      for (const n of items) {
        const r = this.mustRow(n);
        ticket.sealed[n] = sealFor(holderBox, { kind: r.kind, description: r.description, fields: await this.fields(r), url: r.url, hosts: json(r.hosts, []) }, `vyre:pass:v1:${pass}:${n}`, "pass");
      }
    }
    return relay.encodeTicket(ticket, me.sign.private);
  }

  pending() {
    return {
      grants: /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_grant_requests ORDER BY at").all()).map(g => ({ ...this.grantOut({ ...g, status: "pending" }), by: g.by, at: g.at })),
      passes: this.db.prepare("SELECT * FROM vault_passes WHERE status='pending' AND revoked IS NULL ORDER BY created").all().filter(p => this.rowOk("vault_passes", p)).map(p => ({ ...this.passOut(p), by: p.by })),
      agentGrants: this.access ? this.access.pending() : [],
      ...(this.mcp ? { mcpReveals: this.mcp.reveals() } : {}),
      ...this.share.requests(),
    };
  }

  async approve({ id }, caller, meta = { caller }) {
    await this.key();
    if (String(id).startsWith("ag_")) {
      const a = this.access ? await this.access.approve(String(id), meta) : null;
      if (a) return a;
      throw new Error(`nothing pending with id ${id}`);
    }
    const g = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_grant_requests WHERE id=?").get(id));
    if (g) {
      const item = this.row(g.item);
      if (item && item.vault === PERSONAL) await this.reseal(item, AGENTS);
      await this.releases.put({ name: g.item, module: g.module, watcher: g.watcher, project: g.project }, caller);
      this.db.prepare("DELETE FROM vault_grant_requests WHERE id=?").run(id);
      this.audit("grant", g.item, caller, true, `approved ${g.module}${g.watcher ? "/" + g.watcher : ""}`);
      this.emit("vault.granted", { name: g.item, module: g.module, ...(g.watcher ? { watcher: g.watcher } : {}) });
      return { approved: this.grantOut({ ...g, status: "active" }) };
    }
    const p = this.db.prepare("SELECT * FROM vault_passes WHERE id=? AND status='pending' AND revoked IS NULL").get(id);
    if (p && this.rowOk("vault_passes", p)) {
      this.db.prepare("UPDATE vault_passes SET status='active', by=? WHERE id=?").run(String(caller), id);
      this.sign("vault_passes", id);
      this.audit("pass", null, caller, true, `approved ${id}`);
      const out = await this.issue(id);
      return { approved: out.pass, ticket: out.ticket };
    }
    const s = await this.share.approve(id, caller);
    if (s) return s;
    throw new Error(`nothing pending with id ${id}`);
  }

  passes() {
    return {
      passes: this.db.prepare("SELECT * FROM vault_passes ORDER BY created DESC").all().filter(p => this.rowOk("vault_passes", p)).map(p => this.passOut(p)),
      held: this.db.prepare("SELECT * FROM vault_held ORDER BY accepted DESC").all().map(h => ({ id: h.id, owner: h.owner, items: json(h.items, []), mode: h.mode, expires: h.expires })),
    };
  }

  /** End a pass. A relayed pass stops working now; a sealed one names what must be rotated. */
  revokePass({ id }, caller) {
    const p = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_passes WHERE id=?").get(id));
    if (!p) throw new Error(`no pass ${id}`);
    if (p.revoked) return { revoked: false, rotate: [] };
    // Revoking is always allowed, even for a row that fails its check: taking access away is safe.
    this.db.prepare("UPDATE vault_passes SET revoked=? WHERE id=?").run(now(), id);
    if (this.rowOk("vault_passes", p)) this.sign("vault_passes", id);
    const rotate = p.mode === "sealed" && p.issued ? this.markRotate(p) : [];
    this.audit("pass-revoke", null, caller, true, `${id} from ${p.holder}`);
    this.emit("pass.revoked", { pass: id, holder: p.holder, rotate: rotate.length });
    return { revoked: true, rotate };
  }

  /** Items a sealed pass handed over that have not been put again since. */
  markRotate(p) {
    const out = [];
    for (const n of json(p.items, [])) {
      const r = this.row(n);
      if (!r || r.updated > p.issued) continue;
      this.db.prepare("UPDATE vault_items SET rotate=? WHERE id=?").run(`sealed to ${p.holder} by ${p.id}`, r.id);
      this.sign("vault_items", r.id);
      out.push(n);
    }
    return out;
  }

  /** Someone leaves: every pass they hold ends, their card is forgotten, and the list to rotate. */
  async offboard({ person }, caller) {
    const all = this.db.prepare("SELECT * FROM vault_passes WHERE holder=?").all(person);
    const known = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_people WHERE name=?").get(person));
    // Shared vaults first, while their pinned key is still known: out of every vault this Vyre
    // can administer, with a new key there and every item they could read flagged.
    const shared = await this.shared.removeEverywhere(known ? known.sign : null, person, caller);
    // Emergency access they could ask for ends too; its escrow is deleted.
    const emergency = this.emergency.removeAll(person, caller);
    if (!all.length && !known && !shared.vaults.length && !emergency) throw new Error(`no one called ${person} holds anything`);
    const revoked = [], rotate = new Set(shared.rotate);
    for (const p of all) {
      if (!p.revoked) {
        const good = this.rowOk("vault_passes", p);
        this.db.prepare("UPDATE vault_passes SET revoked=? WHERE id=?").run(now(), p.id);
        if (good) this.sign("vault_passes", p.id);
        revoked.push(p.id);
      }
      if (p.mode === "sealed" && p.issued) for (const n of this.markRotate(p)) rotate.add(n);
    }
    this.db.prepare("DELETE FROM vault_people WHERE name=?").run(person);
    this.audit("offboard", null, caller, true, `${person}: ${revoked.length} passes, ${rotate.size} to rotate`);
    this.emit("person.offboarded", { person, revoked: revoked.length, rotate: rotate.size });
    return { person, revoked, rotate: [...rotate].sort(), ...(shared.vaults.length ? { vaults: shared.vaults } : {}), ...(emergency ? { emergency: true } : {}) };
  }

  /**
   * The relay listener's handler: a holder's signed request, checked against its pass, sent on
   * with the value added, and the value scrubbed from whatever comes back. Nothing a stranger
   * sends reaches an error message verbatim, and a pass nobody issued writes at most one audit
   * row a minute.
   */
  async onRelay(env, meta = {}) {
    const deny = (status, message) => ({ status, body: { error: { code: status === 403 ? "denied" : "bad_request", message } } });
    try { await this.key(); } catch { return { status: 503, body: { error: { code: "locked", message: "this vault is locked" } } }; }
    const raw = env && typeof env.pass === "string" ? /** @type {any} */ (this.db.prepare("SELECT * FROM vault_passes WHERE id=?").get(env.pass)) : null;
    const p = raw && this.rowOk("vault_passes", raw) ? raw : null;
    if (!p) { this.share.auditUnknown(env && env.pass, env && env.item, "no such pass"); return deny(403, "no such pass"); }
    const who = `pass:${p.id}:${p.holder}`;
    const refuse = why => { this.audit("relay", env && typeof env.item === "string" ? env.item : null, who, false, why); return deny(403, why); };
    const why = relay.checkEnvelope(env, { holderKey: p.holder_sign, audience: this.relayUrl || "", seen: this.share.nonces });
    if (why) return refuse(why);
    // Remembered for the warning on a new pass and for vault.grants.status; nothing reads it to allow.
    if (meta.peer && meta.login) this.seenCaps.set(meta.login, { caps: meta.peer.caps || {}, node: String(meta.peer.node || ""), at: now() });
    if (this.relayIdentity) {
      if (!meta.login) return refuse(this.relayIdentity === "whois" ? "this relay answers only people on the tailnet" : "this relay answers only through tailscale serve");
      if (p.holder_login && meta.login !== p.holder_login) return refuse("this pass belongs to another Tailscale user");
    }
    if (p.revoked) return refuse("this pass was revoked");
    if (p.status !== "active") return refuse("this pass is not approved");
    if (p.expires && p.expires < now()) return refuse("this pass has expired");
    if (p.mode !== "relayed") return refuse("this pass is sealed, not relayed");
    if (!json(p.items, []).includes(env.item)) return refuse(`${env.item} is not in this pass`);
    // Last of the pass checks, so it can only add a refusal: revoked, expired and unapproved passes are already out.
    if (this.relayGrants === "require" && !relay.grantCovers(meta.peer, env.item, p.mode))
      return refuse(`the tailnet policy does not grant ${meta.login || "this caller"} ${relay.VAULT_CAP} for ${env.item} (${p.mode})`);
    const r = this.row(env.item);
    if (!r) return refuse(`${env.item} no longer exists`);
    const narrowed = p.hosts ? json(p.hosts, []) : null;
    const hosts = json(r.hosts, []).filter(h => !narrowed || narrowed.includes(h));
    if (!relay.allowedOrigin(env.request.url, hosts)) return refuse(`${env.item} may only be sent to ${hosts.join(", ") || "nowhere"}`);
    if (!relay.secureTarget(env.request.url)) return refuse("a relayed value goes over https only (plain http is allowed to loopback)");
    const narrow = relay.requestAllowed(env.request, { methods: json(p.methods, null), paths: json(p.paths, null) });
    if (narrow) return refuse(narrow);
    const f = await this.fields(r);
    let sub;
    try { sub = relay.substitute(env.request, f, defaultField(r.kind, json(r.fields, [])), this.share.relayRules(r)); }
    catch (e) { return refuse(/** @type {Error} */ (e).message); }
    let res;
    try { res = await relay.send(sub.request); }
    catch { this.audit("relay", env.item, who, false, "upstream failed"); return { status: 502, body: { error: { code: "upstream", message: "the request to the upstream failed" } } }; }
    const headers = {};
    for (const [k, v] of Object.entries(res.headers || {})) headers[k] = relay.scrub(String(v), sub.values);
    this.audit("relay", env.item, who, true, `${origin(env.request.url)} ${res.status}${meta.login ? " as " + meta.login : ""}`);
    this.emit("vault.released", { name: env.item, pass: p.id, holder: p.holder });
    return { status: 200, body: { data: { status: res.status, headers, body: relay.scrub(res.body, sub.values) } } };
  }

  // ---- passes: the holder's side --------------------------------------------------------

  /**
   * Take a ticket someone sent. It must be signed by its owner, for this Vyre, from a key that
   * matches the one pinned for them (or a first contact, pinned now). From an agent it waits for
   * a person. A sealed ticket's items become ordinary sealed items here.
   */
  async accept({ ticket }, caller) {
    const t = relay.decodeTicket(ticket);
    const me = await this.identity();
    if (t.holderSign !== me.sign.public) throw new Error(`this ticket was made for another Vyre (${t.holder}), not this one`);
    if (kindOf(caller) === "mcp") return this.share.request("accept", t.owner, String(ticket).trim(), caller, { items: t.items, mode: t.mode });
    const owner = await this.share.pinOwner(relay.decodeCard(t.ownerCard), t.ownerCard, caller);
    const from = `pass:${owner}:${t.pass}`;
    const added = [];
    if (t.mode === "sealed") {
      for (const n of t.items) {
        let item;
        try { item = openFrom(me.box.private, t.sealed?.[n], `vyre:pass:v1:${t.pass}:${n}`, "pass"); }
        catch { throw new Error("this ticket was not sealed for this Vyre"); }
        const name = this.row(n) && this.row(n).origin !== from ? `${owner}.${n}`.replace(/[^A-Za-z0-9._-]/g, "-") : n;
        await this.put({ name, kind: item.kind, description: item.description, fields: item.fields, url: item.url, hosts: item.hosts, origin: from }, caller);
        added.push(name);
      }
    }
    // Keyed on (owner key, pass): the same owner may re-issue, nobody else can take the slot.
    this.db.prepare(`INSERT INTO vault_held (owner_sign, id, owner, relay, items, mode, expires, accepted) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (owner_sign, id) DO UPDATE SET owner=excluded.owner, relay=excluded.relay, items=excluded.items, mode=excluded.mode, expires=excluded.expires, accepted=excluded.accepted`)
      .run(t.ownerSign, t.pass, owner, t.relay || "", JSON.stringify(t.items), t.mode, t.expires, now());
    this.audit("pass-accept", null, caller, true, `${t.pass} from ${owner}`);
    this.emit("pass.accepted", { pass: t.pass, owner, items: t.items, mode: t.mode });
    return { held: { id: t.pass, owner, items: t.items, mode: t.mode, ...(added.length ? { added } : {}) } };
  }

  /** Use an item someone relayed to us: the request goes to their box, which adds the value. */
  async relayOut({ item, request, owner }, caller) {
    const t = now();
    const held = this.db.prepare("SELECT * FROM vault_held WHERE mode='relayed' ORDER BY accepted DESC").all()
      .filter(h => json(h.items, []).includes(item) && (!owner || h.owner === owner) && (!h.expires || h.expires > t));
    if (!held.length) throw new Error(`no relayed pass holds ${item}${owner ? ` from ${owner}` : ""}`);
    const h = held[0];
    const me = await this.identity();
    const env = relay.envelope({ pass: String(h.id), item, request, privDer: me.sign.private, aud: String(h.relay) });
    const r = await relay.callRelay(String(h.relay), env);
    this.audit("relay-out", item, caller, !r.error, r.error ? r.error.message : `via ${h.owner}`);
    if (r.error) throw Object.assign(new Error(`${h.owner}'s Vyre said: ${r.error.message}`), { code: r.error.code });
    return r.data;
  }
}
