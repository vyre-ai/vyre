// @ts-check
// The in-page tool host, stage 1: the identity half of first run, for a page with no daemon (web.vyre.run, the Windows window, a Mac window with no vyred). It answers the SAME tool names and shapes as
// core/onboard (onboard.person.*, onboard.first.*) and core/identity (identity.status, unlock, lock), so the screens call one door whether a daemon or this answers. Nothing here is a second design: the
// identity chain and the directory claim are apps/app/src/identity/claim.js (kernel/identity/chain.js itself), the master record is master-web.js (byte-identical to kernel/identity/master.js), and the
// shapes come from lib/first-run-shape.js. What is kept at rest is JSON bytes only: the chain (public) and the master record (every key wrapped by the password or the recovery key). The unlocked
// key lives in this object's memory until lock. Stage 2 (create a space) answers onboard.space.*: the install line is made here with the identity key (relay/client/pair-install.js, the one mint the
// app already uses, whose bytes lib/pair-code.js verifies), the server is found and paired through src/real/add-server.js over the relay, and what is kept is the space row and the paired server's
// name, never a key. Steps not in a stage answer `host_unsupported`.
import { claimIdentity } from "../identity/claim.js";
import { codeKey, newCode } from "../identity/recovery.js";
import { fromSeed } from "../identity/keys.js";
import { AIS } from "../../../../lib/ai-ids.js";
import { scrub } from "../../../../lib/scrub.js";
import { lookOf } from "../../ui/chat/agent-look.js";
import { SPACE_NAME_SAY, commandOk, passwordOk, personRoutes, placeKind, spaceAddressOf, spaceKey, usernameOf } from "../../../../lib/first-run-shape.js";
import { resolveInviteLink } from "../../../../lib/invite-link.js";
import { createAddServer } from "../real/add-server.js";
import { trail } from "./trail.js";
import { createMasterRecord, openMasterRecord } from "./master-web.js";
import { makeDeviceKey } from "./device-key.js";
import * as C from "../../../../kernel/identity/chain.js";
import { BROWSER_TOO_OLD, ed25519Works, ed25519Mode } from "../identity/webcrypto-web.js";
import { githubSay } from "../identity/github-core.js";
import { actMessage } from "../../../../names/worker/id-messages.js";
import { acceptKdf, bundleHash, deriveLogin, loginMessage, registerMessage } from "./login-web.js";

/**
 * Is this key a DEVICE key on the person's checked chain? A sign-in that opens a record whose identity key the chain does not list as a device is refused: the server (or a swapped record) cannot hand a device
 * a key the person never published. @param {Uint8Array} seed @param {{ eid: string, kind: string }[]} entries
 */
export async function seedIsDeviceOnChain(seed, entries) {
  const key = await fromSeed(seed);
  return Array.isArray(entries) && entries.some((e) => e && e.eid === key.eid && e.kind === "device");
}

const bad = (/** @type {string} */ message, code = "bad_input") => Object.assign(new Error(message), { code });
const b64u = (/** @type {Uint8Array} */ b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (/** @type {string} */ s) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)); };

/**
 * @typedef {{ id: string, name: string, role: string, server: string | null, paired?: { box: string, route: string, relay: string, name: string } | null }} KeptSpace
 * @typedef {{ master: any, username: string, id: string, ops: unknown[], pin: unknown, device?: { pub: string, wrapped: { iv: string, ct: string } }, signin?: { space: string }, spaces?: KeptSpace[], listed?: Record<string, string>, current?: string | null, progress?: { screen: string, stack: string[] } | null, done?: boolean }} Kept
 * @typedef {{ load(): Promise<Kept | null>, save(k: Kept): Promise<void> }} KeptStore
 * The GitHub leg of sign-in, bound in the app (host/index.ts): `start` runs the GitHub sign-in (src/real/github.ts signInWithGithub: who GitHub says this is, and the session the relay holds), `assert` asks the relay for a short assertion
 * for one audience (a space's name, or "names" for the directory). @typedef {{ start(): Promise<{ ok: boolean, code?: string, session?: any, user?: { id: number, login: string } }>, assert(session: any, audience: string): Promise<string> }} GithubPorts
 * The outside things the space steps need (host/space-ports.ts binds them in the app; a test binds fakes or a real server over a real relay): the relay client's setup module, the relay's url, the setup channel,
 * the pairing the app already does with a server's ticket (it returns the pairing it made), the claim of the space's name (the paired server names its own space and the directory gets the record, signed by this identity), a call to the paired server, reading and accepting a join link through the team's own server, and forgetting a pairing.
 * @typedef {{ client: any, mintPairCode: typeof import("@vyre/relay-client/pair-install.js").mintPairCode, createSetupKey: typeof import("@vyre/relay-client/setup.js").createSetupKey, setupFingerprint: typeof import("@vyre/relay-client/setup.js").setupFingerprint, relay: string, connect: (o: any) => Promise<any>, pair: (qr: string, ctx: { pageKey?: unknown }, who: { id: string, name: string, pin: any, key: any }) => Promise<{ box: string, route: string, relay: string, name: string } | null>, claim: (who: { id: string, name: string, eid: string, ops: unknown[], key: any }, o: { name: string, route: { relay: string, route: string, box: string } }) => Promise<string>, listing?: (space: string) => Promise<{ listed: boolean, why: string } | undefined>, call: (name: string, input: any, box: string) => Promise<any>, join?: (link: string, who: { id: string, name: string, pin: any, key: any }) => Promise<{ card: any, accept: () => Promise<any>, close: () => void }>, ask?: (address: string, note: string, who: { id: string, name: string, pin: any, key: any }) => Promise<any>, askStatus?: (address: string, who: { id: string, name: string, pin: any, key: any }) => Promise<any>, forget: (box: string) => Promise<void> }} SpacePorts
 */

/** One stage-trail line per change (no code, no key, no name): what the first-run proof prints when the screen does not get where it should. */
let lastTrace = "";
/** What a server answers when an act needs the person's own approval. */
const PRESENCE_CODES = ["presence_required"];
const trace = (/** @type {string} */ line) => { if (line === lastTrace) return; lastTrace = line; trail(`step ${line}`); };

/** What the sign-in screen may be told about a provider login the server started: only these fields, only plain values (a flow id, the login address and code, a state, the account's id and label, a message or an error). Nothing else the server says passes. @param {any} r */
function pickSignin(r) {
  const src = r && typeof r === "object" ? r : {};
  const plain = (/** @type {any} */ v) => (typeof v === "string" ? v.slice(0, 500) : typeof v === "number" || typeof v === "boolean" ? v : undefined);
  /** @type {Record<string, any>} */ const out = {};
  for (const key of ["flow", "step", "state", "status", "url", "code", "paste", "account", "id", "label", "provider", "message"]) { const v = plain(src[key]); if (v !== undefined) out[key] = v; }
  if (src.error && typeof src.error === "object") out.error = { ...(plain(src.error.code) !== undefined ? { code: plain(src.error.code) } : {}), ...(plain(src.error.message) !== undefined ? { message: plain(src.error.message) } : {}) };
  else if (plain(src.error) !== undefined) out.error = plain(src.error);
  return out;
}

/**
 * `agreePoint` answers this device's key-agreement point (base64url, the raw uncompressed P-256 point), or null where this page has none: it goes in the genesis device entry, and is added to an entry that lacks it (ensureAgree).
 * @param {{ store: KeptStore, directory: string, agreePoint?: () => Promise<string | null>, fetch?: typeof fetch, kdf?: { memoryKiB: number, passes: number }, random?: (n: number) => Uint8Array, now?: () => number, signin?: { base?: (space: string) => string, label?: string, deviceId?: () => Promise<string> | string }, github?: GithubPorts,
 *   space?: { load: () => Promise<SpacePorts> }, done?: () => Promise<void>, sleep?: (ms: number) => Promise<void>, pollMs?: number, version?: string | null, softwareKeyHere?: boolean, memberKeyPath?: boolean, memberKeys?: { get: (acct: string) => Promise<string | null>, put: (acct: string, key: string) => Promise<void>, remove: (acct: string) => Promise<void> } }} o
 */
export function createHost(o) {
  const f = o.fetch || globalThis.fetch.bind(globalThis);
  const base = o.directory.replace(/\/+$/, "");
  /** The unlocked identity key, in memory only. @type {Uint8Array | null} */
  let held = null;

  async function reserve(/** @type {string} */ name) {
    let res;
    try { res = await f(`${base}/v1/ids/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); }
    catch { throw bad("Cannot reach the names directory right now.", "unreachable"); }
    /** @type {any} */ let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (res.status === 200 && body && body.data && typeof body.data.code === "string") return String(body.data.code);
    const code = body && body.error && body.error.code;
    throw bad(code === "name_taken" || code === "taken" ? "That name is taken." : code === "rate_limited" ? "Too many names were claimed from here today. Try again tomorrow." : "That name cannot be claimed right now. Try another.", code || "reserve");
  }

  /** One run per install line this page made: the add-server run, what the person called the space, the pairing it made and whether it is kept. @type {Map<string, { run: ReturnType<typeof createAddServer>, name: string, kind: string, paired: any, saved: boolean, failed: any, space: string, vault: boolean, pending?: Promise<any> | null, vaultPending?: boolean, unreachable?: string }>} */
  const waits = new Map();
  /** The paired server of the space this onboarding made last: where an AI sign-in goes. */
  let madeHere = "";
  /**
   * A joining member's own key: it goes to THEIR OWN Vault (never the space owner's), then the account names it. Their vault is made, or opened, with their password only when it must be (none yet, or locked):
   * the password is used for those two calls and nowhere else, kept by no one here, and never in anything this throws. The key is sent once over the same peer wire as every other vault.me call.
   * @param {any} ports @param {string} box @param {string} space the team's Space id: the app routes a joined team's calls through its door by it @param {{ kind: string, key: string, label: string, password: string, base_url?: string }} i
   */
  /** The key kind each provider's account is added as. */
  const COPY_KINDS = /** @type {Record<string, string>} */ ({ claude: "anthropic-compatible", openrouter: "openrouter", "openai-compatible": "openai-compatible" });
  /** The person's OTHER paired server (the current Space's, else the first that is not the one made here), for reads when another Space is added: its box and the Space's name. */
  const otherServer = async () => {
    const k = await o.store.load();
    if (!k) throw bad("Make your username first.", "no_identity");
    const paired = /** @type {any[]} */ ((k.spaces || []).filter((s) => s && s.paired && s.paired.box && s.paired.box !== madeHere));
    const there = paired.find((s) => s.id === k.current) || paired[0];
    return there ? { box: String(there.paired.box), name: String(there.name || "your other Space").slice(0, 60), role: String(there.role || ""), person: String(k.id || "") } : null;
  };
  /** Whether an account of the other server is the caller's own to copy: the home's own account (no person) when the caller owns that server, or an account whose person is the caller. A team's shared account, or a member's, is not. @param {any} a @param {{ role: string, person: string }} other */
  const isOwnAccount = (a, other) => (a.person ? String(a.person) === other.person : other.role === "owner");
  /** Why an account is not copied, or "": a custom address is added by hand (the key is for that provider, not the kind's default), a sign-in account signs in again, someone else's is not the caller's. @param {any} a @param {{ role: string, person: string }} other */
  const noCopy = (a, other) => {
    if (!isOwnAccount(a, other)) return "Not yours to copy.";
    if (a.kind !== "api-key" || typeof a.vault_item !== "string" || COPY_KINDS[String(a.provider)] === undefined) return "Sign in again on the new Space.";
    if (typeof a.base_url === "string" && a.base_url && a.base_url !== "https://api.x.ai/v1") return "Add this one by hand.";
    return "";
  };
  /** @param {any} ports @param {any} box @param {any} space @param {any} i */
  const memberKey = async (ports, box, space, i) => {
    // every kind the owner can add; the provider an account of it is made for (an OpenAI-style key, xAI's included, is an openai-compatible account at its address)
    const provider = { "anthropic-compatible": "claude", openrouter: "openrouter", "openai-compatible": "openai-compatible" }[/** @type {"anthropic-compatible" | "openrouter" | "openai-compatible"} */ (i.kind)];
    if (!provider) throw bad("That kind of key is not supported here.", "bad_kind");
    // A member's key goes through the team server's member door, which carries these calls only once sec53 has signed them and they are green; until then a member is told to ask the owner.
    if (!o.memberKeyPath) throw bad("Ask the owner to add this account.", "ask_owner");
    if (!o.memberKeys) throw unsupported();
    /** @type {(tool: string, input?: any) => Promise<any>} */
    const ask = (tool, input) => ports.call(tool, { ...(input || {}), ...(space ? { space } : {}) }, box);
    const redact = (/** @type {unknown} */ e) => {
      let said = String((e && /** @type {any} */ (e).message) || "That did not work. Try again.");
      said = scrub(said, [i.key, i.password], { marker: "[hidden]", min: 1 });
      return bad(said.slice(0, 200), e && /** @type {any} */ (e).code ? String(/** @type {any} */ (e).code) : "failed");
    };
    try {
      // the key is checked with its provider first (the server's own check, nothing kept), so a bad key is caught before a password is asked for or anything is put anywhere
      await ask("sessions.accounts.key", { kind: i.kind, key: i.key, check_only: true, ...(i.base_url ? { base_url: i.base_url } : {}) });
      // their vault: whether it exists and is open decides whether a password is asked for (no prompt when it is open)
      const st = await ask("vault.me.account.status");
      const open = Boolean(st && st.account && st.unlocked);
      const deviceKey = st && st.account && !st.unlocked && st.acct ? await o.memberKeys.get(String(st.acct)) : null;
      if (!open && !i.password) throw bad("Your password, to open your own Vault.", "need_password");
      if (st && st.account && !st.unlocked && !deviceKey) throw bad("This device does not hold your Vault's Secret Key. Open Vyre on a device that does and approve this one.", "no_device_key");
      // ONE act, covered by ONE presence proof over the label and the key's hash: the vault is made or opened, the item gets a free name in THEIR vault, the key is put there. The Secret Key of a vault just made comes back once.
      const added = await ask("vault.me.add-key", { label: i.label, value: i.key, ...(!open && i.password ? { password: i.password } : {}), ...(deviceKey ? { secret_key: deviceKey } : {}) });
      // a vault just made hands over its Secret Key even when a later step failed: keep it first, so the next try can open the vault
      if (added && typeof added.secret_key === "string" && added.acct) await o.memberKeys.put(String(added.acct), added.secret_key);
      const item = String(added && added.item || "");
      if (!item) throw bad(added && added.failed ? String(added.failed) : "Your key could not be put in your Vault.", "failed");
      const add = await ask("sessions.accounts.add", { provider, label: i.label, kind: "api-key", vault_item: item, ...(i.base_url ? { base_url: i.base_url } : {}) });
      return { account: String((add && (add.id || add.account)) || ""), provider, label: i.label, checked: true, item };
    } catch (e) {
      throw /** @type {any} */ (e).code === "need_password" ? e : redact(e);
    }
  };

  /** The server this onboarding just made (or joined) is where the Space's own steps go: not the first one an identity with several servers happens to list. Without one made here, the current space's server, then the only one. @param {string} none what to say when there is none yet @param {boolean} [strict] a tool that WRITES (the Assistant, its model) never falls back to the current space's server, which may be a team's: it takes the one made in this run, else the only paired server, else refuses */
  const serverOfThisRun = async (none, strict = false) => {
    const k = await o.store.load();
    if (!k) throw bad("Make your username first.", "no_identity");
    const paired = /** @type {any[]} */ ((k.spaces || []).filter((s) => s && s.paired && s.paired.box));
    const here = paired.find((s) => s.paired.box === madeHere) || (strict ? null : paired.find((s) => s.id === k.current)) || (paired.length === 1 ? paired[0] : null);
    if (!here) throw bad(`Your server is not set up yet. ${none}`, "no_server");
    return { box: String(here.paired.box), k, role: String(here.role || ""), space: String(here.id || "") };
  };
  /**
   * The link the join reads: lib/invite-link.js, the one resolver the daemon's join uses too. A `https://vyre.run/i/<token>` link names no server; the names directory says which space has the token's chain id.
   * @param {string} text
   */
  const joinLinkOf = (text) => resolveInviteLink(text, {
    lookupSpace: async (chain) => {
      const res = await f(`${base}/v1/ids/resolve?id=${encodeURIComponent(chain)}`, { headers: { accept: "application/json" } });
      /** @type {any} */ let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      return body && body.data;
    },
  });

  /** The join cards read and not yet accepted, by link: the open stream is kept for the accept that follows. @type {Map<string, { card: any, accept: () => Promise<any>, close: () => void }>} */
  const invites = new Map();
  const stopRuns = () => { for (const w of waits.values()) w.run.stop(); };

  const unsupported = () => Object.assign(new Error("This step is not ready in the app yet."), { code: "host_unsupported" });
  /** Stage 2 needs the ports, and the unlocked identity: the line is signed by the identity key and the person's own yes is pressing Create. */
  async function spaceCtx() {
    if (!o.space) throw unsupported();
    const k = await o.store.load();
    if (!k) throw bad("Make your username first.", "no_identity");
    if (!held) throw bad("Unlock with your password first.", "locked");
    return { k, ports: await o.space.load(), key: await fromSeed(held) };
  }
  /** @param {KeptSpace[]} rows */
  const outRows = (rows) => rows.map((s) => ({ id: s.id, name: s.name, role: s.role, server: s.server }));
  /** Keep the new space and the server it paired with, and make it the current one. */
  async function keepSpace(/** @type {Kept} */ k, /** @type {KeptSpace} */ row) {
    const rows = (k.spaces || []).filter((s) => s.id !== row.id && s.name !== row.name);
    await o.store.save({ ...k, spaces: [...rows, row], current: row.id });
  }


  /**
   * The row for a space this device signed in to: the id, name, role and address the SPACE says it is (its own reply), so a signed-in space and a created one are the same row. A space that does not say which
   * space it is gets no row. @param {any} done the door's finish or github answer @param {{ space: string, address: string }} addr
   */
  function rowFromReply(done, addr) {
    const list = Array.isArray(done && done.spaces) ? done.spaces : [];
    const mine = list.find((/** @type {any} */ x) => x && x.name === addr.space) || list[0];
    if (!mine || !/^spc_[a-z2-7]{8,}$/.test(String(mine.id))) throw Object.assign(new Error("That space did not say which space it is. Check the address and try again."), { code: "bad_space" });
    return { id: String(mine.id), name: String(mine.name || addr.space), role: String(mine.role || done.role || "member"), server: String(mine.server || addr.address) };
  }

  /** This browser's stable device id (so a known browser does not ring the person's other devices on every sign-in) and its label. */
  async function deviceInfo() {
    const id = o.signin && o.signin.deviceId ? await o.signin.deviceId() : "";
    return { ...(/^[A-Za-z0-9_-]{8,64}$/.test(String(id)) ? { id: String(id) } : {}), label: (o.signin && o.signin.label) || "This browser" };
  }

  /** POST one step of the space's sign-in door: https://<space>.vyre.run/login, text/plain so the browser sends no preflight. The answer is the door's own JSON (kernel/identity/space-login.js shapes). */
  async function door(/** @type {string} */ space, /** @type {any} */ body) {
    const base = (o.signin && o.signin.base ? o.signin.base(space) : `https://${space}.vyre.run`).replace(/\/+$/, "");
    let res;
    try { res = await f(`${base}/login`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) }); }
    catch { throw bad("Cannot reach that space right now. Check the address and try again.", "unreachable"); }
    /** @type {any} */ let out = null;
    try { out = await res.json(); } catch { /* not JSON */ }
    if (!out || typeof out !== "object") throw bad("That address did not answer like a Vyre space. Check it and try again.", "unreachable");
    if (out.error) throw Object.assign(new Error(String(out.error.message || "That did not work.")), { code: String(out.error.code || "failed"), ...(out.error.retry ? { retry: out.error.retry } : {}) });
    return out;
  }

  /** The whole chain of a person from the names directory, checked, and the pin a later claim carries. @param {string} id */
  async function chainOf(id) {
    let res;
    try { res = await f(`${base}/v1/ids/resolve?id=${encodeURIComponent(id)}`); } catch { throw bad("Cannot reach the names directory right now.", "unreachable"); }
    /** @type {any} */ let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    const d = body && body.data;
    if (!res.ok || !d || !Array.isArray(d.ops)) throw bad("That identity is not in the directory.", "bad_login");
    const state = await C.verifyChain(d.ops, { now: o.now ? o.now() : Date.now() });
    if (state.id !== id) throw bad("That identity's chain does not match.", "bad_login");
    return { ops: d.ops, pin: C.pinOf(state), entries: /** @type {any[]} */ (state.entries || []) };
  }

  /** What the last agree repair came to, for Account to say plainly: "" (nothing to do or done), or why it could not finish. @type {{ failed: string }} */
  const agreeNote = { failed: "" };

  /**
   * Repair an identity whose device entry has no key-agreement point (v0.6.1 made them so): the device signs the chain's own `agree` op for ITS OWN entry (kernel/identity/chain.js: once, only for itself) and the
   * directory appends it. Never a silent failure: what stopped it is kept in agreeNote (and one trail line), and Account shows it with a retry. @param {Uint8Array} seed
   */
  async function ensureAgree(seed) {
    agreeNote.failed = "";
    try {
      if (!o.agreePoint) return;
      const point = await o.agreePoint();
      if (!point) { agreeNote.failed = "this page has no key for private chats"; trail("agree repair: no key on this page"); return; }
      const k = await o.store.load();
      if (!k) return;
      const key = await fromSeed(seed);
      const chain = await chainOf(String(k.id));
      const state = await C.verifyChain(chain.ops, { now: o.now ? o.now() : Date.now() });
      const entry = /** @type {any} */ ((state.entries || []).find((/** @type {any} */ e) => e.eid === key.eid && e.kind === "device"));
      if (!entry) { agreeNote.failed = "this Mac's key is not on your list"; trail("agree repair: this device is not on the chain"); return; }
      if (entry.agree !== undefined) return;
      const op = await C.makeOp(state, { type: "agree", target: entry.eid, agree: point }, { by: entry.eid, ts: Math.max(o.now ? o.now() : Date.now(), state.ts), sign: (/** @type {Uint8Array} */ m) => key.sign(m) });
      const next = await C.applyOp(state, op, { now: (o.now ? o.now() : Date.now()) + C.SKEW_MS });
      const res = await f(`${base}/v1/ids/append`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ name: k.username, ops: [op] }) });
      if (!res.ok) { agreeNote.failed = `the directory said no (${res.status})`; trail(`agree repair refused ${res.status}`); return; }
      await o.store.save({ ...k, ops: [...chain.ops, op], pin: C.pinOf(next) });
      trail("agree repair done");
    } catch (e) {
      const code = String(/** @type {any} */ (e) && /** @type {any} */ (e).code || "error");
      agreeNote.failed = code === "unreachable" ? "the names directory could not be reached" : `it did not go through (${code})`;
      trail(`agree repair failed ${code}`);
    }
  }

  /**
   * A Space this person owns on a paired server is listed with the directory as served by that server's route (POST /v1/ids/server, the owner's signed act). The first run does it right after the claim (identity/claim-space.js);
   * a Space named before that step existed (v0.6.1) has an empty list, and the directory then refuses the server's certificate and address ("that name is not served by this server"). Once per Space and route, kept in `listed`;
   * quiet, and a refusal or an unreachable directory leaves it for the next unlock. @param {Uint8Array} seed
   */
  async function ensureServers(seed) {
    try {
      const k = await o.store.load();
      if (!k) return;
      const rows = (k.spaces || []).filter((r) => r && r.role === "owner" && r.paired && (r.paired.route || r.paired.box) && r.name);
      if (!rows.length) return;
      const key = await fromSeed(seed);
      const listed = { ...(k.listed || {}) };
      let changed = false;
      for (const r of rows) {
        const label = String(r.name).toLowerCase().replace(/\.vyre\.run$/, "");
        let route = String(/** @type {any} */ (r.paired).route || "");
        // No route kept beside the row: ask the paired server itself, over the pairing's own channel (the box is the one the pairing pinned, never a typed value). Only a well-formed route is taken.
        if (!route && /** @type {any} */ (r.paired).box && o.space) {
          try { const st = /** @type {any} */ (await (await o.space.load()).call("relay.status", {}, String(/** @type {any} */ (r.paired).box))); if (st && typeof st.route === "string" && /^[a-z2-7]{26}$/.test(st.route)) route = st.route; } catch { route = ""; }
        }
        if (!route) { trail(`server listing for ${label}: the server's route is not known`); continue; }
        if (listed[label] === route) continue;
        const ts = o.now ? o.now() : Date.now();
        const act = { by: String(k.id), via: key.eid, ts, sig: b64u(await key.sign(actMessage({ action: "server-add", name: label, domain: route, ts }))) };
        const res = await f(`${base}/v1/ids/server`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ name: label, route, act }) });
        if (!res.ok) { trail(`server listing for ${label} refused ${res.status}`); continue; }
        listed[label] = route; changed = true;
        trail(`server listed for ${label}`);
      }
      if (changed) { const fresh = await o.store.load(); if (fresh) await o.store.save({ ...fresh, listed: { ...(fresh.listed || {}), ...listed } }); }
    } catch (e) { trail(`server listing failed ${String(/** @type {any} */ (e) && /** @type {any} */ (e).code || "error")}`); }
  }

  /** The GitHub sign-in in progress: the relay session, the username the directory found, and the spaces it listed. Memory only, ten minutes. @type {{ session: any, username: string, spaces: { space: string, address: string }[], at: number } | null} */
  let pendingGithub = null;

  /** One answer to onboard.space.poll: where the install is, and once the server is paired, the steps that make the space usable. */
  const pollSpaceOnce = async (/** @type {any} */ { id }) => {
      const w = waits.get(String(id || ""));
      if (!w) throw bad("That install is not one this device started.");

      const st = w.run.state;
      const base = { id: String(id), kind: w.kind, expiresAt: new Date(st.expiresAt || 0).toISOString() };
      if (st.stage === "done") {
        const { k, ports, key } = await spaceCtx();
        const p = w.paired;
        const hostname = (p && p.name) || (st.box && st.box.name) || "";
        if (w.failed) return { ...base, online: false, expired: false, failed: true, ...w.failed, canRemove: Boolean(p && p.box), canRename: w.failed.code === "taken" || w.failed.code === "name_taken" };
        if (!w.saved) {
          // The server is paired. Now the space is usable: the paired server names its own space and the directory gets the record signed by this identity (so <space>.vyre.run signs in), the space vault is made on
          // that server, and the space is added to the person's list in the directory so GitHub sign-in finds it. Each step is done once; only the last (the directory being unreachable) is tried again on the next poll.
          trace(`poll: paired server ${p ? (p.box ? "has a box id" : "has NO box id") : "is missing"}`);
          if (!p || !p.box) { w.failed = { code: "pair", message: "Your server did not finish connecting. Start again." }; return { ...base, online: false, expired: false, failed: true, ...w.failed, canRemove: false }; }
          if (!w.space) {
            trace("poll: claiming the space name");
            try {
              w.space = await ports.claim({ id: k.id, name: k.username, eid: key.eid, ops: k.ops, key }, { name: w.name, route: { relay: p.relay, route: p.route, box: p.box } });
              // Was the server listed with the directory by the claim? Never a reason to stop: if not, the first run goes on, the page says so in one line, and ensureServers tries again now and on every unlock.
              const seenListing = ports.listing ? await ports.listing(w.space).catch(() => undefined) : undefined;
              if (seenListing && seenListing.listed) { const fresh = await o.store.load(); if (fresh) await o.store.save({ ...fresh, listed: { ...(fresh.listed || {}), [String(w.name).toLowerCase()]: String(p.route) } }); }
              else if (seenListing) { w.unreachable = `${String(w.name).toLowerCase()}.vyre.run`; trace(`poll: the directory was not told this server serves ${w.name} (${seenListing.why || "no reason given"}); it will be tried again`); }
            }
            catch (e) {
              const x = /** @type {any} */ (e);
              w.failed = { code: String((x && x.code) || "claim"), message: String((x && x.message) || "The space could not be made.").slice(0, 300) };
              return { ...base, online: false, expired: false, failed: true, ...w.failed, canRemove: true, canRename: w.failed.code === "taken" || w.failed.code === "name_taken" };
            }
          }
          if (!w.vault) {
            trace("poll: making the space vault");
            try { await ports.call("vault.space.create", { space: w.space }, p.box); }
            catch (e) {
              const x = /** @type {any} */ (e);
              // A server asks for the person's own approval before it makes a space vault, and a page with a software key has none to give yet: the space is still usable, the vault waits for an approval
              // the person can give (the answer says so), and nothing is lost by making it later.
              if (x && PRESENCE_CODES.includes(String(x.code))) { w.vaultPending = true; trace(`poll: the vault waits for an approval (${String(x.code)})`); }
              else if (!x || x.code !== "exists") {
                w.failed = { code: String((x && x.code) || "vault"), message: String((x && x.message) || `The space vault could not be made. The server said: ${String((x && x.code) || "nothing")}.`).slice(0, 300) };
                return { ...base, online: false, expired: false, failed: true, ...w.failed, canRemove: true };
              }
            }
            w.vault = true;
          }
          trace("poll: publishing the space to the directory");
          try { await api.publishSpace(w.name, "add"); }
          catch (e) {
            const x = /** @type {any} */ (e);
            return { ...base, online: false, expired: false, failed: true, code: String((x && x.code) || "directory"), message: String((x && x.message) || "The names directory did not take the space. Trying again.").slice(0, 300), canRemove: true, retrying: true };
          }
          await keepSpace(k, { id: w.space || spaceKey("", w.name), name: w.name, role: "owner", server: `https://${w.name}.vyre.run`, paired: p });
          // The listing did not land at the claim: try it again now, quietly, and on every unlock; the page already says it is not reachable yet.
          if (w.unreachable && held) void ensureServers(held);
          w.saved = true;
          madeHere = String(p.box);
        }
        const row = ((await o.store.load())?.spaces || []).find((s) => s.name === w.name);
        return { ...base, online: true, expired: false, ...(w.vaultPending ? { vaultPending: true } : {}), ...(o.softwareKeyHere ? { noFingerprintYet: true } : {}), ...(w.unreachable ? { notReachableYet: w.unreachable } : {}), space: row ? row.id : spaceKey("", w.name), server: { hostname, address: `https://${w.name}.vyre.run`, space: w.name, name: hostname, route: (p && p.route) || "", box: (p && p.box) || "" }, canRemove: true };
      }
      if (st.stage === "stopped") {
        const code = st.error ? st.error.code : "stopped";
        const message = st.error ? st.error.message : "The install stopped. Show a new command.";
        // Two servers answered one line: nothing was paired and nothing will be. The only way on is a new line.
        if (code === "contested") return { ...base, online: false, expired: false, contested: true, message };
        if (code === "expired") return { ...base, online: false, expired: true, message: "The install window ended. Go back and show a new command." };
        return { ...base, online: false, expired: false, failed: true, code, message };
      }
      if (st.stage === "found" || st.stage === "pairing") return { ...base, online: false, expired: false, connecting: true, ...(st.box ? { found: { name: st.box.name } } : {}) };
      return { ...base, online: false, expired: false };
  };

  /** @type {Record<string, (input: any) => Promise<any>>} */
  const tools = {
    "onboard.person.lookup": async ({ username }) => {
      const name = usernameOf(username);
      if (!name) return { ok: false, reason: "invalid" };
      return { ok: true, username: name, ...personRoutes(name) };
    },

    "onboard.person.status": async () => {
      const k = await o.store.load();
      return { exists: Boolean(k), username: k ? k.username : null, id: k ? k.id : null, current: null, spaces: [], ...(k ? personRoutes(k.username) : {}) };
    },

    "onboard.person.create": async ({ username, password, confirm }) => {
      const name = usernameOf(username);
      if (!name) throw bad("A username is lowercase letters, digits and hyphens, 3 to 20 characters, starting with a letter.");
      if (!passwordOk(password)) throw bad("Use a password of at least 12 characters, and not a common one.");
      if (confirm !== undefined && confirm !== password) throw bad("Type the password the same way twice.");
      const existing = await o.store.load();
      if (existing) return { username: existing.username, id: existing.id, ...personRoutes(existing.username), recoveryKey: null, once: false, already: true };
      // The identity chain verifies Ed25519 signatures with WebCrypto (or the fallback webcrypto.ts installs): a browser with neither is told so, not given the chain's own words.
      { const works = await ed25519Works(); trail(`ed25519 ${ed25519Mode()}`); if (!works) throw bad(BROWSER_TOO_OLD, "browser_too_old"); }
      const seed = (o.random || ((n) => crypto.getRandomValues(new Uint8Array(n))))(32);
      const key = await fromSeed(seed);
      const code = await reserve(name);
      // The device's key-agreement point goes in its first entry: without it no other device (or this one, for a chat) can wrap a chat key to it. A page with no such key says so and goes on; ensureAgree adds it later.
      const agree = o.agreePoint ? await o.agreePoint().catch(() => null) : null;
      trail(`agree ${agree ? "in the genesis entry" : "none on this page"}`);
      const made = await claimIdentity({ name, code, base, key, fetch: f, ...(agree ? { agree } : {}), ...(o.random ? { random: o.random } : {}), ...(o.now ? { now: o.now } : {}) });
      const master = await createMasterRecord({ username: name, id: made.id, password, recoveryCode: made.recoveryCode, privateKey: b64u(seed), agreePrivate: null, ...(o.kdf ? { kdf: o.kdf } : {}) });
      await o.store.save({ master, username: name, id: made.id, ops: made.ops, pin: made.pin, device: makeDeviceKey(seed, o.random) });
      held = seed;
      return { username: name, id: made.id, ...personRoutes(name), recoveryKey: made.recoveryCode, once: true, already: false };
    },

    "identity.status": async () => {
      const k = await o.store.load();
      if (!k) return { exists: false, unlocked: false, username: null, id: null, url: null, private: true, github: null, needsMigration: false };
      return { exists: true, unlocked: held !== null, username: k.username, id: k.id, url: personRoutes(k.username).route, private: true, github: null, needsMigration: false };
    },

    "identity.unlock": async ({ password, recovery }) => {
      if ((password == null || password === "") && (recovery == null || recovery === "")) throw bad("Enter your password on this device.", "person_enters");
      const k = await o.store.load();
      if (!k) throw bad("There is no password on this device yet. Create your username first.", "no_identity");
      const keys = await openMasterRecord(k.master, recovery ? { recovery } : { password });
      held = unb64(keys.privateKey);
      // A record made before the device key existed gets one now, wrapped under the identity just opened.
      if (!k.device) await o.store.save({ ...k, device: makeDeviceKey(held, o.random) });
      // An identity made without its key-agreement point (v0.6.1) is repaired now, in the background: nothing waits on it.
      void ensureAgree(held);
      // A Space named before the first run listed its server gets that listing now, once, in the background.
      void ensureServers(held);
      return { unlocked: true, username: k.username, id: k.id };
    },

    // The person's list as the directory holds it (what Settings, Account shows): the box of a page like this one holds no identity, so the page's own host answers. `self` is this device's entry, known once the key is unlocked.
    // What the unlock-time repair of private chats came to: `failed` is "" or the reason in words, so Account says so with a retry instead of staying silent.
    "identity.agree.status": async () => ({ failed: agreeNote.failed, unlocked: held !== null }),
    "identity.agree.retry": async () => {
      if (!held) throw bad("Unlock with your password first.", "locked");
      await ensureAgree(held);
      return { failed: agreeNote.failed };
    },

    "identity.entries": async () => {
      const k = await o.store.load();
      if (!k) return { entries: [] };
      const chain = await chainOf(String(k.id));
      const mine = held ? (await fromSeed(held)).eid : null;
      const now = o.now ? o.now() : Date.now();
      return { entries: chain.entries.map((/** @type {any} */ e) => ({ eid: e.eid, kind: e.kind, label: typeof e.label === "string" ? e.label : null, since: e.since, self: e.eid === mine, newcomer: C.youngAt(e, now), agree: typeof e.agree === "string" })) };
    },

    // A new recovery code, for a page whose box holds no identity: the password opens the master record (and is the person's yes here), the device signs the chain's own replace-code op, the directory appends it, and the
    // record is wrapped again under the new code so it opens this device later. The old code stops working. The new one comes back once.
    "identity.code.replace": async ({ password }) => {
      const k = await o.store.load();
      if (!k) throw bad("There is no identity on this page yet.", "no_identity");
      if (!held) throw bad("Unlock with your password first.", "locked");
      if (!password) throw bad("Enter your password to make a new recovery code.", "person_enters");
      const keys = await openMasterRecord(k.master, { password: String(password) });
      const key = await fromSeed(held);
      const code = newCode(o.random);
      const ck = await codeKey(code, "");
      const chain = await chainOf(String(k.id));
      const state = await C.verifyChain(chain.ops, { now: o.now ? o.now() : Date.now() });
      const op = await C.makeOp(state, { type: "replace-code", entry: { eid: ck.eid, kind: "code", pub: ck.publicKey } }, { by: key.eid, ts: Math.max(o.now ? o.now() : Date.now(), state.ts), sign: (/** @type {Uint8Array} */ m) => key.sign(m) });
      const next = await C.applyOp(state, op, { now: (o.now ? o.now() : Date.now()) + C.SKEW_MS });
      const res = await f(`${base}/v1/ids/append`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ name: k.username, ops: [op] }) });
      if (!res.ok) throw bad("The directory did not take the new code. Nothing changed. Try again.", "unreachable");
      const master = await createMasterRecord({ username: k.username, id: k.id, password: String(password), recoveryCode: code, privateKey: keys.privateKey, agreePrivate: keys.agreePrivate, ...(o.kdf ? { kdf: o.kdf } : {}) });
      await o.store.save({ ...k, master, ops: [...chain.ops, op], pin: C.pinOf(next) });
      return { recoveryCode: code, seq: next.seq };
    },

    // Take another device off the person's list (not this one): the device signs the chain's own remove op.
    "identity.entry.remove": async ({ eid }) => {
      const k = await o.store.load();
      if (!k) throw bad("There is no identity on this page yet.", "no_identity");
      if (!held) throw bad("Unlock with your password first.", "locked");
      const key = await fromSeed(held);
      if (String(eid) === key.eid) throw bad("This device cannot take itself off the list.", "bad_input");
      const chain = await chainOf(String(k.id));
      const state = await C.verifyChain(chain.ops, { now: o.now ? o.now() : Date.now() });
      if (!(state.entries || []).some((/** @type {any} */ e) => e.eid === String(eid))) throw bad("That is not on your list.", "not_found");
      const op = await C.makeOp(state, { type: "remove", target: String(eid) }, { by: key.eid, ts: Math.max(o.now ? o.now() : Date.now(), state.ts), sign: (/** @type {Uint8Array} */ m) => key.sign(m) });
      const next = await C.applyOp(state, op, { now: (o.now ? o.now() : Date.now()) + C.SKEW_MS });
      const res = await f(`${base}/v1/ids/append`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ name: k.username, ops: [op] }) });
      if (!res.ok) throw bad("The directory did not take that. Nothing changed. Try again.", "unreachable");
      await o.store.save({ ...k, ops: [...chain.ops, op], pin: C.pinOf(next) });
      return { eid: String(eid), seq: next.seq };
    },

    // A page has no vault to open with the identity (the daemon's vault takes the unlocked key here): the unlock screen asks, and this says there is nothing to install, so a good password opens the page.
    "identity.vault.install": async () => ({ installed: false, reason: "no_vault" }),

    "identity.lock": async () => { stopRuns(); for (const i of invites.values()) { try { i.close(); } catch { /* gone */ } } invites.clear(); if (held) held.fill(0); held = null; pendingGithub = null; return { locked: true }; },

    // Sign in from any device: the space's address, the username, the password. The space gives the username's salt, the device stretches the password itself, signs a single-use challenge, and
    // opens the returned record with the same key. Every refusal for a wrong name or password is the door's one bad_login answer.
    "onboard.signin": async ({ space, username, password }) => {
      const addr = spaceAddressOf(String(space || "").includes(".") ? space : `${String(space || "").trim()}.vyre.run`);
      const name = usernameOf(username);
      const BAD = "That username and password do not match.";
      if (!addr) throw bad("Use the address of a space, like juniper.vyre.run.");
      if (!name || !password) throw Object.assign(new Error(BAD), { code: "bad_login" });
      if (await o.store.load()) throw bad("This device already has an identity. Lock it and use its password, or forget it first.", "exists");
      { const works = await ed25519Works(); trail(`ed25519 ${ed25519Mode()}`); if (!works) throw bad(BROWSER_TOO_OLD, "browser_too_old"); }
      const begun = await door(addr.space, { op: "begin", username: name });
      const kdf = acceptKdf(begun.kdf);
      const d = await deriveLogin(String(password).normalize("NFKC"), String(begun.salt), kdf);
      /** @type {any} */ let done, keys;
      try {
        const sig = d.sign(loginMessage(addr.space, name, String(begun.challenge)));
        done = await door(addr.space, { op: "finish", username: name, challenge: begun.challenge, sig, device: await deviceInfo() });
        if (!done.bundle || done.bundle.username !== name) throw Object.assign(new Error(BAD), { code: "bad_login" });
        keys = await openMasterRecord(done.bundle, { kek: d.K }).catch(() => { throw Object.assign(new Error(BAD), { code: "bad_login" }); });
      } finally { d.close(); }
      const chain = await chainOf(String(done.bundle.id));
      const seed = unb64(keys.privateKey);
      if (!(await seedIsDeviceOnChain(seed, chain.entries))) throw Object.assign(new Error(BAD), { code: "bad_login" });
      const row = rowFromReply(done, addr);
      await o.store.save({ master: done.bundle, username: name, id: String(done.bundle.id), ops: chain.ops, pin: chain.pin, device: makeDeviceKey(seed, o.random), signin: { space: addr.space }, spaces: [row], current: row.id });
      held = seed;
      return { username: name, id: String(done.bundle.id), spaces: [row] };
    },

    // Sign in with GitHub: the relay vouches for the GitHub account with a short assertion; the names directory answers with the spaces that account's linked username belongs to (only to a valid assertion);
    // the password is asked ONCE, next, and opens the bundle each space returns. Nothing about the password reaches any server.
    "onboard.signin.github": async ({ space } = {}) => {
      if (!o.github) throw Object.assign(new Error("This step is not ready in the app yet."), { code: "host_unsupported" });
      if (await o.store.load()) throw bad("This device already has an identity. Lock it and use its password, or forget it first.", "exists");
      const started = await o.github.start();
      if (!started.ok || !started.session) throw Object.assign(new Error(githubSay(started.code)), { code: started.code || "denied" });
      /** @type {{ space: string, address: string }[]} */ let spaces = [];
      let username = "";
      // The directory's list of this GitHub account's spaces, when it has one (only a valid assertion gets it). Without one (the list is not there yet, or the account is not linked), the person's own space
      // address, typed on the sign-in screen, is the one space to log in to; the space's reply names the rest.
      try {
        const assertion = await o.github.assert(started.session, "names");
        const res = await f(`${base}/v1/ids/spaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assertion }) });
        /** @type {any} */ const body = await res.json().catch(() => null);
        const d = body && body.data;
        if (res.ok && d && Array.isArray(d.spaces)) {
          username = String(d.username || "");
          spaces = /** @type {any} */ (d.spaces.map((/** @type {any} */ x) => spaceAddressOf(String(x.address || `${x.name}.vyre.run`))).filter(Boolean));
        }
      } catch { /* no list: the typed address below */ }
      if (!spaces.length) {
        const typed = space ? spaceAddressOf(String(space).includes(".") ? space : `${String(space).trim()}.vyre.run`) : null;
        if (!typed) throw Object.assign(new Error("Type the address of a space you belong to, then continue with GitHub again."), { code: "needs_space" });
        spaces = [typed];
      }
      pendingGithub = { session: started.session, username, spaces, at: Date.now() };
      return { login: pendingGithub.username, spaces: spaces.map((x) => ({ id: x.space, name: x.space, role: "member", server: x.address })) };
    },

    // The password, once, after GitHub: log in to each space the directory listed (each asks for its own assertion), stretch the password with the first space's salt, and open its bundle.
    "onboard.signin.unlock": async ({ password }) => {
      const BAD = "That password does not unlock this identity. Try again.";
      const pend = pendingGithub;
      if (!pend || Date.now() - pend.at > 10 * 60_000 || !o.github) throw bad("Start with GitHub again.", "expired");
      if (!password) throw bad("Enter your password on this device.", "person_enters");
      /** @type {{ space: string, address: string, row: { id: string, name: string, role: string, server: string } }[]} */ const opened = [];
      /** @type {any} */ let first = null, keys = null;
      for (const sp of pend.spaces) {
        let done;
        try {
          const assertion = await o.github.assert(pend.session, sp.space);
          done = await door(sp.space, { op: "github", assertion, device: await deviceInfo() });
        } catch (e) { if (!first) throw e; continue; }
        if (!done.bundle) continue;
        if (!first) {
          const d = await deriveLogin(String(password).normalize("NFKC"), String(done.salt), acceptKdf(done.kdf));
          try { keys = await openMasterRecord(done.bundle, { kek: d.K }).catch(() => { throw Object.assign(new Error(BAD), { code: "bad_password" }); }); }
          finally { d.close(); }
          first = done;
        }
        opened.push({ space: sp.space, address: sp.address, row: rowFromReply(done, sp) });
      }
      if (!first || !keys) throw bad("None of your spaces answered. Try again.", "unreachable");
      const chain = await chainOf(String(first.bundle.id));
      const seed = unb64(keys.privateKey);
      if (!(await seedIsDeviceOnChain(seed, chain.entries))) throw Object.assign(new Error(BAD), { code: "bad_password" });
      const rows = opened.map((x) => x.row);
      await o.store.save({ master: first.bundle, username: String(first.bundle.username), id: String(first.bundle.id), ops: chain.ops, pin: chain.pin, device: makeDeviceKey(seed, o.random), signin: { space: opened[0].space }, spaces: rows, current: rows[0].id });
      held = seed;
      pendingGithub = null;
      return { username: String(first.bundle.username), id: String(first.bundle.id), spaces: rows };
    },

    "onboard.first.progress": async () => {
      const k = await o.store.load();
      return k && k.progress ? { ok: true, ...k.progress } : { ok: true, screen: null, stack: [] };
    },
    "onboard.first.progress.save": async ({ screen, stack }) => {
      const k = await o.store.load();
      if (!k) return { saved: false };
      await o.store.save({ ...k, progress: { screen: String(screen || ""), stack: Array.isArray(stack) ? stack.map(String) : [] } });
      return { saved: true };
    },
    "onboard.first.done": async () => {
      const k = await o.store.load();
      if (k) await o.store.save({ ...k, done: true, progress: null });
      // The Windows app starts hidden in the tray from now on (shell.ts shellSetupDone); a page with no such shell has nothing to tell.
      if (o.done) { try { await o.done(); } catch { /* the shell opens its window until this lands */ } }
      return { done: true };
    },
    "onboard.status": async () => {
      const k = await o.store.load();
      return { firstRun: k && k.done ? "done" : "open", person: k ? k.username : null };
    },

    "onboard.space.open": async ({ kind, name }) => {
      const { k, ports, key } = await spaceCtx();
      const place = placeKind(kind);
      if (!place) throw bad("Pick a Linux server or an always-on Mac.");
      const label = usernameOf(name);
      if (!label) throw bad(SPACE_NAME_SAY.required);
      stopRuns();
      const random = o.random || ((n) => crypto.getRandomValues(new Uint8Array(n)));
      const run = createAddServer({
        client: ports.client, relay: ports.relay, autoPair: true,
        // The stages of this run, one line each (no code, no key): what a failed first run needs in order to say where it stopped.
        onChange: (s) => { trail(`${s.stage}${s.error ? ` ${s.error.code}` : ""}`); },
        issue: async () => {
          const setupKey = await ports.createSetupKey();
          const secret = random(16);
          const minted = await ports.mintPairCode({ person: k.id, publicKey: key.publicKey, secret, fingerprint: await ports.setupFingerprint(setupKey.spki), sign: (m) => key.sign(m), ...(o.now ? { now: o.now } : {}), random });
          return { code: minted.code, secret, key: setupKey, expiresAt: minted.exp * 1000 };
        },
        identity: async () => ({ id: k.id }),
        connect: ports.connect,
        pair: async (qr, ctx) => {
          const made = await ports.pair(qr, ctx || {}, { id: k.id, name: k.username, pin: k.pin, key });
          const w = waits.get(id);
          if (w) w.paired = made;
        },
        ...(o.random ? { random } : {}), ...(o.now ? { now: o.now } : {}), ...(o.sleep ? { sleep: o.sleep } : {}), ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}), version: o.version ?? null,
      });
      const id = `fr_${Array.from(random(8), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      waits.set(id, { run, name: label, kind: place, paired: null, saved: false, failed: null, space: "", vault: false });
      await run.begin("records", place);
      const st = run.state;
      if (st.stage === "stopped" || !commandOk(st.installLine)) { waits.delete(id); throw bad(st.error ? st.error.message : "The install command is not one this app can show.", st.error ? st.error.code : "bad_input"); }
      return { id, command: st.installLine, expiresAt: new Date(st.expiresAt).toISOString(), kind: place, name: label, spaceId: spaceKey("", label) || null, role: "owner" };
    },

    // The screen asks every few seconds and a step here (the claim, the vault, the directory) can take longer than that: one answer is worked out at a time, and a later ask gets the same one, so
    // no step is started twice.
    "onboard.space.poll": async (input) => {
      const w0 = waits.get(String((input && input.id) || ""));
      if (!w0) throw bad("That install is not one this device started.");
      if (w0.pending) return w0.pending;
      const mine = pollSpaceOnce(input);
      w0.pending = mine;
      try { return await mine; } finally { if (w0.pending === mine) w0.pending = null; }
    },

    // The directory said the name is taken: pick another and the claim is tried again on the same paired server.
    "onboard.space.name": async ({ id, name }) => {
      const w = waits.get(String(id || ""));
      if (!w) throw bad("That install is not one this device started.");
      const label = usernameOf(name);
      if (!label) throw bad("A space name is lowercase letters, digits and hyphens, 3 to 20 characters, starting with a letter.");
      w.name = label; w.failed = null;
      return { id: String(id), name: label };
    },

    "onboard.join.read": async ({ link }) => {
      const { k, ports, key } = await spaceCtx();
      if (!ports.join) throw unsupported();
      const text = String(link || "").trim();
      if (!text) throw bad("That link does not open a space. Ask for a new invite.");
      const inv = await ports.join(await joinLinkOf(text), { id: k.id, name: k.username, pin: k.pin, key });
      const was = invites.get(text);
      if (was) was.close();
      invites.set(text, inv);
      const c = inv.card || {};
      return { link: text, role: String(c.role || "member"), space: String(c.space || "").replace(/\.vyre\.run$/, "") || null, ttlDays: null, ...(c.fingerprint_words ? { fingerprint_words: String(c.fingerprint_words) } : {}) };
    },

    // Join a space with the role on the link; the space is then added to this username's list in the directory (so GitHub sign-in finds it), as on create. The list line is best effort once the person is a member.
    // Asking to join a Space by its address (no invite): the answer is the home's own, one of waiting, approved (with the link to join by), not accepted, or the closed words. Only what the home says comes back.
    "onboard.space.ask": async ({ address, note }) => {
      const { k, ports, key } = await spaceCtx();
      if (!ports.ask) throw unsupported();
      const r = await ports.ask(String(address || ""), String(note || "").slice(0, 200), { id: k.id, name: k.username, pin: k.pin, key });
      return { state: String((r && r.state) || "closed"), ...(r && typeof r.words === "string" ? { words: r.words.slice(0, 120) } : {}), ...(r && typeof r.label === "string" ? { label: r.label.slice(0, 80) } : {}), eid: String(key && key.eid || "") };
    },
    "onboard.space.ask.status": async ({ address }) => {
      const { k, ports, key } = await spaceCtx();
      if (!ports.askStatus) throw unsupported();
      const r = await ports.askStatus(String(address || ""), { id: k.id, name: k.username, pin: k.pin, key });
      return { state: String((r && r.state) || "closed"), ...(r && typeof r.words === "string" ? { words: r.words.slice(0, 120) } : {}), ...(r && typeof r.link === "string" && /^https:\/\/[a-z0-9-]+\.vyre\.run\/join\/inv_[0-9a-f]{32}\.[A-Za-z0-9_-]+$/.test(r.link) ? { link: r.link } : {}), eid: String(key && key.eid || "") };
    },
    "onboard.space.join": async ({ link }) => {
      const { k, ports, key } = await spaceCtx();
      if (!ports.join) throw unsupported();
      const text = String(link || "").trim();
      if (!text) throw bad("That link does not open a space. Ask for a new invite.");
      const inv = invites.get(text) || await ports.join(await joinLinkOf(text), { id: k.id, name: k.username, pin: k.pin, key });
      invites.delete(text);
      /** @type {any} */ let r;
      try { r = await inv.accept(); } finally { inv.close(); }
      const c = inv.card || {};
      const name = String(c.space || "").replace(/\.vyre\.run$/, "");
      const role = String((r && r.membership && r.membership.role) || c.role || "member");
      const id = String((r && r.space) || "") || spaceKey("", name);
      const fresh = (await o.store.load()) || k;
      await keepSpace(fresh, { id, name: name || id, role, server: name ? `https://${name}.vyre.run` : null, paired: null });
      let listed = false;
      if (name) { try { await api.publishSpace(name, "add"); listed = true; } catch { /* a member already; the line is added the next time this space is published */ } }
      return { joined: true, space: name || null, id, role, server: name ? `https://${name}.vyre.run` : null, listed };
    },

    // AI accounts are made on the server (a member's own login, sessions.accounts.signin), so a page with no daemon offers them once its space is online: the three providers, and the sign-in forwarded to the
    // paired server over the peer wire with the same start (provider, label), then poll (flow, code) the screen already speaks. Nothing secret is returned.
    "onboard.agent.list": async () => {
      if (!o.space) throw unsupported();
      return { providers: AIS.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) })) };
    },
    "onboard.agent.signin": async (input) => {
      if (!o.space) throw unsupported();
      const { box } = await serverOfThisRun("Sign in to an AI once your space is online.");
      const provider = String((input && input.provider) || "");
      if (!AIS.includes(provider)) throw bad("That provider does not support sign-in here.");
      const ports = await o.space.load();
      const body = { provider, ...(input.label ? { label: String(input.label).slice(0, 80) } : {}), ...(input.flow ? { flow: String(input.flow).slice(0, 200) } : {}), ...(input.code ? { code: String(input.code).slice(0, 200) } : {}) };
      return pickSignin(await ports.call("sessions.accounts.signin", body, box));
    },

    // The Assistant step: name it and pick its look. The same server tools the daemon's first run uses (onboard.you names the assistant, onboard.assistant makes it, agents.update keeps the look),
    // sent to the server this onboarding made, with nothing but the name and a look seed that names a real shape and colour.
    "onboard.assistant.set": async (input) => {
      if (!o.space) throw unsupported();
      const { box, k } = await serverOfThisRun("Name your Assistant once your space is online.", true);
      const display = String((input && input.name) || "").trim();
      if (!display || display.length > 40 || /[\u0000-\u001f]/.test(display)) throw bad("An Assistant's name is one line of up to 40 characters.", "bad_name");
      const look = input && input.look ? String(input.look) : "";
      if (look && !lookOf(look)) throw bad("That look is not one the Assistant can have.", "bad_look");
      const ports = await o.space.load();
      // the name the person gave (letters, up to 60), else the username
      const given = String((input && input.person) || "").trim();
      const person = given && given.length <= 60 && /\p{L}/u.test(given) && !/[\u0000-\u001f]/.test(given) ? given : k.username;
      await ports.call("onboard.you", { name: person, assistant: display }, box);
      const a = /** @type {any} */ (await ports.call("onboard.assistant", {}, box));
      if (!a || !a.made || !a.name) throw bad(a && a.why ? String(a.why) : "Your Assistant could not be made yet. Try again in a moment.", "assistant_not_made");
      if (look) await ports.call("agents.update", { name: String(a.name), look }, box);
      return { name: String(a.name), display: String(a.display || display), look: look || null };
    },

    // An API key as an AI account (the owner's own): sent once to the server's own key tool, which checks it with the provider and keeps it in the Vault. The key is never logged, kept or returned: only the account's id, provider and name come back.
    "onboard.agent.key": async (input) => {
      if (!o.space) throw unsupported();
      const { box, role, space } = await serverOfThisRun("Add an AI account once your space is online.", true);
      const kind = String((input && input.kind) || "");
      if (!["anthropic-compatible", "openai-compatible", "openrouter"].includes(kind)) throw bad("That kind of key is not supported here.", "bad_kind");
      const key = String((input && input.key) || "").trim();
      if (key.length < 12 || key.length > 400 || /[\s\u0000-\u001f\u007f]/.test(key)) throw bad("That does not look like an API key.", "bad_key");
      const label = String((input && input.label) || "").trim();
      if (!label || label.length > 80 || /[\u0000-\u001f]/.test(label)) throw bad("An account's name is one line of up to 80 characters.", "bad_name");
      const base = input && input.base_url ? String(input.base_url) : "";
      if (base && !(kind === "openai-compatible" && base === "https://api.x.ai/v1")) throw bad("That address is not one a key can be sent to from here.", "bad_address");
      const ports = await o.space.load();
      /** @type {any} */ let r;
      if (role && role !== "owner") return memberKey(ports, box, space, { kind, key, label, password: input && input.password ? String(input.password) : "", ...(base ? { base_url: base } : {}) });
      try { r = await ports.call("sessions.accounts.key", { kind, key, label, name: label, ...(base ? { base_url: base } : {}) }, box); }
      catch (e) {
        // whatever the server or the provider said, the key is never in what is thrown here
        const code = e && /** @type {any} */ (e).code ? String(/** @type {any} */ (e).code) : "failed";
        const said = scrub(String((e && /** @type {any} */ (e).message) || "That key could not be added."), [key], { marker: "[key]", min: 1 }).slice(0, 200);
        throw bad(said, code);
      }
      return { account: String((r && r.account) || ""), provider: String((r && r.provider) || ""), label: String((r && r.label) || label), checked: Boolean(r && r.checked), ...(r && typeof r.item === "string" && r.item ? { item: r.item.slice(0, 128) } : {}) };
    },

    // The model step: what each connected AI account offers, and the Assistant's default among them. Reads the accounts the person just signed in (sessions.accounts.list) and what each offers
    // (sessions.accounts.models, else the provider's own list), and keeps the pick with agents.update. Only ids, labels and names come back: never a credential.
    // Adding another Space: the Assistant of the person's OTHER server (the current Space's, else the only other one), read only, so the new Space's Assistant can keep its name and look. Names and a look seed come back, nothing else.
    "onboard.assistant.current": async () => {
      if (!o.space) throw unsupported();
      const k = await o.store.load();
      if (!k) throw bad("Make your username first.", "no_identity");
      const paired = /** @type {any[]} */ ((k.spaces || []).filter((s) => s && s.paired && s.paired.box && s.paired.box !== madeHere));
      const there = paired.find((s) => s.id === k.current) || paired[0];
      if (!there) return { assistant: null };
      const ports = await o.space.load();
      /** @type {any} */ let l;
      try { l = await ports.call("agents.list", {}, there.paired.box); } catch { return { assistant: null }; }
      const a = (Array.isArray(l) ? l : l && Array.isArray(l.agents) ? l.agents : []).find((/** @type {any} */ x) => x && x.kind === "assistant");
      if (!a) return { assistant: null };
      const look = typeof a.look === "string" && lookOf(a.look) ? a.look : "";
      return { assistant: { name: String(a.display || a.name || "").slice(0, 40), look } };
    },
    // Adding another Space: the AI accounts of the person's OTHER server, for the copy sheet. Labels, providers and whether a key can be copied (a key account can; a sign-in account keeps its token on that server and signs in again). No key, no item name.
    "onboard.accounts.copyable": async () => {
      if (!o.space) throw unsupported();
      const other = await otherServer();
      if (!other) return { from: null, accounts: [] };
      const ports = await o.space.load();
      /** @type {any} */ let l;
      try { l = await ports.call("sessions.accounts.list", {}, other.box); } catch { return { from: other.name, accounts: [] }; }
      const rows = (Array.isArray(l) ? l : l && Array.isArray(l.accounts) ? l.accounts : []).filter((/** @type {any} */ a) => a && !a.synthetic && !a.pending && typeof a.id === "string");
      return { from: other.name, accounts: rows.slice(0, 12).map((/** @type {any} */ a) => ({ id: String(a.id), label: String(a.label || a.provider || "AI account").slice(0, 80), provider: String(a.provider || ""), copy: noCopy(a, other) === "", ...(noCopy(a, other) && a.kind === "api-key" ? { why: noCopy(a, other) } : {}) })) };
    },
    // Copy chosen key accounts into the NEW Space: each key is read from the other server's Vault (a gated read, one per key, with its own presence), kept in memory only, and added to the new Space through the same
    // path a typed key takes (the owner's key tool, or a member's own Vault in one set act). Returns, per account, whether it was added; never a key or an item name.
    "onboard.accounts.copy": async (input) => {
      if (!o.space) throw unsupported();
      const ids = Array.isArray(input && input.ids) ? input.ids.map(String).slice(0, 12) : [];
      if (!ids.length) throw bad("Pick the accounts to copy.", "bad_input");
      const dest = await serverOfThisRun("Copy accounts once your space is online.", true);
      const other = await otherServer();
      if (!other) throw bad("There is no other Space to copy from.", "no_server");
      const ports = await o.space.load();
      const l = /** @type {any} */ (await ports.call("sessions.accounts.list", {}, other.box));
      const rows = (Array.isArray(l) ? l : l && Array.isArray(l.accounts) ? l.accounts : []).filter((/** @type {any} */ a) => a && ids.includes(String(a.id)));
      /** @type {{ id: string, label: string, ok: boolean, why?: string }[]} */ const done = [];
      /** @type {{ id: string, label: string, kind: string, key: string, base_url?: string }[]} */ const keys = [];
      for (const a of rows) {
        const label = String(a.label || a.provider || "AI account").slice(0, 80), kind = COPY_KINDS[String(a.provider)];
        // decided before any key is read: not the caller's, a custom address, or a sign-in account is skipped with its reason and vault.reveal is never called for it
        const skip = noCopy(a, other);
        if (skip || !kind) { done.push({ id: String(a.id), label, ok: false, why: skip || "Sign in again on the new Space." }); continue; }
        try {
          const got = /** @type {any} */ (await ports.call("vault.reveal", { name: a.vault_item, field: "value" }, other.box));
          const key = String(got && (got.value ?? got.fields?.value) || "");
          if (key.length < 12 || key.length > 400 || /[\s\u0000-\u001f\u007f]/.test(key)) { done.push({ id: String(a.id), label, ok: false, why: "That key could not be read." }); continue; }
          const base = a.base_url === "https://api.x.ai/v1" ? a.base_url : "";
          keys.push({ id: String(a.id), label, kind, key, ...(base ? { base_url: base } : {}) });
        } catch (e) {
          // the read is the person's own act (vault.reveal): the app's one call path (src/real/box.ts tool, the same the Vault screen uses) asks for the yes on this exact call; what it answers is said, never swallowed
          const code = String(e && /** @type {any} */ (e).code || "");
          done.push({ id: String(a.id), label, ok: false, why: code === "cancelled" || code === "not_approved" ? "Not approved. Sign in again on the new Space, or try the copy again." : code === "held_for_approval" || code === "needs_presence" || code === "presence_required" ? "Waiting for your approval. Try again once you have approved." : "That key could not be read. Sign in again on the new Space." });
        }
      }
      try {
        if (dest.role && dest.role !== "owner") {
          if (keys.length) {
            const r = /** @type {any} */ (await ports.call("vault.me.add-keys", { items: keys.map((k) => ({ label: k.label, value: k.key })), ...(input && input.password ? { password: String(input.password) } : {}), ...(dest.space ? { space: dest.space } : {}) }, dest.box));
            if (r && typeof r.secret_key === "string" && r.acct && o.memberKeys) await o.memberKeys.put(String(r.acct), r.secret_key);
            const added = new Set(((r && r.added) || []).map((/** @type {any} */ x) => String(x.label)));
            for (const k of keys) done.push({ id: k.id, label: k.label, ok: added.has(k.label), ...(added.has(k.label) ? {} : { why: String((r && r.reason) || "Not added.").slice(0, 120) }) });
          }
        } else {
          for (const k of keys) {
            try { await ports.call("sessions.accounts.key", { kind: k.kind, key: k.key, label: k.label, name: k.label, ...(k.base_url ? { base_url: k.base_url } : {}) }, dest.box); done.push({ id: k.id, label: k.label, ok: true }); }
            catch (e) { done.push({ id: k.id, label: k.label, ok: false, why: scrub(String((e && /** @type {any} */ (e).message) || "Not added."), [k.key], { marker: "[key]", min: 1 }).slice(0, 120) }); }
          }
        }
      } catch (e) {
        const said = String((e && /** @type {any} */ (e).message) || "Not added.");
        const clean = scrub(said, keys.map((k) => k.key), { marker: "[hidden]", min: 1 }).slice(0, 160);
        if (e && /** @type {any} */ (e).code === "need_password") throw e;
        throw bad(clean, e && /** @type {any} */ (e).code ? String(/** @type {any} */ (e).code) : "failed");
      } finally { keys.length = 0; }
      return { copied: done };
    },
    "onboard.assistant.models": async () => {
      if (!o.space) throw unsupported();
      const { box } = await serverOfThisRun("Pick a model once your space is online.", true);
      const ports = await o.space.load();
      const list = /** @type {any} */ (await ports.call("sessions.accounts.list", {}, box));
      const rows = (Array.isArray(list) ? list : list && Array.isArray(list.accounts) ? list.accounts : []).filter((/** @type {any} */ a) => a && !a.synthetic && !a.pending && typeof a.id === "string");
      const modelsOf = async (/** @type {any} */ a) => {
        /** @type {any} */ let r;
        try { r = await ports.call("sessions.accounts.models", { account: a.id }, box); } catch { r = null; }
        let models = r && Array.isArray(r.models) ? r.models : null;
        if (!models || !models.length) { try { const p = /** @type {any} */ (await ports.call("sessions.models", { provider: String(a.provider || "claude") }, box)); models = Array.isArray(p) ? p : p && Array.isArray(p.models) ? p.models : []; } catch { models = []; } }
        return models.filter((/** @type {any} */ m) => m && typeof m.id === "string").slice(0, 60).map((/** @type {any} */ m) => ({ id: String(m.id).slice(0, 120), label: String(m.label || m.id).slice(0, 120) }));
      };
      const accounts = [];
      for (const a of rows.slice(0, 12)) accounts.push({ id: String(a.id), label: String(a.label || a.provider || "AI account").slice(0, 80), provider: String(a.provider || ""), models: await modelsOf(a) });
      return { accounts };
    },
    "onboard.assistant.model": async (input) => {
      if (!o.space) throw unsupported();
      const { box } = await serverOfThisRun("Pick a model once your space is online.", true);
      const model = String((input && input.model) || "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model)) throw bad("That is not a model name.", "bad_model");
      const ports = await o.space.load();
      const l = /** @type {any} */ (await ports.call("agents.list", {}, box));
      const a = (Array.isArray(l) ? l : l && Array.isArray(l.agents) ? l.agents : []).find((/** @type {any} */ x) => x && x.kind === "assistant");
      if (!a || !a.name) throw bad("Your Assistant is not made yet.", "assistant_not_made");
      await ports.call("agents.update", { name: String(a.name), model }, box);
      return { name: String(a.name), model };
    },

    "onboard.space.list": async () => {
      const k = await o.store.load();
      if (!k) throw bad("Make your username first.", "no_identity");
      return { person: k.username, id: k.id, current: k.current || null, spaces: outRows(k.spaces || []) };
    },

    "onboard.space.current": async ({ space }) => {
      const k = await o.store.load();
      if (!k) throw bad("Make your username first.", "no_identity");
      const want = String(space || "");
      const hit = (k.spaces || []).find((s) => s.id === want || s.name === want);
      if (!hit) throw bad("That space is not one this identity belongs to.");
      await o.store.save({ ...k, current: hit.id });
      return { current: hit.id, name: hit.name, role: hit.role, server: hit.server };
    },

    // "Not your server? Remove it": forget the pairing this page made and the space row that came with it. The person's own yes was pressing Create; this is the way back from a stand-in.
    "onboard.space.remove": async ({ space }) => {
      if (!o.space) throw unsupported();
      const k = await o.store.load();
      if (!k) throw bad("Make your username first.", "no_identity");
      const want = String(space || "");
      const hit = (k.spaces || []).find((s) => s.id === want || s.name === want);
      if (!hit) throw bad("That space is not one this identity belongs to.");
      const ports = await o.space.load();
      if (hit.paired && hit.paired.box) await ports.forget(hit.paired.box);
      stopRuns();
      for (const [wid, w] of waits) if (w.name === hit.name) waits.delete(wid);
      const rest = (k.spaces || []).filter((s) => s.id !== hit.id);
      await o.store.save({ ...k, spaces: rest, current: k.current === hit.id ? (rest[0] ? rest[0].id : null) : k.current || null });
      // The directory's list for this username drops the space too, so GitHub sign-in stops offering it. Best effort: the space is already gone here, and a locked page or an unreachable directory leaves a stale line the directory ignores when the space does not answer.
      let unpublished = false;
      try { await api.publishSpace(hit.name, "remove"); unpublished = true; } catch { /* stale line at most */ }
      return { removed: true, id: hit.id, unpublished };
    },
  };

  /** The host's own methods; the space steps call publishSpace through it. */
  const api = {
    /** Does this host answer that tool name? */
    has: (/** @type {string} */ name) => name in tools && (Boolean(o.space) || !/^onboard\.(space|join)\./.test(name)),
    /** Answer a tool, or throw what the daemon would throw. Names this stage does not have say so plainly. @param {string} name @param {any} [input] */
    async call(name, input = {}) {
      const fn = tools[name];
      if (!fn) throw Object.assign(new Error("This step is not ready in the app yet."), { code: "host_unsupported" });
      if (name !== "onboard.space.poll") return fn(input || {});
      try {
        const r = await fn(input || {});
        trace(`poll answered: online ${Boolean(r.online)}${r.failed ? ` failed ${String(r.code || "")}` : ""}${r.connecting ? " connecting" : ""}${r.expired ? " expired" : ""}${r.contested ? " contested" : ""}`);
        return r;
      } catch (e) { trace(`poll threw ${String((/** @type {any} */ (e)) && (/** @type {any} */ (e)).code || "no code")}`); throw e; }
    },
    /**
     * The body that registers this identity's sign-in record at a space (op "register"), signed by the identity key: K is the password key of the stored master record (its own salt and cost), so the
     * login key and the record's wrap come from one stretch. The password is the person's, held in memory by the caller only until this is made. @param {string} space @param {string} password
     */
    async registerLogin(space, password) {
      const k = await o.store.load();
      if (!k) throw bad("Make your username first.", "no_identity");
      if (!held) throw bad("Unlock with your password first.", "locked");
      const kdf = acceptKdf(k.master.kdf);
      const d = await deriveLogin(String(password).normalize("NFKC"), String(k.master.kdf.salt), kdf);
      try {
        const ts = o.now ? o.now() : Date.now();
        const pub = (await fromSeed(held)).publicKey;
        const sig = b64u(await (await fromSeed(held)).sign(registerMessage(space, k.username, d.loginPub, bundleHash(k.master), ts)));
        return { op: "register", username: k.username, person: k.id, pub, ts, sig, salt: String(k.master.kdf.salt), loginPub: d.loginPub, bundle: k.master };
      } finally { d.close(); }
    },
    /**
     * Add (or remove) a space address in the names directory's list for this username, signed by the identity as an act (`space-add` / `space-remove`), so GitHub sign-in can find the person's spaces. Called when a space
     * is created or joined. @param {string} space the space's name (juniper) @param {"add" | "remove"} [what]
     */
    async publishSpace(space, what = "add") {
      const k = await o.store.load();
      if (!k) throw bad("Make your username first.", "no_identity");
      if (!held) throw bad("Unlock with your password first.", "locked");
      const addr = spaceAddressOf(`${String(space).replace(/\.vyre\.run$/, "")}.vyre.run`);
      if (!addr) throw bad("That is not a space address.");
      const key = await fromSeed(held);
      const ts = o.now ? o.now() : Date.now();
      const domain = `${addr.space}.vyre.run`;
      const sig = b64u(await key.sign(actMessage({ action: `space-${what}`, name: k.username, domain, ts })));
      let res;
      try { res = await f(`${base}/v1/ids/spaces/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: k.username, address: domain, act: { by: key.eid, ts, sig } }) }); } catch { throw bad("Cannot reach the names directory right now.", "unreachable"); }
      if (!res.ok) throw bad("The names directory did not take the space.", "directory");
      return { ok: true, address: domain };
    },
    /** The unlocked key for the identity's own signing (the next stage's pair code), or null while locked. */
    signer: () => (held ? { seed: held } : null),
  };
  return api;
}
