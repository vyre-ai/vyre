// @ts-check
// presence: proving a person is there before a human-only action (docs/adr/0004-presence.md).
//
// A caller's name is only a claim: Claude Code runs as the same user and can say "cli" on the
// socket. So a tool that only a person may run needs a proof that vyred checks itself, bound to
// the tool and the exact input, used once. This file is the verifier. The registry asks it
// before such a tool runs, and the presence module (module.js) enrolls keys and mints codes.
//
// Every touch point with the OS (who, the terminal device, the Touch ID helper, WebAuthn) is
// injectable, so tests never open a dialog or write to a real terminal.

import crypto from "node:crypto";
import { normalizePublicKey, checkRsa } from "./keys.js";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { migrate } from "../store/index.js";
import { dialogsAllowed, NO_DIALOG } from "../config/dialogs.js";
import { isServer } from "../config/index.js";
import { within } from "../../lib/within.js";

/**
 * The floor's list. These need presence whatever their owners declare; a module can add to the
 * list with `presence: true` on a tool, never take away from it (principle 7).
 */
export const HUMAN_ONLY = new Set([
  // Floor rule 1: nothing goes out unseen. Changing or discarding a held draft sends nothing, and
  // answering Claude's permission questions is the person's own business (the no-nag rule), so
  // gate.revise, gate.reject and threads.answer need a person caller and no proof.
  "gate.approve",
  // Floor rule 8: every way a value, or the power to release one, leaves the vault.
  "vault.put", "vault.approve", "vault.unlock", "vault.offboard", "vault.inject", "vault.totp",
  "vault.backup", "vault.restore", "vault.delete", "vault.device.code", "vault.device.unlock",
  "vault.unlock-passphrase", "vault.reveal", "vault.copy", "vault.resolve", "vault.render",
  "vault.session.open", "vault.export", "vault.kit",
  // What Claude is told in every later session: installing a skill. Accepting, relaxing and
  // retiring a lesson are the user's own (PERSON_ONLY): they ask nothing.
  "learn.skill-install",
  // A new machine joined to this one.
  "link.pair.approve",
  "presence.enroll", "presence.remove", "presence.code", "presence.session.open",
  // Signing a browser in as the person for 30 days (core/presence/person.js).
  "presence.person.start",
  // Who beyond the owner can reach this box, and what the internet can send it (ADR 0014): a
  // shared folder, a guest from another tailnet, a public webhook route, an agent's own node,
  // and the sites that leave through the owner's Mac. Switching a share the owner already made
  // between read-only and read-write is the owner's own (PERSON_ONLY below).
  "files.drive.share", "files.drive.unshare",
  "network.guests.add", "network.guests.remove", "network.guests.enable",
  "hooks.enable", "hooks.open", "hooks.close",
  "computers.tailnet.set", "computers.egress.set",
  // Letting an agent reach a project's data at all (Vyre Drive step 3, federation): the same
  // weight a vault grant to an agent carries. Taking it away (projects.access.revoke) is
  // PERSON_ONLY below, instant, so revoking is never held up behind a prompt.
  "projects.access.grant",
]);

/**
 * The person's own actions that ask no proof, because the owner does them on their own screens and
 * Vyre does not nag (ADR 0024, user rule 27 Sep): answering a session's ask, opening a terminal,
 * making and changing agents, changing or discarding a held draft (gate.revise, gate.reject send
 * nothing), the owner's hands on an agent's computer (taking the keyboard pauses the agent,
 * handing it back returns what it had), the user's own lessons, switching one of the box's
 * VyreDrive shares between read-only and read-write (files.drive.access: the share already exists
 * and reaches no one new), and moving a box's project homes to /work/projects (projects.move).
 * None sends, pays, pairs or releases a secret. The tools' caller checks keep models, agents and
 * guests out (computers ownSurface, glass surfaceOf, drive's owner check, the allowlists), the
 * harness floor refuses a model's shell that names one of these, as it does the list above, and
 * vyred refuses a socket call to one from any process under a `claude` or a thread's process
 * (core/daemon/peer.js).
 */
export const PERSON_ONLY = new Set(["threads.answer", "term.open", "term.attach", "gate.revise", "gate.reject",
  "agents.create", "agents.update", "agents.resume",
  // team.add is no longer here: it is reach "asked" (a session may add a teammate only when the person's own
  // words asked, matched by lib/said/team.js), which a PERSON_ONLY entry would refuse before the gate ran.
  // The rest of core/team's "a person may also..." branches (an explicit project, reading every
  // project's teammates, checking or cancelling a request that is not the caller's own, editing a
  // teammate's notes) trust the same caller label, and were first fixed here per-tool (e2e
  // review, HIGH 1, f8cbc882); the lead moved that fix into the daemon instead, for every tool at
  // once, so it is not repeated per module (2026-09-28). See core/daemon/index.js.
  "computers.takeover", "computers.giveback", "glass.take", "glass.release", "files.drive.access", "files.receive", "projects.move",
  // Who watches a project's Needs without running a session in it: the owner's own list to edit.
  "projects.watchers.add", "projects.watchers.remove",
  // Taking an agent's project access away (Vyre Drive step 3): instant, no presence, so the owner
  // is never held up behind a prompt to shut a door. Granting it (projects.access.grant) is
  // HUMAN_ONLY above.
  "projects.access.revoke",
  // Attaching an existing folder to an existing project (Vyre Drive step 4): a placement
  // decision, the same weight a pick carries, but instant, no presence, so confirming
  // sync.consent's proposed mapping is never held up behind a Touch ID prompt.
  "projects.add-workspace",
  // A shared computer's own membership (agent-browsers.md level 2): who is on it, rotating a
  // member's token, and deleting one's browser context (its cookies and logins) -- the reviewer
  // and the lead's own call (28 Sep), the same floor computers.takeover already stands behind.
  // dispose is called only after the person has previewed what it removes -- a Deck-level
  // guarantee this floor does not itself prove, the same way computers.takeover asks no proof
  // beyond being the person.
  "computers.member.add", "computers.member.remove", "computers.member.rotate", "computers.member.dispose",
  // The user's own lessons: accepting, relaxing and retiring (the no-nag rule).
  "learn.accept", "learn.retire", "learn.relax",
  // What every session is told and runs on (ADR 0030): a model never edits a system prompt, a
  // mode or a model, its own least of all.
  "sessions.prompt.set", "sessions.prompt.revert", "threads.mode", "sessions.mode.set", "sessions.usage.resume", "sessions.models.set", "sessions.limits.set", "threads.shell", "threads.remember",
  // Signing a browser or app out (core/presence/person.js).
  "presence.person.revoke",
  // Every setting is the person's own: a model never changes one, and settings relays the
  // person to the owning module's setter (e2e review, HIGH 1).
  "settings.set", "settings.reset",
  // ADR 0039: which of the eight box-only modules load is the person's own choice, never an
  // agent's ancestry-forged one (reviewer's HOLD on 041f87f0/efbf7a2a).
  "onboard.machine",
  // core/link/mac.js's link.call carries a named tool to the box (`inner`, checked only by name
  // in core/daemon/index.js's floor: the Mac has no local def for a box tool to derive from). These
  // are the tools personOnly() would derive on the box itself but this Mac-side pre-check cannot,
  // named explicitly so a model's shell forwarding through link.call is refused just as early as a
  // direct call would be (reviewer's LOW, 28 Sep). voice.speak and capsule.report join them too.
  // link.unpair is here, so a model's shell on the box cannot forget a Mac by id; the one
  // machine-to-machine call it must still take, a paired Mac unpairing itself, is MACHINE_SELF
  // below (the reviewer's LOW for 0.1.1).
  "link.pair", "link.unpair", "vault.device.join", "vault.device.revoke", "vault.vaults.create",
  "files.drive.mount", "files.drive.unmount", "files.drive.open", "files.send", "agents.delete",
  "memory.correct", "memory.merge", "memory.split",
  // A model's shell making Vyre speak out loud is a social-engineering channel ("approve the
  // Touch ID prompt now"); a diagnostic bundle (paths, device names, logs) is not the model's to
  // read (reviewer, 28 Sep).
  "voice.speak", "capsule.report",
  // Ends this Mac's own person session; cheap to protect, and a model signing the person out
  // mid-task is a real annoyance (reviewer, 28 Sep).
  "link.signout",
  // core/goals: an agent may propose a goal (goals.set, state pending), but only a person's tap
  // turns it into a real one - the same shape as team_propose needing a person's team.add.
  "goals.accept"]);


/**
 * The person's own surfaces: a real terminal, the Deck, Capsule. Never `module`, `mcp`, `tailnet`,
 * `hook` or a guest kind — those already keep a model, an agent or another box's peer out on
 * their own, so a tool naming one of them is not "person-only" by its callers alone.
 */
export const PERSON_SURFACES = new Set(["cli", "local", "deck", "capsule"]);

/**
 * A tool whose callers are person-only surfaces reads as person-only, but until now only
 * PERSON_ONLY's own hand-kept list got the floor's own-process check (core/daemon/peer.js): a
 * model's shell can claim "cli" exactly as a real terminal would, so anything left off that list
 * had nothing stopping it (e2e review, 28 Sep: files.receive was the latest instance; a sweep of
 * every module found dozens more). PERSON_ONLY is derived from the manifests now: it is default-
 * deny, and OPT_OUT is the only way off it — a short, explicit, reviewed list of tools that are
 * harmless even if a model's own shell spoofs "cli", one line of reason each. It may only shrink
 * (test/person-only-guard.test.js freezes it); nothing on the reviewer's protect list (link.pair,
 * link.unpair, vault.device.join, vault.device.revoke, vault.vaults.create, files.drive.mount,
 * files.drive.unmount, files.drive.open, files.send, agents.delete, memory.correct, memory.merge,
 * memory.split, and anything else that sends, pairs, joins or changes what is remembered) belongs
 * here.
 */
export const OPT_OUT = new Set([
  // A tip list nudge: read, mark seen, dismiss, reset. Nothing sent, paid, paired or revealed.
  "tips.next", "tips.seen", "tips.used", "tips.dismiss", "tips.whatsnew", "tips.reset",
  // Dismissing a suggested skill install, the same shape as tips.dismiss.
  "learn.skill-dismiss",
  // Local voice output settings: read them, or change which voice/volume. No data leaves this
  // machine. voice.speak stays off this list (reviewer, 28 Sep): a model making Vyre say
  // something out loud is a social-engineering channel ("approve the Touch ID prompt now").
  "voice.status", "voice.settings",
  // A read-only tailnet probe for candidate boxes (`vyre up`'s own search); pairing itself
  // (link.pair) is not opted out.
  "link.find",
]);

/**
 * The only person-only calls an owner's device may make with no person session: a paired Mac
 * unpairing ITSELF, by its own link key and nothing else (core/link/mac.js sends exactly
 * `{ key }`). The box's link.unpair then finds the row by that key AND the calling node's
 * stableId (core/link/box.js byKey), so this can never forget a different Mac. By id stays the
 * person's. Adding to this needs the same review as PERSON_ONLY.
 * @param {string} tool @param {any} input
 */
export function machineSelf(tool, input) {
  return tool === "link.unpair" && Boolean(input) && typeof input.key === "string" && input.key.length > 0
    && Object.keys(input).every(k => k === "key");
}

/**
 * Is `name` a person-only tool: PERSON_ONLY's own list, or (unless explicitly opted out) a tool
 * whose declared callers are person-only surfaces alone. `def` is the live tool definition (its
 * `callers`), when the caller has it; a remote tool forwarded blind (link.call's `inner`) has none,
 * so it is checked by name against PERSON_ONLY and HUMAN_ONLY only, same as before.
 * @param {string} name @param {{ callers?: string[] }} [def]
 */
export function personOnly(name, def) {
  if (PERSON_ONLY.has(name)) return true;
  if (OPT_OUT.has(name)) return false;
  return Boolean(def) && Array.isArray(def.callers) && def.callers.length > 0 && def.callers.every(c => PERSON_SURFACES.has(c));
}

export const METHODS = ["touchid", "tty", "capsule", "device", "passkey", "code", "grant", "session"];

/**
 * Tools a short session may prove, after one strong proof: the Deck revealing or copying items
 * one after another. The floor fixes this list; a tool must also say yes for the input at hand
 * (`presence.session(input)`), so an item that asks every time never rides a session.
 */
export const SESSIONABLE = new Set(["vault.reveal", "vault.copy", "vault.totp", "vault.approve", "vault.grant", "gate.approve",
  // A person's messages from the Capsule (ADR 0022): each send is still previewed and confirmed
  // there, and the session secret lives only in the surface that opened it.
  "apps.send"]);

/**
 * Floor tools whose owner may say, per input, that no proof is needed (`presence.when`). Without
 * that declaration they ask every time. gate.approve asks only for what goes out as the user:
 * sending, posting, paying or deleting outside (the no-nag rule). vault.account.unlock asks only
 * when no vault password comes with it (Touch ID): the password is the proof, so a Mac with no
 * Touch ID reader is asked once, not for the Mac login and then the vault password.
 */
export const NARROWABLE = new Set(["gate.approve", "vault.account.unlock"]);

/**
 * Who a session may prove a vault tool for: the Deck (locally, or as the owner over the tailnet),
 * a device paired over the relay (`device:<id>`), and the Capsule. The CLI rides its own window
 * instead, bound to the login terminal vyred saw (`terminal`, see Presence.verify): the CLI is a
 * first-class surface, and a secret on disk is something a model could read. A tailnet or relayed
 * caller reaches a HUMAN_ONLY tool only with a person session as well (ADR 0032; the registry's
 * gate runs first), so a script on that device cannot borrow the node's identity here.
 */
const vaultSessionCaller = caller => {
  const c = String(caller || "");
  if (/(?:^|[\s:])agent:/.test(c)) return false;
  return c.startsWith("tailnet:") || /^device:[a-z2-7]{16}$/.test(c) || c === "deck" || c === "capsule";
};

/** How long one proof covers a login's windowed calls: as long as a session. */
const TERMINAL_WINDOW = 30 * 60_000;

/**
 * What the CLI's window covers: actions that also show in Needs and in notices. Revealing, copying
 * and one-time codes put a secret or a code on screen, so a terminal proves each of those.
 */
export const TERMINAL_WINDOWED = new Set(["vault.approve", "vault.grant"]);

export const MIGRATIONS = [`
  CREATE TABLE presence_keys (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('capsule', 'passkey')),
    name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    alg INTEGER,
    rp_id TEXT,
    sign_count INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    last_used INTEGER
  );
  CREATE TABLE presence_codes (
    hash TEXT PRIMARY KEY,
    expires INTEGER NOT NULL,
    used INTEGER
  );
`, `
  CREATE TABLE presence_sessions (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    key_id TEXT,
    method TEXT NOT NULL,
    peer TEXT,
    created INTEGER NOT NULL,
    last_used INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
`, `
  CREATE TABLE presence_keys_v3 (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('capsule', 'passkey', 'device')),
    name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    alg INTEGER,
    rp_id TEXT,
    sign_count INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    last_used INTEGER
  );
  INSERT INTO presence_keys_v3 SELECT id, kind, name, public_key, alg, rp_id, sign_count, created, last_used FROM presence_keys;
  DROP TABLE presence_keys;
  ALTER TABLE presence_keys_v3 RENAME TO presence_keys;
`, `
  CREATE TABLE presence_people (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('cookie', 'bearer')),
    node TEXT NOT NULL,
    label TEXT,
    key TEXT,
    created INTEGER NOT NULL,
    last_used INTEGER NOT NULL,
    max INTEGER NOT NULL
  );
  CREATE TABLE presence_person_codes (
    hash TEXT PRIMARY KEY,
    cc TEXT NOT NULL,
    node TEXT NOT NULL,
    origin TEXT NOT NULL,
    label TEXT,
    expires INTEGER NOT NULL
  );
`, `
  CREATE TABLE presence_key_devices (
    key TEXT PRIMARY KEY,
    device TEXT NOT NULL,
    origin TEXT NOT NULL
  );
`, `
  -- A single row: the Capsule build most recently pinned by \`vyre capsule install\`. A DB row
  -- through the normal presence tool floor (capsule.pin, presence-required), never a bystander
  -- file: a flat JSON file under root was the first version of this and the reviewer broke it in
  -- one line -- writable by the same uid vyred runs as, which is also a model's shell's, so
  -- nothing stopped it writing its own build's cdhash there directly, no tool call needed at all
  -- (28 Sep). A row here is exactly as protected as any other presence key: only vyred's own tool
  -- handler, gated the same way presence.enroll already is, ever writes one.
  CREATE TABLE presence_capsule_pin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cdhash TEXT NOT NULL,
    pinned_at INTEGER NOT NULL
  );
`, `
  -- A key that signs a call itself (capsule, device) always stores its kind: ES256, alg -7. Device
  -- keys were always enrolled that way; fill any row that isn't, then refuse one that would not be.
  -- An old Ed25519 capsule row keeps its -8, so it is refused at proof time rather than rewritten.
  UPDATE presence_keys SET alg = -7 WHERE kind = 'device' AND alg IS NULL;
  CREATE TRIGGER presence_keys_signer_alg BEFORE INSERT ON presence_keys
    WHEN NEW.kind IN ('capsule', 'device') AND (NEW.alg IS NULL OR NEW.alg <> -7)
    BEGIN SELECT RAISE(ABORT, 'a capsule or device key must store alg -7'); END;
  CREATE TRIGGER presence_keys_signer_alg_update BEFORE UPDATE OF kind, alg, public_key ON presence_keys
    WHEN NEW.kind IN ('capsule', 'device') AND (NEW.alg IS NULL OR NEW.alg <> -7)
    BEGIN SELECT RAISE(ABORT, 'a capsule or device key must store alg -7'); END;
`, `
  -- The first owner passkey's one-time grant (relay.setup.claim): stored hashed, five minutes, one
  -- use, bound to the node that asked for it and to the address the claim was made at (the
  -- passkey's rp_id).
  CREATE TABLE presence_grants (
    hash TEXT PRIMARY KEY,
    expires INTEGER NOT NULL,
    used INTEGER,
    peer TEXT,
    host TEXT
  );
`, `
  -- A device key may also be RS256 (alg -257, RSA 2048+, Windows Hello). The Capsule's key stays
  -- ES256 only. Index.js checks the alg against the key's type at enroll and again at every proof.
  DROP TRIGGER presence_keys_signer_alg;
  DROP TRIGGER presence_keys_signer_alg_update;
  CREATE TRIGGER presence_keys_signer_alg BEFORE INSERT ON presence_keys
    WHEN (NEW.kind = 'capsule' AND (NEW.alg IS NULL OR NEW.alg <> -7)) OR (NEW.kind = 'device' AND (NEW.alg IS NULL OR NEW.alg NOT IN (-7, -257)))
    BEGIN SELECT RAISE(ABORT, 'a capsule key must store alg -7 and a device key alg -7 or -257'); END;
  CREATE TRIGGER presence_keys_signer_alg_update BEFORE UPDATE OF kind, alg, public_key ON presence_keys
    WHEN (NEW.kind = 'capsule' AND (NEW.alg IS NULL OR NEW.alg <> -7)) OR (NEW.kind = 'device' AND (NEW.alg IS NULL OR NEW.alg NOT IN (-7, -257)))
    BEGIN SELECT RAISE(ABORT, 'a capsule key must store alg -7 and a device key alg -7 or -257'); END;
`, `
  -- A person session made with a presence key remembers which one, so removing that key can end the
  -- sessions it opened. presence_removed keeps what was removed for 30 days: a session's id with
  -- the hash of its secret (so only a holder of the credential this box issued can be told "this
  -- device was removed"; anyone else gets today's answer) and the removed key's id.
  ALTER TABLE presence_people ADD COLUMN key_id TEXT;
  CREATE TABLE presence_removed (
    id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('session', 'key')),
    hash TEXT,
    key_id TEXT,
    removed INTEGER NOT NULL,
    PRIMARY KEY (id, kind)
  );
`, `
  -- An owner-paired device's person session (ADR 0032 section 2d). The pairing writes one grant for
  -- the device: the key the owner confirmed, the presence key whose proof confirmed it, and a short
  -- life. The device's first start proves it holds that key, and turns the grant into a session
  -- with no maximum life (paired = 1), which still ends after 30 days unused.
  ALTER TABLE presence_people ADD COLUMN paired INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE presence_people ADD COLUMN rotated INTEGER;
  ALTER TABLE presence_people ADD COLUMN software INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE presence_pair_grants (
    device TEXT PRIMARY KEY,
    key_id TEXT NOT NULL,
    device_key TEXT NOT NULL,
    challenge TEXT NOT NULL,
    software INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0
  );
`];

const CHALLENGE_TTL = 120_000;
const CAPSULE_SKEW = 60_000;
const COOL_DOWN = 30_000;
const CODE_TTL = 10 * 60_000;
const GRANT_TTL = 5 * 60_000;
// A session lasts 30 minutes from the proof, used or not (the no-nag rule: one proof covers
// about 30 minutes on that device). There is no shorter idle cutoff inside that.
const SESSION_MAX = 30 * 60_000;
const SESSION_IDLE = SESSION_MAX;
/** The proofs strong enough to open a session: hardware or a key the model cannot read. */
const SESSION_FROM = new Set(["touchid", "capsule", "device", "passkey"]);
const MAX_OPEN = 64;
// No 0/O, 1/I/L: a code is read off a screen and typed by hand.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TTY = /^\/dev\/(ttys\d+|pts\/\d+|tty\d+)$/;
// COSE algorithms a passkey may use, and the key type each needs.
const ALGS = { "-7": "ec", "-8": "ed25519", "-257": "rsa" };

/** JSON with object keys sorted at every depth and no spaces. What the input hash is taken over. */
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(x => (x === undefined || typeof x === "function" ? "null" : canonical(x))).join(",") + "]";
  if (v && typeof v === "object" && typeof v.toJSON !== "function") {
    const keys = Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== "function").sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}

/** base64url SHA-256 of the canonical input. A proof is bound to this, so it cannot approve anything else. */
export const inputHash = input => crypto.createHash("sha256").update(canonical(input)).digest("base64url");

/**
 * The x-vyre-presence header: "<method> k=v k=v". Returns { method, ...fields }, or null for
 * anything else (no header, an unknown method, a malformed or repeated field).
 * @param {unknown} header
 */
export function parse(header) {
  if (typeof header !== "string" || !header.trim() || header.length > 32_768) return null;
  const [method, ...rest] = header.trim().split(/\s+/);
  if (!METHODS.includes(method)) return null;
  /** @type {Record<string, string>} */
  const out = { method };
  for (const part of rest) {
    const m = /^([a-z][a-z0-9_]*)=(\S*)$/.exec(part);
    if (!m || m[1] === "method" || Object.hasOwn(out, m[1])) return null;
    out[m[1]] = m[2];
  }
  return out;
}

/** Control characters (C0, DEL, C1) and bidi overrides: a summary goes on a terminal and in a dialog. */
const clean = s => String(s).replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g, " ").replace(/ {2,}/g, " ").trim();

const b64url = n => crypto.randomBytes(n).toString("base64url");
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
/** Equal in constant time, whatever the lengths. */
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const randomCode = n => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
/** Codes are typed by hand: case and spaces do not matter. */
const normal = code => String(code || "").toUpperCase().replace(/[\s-]/g, "");
/** The tailnet node a request came from, when a listener established one. */
const peerId = peer => (peer && (peer.stableId || peer.node) ? String(peer.stableId || peer.node) : null);
const spki = b64 => crypto.createPublicKey({ key: Buffer.from(String(b64), "base64url"), format: "der", type: "spki" });
/** A signing key's id is its fingerprint, so one key cannot be enrolled twice. */
export const fingerprint = b64 => crypto.createHash("sha256").update(Buffer.from(String(b64), "base64url")).digest("base64url").slice(0, 22);
/**
 * The keys that sign a call themselves, the same message and rules for each, both ES256 (P-256,
 * DER signatures): the Capsule's key in the Mac's Secure Enclave, which asks for a live Touch ID
 * on every signature (biometryCurrentSet), and a phone's key in its Secure Enclave or StrongBox
 * (ADR 0018). Each is checked only against the public key enrolled for its id, never a key the
 * proof carries. `check` is crypto.verify's algorithm and key for that kind.
 */
const ES256 = pub => ["sha256", { key: spki(pub), dsaEncoding: /** @type {const} */ ("der") }];
const SIGNERS = {
  capsule: { label: "Capsule", check: ES256, stale: "that Capsule key is an old kind Vyre no longer accepts; re-enroll the Capsule's key" },
  // The algorithm comes from the alg stored at enroll time, never from the caller: ES256 for a
  // P-256 key, RS256 (RSASSA-PKCS1-v1_5, SHA-256) for an RSA key, and the key must be that type.
  device: { label: "device", stale: "that phone's key is not a kind Vyre accepts (P-256, or RSA 2048 bits or more); pair the phone again", check: (pub, alg) => {
    const key = spki(pub);
    if (alg === -7 && key.asymmetricKeyType === "ec") return ["sha256", { key, dsaEncoding: /** @type {const} */ ("der") }];
    if (alg === -257 && key.asymmetricKeyType === "rsa") { checkRsa(key); return ["sha256", { key, padding: crypto.constants.RSA_PKCS1_PADDING }]; }
    throw new Error("the stored alg does not match the stored key");
  } },
};

/** EC P-256 and nothing else: what a Secure Enclave or StrongBox holds. @param {crypto.KeyObject} key */
const isP256 = key => key.asymmetricKeyType === "ec" && /** @type {any} */ (key.asymmetricKeyDetails || {}).namedCurve === "prime256v1";

/** Load one of the helper modules lazily. Another file may not exist yet; a failed import is "unavailable". */
async function lazy(spec, name) {
  try {
    const m = await import(spec);
    if (typeof m[name] === "function") return m;
    if (m.default && typeof m.default[name] === "function") return m.default;
  } catch {}
  return null;
}

/** The terminals `who` lists as login sessions: ttys003 on a Mac, pts/3 on Linux. */
function who() {
  return new Promise(resolve => {
    execFile("/usr/bin/who", [], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout).split("\n").map(l => l.trim().split(/\s+/)[1]).filter(Boolean));
    });
  });
}

/** Write straight to a terminal device, without making it this process's controlling terminal. */
function writeTty(file, text) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | (fs.constants.O_NOCTTY || 0));
  try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
}

/**
 * On a Mac with vyre-core installed (ADR 0040), the trust anchors are core's, not vyred's: vyred's
 * own presence_keys can be written by a model's shell (same uid). vyred's daemon sets `core.link`
 * at start when a root-owned core.json names core (lib/vyre-core-client.js), and every Presence
 * then asks core to check a signature, passkey or code proof, and refuses to enroll or remove a
 * key itself: those go from the person's own client straight to core. Touch ID, the terminal
 * code and sessions stay vyred's own, and advisory on a Mac, as ADR 0040 section 3 says of every
 * vyred-side control. Linux never sets it.
 * @typedef {{ verify(tool: string, input: any, header: string): Promise<{ ok: boolean, method?: string, keyId?: string|null, message?: string }>,
 *   keys(): Promise<any[]>, challenge(tool: string, input: any): Promise<any>,
 *   call?(tool: string, input: any, header?: string): Promise<{ data?: any, error?: any }> }} CoreLink
 */
export const core = { link: /** @type {CoreLink|null} */ (null) };
/** The proofs vyre-core checks in vyred's place. */
export const CORE_CHECKED = new Set(["capsule", "device", "passkey", "code"]);
/** A parsed proof back into its header, fields in their own order. @param {Record<string, string>} proof */
export const format = proof => [proof.method, ...Object.entries(proof).filter(([k]) => k !== "method").map(([k, v]) => `${k}=${v}`)].join(" ");
const coreOwned = what => Object.assign(new Error(`on this Mac, ${what} in vyre-core: do it from your own terminal or the Capsule, which talk to vyre-core directly`), { code: "core_owned" });

export class Presence {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, events?: any, log?: (m: string) => void, platform?: string,
   *           role?: string, network?: () => { owner?: string, address?: string }, who?: () => Promise<string[]>, writeTty?: (file: string, text: string) => void, statTty?: (file: string) => any,
   *           touchid?: any, webauthn?: any, now?: () => number, env?: NodeJS.ProcessEnv, core?: CoreLink|null }} opts
   */
  constructor({ db, events = null, standIn = () => false, log = () => {}, platform = process.platform, role = "local", network = () => ({}), who: whoFn, writeTty: write, statTty, touchid, webauthn, now, env = process.env, core: coreOpt }) {
    this.db = db;
    /** DEVELOPMENT ONLY: is the walk's presence stand-in on for this home? The daemon answers true only for a development build whose home holds a file the owner made by hand. */
    this.standIn = standIn;
    /** A test's own link, or null for none; undefined reads the daemon's (core.link). */
    this.coreOpt = coreOpt;
    this.role = role;
    this.network = network;
    this.events = events;
    this.log = log;
    this.platform = platform;
    this.who = whoFn || who;
    this.writeTty = write || writeTty;
    this.statTty = statTty || (f => fs.statSync(f));
    this.touchidImpl = touchid;
    // The real helper shows a system dialog, so it never runs under tests (core/config/dialogs.js).
    // An injected stand-in shows nothing, so it always may.
    this.noDialogs = touchid === undefined && !dialogsAllowed(env);
    // Nor does the real terminal code: it would land in the user's own terminal window.
    this.noTtyWrites = write === undefined && !dialogsAllowed(env);
    this.webauthnImpl = webauthn;
    this.now = now || Date.now;
    migrate(db, "presence", MIGRATIONS);
    /** Open challenges, in memory only: a restart forgets them, which is the safe direction. */
    /** @type {Map<string, { tool: string, hash: string, method: string, code?: string, tries: number, expires: number, challenge?: string, rpId?: string }>} */
    this.challenges = new Map();
    /** Capsule nonces seen, with when each can be forgotten. */
    /** @type {Map<string, number>} */
    this.nonces = new Map();
    this.dialogOpen = false;
    this.coolUntil = 0;
    /** Login terminal -> when its window ends. In memory only: a restart asks again. */
    /** @type {Map<string, number>} */
    this.terminals = new Map();
  }

  /** vyre-core, when it holds this Mac's trust anchors. @returns {CoreLink|null} */
  get coreLink() { return this.coreOpt !== undefined ? this.coreOpt : core.link; }

  /**
   * One line on the terminal a window was used from, so a command someone else typed into it
   * (tmux send-keys, AppleScript) cannot pass unseen.
   * @param {string|null|undefined} tty @param {string} tool @param {any} input
   */
  windowNotice(tty, tool, input) {
    if (!tty || this.noTtyWrites) return;
    const what = tool === "vault.grant" ? `letting ${input && input.module} use ${input && input.name}` : tool === "vault.approve" ? `approving ${input && input.id}` : tool;
    try { this.writeTty(`/dev/${tty}`, `\r\nvyre: used your Touch ID window for ${what}\r\n`); }
    catch (e) { this.log(`presence: could not write the window notice to ${tty}: ${/** @type {Error} */ (e).message}`); }
  }

  async touchid() {
    if (this.touchidImpl === undefined) this.touchidImpl = await lazy("./touchid/index.js", "authenticate");
    return this.touchidImpl;
  }

  async webauthn() {
    if (this.webauthnImpl === undefined) this.webauthnImpl = await lazy("./webauthn.js", "verifyAssertion");
    return this.webauthnImpl;
  }

  /** Does this tool need a person? The floor's list, or the tool's own declaration. */
  required(tool, def, input) {
    // A tool may ask only for some inputs (presence.when). Without the input (listing tools), it
    // counts as asking.
    const p = def && def.presence;
    const when = p && typeof p.when === "function" && input !== undefined ? () => Boolean(p.when(input)) : null;
    if (HUMAN_ONLY.has(tool)) return NARROWABLE.has(tool) && when ? when() : true;
    return when ? when() : Boolean(p);
  }

  /**
   * Is there a live presence session for this device (the tailnet peer, or none for this
   * machine's own surfaces)? A surface shows "covered" and sends the session instead of asking.
   * @param {any} peer
   */
  covered(peer) { return this.coverage(peer).covered; }

  /**
   * The same, with when: `since` is when the newest live session for this device was proved and
   * `expires` when it lapses (ms since the epoch), both null when there is none. A surface shows
   * "confirmed 12 min ago" from since.
   * @param {any} peer @returns {{ covered: boolean, since: number|null, expires: number|null }}
   */
  coverage(peer) {
    const now = this.now();
    const id = peerId(peer);
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT peer, created, expires FROM presence_sessions WHERE expires > ? AND last_used > ? ORDER BY created DESC").all(now, now - SESSION_IDLE));
    const row = rows.find(r => (r.peer ?? null) === id);
    return row ? { covered: true, since: Number(row.created), expires: Number(row.expires) } : { covered: false, since: null, expires: null };
  }

  /** What the person sees before proving anything. Never carries a control character. */
  async summary(tool, input, def) {
    const fn = def && def.presence && typeof def.presence.summary === "function" ? def.presence.summary : null;
    if (fn) {
      try {
        const s = clean(await fn(input));
        if (s) return s.slice(0, 400);
      } catch {}
    }
    return clean(`${tool} ${canonical(input)}`.slice(0, 160));
  }

  /** The methods this machine can take a proof by right now. */
  async methods() {
    const out = [];
    if (this.platform === "darwin" && !this.noDialogs) {
      // The helper is built on first use, which can take a while. A refusal should not wait on
      // that: until it answers, Touch ID is not offered, and the build carries on behind.
      const t = await this.touchid();
      try { if (t && await within(t.available(), 3000, false)) out.push("touchid"); } catch {}
    }
    if (this.ttyAllowed() && !this.noTtyWrites) out.push("tty");
    const link = this.coreLink;
    let rows = [];
    if (link) { try { rows = await link.keys(); } catch {} }
    else rows = this.db.prepare("SELECT DISTINCT kind FROM presence_keys").all();
    const kinds = new Set(rows.map(r => String(r.kind)));
    if (kinds.has("capsule")) out.push("capsule");
    if (kinds.has("device")) out.push("device");
    if (kinds.has("passkey")) out.push("passkey");
    return out;
  }

  prune() {
    const now = this.now();
    for (const [id, c] of this.challenges) if (c.expires <= now) this.challenges.delete(id);
    for (const [n, until] of this.nonces) if (until <= now) this.nonces.delete(n);
    for (const [t, until] of this.terminals) if (until <= now) this.terminals.delete(t);
  }

  /**
   * A code on a login terminal proves a person only where a model cannot open a login terminal
   * of its own. On the box it can: the Mac it runs on usually holds SSH keys to the box. And in
   * the box's container, `vyre` reaches vyred through `docker compose exec`, whose terminal no
   * `who` lists, so nothing there could tell the person's terminal from Claude's. The box never
   * takes a terminal code; its first passkey comes from onboarding's one-time code.
   * @param {string} [tool]
   */
  ttyAllowed(tool) {
    return !isServer(this.role);
  }

  /**
   * Start a proof that needs one: tty writes a code to a login terminal, passkey hands back
   * WebAuthn options. Returns { challenge, ... } or { error: { code, message } }.
   * @param {{ tool: string, input: any, method: string, tty?: string, def?: any }} a
   */
  async challenge({ tool, input, method, tty, def, peer = null }) {
    this.prune();
    if (this.challenges.size >= MAX_OPEN) return { error: { code: "denied", message: "too many presence challenges are open; wait for them to expire" } };
    const hash = inputHash(input);
    const id = b64url(16);
    const expires = this.now() + CHALLENGE_TTL;
    if (method === "tty") {
      if (!this.ttyAllowed(tool)) return { error: { code: "denied", message: "on the box, prove it with a passkey from the Deck" } };
      if (typeof tty !== "string" || !TTY.test(tty)) return { error: { code: "bad_input", message: "tty must be a terminal device such as /dev/ttys003 or /dev/pts/3" } };
      let st;
      try { st = this.statTty(tty); } catch { return { error: { code: "denied", message: `${tty} is not a terminal` } }; }
      if (!st || typeof st.isCharacterDevice !== "function" || !st.isCharacterDevice()) return { error: { code: "denied", message: `${tty} is not a terminal` } };
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) return { error: { code: "denied", message: `${tty} belongs to another user` } };
      // script, expect, Python pty and tmux panes are not login sessions, so who does not list them.
      const logins = await this.who();
      if (!logins.includes(tty.slice("/dev/".length))) return { error: { code: "denied", message: `${tty} is not a login terminal; run the command in a terminal window or over SSH` } };
      if (this.noTtyWrites) return { error: { code: NO_DIALOG, message: "no terminal code is written under tests" } };
      const code = randomCode(6);
      const summary = await this.summary(tool, input, def);
      try { this.writeTty(tty, `\r\n  Vyre · ${summary}\r\n  To allow it, type this code where you ran the command: ${code}\r\n\r\n`); }
      catch (e) { return { error: { code: "denied", message: `could not write to ${tty}: ${/** @type {Error} */ (e).message}` } }; }
      this.challenges.set(id, { tool, hash, method, code, tries: 0, expires });
      return { challenge: id };
    }
    // A passkey answers a challenge, and on a Mac with vyre-core only core's own challenge counts.
    if (method === "passkey" && this.coreLink && !(peer && peer.kind === "device")) return this.coreLink.challenge(tool, input);
    if (method === "passkey") {
      // A browser paired over the relay (ADR 0032 part 2b) uses only the passkey enrolled for its
      // own device id; every other caller uses only the passkeys bound to no device.
      const device = peer && peer.kind === "device" && peer.stableId ? String(peer.stableId) : null;
      const rows = /** @type {any[]} */ (this.db.prepare(`SELECT k.id, k.rp_id, d.origin FROM presence_keys k LEFT JOIN presence_key_devices d ON d.key = k.id
        WHERE k.kind = 'passkey' AND ${device ? "d.device = ?" : "d.device IS NULL"} ORDER BY k.created`).all(...(device ? [device] : [])));
      if (!rows.length) return { error: { code: "bad_input", message: device ? "no passkey is enrolled for this device" : "no passkey is enrolled; enroll one with presence.enroll" } };
      const rpId = String(rows[0].rp_id);
      const challenge = b64url(32);
      this.challenges.set(id, { tool, hash, method, tries: 0, expires, challenge, rpId, ...(device ? { device, origin: String(rows[0].origin) } : {}) });
      return { challenge: id, webauthn: { challenge, rpId, userVerification: "required", timeout: 60_000,
        allowCredentials: rows.filter(r => String(r.rp_id) === rpId).map(r => ({ type: "public-key", id: String(r.id) })) } };
    }
    return { error: { code: "bad_input", message: `method must be tty or passkey; ${method} needs no challenge or does not exist` } };
  }

  /**
   * Check a proof for one call. Returns { ok: true, method } or a refusal that lists the methods
   * the client could use instead.
   * @param {{ tool: string, input: any, caller: string, proof: any, def?: any, peer?: any, terminal?: string|{ key: string, tty?: string|null }|null }} a terminal: the login vyred saw the caller in (key) and the terminal to write a notice to (tty)
   */
  async verify({ tool, input, caller, proof, def, peer = null, terminal = null, meta = null }) {
    const method = proof && typeof proof.method === "string" ? proof.method : null;
    // A call with no proof is how a client learns what to offer, so only a failed proof is an event.
    const refuse = async message => {
      if (method) this.emit("presence.refused", { tool, method, caller });
      return { ok: /** @type {false} */ (false), code: "presence_required", message, methods: await this.methods() };
    };
    this.prune();
    // The CLI's window: after one strong proof from a login (Touch ID, the Capsule, a passkey), the
    // same login's vault approvals and grants ask nothing for 30 minutes. vyred names the login from
    // the kernel's word on who connected (core/daemon/index.js atTerminal), never from anything the
    // caller sends. Anything that puts a secret or a code on screen stays per call: a terminal can
    // be typed into by other processes (tmux send-keys, AppleScript), and a window must never turn
    // that into a silent reveal. Each use writes a line to that terminal and says so to the tool.
    const term = typeof terminal === "string" ? (terminal ? { key: terminal, tty: terminal } : null)
      : terminal && typeof terminal.key === "string" && terminal.key ? terminal : null;
    const cliLogin = Boolean(term) && /^(cli|local)$/.test(String(caller));
    const sessionOk = async () => (def && def.presence && typeof def.presence.session === "function"
      ? (await Promise.resolve(def.presence.session(input)).catch(() => false)) === true : false);
    const opens = cliLogin && SESSIONABLE.has(tool);
    if (cliLogin && TERMINAL_WINDOWED.has(tool) && (this.terminals.get(/** @type {any} */ (term).key) || 0) > this.now() && await sessionOk()) {
      const tty = /** @type {any} */ (term).tty;
      this.windowNotice(tty, tool, input);
      this.emit("presence.proved", { tool, method: "window", caller });
      return { ok: /** @type {true} */ (true), method: "window", keyId: null, where: tty || null };
    }
    if (method === "stand-in") {
      // The automated walk's stand-in for a person's proof: honoured only where the daemon says so (a development build with the owner's hand-made file). Every event and audit row that follows
      // carries method "stand-in", so a walk can never be mistaken for a real proof. A packaged build says so once and refuses.
      let on = false; try { on = this.standIn() === true; } catch { on = false; }
      if (!on) {
        if (!this.standInSaid) { this.standInSaid = true; this.log("presence: a stand-in proof was offered and ignored: this build takes none"); }
        return refuse("this build takes no presence stand-in");
      }
      this.emit("presence.proved", { tool, method: "stand-in", caller });
      return { ok: /** @type {true} */ (true), method: "stand-in", keyId: null };
    }
    if (!method) return refuse(`${tool} needs a person to prove they are here`);
    const hash = inputHash(input);
    const proved = (keyId = null) => {
      if (opens && SESSION_FROM.has(method)) this.terminals.set(/** @type {any} */ (term).key, this.now() + TERMINAL_WINDOW);
      this.emit("presence.proved", { tool, method, caller });
      return { ok: /** @type {true} */ (true), method, keyId };
    };

    // On a Mac with vyre-core, a key-based proof is core's to check, against core's own keys;
    // vyred's own presence_keys are never read for it.
    const link = this.coreLink;
    if (link && CORE_CHECKED.has(method)) {
      let r;
      try { r = await link.verify(tool, input, format(proof)); }
      catch (e) { r = { ok: false, message: `vyre-core could not be asked: ${/** @type {Error} */ (e).message}` }; }
      return r && r.ok ? proved(r.keyId ?? null) : refuse(r && r.message ? r.message : "vyre-core did not accept that proof");
    }

    if (method === "touchid") {
      if (this.platform !== "darwin") return refuse("Touch ID is only on a Mac");
      if (this.noDialogs) {
        this.emit("presence.refused", { tool, method, caller });
        return { ok: /** @type {false} */ (false), code: NO_DIALOG, message: "Touch ID shows no dialog under tests", methods: await this.methods() };
      }
      // Checked and taken before any await, so two calls at once cannot both open a dialog.
      if (this.dialogOpen) return refuse("a Touch ID dialog is already open");
      if (this.now() < this.coolUntil) return refuse(`Touch ID was cancelled; try again in ${Math.ceil((this.coolUntil - this.now()) / 1000)}s`);
      this.dialogOpen = true;
      let r;
      try {
        const t = await this.touchid();
        if (!t || !(await t.available())) return refuse("Touch ID is not available on this Mac");
        const summary = await this.summary(tool, input, def);
        try { r = await t.authenticate(`Vyre: ${summary}`, { timeout: 60 }); }
        catch (e) { r = { ok: false, reason: /** @type {Error} */ (e).message }; }
      } finally { this.dialogOpen = false; }
      // After a cancel or a failure, wait before showing another: a model must not wear the user down.
      if (!r || !r.ok) { this.coolUntil = this.now() + COOL_DOWN; return refuse(`Touch ID did not confirm${r && r.reason ? ": " + r.reason : ""}`); }
      return proved();
    }

    if (method === "tty") {
      if (!this.ttyAllowed(tool)) return refuse("on the box, prove it with a passkey from the Deck");
      const c = this.challenges.get(String(proof.id || ""));
      if (!c || c.method !== "tty") return refuse("no such terminal challenge, or it expired");
      if (c.tool !== tool || c.hash !== hash) return refuse("the terminal challenge was for a different call");
      if (!same(normal(proof.code), c.code)) {
        c.tries += 1;
        if (c.tries >= 3) this.challenges.delete(String(proof.id));
        return refuse(c.tries >= 3 ? "wrong code three times; start again" : "wrong code");
      }
      this.challenges.delete(String(proof.id));
      return proved();
    }

    if (method === "capsule" || method === "device") {
      const { label, check, stale } = SIGNERS[method];
      const { key, ts, nonce, sig } = proof;
      const row = /** @type {any} */ (this.db.prepare("SELECT id, public_key, alg FROM presence_keys WHERE id = ? AND kind = ?").get(String(key || ""), method));
      if (!row) return refuse(`that ${label} key is not enrolled`);
      // A Capsule key from before the Secure Enclave (Ed25519 in the login keychain, which any
      // program running as the same user could use): never a proof again, whatever it signed.
      // The stored key itself must be P-256 too, so the check never rests on the alg column alone.
      let stored = null;
      try { stored = spki(row.public_key); } catch { /* unreadable: refused below */ }
      // A device key is P-256 or RSA with a matching alg; a stored alg that disagrees with its key is left to check(), which refuses it.
      const keyOk = method === "device" ? [-7, -257].includes(Number(row.alg)) && Boolean(stored) && (isP256(stored) || stored.asymmetricKeyType === "rsa") : Number(row.alg) === -7 && Boolean(stored) && isP256(stored);
      if (!keyOk) return refuse(stale);
      if (!/^\d{1,16}$/.test(String(ts || "")) || Math.abs(this.now() - Number(ts)) > CAPSULE_SKEW) return refuse(`the ${label} signature is too old or from the future`);
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(nonce || ""))) return refuse(`the ${label} nonce is missing or malformed`);
      // One set for both kinds: a nonce is spent whichever key signed with it.
      if (this.nonces.has(nonce)) return refuse(`that ${label} nonce was already used`);
      let good = false;
      try {
        const msg = Buffer.from(`vyre-presence-v1\n${tool}\n${hash}\n${ts}\n${nonce}`);
        const [alg, pub] = check(row.public_key, row.alg === null ? null : Number(row.alg));
        good = crypto.verify(alg, msg, pub, Buffer.from(String(sig || ""), "base64url"));
      } catch {}
      if (!good) return refuse(`the ${label} signature does not check out`);
      this.nonces.set(nonce, this.now() + 2 * CAPSULE_SKEW + 1000);
      this.db.prepare("UPDATE presence_keys SET last_used = ? WHERE id = ?").run(this.now(), row.id);
      return proved(row.id);
    }

    if (method === "passkey") {
      const c = this.challenges.get(String(proof.id || ""));
      if (!c || c.method !== "passkey") return refuse("no such passkey challenge, or it expired");
      if (c.tool !== tool || c.hash !== hash) return refuse("the passkey challenge was for a different call");
      // One attempt per challenge, whatever its outcome.
      this.challenges.delete(String(proof.id));
      const row = /** @type {any} */ (this.db.prepare("SELECT * FROM presence_keys WHERE id = ? AND kind = 'passkey'").get(String(proof.cred || "")));
      if (!row || String(row.rp_id) !== c.rpId) return refuse("that passkey is not enrolled");
      const bound = /** @type {any} */ (this.db.prepare("SELECT device, origin FROM presence_key_devices WHERE key = ?").get(row.id));
      const from = peer && peer.kind === "device" && peer.stableId ? String(peer.stableId) : null;
      // A device-bound passkey proves only for its device, from its app's origin; no other does.
      if ((bound ? bound.device : null) !== (c.device || null) || (c.device || null) !== from) return refuse("that passkey is not this device's");
      const w = await this.webauthn();
      if (!w) return refuse("passkeys cannot be checked on this machine");
      let r;
      try {
        r = await w.verifyAssertion({ publicKey: String(row.public_key), alg: Number(row.alg), rpId: String(row.rp_id), challenge: c.challenge,
          authenticatorData: String(proof.ad || ""), clientDataJSON: String(proof.cd || ""), signature: String(proof.sig || ""),
          ...(bound ? { origins: [String(bound.origin)] } : {}) });
      } catch (e) { r = { ok: false, reason: /** @type {Error} */ (e).message }; }
      if (!r || !r.ok) return refuse(`the passkey assertion does not check out${r && r.reason ? ": " + r.reason : ""}`);
      // A counter that does not move forward means a cloned authenticator. Synced passkeys send 0.
      const count = Number(r.signCount || 0);
      if (count !== 0 && count <= Number(row.sign_count || 0)) return refuse("the passkey's signature counter went backwards");
      this.db.prepare("UPDATE presence_keys SET sign_count = ?, last_used = ? WHERE id = ?").run(count, this.now(), row.id);
      return proved(row.id);
    }

    if (method === "session") {
      if (!SESSIONABLE.has(tool)) return refuse(`${tool} needs its own proof, not a session`);
      // A session proves a vault tool only for the person: the kernel's chain for the call says so (`personOf`, set by the presence module from ctx.kernel), never the caller's label. With no
      // kernel (development) the old label rule stays: SHIM(legacy labels).
      if (tool.startsWith("vault.") && !(this.personOf ? await this.personOf(meta || { caller }) : vaultSessionCaller(caller))) return refuse(`${tool} asks for its own proof from here; a session serves the Deck and the Capsule, and a terminal has its own window`);
      const ok = def && def.presence && typeof def.presence.session === "function" ? await Promise.resolve(def.presence.session(input)).catch(() => false) : false;
      if (ok !== true) return refuse("this item needs its own proof every time");
      const row = /** @type {any} */ (this.db.prepare("SELECT * FROM presence_sessions WHERE id = ?").get(String(proof.id || "")));
      const now = this.now();
      if (!row || row.expires <= now || row.last_used + SESSION_IDLE <= now) return refuse("no such session, or it ended");
      if (!same(sha(String(proof.secret || "")).toString("hex"), row.hash)) return refuse("that session secret is wrong");
      if (row.peer && row.peer !== peerId(peer)) return refuse("that session belongs to another device");
      this.db.prepare("UPDATE presence_sessions SET last_used = ? WHERE id = ?").run(now, row.id);
      return proved(row.key_id);
    }

    if (method === "code") {
      if (tool !== "presence.enroll") return refuse("a one-time code only enrolls a passkey or a device key");
      // On the box, Claude's sessions share vyred's socket and can ask onboarding for a fresh code.
      // So the code counts only from the owner's own device over the tailnet, where they cannot be.
      if (isServer(this.role)) {
        const owner = String((this.network() || {}).owner || "").toLowerCase();
        if (!owner || String(caller || "").toLowerCase() !== `tailnet:${owner}`) return refuse("on the box, a passkey is enrolled from the owner's own device, over the tailnet");
      }
      if (!this.useCode(proof.code)) return refuse("that code is wrong, used or expired");
      return proved();
    }

    if (method === "grant") {
      // The first owner passkey's grant (relay.setup.claim checked a signed claim token to mint it):
      // presence.enroll only, once, within five minutes, from the browser it was made for, and on the
      // box from the owner's own device over the tailnet as a code is.
      if (tool !== "presence.enroll") return refuse("a grant only enrolls the first passkey");
      if (isServer(this.role)) {
        const owner = String((this.network() || {}).owner || "").toLowerCase();
        if (!owner || String(caller || "").toLowerCase() !== `tailnet:${owner}`) return refuse("on the box, a passkey is enrolled from the owner's own device, over the tailnet");
      }
      const h = sha(String(proof.grant || "")).toString("hex");
      const row = /** @type {any} */ (this.db.prepare("SELECT peer, host FROM presence_grants WHERE hash = ? AND used IS NULL AND expires > ?").get(h, this.now()));
      if (!row || (row.peer && row.peer !== peerId(peer))) return refuse("that grant is wrong, used, expired or made for another device");
      // It enrols a passkey for the address the claim was made at, and nothing else.
      if (!input || input.kind !== "passkey" || !row.host || String(input.rp_id || "").toLowerCase() !== row.host) return refuse("a grant enrolls a passkey for the address it was claimed at");
      const r = this.db.prepare("UPDATE presence_grants SET used = ? WHERE hash = ? AND used IS NULL AND expires > ?").run(this.now(), h, this.now());
      if (Number(r.changes) !== 1) return refuse("that grant is wrong, used or expired");
      return proved();
    }

    return refuse(`unknown presence method ${method}`);
  }

  /**
   * Open a short session after a strong proof. The secret is returned once and kept only as a
   * hash; it lasts 30 minutes from the proof, and only on the device that opened it.
   * @param {{ method?: string, keyId?: string|null, peer?: any }} proved how the opening call was proved
   */
  openSession({ method, keyId = null, peer = null } = {}) {
    if (!method || !SESSION_FROM.has(method)) throw new Error("a session opens only after Touch ID, the Capsule, a device key or a passkey");
    const now = this.now();
    this.db.prepare("DELETE FROM presence_sessions WHERE expires <= ? OR last_used <= ?").run(now, now - SESSION_IDLE);
    const id = b64url(12), secret = b64url(32);
    this.db.prepare("INSERT INTO presence_sessions (id, hash, key_id, method, peer, created, last_used, expires) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, sha(secret).toString("hex"), keyId, method, peerId(peer), now, now, now + SESSION_MAX);
    return { session: id, secret, expires: now + SESSION_MAX, idle: SESSION_IDLE };
  }

  /** @param {string} id */
  closeSession(id) {
    return Number(this.db.prepare("DELETE FROM presence_sessions WHERE id = ?").run(String(id)).changes) > 0;
  }

  /**
   * A one-time code for presence.enroll: 8 characters, stored hashed, valid 10 minutes. vyre-core's
   * installer code is shorter lived and shorter to type (length 6, ttl 2 minutes).
   * @param {{ ttl?: number, length?: number }} [o]
   */
  mintCode({ ttl = CODE_TTL, length = 8 } = {}) {
    if (this.coreLink) throw coreOwned("one-time enrollment codes are made");
    const now = this.now();
    if (!(length >= 6 && length <= 16) || !(ttl > 0 && ttl <= CODE_TTL)) throw new Error("a code is 6 to 16 characters and lasts at most 10 minutes");
    const code = randomCode(length);
    const expires = now + ttl;
    this.db.prepare("DELETE FROM presence_codes WHERE expires < ?").run(now - 24 * 3600_000);
    this.db.prepare("INSERT INTO presence_codes (hash, expires, used) VALUES (?,?,NULL)").run(sha(code).toString("hex"), expires);
    return { code, expires };
  }

  /**
   * Spend a one-time code: true once for a right, unused, unexpired code, false otherwise.
   * Synchronous, so a caller can spend it and enroll in one transaction (vyre-core does).
   * @param {unknown} code
   */
  useCode(code) {
    const r = this.db.prepare("UPDATE presence_codes SET used = ? WHERE hash = ? AND used IS NULL AND expires > ?")
      .run(this.now(), sha(normal(code)).toString("hex"), this.now());
    return Number(r.changes) === 1;
  }

  /** The one-time grant for the first owner passkey: 32 random bytes, stored hashed, five minutes, bound to `peer` when known and to the address `host` it was claimed at. @param {any} [peer] @param {string} [host] */
  mintGrant(peer = null, host = "") {
    const now = this.now();
    const grant = b64url(32);
    this.db.prepare("DELETE FROM presence_grants WHERE expires < ?").run(now - 24 * 3600_000);
    this.db.prepare("INSERT INTO presence_grants (hash, expires, used, peer, host) VALUES (?,?,NULL,?,?)").run(sha(grant).toString("hex"), now + GRANT_TTL, peerId(peer), String(host || "").toLowerCase() || null);
    return { grant, expires: now + GRANT_TTL };
  }

  /** Enrolled keys, never their public keys: a list is for recognising and removing them. */
  keys() {
    return this.db.prepare("SELECT id, kind, name, rp_id, created, last_used FROM presence_keys ORDER BY created").all();
  }

  /**
   * The Capsule build `vyre capsule install` most recently pinned, or null.
   * @returns {{ cdhash: string, pinnedAt: number } | null}
   */
  capsulePin() {
    const row = /** @type {any} */ (this.db.prepare("SELECT cdhash, pinned_at FROM presence_capsule_pin WHERE id = 1").get());
    return row ? { cdhash: row.cdhash, pinnedAt: Number(row.pinned_at) } : null;
  }

  /**
   * Pins a Capsule build. Only capsule.pin (presence-required, same floor as presence.enroll)
   * calls this -- never a bare file, which the same uid a model's shell runs as could write to
   * directly (the reviewer's HIGH, 28 Sep).
   * @param {string} cdhash
   */
  pinCapsule(cdhash) {
    if (!/^[0-9a-f]{40,}$/.test(cdhash)) throw Object.assign(new Error("not a cdhash"), { code: "bad_input" });
    this.db.prepare("INSERT INTO presence_capsule_pin (id, cdhash, pinned_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET cdhash = excluded.cdhash, pinned_at = excluded.pinned_at")
      .run(cdhash, this.now());
    return { pinned: true };
  }

  /**
   * Enroll a Capsule key (P-256 in the Secure Enclave), a device key (P-256 with alg -7, or RSA-2048+ with alg -257) or a passkey. Public keys
   * only: base64url SPKI DER, or a JWK, or a Windows BCRYPT RSA blob (keys.js), stored as SPKI.
   * @param {{ kind: string, name?: string, public_key: string, alg?: number, rp_id?: string, credential_id?: string }} k
   */
  enroll({ kind, name, public_key, alg, rp_id, credential_id, device = null, origin = null }) {
    if (this.coreLink) throw coreOwned("presence keys are enrolled");
    if (kind !== "capsule" && kind !== "passkey" && kind !== "device") throw new Error("kind must be capsule, passkey or device");
    let key;
    try { public_key = normalizePublicKey(public_key); key = spki(public_key); } catch (e) {
      const m = /** @type {Error} */ (e).message;
      throw new Error(/private key material|JWK|BCRYPT|blob|JSON/.test(m) ? m : "public_key must be a base64url SPKI DER public key");
    }
    let id;
    if (kind === "capsule") {
      // The Capsule's Secure Enclave key: ES256 on P-256, nothing else (ADR 0040).
      if (!isP256(key)) throw new Error("a Capsule key must be an EC P-256 key from the Secure Enclave");
      if (alg !== undefined && alg !== -7) throw new Error("a Capsule key's alg must be -7 (ES256)");
      alg = -7; rp_id = undefined;
      id = fingerprint(public_key);
    } else if (kind === "device") {
      // What a device's hardware can hold: ES256 on P-256 (ADR 0018), or RS256 on RSA of 2048 bits
      // or more (Windows Hello). The alg is bound to the key's type here and again at every verify.
      if (alg === -257) {
        if (key.asymmetricKeyType !== "rsa") throw new Error("alg -257 (RS256) needs an RSA key");
        try { checkRsa(key); } catch (e) { throw new Error(/** @type {Error} */ (e).message); }
      } else {
        if (key.asymmetricKeyType !== "ec" || /** @type {any} */ (key.asymmetricKeyDetails || {}).namedCurve !== "prime256v1") throw new Error("a device key must be an EC P-256 key, or RSA with alg -257");
        if (alg !== -7) throw new Error("a device key's alg must be -7 (ES256) or -257 (RS256)");
      }
      rp_id = undefined;
      id = fingerprint(public_key);
    } else {
      if (!/^[A-Za-z0-9_-]{8,1024}$/.test(String(credential_id || ""))) throw new Error("a passkey needs its credential_id in base64url");
      if (!rp_id || !/^[a-z0-9.-]+$/i.test(rp_id)) throw new Error("a passkey needs the rp_id it was made for");
      const want = ALGS[String(alg)];
      if (!want) throw new Error("alg must be -7 (ES256), -8 (EdDSA) or -257 (RS256)");
      if (key.asymmetricKeyType !== want) throw new Error(`alg ${alg} needs a ${want} key, not ${key.asymmetricKeyType}`);
      if (want === "rsa") checkRsa(key);
      id = String(credential_id);
    }
    if (this.db.prepare("SELECT 1 FROM presence_keys WHERE id = ?").get(id)) throw new Error("that key is already enrolled");
    const created = this.now();
    this.db.prepare("INSERT INTO presence_keys (id, kind, name, public_key, alg, rp_id, sign_count, created, last_used) VALUES (?,?,?,?,?,?,0,?,NULL)")
      .run(id, kind, clean(name || kind).slice(0, 80) || kind, public_key, alg ?? null, rp_id ?? null, created);
    // A passkey made in a browser paired over the relay: it proves only for that device.
    if (kind === "passkey" && device) this.db.prepare("INSERT INTO presence_key_devices (key, device, origin) VALUES (?,?,?)").run(id, String(device), String(origin));
    return { id, kind, name: clean(name || kind).slice(0, 80) || kind, created };
  }

  /** Remove an enrolled key. Returns whether one was removed. */
  remove(id) {
    if (this.coreLink) throw coreOwned("presence keys are removed");
    this.db.prepare("DELETE FROM presence_key_devices WHERE key = ?").run(String(id));
    const removed = Number(this.db.prepare("DELETE FROM presence_keys WHERE id = ?").run(String(id)).changes) === 1;
    if (removed) {
      // The sessions this key opened end with it. Each is remembered for 30 days (its id and the
      // hash of its secret) so the device that held it can be told once, plainly, that it was
      // removed (person.js check); the key's own id is kept too.
      const now = this.now();
      this.db.prepare("DELETE FROM presence_removed WHERE removed <= ?").run(now - 30 * 86_400_000);
      for (const r of /** @type {any[]} */ (this.db.prepare("SELECT id, hash FROM presence_people WHERE key_id = ?").all(String(id)))) {
        this.db.prepare("INSERT OR REPLACE INTO presence_removed (id, kind, hash, key_id, removed) VALUES (?, 'session', ?, ?, ?)").run(r.id, r.hash, String(id), now);
      }
      this.db.prepare("DELETE FROM presence_people WHERE key_id = ?").run(String(id));
      // PS-4: a grant for a device that the removed key confirmed is not left to be used for up to ten minutes.
      try { this.db.prepare("DELETE FROM presence_pair_grants WHERE key_id = ?").run(String(id)); } catch { /* an older home without the table */ }
      this.db.prepare("INSERT OR REPLACE INTO presence_removed (id, kind, hash, key_id, removed) VALUES (?, 'key', NULL, ?, ?)").run(String(id), String(id), now);
    }
    return removed;
  }

  /** Never a code, key, signature or input: tool, method and caller only. */
  emit(type, payload) {
    if (!this.events) return;
    try { this.events.emit("presence", type, payload); } catch (e) { this.log(`presence: could not record ${type}: ${/** @type {Error} */ (e).message}`); }
  }
}

/** The Presence vyred builds, with every OS touch point real. */
export const defaultPresence = ({ db, events, log }) => new Presence({ db, events, log });
