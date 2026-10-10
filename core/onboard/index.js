// @ts-check
// onboard: the six steps of spec section 1, as tools the Deck's first screen calls.
//
// Each step is worked out fresh from what is true on the machine (is claude installed, is
// the server paired, is the name serving), plus the few choices the person made, which live in
// config.json under "onboard". The steps call other modules' tools (names.*, vault.put,
// recall.*, projects.*) and work without them: a missing module blocks its step and says why.

import { assistantWhenReady } from "./assistant-ready.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import * as config from "../config/index.js";
import { isPerson, onTailnet } from "../../lib/caller.js";
import { anthropicKind } from "../../lib/credential-shapes.js";
import { loopback } from "./loopback.js";
import { setupToken } from "./setup-token.js";
import { SETUP_STEPS, SKIPPABLE, PASSABLE, setupList } from "../../lib/setup-steps.js";

export const STEPS = ["you", "claude", "pair", "name", "history", "devices"];
/** names phases, in order; the page shows them as reserve, dns and cert rows. */
const PHASES = ["idle", "dns", "certificate", "serving"];
const ROWS = ["reserve", "dns", "cert"];
const MAC_DOWNLOAD = "https://vyre.run/download/mac";
const CLAUDE_INSTALL = "npm install -g @anthropic-ai/claude-code";
const VAULT_ITEM = { subscription: "claude-setup-token", "api-key": "anthropic-api-key" };
const VAULT_KIND = { subscription: "secret", "api-key": "api-key" };
const VAULT_ABOUT = { subscription: "Claude subscription token from `claude setup-token`, for headless sessions", "api-key": "Anthropic API key, for headless sessions" };
// The token is handed to the session launcher through the vault's credentials port (vault.launcherOnly), never through a module grant.

// Never a linked-device caller, which a model on the owner's Mac is too.
// relay.join is not shippable on a Mac yet: vyre.db is a same-uid store, so a Mac chosen as
// Solo/Server has nowhere safe to hold a paired device's keys until vyre-core (ADR 0040) owns
// its own root-only store -- reviewer/team-lead, 28 Sep ("gated on vyre-core, same as Mac GA").
// launch reads this to hide the code-pairing card rather than offer a path that would fail.
const RELAY_JOIN_DARWIN_REASON = "relay pairing needs vyre-core to hold its keys, which is not built on a Mac yet";
/** Pure, for tests: what onboard.status reports under `can`, for a given `os.platform()` value. */
export function canRelayJoin(platform) {
  return platform === "darwin" ? { relayJoin: false, reason: RELAY_JOIN_DARWIN_REASON } : { relayJoin: true, reason: null };
}
/**
 * Pure, for tests: the loopback's default port when network.onboardPort is unset. 7300 (ADR
 * 0002) everywhere except a Mac chosen as server, which must never even attempt the port a real
 * Mac's own onboarding tunnel binds (reviewer's LOW, 28 Sep round 2) -- 7301 instead. An explicit
 * network.onboardPort always wins, on every platform, box included.
 */
export function defaultOnboardPort(platform) {
  return platform === "darwin" ? 7301 : 7300;
}
const GREETING = "Vyre is set up. Say hello to me in two or three sentences: who you are, and one thing you can do for me now.";
// onboard.join hands out a relay pairing secret: the owner's alone,
// as relay's own owner() guard already treats them (core/relay/index.js). callerAllowed's kind
// check does not catch a Vyre-owned thread, whose caller reduces to "local" or "cli" the same as
// a person at the terminal (core/modules/index.js callerKind strips "thread:<id>" as well as
// "agent:<name>"), so this checks meta.agent and the caller string directly, the same signals
// relay checks, not just the tool's `callers` list.
const AGENT_CLAIM = /(?:^|[\s:])agent:/;
const joinFail = (code, message) => Object.assign(new Error(message), { code });
const joinOwnerOnly = (caller, meta, what) => {
  const c = String(caller || "");
  if (c.startsWith("tailnet-guest:")) throw joinFail("denied", `${what} is the owner's; a guest never sees it`);
  if ((meta && meta.agent) || AGENT_CLAIM.test(c)) throw joinFail("denied", `"${c}" is an agent; ${what} is the owner's`);
  if (["anonymous", "hook"].includes(c)) throw joinFail("denied", `${what} is the owner's`);
};
// HD-1: the tools that write the assistant's sign-in, claim a name, pair a server, index sessions or finish onboarding are the person's own. The callers they have today are the
// person's surfaces, the onboarding page on the loopback address ("onboard"), a paired device or tailnet peer, and this module and launch; a model client (mcp, a thread, an agent) and any
// other module are refused. Before the server has an owner (a paired device) every write is refused ("pair_first"); afterwards the registry asks for presence (the tools declare presence.when).
const SURFACES = ["cli", "local", "deck", "capsule", "mobile", "onboard", "web", "setup"];
export const ownerWrite = (/** @type {unknown} */ caller, /** @type {any} */ meta, /** @type {string} */ what, /** @type {boolean} */ owned, writes = true) => {
  const c = String(caller || "");
  const ok = SURFACES.includes(c) || /^(device|setup|tailnet):[\w.-]+$/.test(c) || c === "module:onboard" || c === "module:launch";
  if (!ok || (meta && meta.agent) || AGENT_CLAIM.test(c)) throw joinFail("denied", `${what} is the person's own; "${c || "anonymous"}" may not do it`);
  // No setup on a server before it has an owner (the user's order: identity first, on the person's device; the server takes only the pairing). Once it has one, the registry asks the person's
  // presence for these writes (the tools declare presence.when), so a hijacked page cannot swap credentials or claim a name.
  if (writes && !owned) throw joinFail("pair_first", `${what} comes after this server is paired to you: pair it from your Vyre app first`);
};
/** An agent's name from a display name: "Juno Two" becomes "juno-two". */
export const slug = s => {
  const v = String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 31).replace(/-+$/, "");
  return v.length >= 2 ? v : "assistant";
};

const obj = (properties = {}, required = []) => ({ type: "object", properties, required });

/** Who may reach the setup tools at all: the person's surfaces, the owner's devices, the setup page's own loopback ("onboard") and modules. A model session is not one; each tool that changes something also checks personOnly(caller), which refuses an agent riding a person's label. */
const ONBOARD_CALLERS = Object.freeze(["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "onboard", "module"]);

/** `claude --version`, remembered for half a minute: the page asks every couple of seconds. */
let known = { at: 0, version: /** @type {Promise<string|null>|null} */ (null) };
function claudeVersion() {
  if (known.version && Date.now() - known.at < 30_000) return known.version;
  known = { at: Date.now(), version: new Promise(resolve => execFile(process.env.VYRE_CLAUDE_BIN || "claude", ["--version"], { timeout: 10_000 },
    (e, out) => resolve(e ? null : String(out).trim().split("\n")[0] || "unknown"))) };
  return known.version;
}

/**
 * The owner's other devices this machine can see, from the Wink network status (network.wink.status): the peers each linked space reports, by device id.
 * @param {any} st
 */
export function winkPeers(st) {
  const out = /** @type {any[]} */ ([]);
  for (const sp of (st && Array.isArray(st.spaces) ? st.spaces : [])) {
    for (const p of (Array.isArray(sp.peerList) ? sp.peerList : [])) out.push({ name: String(p.eid || ""), via: p.via === "direct" ? "direct" : "relay", online: true, lastSeen: p.since ? new Date(Number(p.since)).toISOString() : null });
  }
  return out;
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const save = patch => config.save(patch, ctx.paths.root, ctx.config);
    const ob = () => ctx.config.onboard || {};
    /**
     * Does this machine have an owner? On a SERVER: a device paired and was confirmed (wink.server.owned), or the owner arrived (ownerSeen). On a COMPUTER that is itself the person's Vyre
     * (solo or device: no pairing), the owner exists once the person has claimed their identity there (spaces.identity.id answers an id): the home's owner was adopted to it. Whichever way,
     * a fresh home with neither is not owned.
     */
    const isOwned = async () => {
      if (config.isServer(ctx.config.machine)) return Boolean(net().ownerSeen) || Boolean(((await ctx.call("wink.server.owned", {}).catch(() => null)) || {}).owned);
      const id = await ctx.call("spaces.identity.id", {}).catch(() => null);
      return Boolean(id && (id.id || (id.data && id.data.id)));
    };
    const skipped = () => new Set(ob().skipped || []);
    const net = () => ctx.config.network || {};
    /** The setup page (or an earlier step) already claimed a vyre.run address on this box: ctx.config.name is that address, not the person. */
    const heldAddress = () => net().via === "vyre.run" && Boolean(ctx.config.name);
    // The person's public, non-secret id (team-lead, 28 Sep, for the phone's avatar): made once,
    // here, on every start -- a fresh install gets it right away (this runs before the wizard's
    // first onboard.status), and an install from before this field existed gets it backfilled on
    // its next restart. Only this module's own startup ever writes it (config.ownerId(), with
    // root/live to persist); exposed read-only at system.info, which already carries the owner's
    // name for the same avatar purpose.
    config.ownerId(ctx.config, ctx.paths.root, ctx.config);
    // The link's hash survives a restart (vyre update restarts vyred): 0600, hashes only.
    const kept = path.join(ctx.paths.root, "onboard-link.json");
    const keep = {
      load: () => { try { return JSON.parse(fs.readFileSync(kept, "utf8")); } catch { return null; } },
      save: s => { if (s) fs.writeFileSync(kept, JSON.stringify(s), { mode: 0o600 }); else fs.rmSync(kept, { force: true }); },
    };
    // Reviewer, 28 Sep round 2 (LOW): the box's own default, 7300, is the exact port RULES.md
    // forbids binding on a Mac (the user's real onboarding tunnel to the box lives there); a
    // Mac chosen as server must never even attempt it, "next free port if taken" (ADR 0002)
    // notwithstanding. Solo/Server on darwin defaults one port over instead; an explicit
    // network.onboardPort still wins on every platform, box included.
    const lb = loopback({ handler: p => ctx.handler(p), port: Number(net().onboardPort ?? defaultOnboardPort(process.platform)), log: m => ctx.log(m), keep });
    // Reviewer, 28 Sep: onboard now loads on Solo too, so this can no longer resume
    // unconditionally -- on a Mac that would bind the setup listener with no server chosen and
    // nothing to onboard into. Belt and braces alongside the boxOnly() guard on onboard.link.
    // 0.3: a server has no first-run page. The listener is never opened (onboard.link refuses), so nothing listens on the onboarding port; a server is set up from the owner's app after pairing.
    keep.save(null);
    let indexing = null;
    let lastPhase = "idle";
    const signin = setupToken();
    /** @type {Record<string, string>} */
    let lastStates = {};
    /** The box's last federated catalogue answer, held for 30 s: see the history step. */
    let catalogHeld = /** @type {{ at: number, seen: string, cat: any } | null} */ (null);
    const offLink = ["link.paired", "link.unpaired"].map(type => ctx.events.on(type, () => { catalogHeld = null; }));

    const call = async (tool, input = {}) => {
      const r = await ctx.call(tool, input);
      if (r.error) throw Object.assign(new Error(r.error.code === "no_such_tool" ? `${tool.split(".")[0]} is not running on this machine` : r.error.message), { code: r.error.code });
      return r.data;
    };
    const tryCall = (tool, input) => call(tool, input).catch(e => ({ __error: e.message }));
    const mark = (step, s) => skipped().has(step) && s.state !== "done" ? { ...s, state: "skipped" } : s;
    // ADR 0039: onboard now loads on a Solo machine too (so onboard.machine and, on tailnet's
    // branch, onboard.join can reach it), but the six-step box wizard below assumes box things
    // (a public address, a pairing, an owner-claim flow) it must not run on a machine that isn't
    // one. Reviewer's condition, 28 Sep: refuse up front, through this one guard, on every wizard
    // tool but the two that are meant to work on Solo (onboard.status, which only reads, and
    // onboard.machine, which is how a Solo machine becomes a server in the first place).
    /** The person on their own surface, or the setup page's own loopback caller: not a model on the box, a module or a guest. */
    const personOrPage = caller => String(caller) === "onboard" || isPerson(String(caller));
    const personOnly = caller => { if (!personOrPage(caller)) throw Object.assign(new Error("only the person, on their own surface or the setup page, changes this"), { code: "denied" }); };
    const boxOnly = () => { if (!config.isServer(ctx.config.machine)) throw Object.assign(new Error("this step is part of the box's onboarding wizard, not available on this machine"), { code: "not_a_server" }); };

    async function status(caller = "local") {
      const [version, names, recall, wink, accounts] = await Promise.all([claudeVersion(), tryCall("names.status"), tryCall("recall.status"), tryCall("network.wink.status"), tryCall("sessions.accounts.list", { provider: "claude" })]);
      const n = names.__error ? null : names;

      const you = { state: ob().person ? "done" : "todo", why: null, person: ob().person || null, name: heldAddress() ? (ob().person || null) : ctx.config.name || null, assistant: ob().assistant || null };

      const auth = ob().claude || null;
      // Claude can be signed in two ways: the Claude step's own token (ob().claude), or an account the sign-in tool made (the setup page's "Sign in to your AI", `vyre sessions`). Both count: a doctor that read only
      // the first said "not signed in" right after the page had signed Claude in (IR-17).
      const acct = (Array.isArray(accounts) ? accounts : []).find((/** @type {any} */ a) => a && a.provider === "claude" && !a.synthetic && !a.pending && (a.kind === "login" ? a.signed_in_at != null : true));
      const claude = { state: "todo", why: null, installed: Boolean(version), version, install: version ? null : CLAUDE_INSTALL, auth,
        signedIn: Boolean(auth) || Boolean(acct), via: auth === "api-key" ? "api-key" : auth ? "setup-token" : acct ? (acct.kind === "api-key" ? "api-key" : "account") : null };
      if (claude.auth || acct) claude.state = "done";
      else if (!version) Object.assign(claude, { state: "blocked", why: "Claude Code is not installed on this machine" });

      // The pair step: this server is paired to the person (a server) or the person is signed in here (a computer), and the link to the space is up. Read from the built-in network.
      const w = wink.__error ? null : wink;
      const owned = await isOwned();
      const spaces = w && Array.isArray(w.spaces) ? w.spaces : [];
      const pair = { state: "todo", why: null, owned, signedIn: Boolean(w && w.identity && w.identity.signedIn), spaces: spaces.map(x => ({ id: x.id, name: x.name, state: x.state, path: x.path })), relay: w && w.relay ? { ok: Boolean(w.relay.ok ?? w.relay.connected) } : null };
      if (!w) Object.assign(pair, { state: "blocked", why: wink.__error || "the network status is unavailable" });
      else if (owned) pair.state = "done";
      else pair.why = config.isServer(ctx.config.machine) ? "pair this server from your Vyre app: scan its code or paste it" : "sign in to your Vyre identity on this computer";

      const address = { state: "todo", why: null, code: null, adminUrl: null, name: ctx.config.name || null, address: n ? n.address : null, via: via(n),
        phase: n ? n.phase : "idle", certificate: n ? n.certificate : null };
      if (!n) Object.assign(address, { state: "blocked", why: names.__error });
      else if (n.phase === "serving") address.state = "done";
      else if (n.phase === "dns" || n.phase === "certificate") address.state = "working";
      else if (n.phase === "failed") Object.assign(address, { state: "blocked", why: n.why });
      else if (pair.state !== "done") Object.assign(address, { state: "blocked", why: "pair this server first" });

      const r = recall.__error ? null : recall;
      const history = { state: "todo", why: null, sessions: 0, indexed: r ? r.sessions : 0, running: Boolean(r && r.indexing) || Boolean(indexing) };
      if (!r) Object.assign(history, { state: "blocked", why: recall.__error });
      else {
        // total does not depend on the limit, so one row is enough. On the box the catalogue
        // counts the paired Mac's sessions too (a module asks for that with machines: "all"), and
        // sources says which machines answered.
        const box = config.isServer(ctx.config.machine);
        // The page asks every couple of seconds, and each federated answer is a question to the
        // Mac, so the box keeps it for 30 s, or until a Mac pairs, unpairs, comes or goes
        // (link.macs is the box's own record, so reading it costs the Mac nothing). The box's own
        // count still moves with the index through history.indexed below.
        const linked = box ? await tryCall("link.macs") : [];
        const seen = Array.isArray(linked) ? linked.map(m => `${m.mac}:${m.online}`).join(",") : "";
        let cat;
        if (box && catalogHeld && catalogHeld.seen === seen && Date.now() - catalogHeld.at <= 30_000) cat = catalogHeld.cat;
        else {
          cat = await tryCall("projects.catalog", { limit: 1, ...(box ? { machines: "all" } : {}) });
          catalogHeld = box && !cat.__error ? { at: Date.now(), seen, cat } : null;
        }
        const sources = !cat.__error && Array.isArray(cat.sources) ? cat.sources : null;
        const count = x => Number(x && x.total) || 0;
        // The box's own sessions are what its index has to catch up with; a Mac indexes its own.
        const own = Math.max(sources ? count(sources[0]) : count(cat.__error ? null : cat), history.indexed);
        const macs = sources ? sources.filter(x => x.source === "mac") : [];
        history.sessions = own + macs.reduce((n, m) => n + count(m), 0);
        if (sources) history.machines = sources.map(x => ({ machine: x.machine, source: x.source, sessions: x.source === "box" ? own : count(x), ok: x.ok }));
        if (history.running) history.state = "working";
        else if (history.sessions === 0) {
          const off = Array.isArray(linked) ? linked.find(m => !m.online) : null;
          Object.assign(history, { state: "done",
            why: !box ? "no Claude Code sessions on this machine yet"
              : off ? `Your Mac (${off.name}) is offline, so its sessions do not show here yet`
              : "Your Mac's sessions appear here when you connect your Mac" });
        }
        else if (ob().history && history.indexed >= own) history.state = "done";
      }

      // The Mac counts once link has paired one; the first paired is the one shown.
      const peers = await tryCall("link.peers");
      const mac = Array.isArray(peers) && peers.length ? { connected: true, name: peers[0].name || peers[0].node || null } : { connected: false, name: null };
      // peers: the owner's other devices this machine sees, and whether each is online, for the phone's line.
      const linkedPeers = winkPeers(w);
      const devices = { state: ob().finished ? "done" : "todo", why: null, phoneUrl: n && n.phase === "serving" ? n.address : null, macDownload: MAC_DOWNLOAD, mac, peers: linkedPeers };

      // detail: each step's full state (todo, working, blocked, done, skipped) and what it needs.
      // steps: the page's view of it, todo, done or skipped.
      const detail = { you: mark("you", you), claude: mark("claude", claude), pair: mark("pair", pair),
        name: mark("name", address), history: mark("history", history), devices: mark("devices", devices) };
      for (const k of STEPS) {
        if (lastStates[k] && lastStates[k] !== detail[k].state) ctx.events.emit("onboard.stepped", { step: k, state: detail[k].state });
      }
      lastStates = Object.fromEntries(STEPS.map(k => [k, detail[k].state]));
      const steps = Object.fromEntries(STEPS.map(k => [k, ["done", "skipped"].includes(detail[k].state) ? detail[k].state : "todo"]));
      const current = STEPS.find(k => steps[k] === "todo") || null;
      // The signed-in AI account's own display name, to prefill the person's name (editable; null when it says none).
      const accountName = await aiAccount().then(a => a.name).catch(() => null);
      const mode = caller === "onboard" ? "loopback" : onTailnet({ caller }) ? "tailnet" : "local";
      // can: what this machine is actually able to do, for launch's cards to gate on rather than
      // guess from role/machine. relayJoin is false on darwin until vyre-core exists (see
      // RELAY_JOIN_DARWIN_REASON above); every other platform can already join a relay today.
      const can = canRelayJoin(process.platform);
      return { mode, role: ctx.config.role, machine: ctx.config.machine, platform: process.platform, can, owned, ownerFirst: owned ? null : config.isServer(ctx.config.machine) ? "pair" : "name",
        owner: net().owner || null, address: n && n.phase === "serving" ? n.address : null,
        host: os.hostname(), name: personOrPage(caller) ? ob().person || null : null, accountName: personOrPage(caller) ? accountName : null, person: personOrPage(caller) ? ob().person || null : null, assistant: ob().assistant || null, assistantState: ob().assistantState || null,
        // arrived: the owner has reached the address over the tailnet (the page's Switch), so the
        // loopback page is done with and `vyre box add` may close its tunnel.
        current, finished: Boolean(ob().finished), arrived: Boolean(net().ownerSeen), steps, detail };
    }

    /** How the name step serves: a vyre.run claim, or the person's own domain. */
    function via(n) {
      const d = Boolean(net().domain);
      return d ? "domain" : "vyre.run";
    }

    const stepOf = async (k, caller) => (await status(caller)).detail[k];
    /** The address step as progress rows (reserve, dns, cert), and its url once it serves. */
    const progress = s => {
      if (s.phase !== "failed") lastPhase = s.phase;
      const failed = s.phase === "failed", i = Math.min(PHASES.indexOf(failed ? lastPhase : s.phase), failed ? 2 : 3);
      const steps = ROWS.map((id, j) => ({ id, state: j < i ? "done" : j > i ? "todo" : failed ? "failed" : i === 0 ? "todo" : "doing", note: failed && j === i ? s.why : null }));
      return { ...s, steps, url: s.phase === "serving" ? s.address : null };
    };
    ctx.tool("onboard.status", {
      effect: "read", // a read open to every caller: the body keeps the person's name and the sign-in and claim links from a model
      description: "Where the onboarding stands: every step's state and what it needs.",
      input: obj(),
      run: async (_, { caller }) => status(caller),
    });

    ctx.tool("onboard.you", {
      effect: "write", callers: ONBOARD_CALLERS,
      description: "Step 1: your name as you like it shown, and your assistant's name. A name that is also a valid vyre.run name becomes the default candidate.",
      input: obj({ name: { type: "string" }, assistant: { type: "string" } }, ["name"]),
      run: async ({ name, assistant }, { caller }) => {
        boxOnly();
        personOnly(caller);
        const p = String(name ?? "").trim(), a = String(assistant ?? "").trim();
        if (!p || p.length > 60 || /[\u0000-\u001f]/.test(p) || !/\p{L}/u.test(p)) throw new Error("your name is any letters, one line of up to 60 characters");
        if (a.length > 40 || /[\u0000-\u001f]/.test(a)) throw new Error("the assistant's name is one line of up to 40 characters");
        // The address is never derived from the person's name (#50): this saves the person and the assistant's name, nothing else.
        save({ onboard: { person: p, ...(a ? { assistant: a } : {}) } });
        // The assistant is made as soon as it has a name and its person exists: no second click, whatever the Claude step does later.
        if (a) await ensureAssistant();
        return stepOf("you", caller);
      },
    });

    ctx.tool("onboard.machine", {
      effect: "write",
      description: "ADR 0039: how Vyre runs on this machine. solo (everything here) or server (always on for other devices) are the person's own choice; device is set by onboard.join/relay.join once a connection to another server is confirmed, never chosen directly by a person.",
      // "device" stays in the type (checkInput has no per-caller schema, and removing it would
      // break the already-shipped, already-reviewed relay.join -> onboard.machine wiring); the
      // run() guard below, not the schema, is what actually stops a person or an agent choosing
      // it -- reviewer, 28 Sep round 2.
      input: obj({ machine: { type: "string", enum: ["solo", "server", "device"] } }, ["machine"]),
      // Reviewer, 28 Sep: this tool changes which modules load, so it is the person's own action,
      // never an agent's or a third-party module's. "onboard" is the pre-owner loopback session
      // (only reachable through a one-time link cli/local/capsule minted). "module" stays in the
      // allowlist only so the two specific callers below can reach run() at all; which of them
      // may do what is checked there, by the exact caller string, not by this coarse kind.
      callers: ["cli", "local", "deck", "capsule", "onboard", "module"],
      // Moving TO server turns on the eight box-only modules -- a real network-facing change --
      // so it needs an actual presence proof, EXCEPT the very first choice on a real box, before
      // any owner exists: that's already proven by the one-time link only cli/local/capsule can
      // mint (ADR 0032's own passkey-enrollment exemption; there's no passkey to prove with yet
      // either). A Mac never gets this exemption (role is never "box"), so a Solo Mac choosing
      // server always needs the proof -- reviewer's HIGH, round 2: the first version of this
      // exempted "no owner seen", which is permanently true for every Solo Mac, so it was
      // proof-free there always, the opposite of the fix.
      presence: { when: input => Boolean(input && input.machine === "server" && !(ctx.config.role === "box" && !net().ownerSeen)) },
      run: async ({ machine }, { caller }) => {
        const raw = String(caller);
        if (machine === "device") {
          // Only onboard's own onboard.join step, or relay's relay.join, ever sets this, each
          // after its own person-gated, presence-proved pairing (ADR 0039 section 5) -- never a
          // person or an agent choosing it directly.
          if (!["module:onboard", "module:relay"].includes(raw)) throw Object.assign(new Error("device is set once a connection to another server is confirmed, not chosen directly; pair this computer to a server to set it"), { code: "denied" });
        } else if (raw.startsWith("module:")) {
          // Any other module reaching this tool may only ever set device (above); solo and
          // server are the person's own choice, whoever is asking on their behalf.
          throw Object.assign(new Error("only a person chooses solo or server"), { code: "denied" });
        }
        // machine's own default (config/index.js defaults()) already covers "no choice made
        // yet"; this tool only ever records an actual choice, so calling it with the value
        // already in effect is a safe no-op, not an error.
        save({ machine });
        // The launchd/keep-awake service (`vyre server here`'s own installer) lands separately;
        // this tool records the choice now so onboarding and Settings have something to call.
        return { machine: ctx.config.machine, service: null };
      },
    });

    ctx.tool("onboard.name", {
      effect: "write", callers: ONBOARD_CALLERS,
      description: "Checks <name>.vyre.run, or reads which space's name this server serves. A server holds no name: a space is named in the app, and the app tells the server to serve it (names.serve).",
      input: obj({ name: { type: "string" }, action: { type: "string" } }),
      run: async ({ name, action = "check" }, { caller, ...meta }) => {
        boxOnly();
        ownerWrite(caller, meta, "reading the name", await isOwned(), false);
        // checked here, after the caller: a model is refused for being a model whatever it asks (check, status)
        if (action !== "check" && action !== "status") throw joinFail("bad_input", "input.action must be one of check, status");
        if (action === "check") {
          if (!name) throw new Error("name is required to check");
          return call("names.check", { name });
        }
        return progress(await stepOf("name", caller));
      },
    });

    ctx.tool("onboard.claude", {
      effect: "write", callers: ONBOARD_CALLERS,
      description: "Store Claude Code's sign-in in the Vault: a subscription setup token or an API key. The value is never returned. setup-token alone starts `claude setup-token` and returns its sign-in url; setup-token with the code the page showed finishes it.",
      presence: { when: () => true, summary: async () => "Sign this server in to Claude" },
      input: obj({ mode: { type: "string", enum: ["detect", "setup-token", "api-key", "disconnect"] }, key: { type: "string" }, code: { type: "string" },
        kind: { type: "string", enum: ["subscription", "api-key"] }, token: { type: "string" } }),
      run: async ({ mode, key, code, kind, token }, { caller, ...meta }) => {
        // A computer that is itself its owner's Vyre (no pairing) may sign in to Claude once the person has claimed their identity there; a computer with no owner still refuses like any non-server.
        const owned = await isOwned();
        if (!config.isServer(ctx.config.machine) && !owned) boxOnly();
        ownerWrite(caller, meta, "signing in to Claude", owned);
        // Only a read (no mode, or detect, and nothing to store) is open to a non-person; storing a key or starting the sign-in is the person's (HD-1).
        if (mode !== "detect" && (mode || key || code || kind || token)) personOnly(caller);
        if (mode === "disconnect") {
          // The person disconnects the AI account: both sign-in items leave the vault (a missing one is fine) and the step reads as not signed in. Assistants on it stop and ask. The account itself is not touched.
          for (const name of Object.values(VAULT_ITEM)) await call("vault.delete", { name }).catch(() => null);
          save({ onboard: { claude: null } });
          ctx.events.emit("onboard.claude-changed", { signedIn: false });
          return stepOf("claude", caller);
        }
        if (mode === "setup-token" && !key && !token) {
          if (!code) return { ...(await stepOf("claude", caller)), url: await signin.start(), needsCode: true };
          [kind, token] = ["subscription", await signin.finish(code)];
        }
        kind ||= mode === "api-key" ? "api-key" : mode === "setup-token" ? "subscription" : undefined;
        token ??= key;
        if (kind) {
          const t = String(token || "").trim();
          if (anthropicKind(t) !== kind || t.length < 40) {
            throw new Error(kind === "subscription" ? "that does not look like a token from `claude setup-token`" : "that does not look like an Anthropic API key");
          }
          await call("vault.put", { name: VAULT_ITEM[kind], kind: VAULT_KIND[kind], description: VAULT_ABOUT[kind], value: t });
          save({ onboard: { claude: kind } });
          ctx.events.emit("onboard.claude-changed", { signedIn: true });
          await ensureAssistant();
        }
        return { ...(await stepOf("claude", caller)), url: null, needsCode: signin.active() };
      },
    });

    ctx.tool("onboard.pair", {
      effect: "read", callers: ONBOARD_CALLERS,
      description: "The pair step: whether this server is paired to you (or you are signed in on this computer) and whether its link is up, direct or through the relay. Read only: pairing itself is done from your Vyre app (wink.pair.server, wink.server.pairing).",
      input: obj(),
      run: async (_, { caller }) => { boxOnly(); return stepOf("pair", caller); },
    });

    /**
     * Adding a second device or a server, or pointing this device at one, the "Vyre anywhere"
     * decision (28 Sep 2026): the relay never matters for Solo, only once something
     * joins. One tool, an action per step, the same shape as onboard.pair/claude/name so
     * launch's onboarding cards need one import and one error-shape for every screen. Reads the
     * the pair step through the function above (no self-call);
     * relay and reachability go through ctx.call, since those live in other modules.
     */
    ctx.tool("onboard.join", {
      effect: "write",
      description: "Adding a second device or a server: status says whether the relay is ready to pair with and where the pair step stands; relay mints a QR/link pairing code; verify checks a device or node is reachable now (link.health) and, when becomeDevice is true, flips this machine to \"device\" once reachability is confirmed (per ADR 0039 section 5; never on the Solo/server side accepting a join). The owner's alone: a guest, an agent (its own node, its thread, or an mcp/harness claim) and hook/anonymous callers are refused outright, whatever proof they carry, the same as relay.pair.start already refuses them.",
      input: obj({ action: { type: "string", enum: ["status", "relay", "verify"] }, node: { type: "string" }, becomeDevice: { type: "boolean" } }),
      callers: ["cli", "local", "deck", "capsule"],
      presence: { when: i => i && i.action === "relay", summary: async () => "Pair a new device with this box" },
      run: async ({ action = "status", node, becomeDevice = false }, meta) => {
        const { caller } = meta;
        joinOwnerOnly(caller, meta, "adding a device or a server");
        if (action === "relay") return call("relay.pair.start");
        if (action === "verify") {
          const health = await call("link.health", node ? { node } : {});
          if (becomeDevice && health.online) await tryCall("onboard.machine", { machine: "device" });
          return health;
        }
        const relay = await tryCall("relay.status");
        return {
          pair: await stepOf("pair", caller),
          relay: relay.__error ? { available: false, why: relay.__error } : { available: true, enabled: relay.enabled, connected: relay.connected, pairing: relay.pairing },
        };
      },
    });

    ctx.tool("onboard.history", {
      effect: "write", callers: ONBOARD_CALLERS,
      description: "Find and index this machine's Claude Code sessions, in the background.",
      presence: { when: i => (i && i.action) === "start", summary: async () => "Import your Claude sessions" },
      input: obj({ action: { type: "string", enum: ["status", "start"] } }),
      run: async ({ action = "status" }, { caller, ...meta }) => {
        boxOnly();
        ownerWrite(caller, meta, "importing your Claude sessions", await isOwned(), action === "start");
        if (action === "start") personOnly(caller);
        if (action === "start" && !indexing) {
          save({ onboard: { history: true } });
          indexing = call("recall.index").catch(e => ctx.log("onboard: indexing failed: " + e.message)).finally(() => { indexing = null; });
        }
        return stepOf("history", caller);
      },
    });

    ctx.tool("onboard.skip", {
      effect: "write", callers: ONBOARD_CALLERS,
      description: "Skip a step for now; it can be finished later from Settings.",
      input: obj({ step: { type: "string", enum: STEPS } }, ["step"]),
      run: async ({ step }, { caller }) => {
        boxOnly();
        personOnly(caller);
        save({ onboard: { skipped: [...new Set([...skipped(), step])] } });
        return status(caller);
      },
    });

    /** The credentials the assistant runs on: the Claude step's Vault items, or none (the machine's own Claude Code sign-in). */
    const assistantAuth = () => {
      const auth = ob().claude;
      return !auth ? {} : auth === "api-key" ? { fallback: VAULT_ITEM["api-key"] } : { vault: VAULT_ITEM.subscription, fallback: VAULT_ITEM["api-key"] };
    };

    /**
     * The assistant's row (spec section 10), made once, on every project, the moment the person has named it (onboard.you) and for as long as it
     * is missing: at that step, at the Claude step, at finish, on every start and on a retry. The row needs no credentials to exist, so a person
     * whose Claude Code is signed in outside this wizard (nothing stored in the Vault) still has their assistant, and it takes the Vault items once the
     * Claude step stores them. Idempotent. Never throws: why it could not be made is kept (onboard.assistantState) and shown with a retry.
     * @param {{ fallbackName?: boolean }} [o] fallbackName: finishing names an unnamed assistant "Juno"
     * @returns {Promise<{ name: string|null, display: string|null, made: boolean, why: string|null }>}
     */
    async function ensureAssistant(o = {}) {
      const display = ob().assistant || (o.fallbackName ? "Juno" : null);
      if (!display) return { name: null, display: null, made: false, why: null };
      try {
        const list = await call("agents.list");
        const rows = Array.isArray(list) ? list : list.agents || [];
        let a = rows.find(x => x.kind === "assistant");
        if (!a) {
          const person = ob().person ? ` You work for ${ob().person}.` : "";
          a = await call("agents.create", { name: slug(display), kind: "assistant", projects: "*", auth: assistantAuth(),
            instructions: `Your name is ${display}.${person} You are their assistant in Vyre: you can see every project and start, drive and stop any session.` });
        } else if (ob().claude && a.auth === "ambient") {
          // Made before the Claude step stored its sign-in (agents.list says its credentials are "ambient"): it gets the Vault items now.
          a = await call("agents.update", { name: a.name, auth: assistantAuth() });
        }
        if (ob().assistantState) save({ onboard: { assistantState: null } });
        return { name: a.name, display, made: true, why: null };
      } catch (e) {
        const why = /** @type {Error} */ (e).message;
        ctx.log("onboard: the assistant was not made: " + why);
        save({ onboard: { assistantState: { state: "failed", why, at: new Date().toISOString() } } });
        return { name: null, display, made: false, why };
      }
    }

    /** The assistant, then its first greeting when there is a Claude sign-in to run it. A failure never blocks finishing. */
    async function meet() {
      if (ob().greeted) return { name: ob().greeted.agent, display: ob().assistant || null, thread: ob().greeted.thread };
      const a = await ensureAssistant({ fallbackName: true });
      if (!a.made) return { name: null, display: a.display, thread: null, why: a.why };
      if (!ob().claude) return { name: a.name, display: a.display, thread: null };
      try {
        const r = await call("agents.ask", { agent: a.name, text: GREETING, wait: false, surface: "onboard" });
        save({ onboard: { greeted: { agent: a.name, thread: r.thread } } });
        return { name: a.name, display: a.display, thread: r.thread };
      } catch (e) {
        ctx.log("onboard: the assistant's greeting was not sent: " + /** @type {Error} */ (e).message);
        return { name: a.name, display: a.display, thread: null };
      }
    }

    ctx.tool("onboard.assistant", {
      effect: "write", callers: ONBOARD_CALLERS,
      description: "Make the assistant now, if it is not made: the name given in the You step, on every project. The retry for \"your assistant was not made\". Says whether it exists and, when not, why.",
      input: obj({ retry: { type: "boolean" } }),
      run: async (_, { caller }) => {
        boxOnly();
        personOnly(caller);
        const a = await ensureAssistant({ fallbackName: Boolean(ob().finished) });
        return { ...a, state: a.made ? "made" : a.display ? "failed" : "unnamed" };
      },
    });

    // The first-passkey path is gone (0.3): a server's owner arrives by pairing with a verified identity proof, and browser passkeys come back with RC2, behind an owner's presence.
    ctx.tool("onboard.passkey", {
      effect: "write", callers: ONBOARD_CALLERS,
      description: "Not available: a server is paired to your Vyre app first. Always answers that.",
      input: obj(),
      run: async () => { boxOnly(); throw Object.assign(new Error("Pair this server to your Vyre app first."), { code: "pair_first" }); },
    });

    ctx.tool("onboard.finish", {
      effect: "write", callers: ONBOARD_CALLERS,
      description: "Finish the onboarding.",
      presence: { when: () => true, summary: async () => "Finish setting up this server" },
      input: obj(),
      run: async (_, { caller, ...meta }) => {
        boxOnly();
        ownerWrite(caller, meta, "finishing setup", await isOwned());
        personOnly(caller);
        const assistant = await meet();
        save({ onboard: { finished: new Date().toISOString() } });
        ctx.events.emit("onboard.finished", {});
        // The setup session (tailnet's relay.setup.*) stays alive through the claims, the phone's after the computer's, and
        // ends here. Absent before the setup session lands, and when none is live: neither is an error.
        await tryCall("relay.setup.end", { reason: "finished" });
        if (net().ownerSeen) await lb.close();
        const s = await status(caller);
        return { ...s, url: s.address, assistant, thread: assistant && assistant.thread, ready: "Vyre is ready." };
      },
    });

    /** The AI accounts that are signed in (a real account that has signed in, or the Claude step's stored token) and the first one's display name, if it says one. */
    async function aiAccount() {
      const l = await tryCall("sessions.accounts.list", {});
      const rows = Array.isArray(l) ? l : [];
      const live = rows.filter(a => a && !a.synthetic && !a.pending && (a.kind === "login" ? a.signed_in_at != null : true));
      const who = live.map(a => a.identity && a.identity.name).find(x => typeof x === "string" && x.trim());
      return { signedIn: live.length > 0 || Boolean(ob().claude), name: who ? String(who).trim().slice(0, 60) : null };
    }

    /**
     * The list the page, the onboarding module and `sudo vyre setup` share (#11): the ten steps with what the box sees for each, and the person's own saved
     * skips and passes. Cheap enough for the page to ask every couple of seconds.
     */
    async function setupSnapshot(caller = "local") {
      const st = await status(caller);
      const [setup, keys, devices, peers, ai] = await Promise.all([tryCall("relay.setup.status", {}), tryCall("presence.keys", {}), tryCall("relay.devices.list", {}), tryCall("link.peers", {}), aiAccount()]);
      const keyList = Array.isArray(keys) ? keys : keys && Array.isArray(keys.keys) ? keys.keys : [];
      const devList = devices && Array.isArray(devices.devices) ? devices.devices : [];
      const people = Array.isArray(peers) ? peers : [];
      const addressDone = st.detail.name.state === "done";
      const pairDone = st.detail.pair.state === "done";
      const passkey = keyList.some(k => k && k.kind === "passkey");
      const assistant = Boolean(ob().person);
      // What the box cannot ask directly is told by what came after it: a step later in the list being done means the earlier ones were passed.
      const later = addressDone || pairDone || passkey || assistant || Boolean(net().ownerSeen);
      const facts = { install: true, words: Boolean(setup && !setup.__error && setup.state === "paired") || later, address: addressDone, pair: pairDone, ai: ai.signedIn,
        phone: devList.some(d => d && d.kind !== "web"), passkey, assistant, computers: people.length > 0, history: false };
      const list = setupList(facts, { skipped: ob().setupSkipped || [], passed: ob().setupPassed || [] });
      return { ...list, name: st.name, accountName: st.accountName, address: st.address, assistant: { display: ob().assistant || null, state: ob().assistantState || null }, finished: list.finished || Boolean(ob().finished) && list.current === null };
    }

    ctx.tool("onboard.setup", {
      // Reading the step list is open to a model session (the name stays out of it); skip, unskip and pass check personOnly in the body.
      effect: "write", callers: [...ONBOARD_CALLERS, "mcp", "harness"],
      description: "The setup step list: ten steps, each done, current, skipped or todo, with the current step and whether setup is finished.",
      input: obj({ skip: { type: "string", enum: [...SKIPPABLE], description: "put this step aside to finish later; it stays listed as skipped" }, unskip: { type: "string", enum: [...SKIPPABLE], description: "take a skipped step back" }, pass: { type: "string", enum: [...PASSABLE], description: "say the person has been through this step" } }),
      run: async (input, { caller }) => {
        boxOnly();
        const i = input || {};
        if (i.skip || i.unskip || i.pass) personOnly(caller);
        const set = k => new Set(ob()[k] || []);
        if (i.skip || i.unskip) {
          const sk = set("setupSkipped");
          if (i.skip) sk.add(String(i.skip)); if (i.unskip) sk.delete(String(i.unskip));
          save({ onboard: { setupSkipped: [...sk] } });
        }
        if (i.pass) { const ps = set("setupPassed"); ps.add(String(i.pass)); save({ onboard: { setupPassed: [...ps] } }); }
        return setupSnapshot(String(caller));
      },
    });

    ctx.tool("onboard.link", {
      effect: "write", callers: ["cli", "local", "capsule"],
      description: "A one-time link to the onboarding page on this machine's loopback address. Only from this machine's own socket. With mint false it makes nothing and says whether an unused link is still open (url null, pending with its expiry), so an update never voids the link the user was sent.",
      input: obj({ mint: { type: "boolean" } }),
      run: async (input, { caller }) => {
        boxOnly(); // revisit once the Solo Deck loopback design (docs/design/anywhere.md) lands and reuses this link
        throw Object.assign(new Error("a server has no setup page: pair it from your Vyre app (the installer shows the code; or run vyre call wink.server.code)"), { code: "not_available" });
        if (!["cli", "local", "capsule"].includes(String(caller))) throw new Error("links are made only from the box's own terminal");
        const address = net().address || null;
        // Once the owner has come in over the tailnet, or onboarding is finished and the address
        // serves, the way in is the address: no more one-time links (the open one may still finish).
        if (net().ownerSeen || (ob().finished && address)) {
          return { url: null, address, port: null, expires: null, user: os.userInfo().username };
        }
        if (input && input.mint === false) {
          const p = lb.pending();
          return { url: null, address, port: p ? p.port : null, expires: p ? p.expires : null, pending: Boolean(p), user: os.userInfo().username };
        }
        return { ...(await lb.link()), address, user: os.userInfo().username };
      },
    });

    // The owner reached the box over the tailnet, so the loopback door is no longer needed.
    const off = ctx.events.on("owner.seen", () => { lb.close().catch(() => {}); });
    // An install whose assistant was named but never made (an earlier version, or a failure at finish) gets it now, once the agents module is up.
    const retry = setTimeout(() => { if (ob().assistant) ensureAssistant({ fallbackName: false }).catch(() => {}); }, 3000);
    if (typeof retry.unref === "function") retry.unref();
    // 0.3: the owner arrives by pairing and nothing names the assistant, so it is made once there is an owner and a signed-in AI account (default name Juno), and until then Now says so.
    // Checked once at start and when something it depends on changes, never on a timer: the owner is adopted or seen, an AI account is connected or disconnected (onboard.claude, or any
    // provider's sign-in, which sessions announces as account.changed).
    let checking = false, again = false;
    const ready = async () => {
      if (checking) { again = true; return; }
      checking = true;
      try { await assistantWhenReady({ tryCall, call, signedInOutside: () => Boolean(ob().claude), hasOwner: async () => Boolean(ob().person) || Boolean(await isOwned().catch(() => false)), ensure: ensureAssistant, state: () => ob().assistantState,
        setState: s => save({ onboard: { assistantState: s } }) }); }
      catch (e) { ctx.log("onboard: the assistant check failed: " + /** @type {Error} */ (e).message); }
      finally { checking = false; if (again) { again = false; void ready(); } }
    };
    const readyFirst = setTimeout(() => { void ready(); }, 3000);
    if (typeof readyFirst.unref === "function") readyFirst.unref();
    const offReady = ["owner.adopted", "owner.seen", "owner.changed", "onboard.claude-changed", "account.changed"].map(type => ctx.events.on(type, () => { void ready(); }));
    return { async stop() { clearTimeout(readyFirst); for (const o of offReady) if (typeof o === "function") o(); clearTimeout(retry); if (typeof off === "function") off(); for (const o of offLink) if (typeof o === "function") o(); signin.stop(); await lb.close({ forget: false }); await indexing; } };
  },
};
