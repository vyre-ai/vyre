// @ts-check
// onboard — the six steps of spec section 1, as tools the Deck's first screen calls.
//
// Each step is worked out fresh from what is true on the machine (is claude installed, is
// Tailscale running, is the name serving), plus the few choices the person made, which live in
// config.json under "onboard". The steps call other modules' tools (names.*, vault.put,
// recall.*, projects.*) and work without them: a missing module blocks its step and says why.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import * as config from "../config/index.js";
import { loopback } from "./loopback.js";
import { setupToken } from "./setup-token.js";
import { checkName } from "../names/service.js";
import { run as tailscale, lockStatus, up as tailscaleUp } from "../names/tailscale.js";

export const STEPS = ["you", "claude", "tailscale", "name", "history", "devices"];
/** names phases, in order; the page shows them as reserve, dns and cert rows. */
const PHASES = ["idle", "dns", "certificate", "serving"];
const ROWS = ["reserve", "dns", "cert"];
const TS_ADMIN = "https://login.tailscale.com/admin/dns";
const HTTPS_OFF = /https (certificates?|is|are)\b|certificates? (are|is) (not enabled|off|disabled)|tls cert/i;
const MAC_DOWNLOAD = "https://vyre.run/download/mac";
const CLAUDE_INSTALL = "npm install -g @anthropic-ai/claude-code";
// Prefixes only; a real value never appears in code, logs or events.
const PREFIX = { subscription: "sk-ant-oat", "api-key": "sk-ant-api" };
const VAULT_ITEM = { subscription: "claude-setup-token", "api-key": "anthropic-api-key" };
const VAULT_KIND = { subscription: "secret", "api-key": "api-key" };
const VAULT_ABOUT = { subscription: "Claude subscription token from `claude setup-token`, for headless sessions", "api-key": "Anthropic API key, for headless sessions" };
// The switchboard's agents module starts the headless sessions and hands them this credential.
// agents for their own threads; threads for every other session Vyre starts (ADR 0030).
const CREDENTIAL_READERS = ["agents", "threads"];
// Who may be handed a passkey code: the loopback onboarding session and the box's own terminal.
// Never a tailnet caller, which a model on the owner's Mac is too.
const HANDS_CODE = new Set(["onboard", "cli", "local"]);
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
// onboard.join hands out a Tailscale sign-in link and a relay pairing secret: the owner's alone,
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
/**
 * The commands the Tailnet Lock card shows. The person runs them on their Mac; Vyre never runs
 * `lock init` or `lock sign`. The init line names the Mac's key (which only the Mac can show) and
 * this box's, and asks for disablement secrets: two for the person, one for Tailscale support.
 */
export function lockCommands(boxKey) {
  return { mac: "tailscale lock", init: `tailscale lock init --gen-disablements 2 --gen-disablement-for-support <mac key> ${boxKey || "<box key>"}` };
}

/** An agent's name from a display name: "Juno Two" becomes "juno-two". */
export const slug = s => {
  const v = String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 31).replace(/-+$/, "");
  return v.length >= 2 ? v : "assistant";
};

const obj = (properties = {}, required = []) => ({ type: "object", properties, required });

/** `claude --version`, remembered for half a minute: the page asks every couple of seconds. */
let known = { at: 0, version: /** @type {Promise<string|null>|null} */ (null) };
function claudeVersion() {
  if (known.version && Date.now() - known.at < 30_000) return known.version;
  known = { at: Date.now(), version: new Promise(resolve => execFile(process.env.VYRE_CLAUDE_BIN || "claude", ["--version"], { timeout: 10_000 },
    (e, out) => resolve(e ? null : String(out).trim().split("\n")[0] || "unknown"))) };
  return known.version;
}

/**
 * The owner's other devices on the tailnet, from `tailscale status --json`: name, os and whether
 * Tailscale says it is online. Tagged nodes (servers) and other people's shared nodes are left out.
 * Remembered for 15 seconds: onboard.status is asked often while a step waits.
 */
let seen = { at: 0, peers: /** @type {Promise<any[]>|null} */ (null) };
function tailnetPeers() {
  if (seen.peers && Date.now() - seen.at < 15_000) return seen.peers;
  seen = { at: Date.now(), peers: tailscale(["status", "--json"], { timeout: 5000 }).then(r => {
    if (r.code !== 0) return [];
    try { return parsePeers(JSON.parse(r.out)); } catch { return []; }
  }) };
  return seen.peers;
}
/** Pure, for tests. */
export function parsePeers(s) {
  const self = s && s.Self;
  const mine = self && !(self.Tags || []).length ? String(self.UserID) : null;
  return Object.values((s && s.Peer) || {})
    .filter(p => !(p.Tags || []).length && (!mine || String(p.UserID) === mine))
    .map(p => ({ name: String(p.HostName || "") || String(p.DNSName || "").split(".")[0], dns: String(p.DNSName || "").replace(/\.$/, ""),
      os: String(p.OS || ""), online: Boolean(p.Online), lastSeen: p.LastSeen && !String(p.LastSeen).startsWith("0001") ? String(p.LastSeen) : null }));
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const save = patch => config.save(patch, ctx.paths.root, ctx.config);
    const ob = () => ctx.config.onboard || {};
    const skipped = () => new Set(ob().skipped || []);
    const net = () => ctx.config.network || {};
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
    if (config.isServer(ctx.config.machine) && !net().ownerSeen) await lb.resume().catch(e => ctx.log(`onboard: the kept link did not reopen: ${e.message}`));
    else keep.save(null);
    let claimUrl = null;
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
    // (a public address, Tailscale, an owner-claim flow) it must not run on a machine that isn't
    // one. Reviewer's condition, 28 Sep: refuse up front, through this one guard, on every wizard
    // tool but the two that are meant to work on Solo (onboard.status, which only reads, and
    // onboard.machine, which is how a Solo machine becomes a server in the first place).
    const boxOnly = () => { if (!config.isServer(ctx.config.machine)) throw Object.assign(new Error("this step is part of the box's onboarding wizard, not available on this machine"), { code: "not_a_server" }); };

    async function status(caller = "local") {
      const [version, names, recall] = await Promise.all([claudeVersion(), tryCall("names.status"), tryCall("recall.status")]);
      const n = names.__error ? null : names;
      const t = n && n.tailscale;

      const you = { state: ob().person ? "done" : "todo", why: null, person: ob().person || null, name: ctx.config.name || null, assistant: ob().assistant || null };

      const auth = ob().claude || null;
      const claude = { state: "todo", why: null, installed: Boolean(version), version, install: version ? null : CLAUDE_INSTALL, auth,
        signedIn: Boolean(auth), via: auth === "api-key" ? "api-key" : auth ? "setup-token" : null };
      if (claude.auth) claude.state = "done";
      else if (!version) Object.assign(claude, { state: "blocked", why: "Claude Code is not installed on this machine" });

      const tailscale = { state: "todo", why: null, installed: false, install: null, backend: null, loginUrl: null,
        operator: { ok: true, fix: null }, node: null, owner: net().owner || null, claimUrl: null };
      if (!t) Object.assign(tailscale, { state: "blocked", why: names.__error || "Tailscale status is unavailable" });
      else {
        Object.assign(tailscale, { installed: t.installed, install: t.install, backend: t.backend, loginUrl: t.loginUrl,
          operator: t.operator || tailscale.operator,
          node: t.node && { name: t.node.name, dnsName: t.node.dnsName, ips: t.node.ips, dns: t.node.dnsName, ip: (t.node.ips || []).find(a => a.includes(".")) || null } });
        if (!t.installed) Object.assign(tailscale, { state: "blocked", why: "Tailscale is not installed" });
        else if (!tailscale.operator.ok) Object.assign(tailscale, { state: "blocked", why: "Vyre may not sign this machine in to Tailscale yet" });
        else if (t.running && !t.tun) Object.assign(tailscale, { state: "blocked", why: "Tailscale runs in userspace networking mode; Vyre needs its network interface" });
        else if (t.running) tailscale.state = "done";
        else if (t.loginUrl) Object.assign(tailscale, { state: "working", why: "waiting for you to sign in" });
      }
      // A tagged node has no person behind it: the owner is whoever opens the claim link first.
      if (t && t.running && t.node && t.node.tagged && !net().owner && n && n.listening && n.address) {
        if (!claimUrl) { const c = await tryCall("names.claim-code"); if (!c.__error) claimUrl = n.address + c.path; }
        tailscale.claimUrl = claimUrl;
      }

      const address = { state: "todo", why: null, code: null, adminUrl: null, name: ctx.config.name || null, address: n ? n.address : null, via: via(n),
        phase: n ? n.phase : "idle", certificate: n ? n.certificate : null };
      if (!n) Object.assign(address, { state: "blocked", why: names.__error });
      else if (n.phase === "serving") address.state = "done";
      else if (n.phase === "dns" || n.phase === "certificate") address.state = "working";
      else if (n.phase === "failed" && address.via === "ts.net" && HTTPS_OFF.test(n.why || "")) Object.assign(address, { state: "blocked",
        why: "HTTPS certificates are turned off in your tailnet, so this machine cannot get one for its ts.net name.", code: "https_off", adminUrl: TS_ADMIN });
      else if (n.phase === "failed") Object.assign(address, { state: "blocked", why: n.why });
      else if (tailscale.state !== "done") Object.assign(address, { state: "blocked", why: "connect Tailscale first" });

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
      // peers: the owner's other tailnet devices and whether each is online, for the phone's line.
      const tailnet = t && t.running ? await tailnetPeers() : [];
      const devices = { state: ob().finished ? "done" : "todo", why: null, phoneUrl: n && n.phase === "serving" ? n.address : null, macDownload: MAC_DOWNLOAD, mac, peers: tailnet };

      // detail: each step's full state (todo, working, blocked, done, skipped) and what it needs.
      // steps: the page's view of it, todo, done or skipped.
      const detail = { you: mark("you", you), claude: mark("claude", claude), tailscale: mark("tailscale", tailscale),
        name: mark("name", address), history: mark("history", history), devices: mark("devices", devices) };
      for (const k of STEPS) {
        if (lastStates[k] && lastStates[k] !== detail[k].state) ctx.events.emit("onboard.stepped", { step: k, state: detail[k].state });
      }
      lastStates = Object.fromEntries(STEPS.map(k => [k, detail[k].state]));
      const steps = Object.fromEntries(STEPS.map(k => [k, ["done", "skipped"].includes(detail[k].state) ? detail[k].state : "todo"]));
      const current = STEPS.find(k => steps[k] === "todo") || null;
      const mode = caller === "onboard" ? "loopback" : String(caller).startsWith("tailnet:") ? "tailnet" : "local";
      // can: what this machine is actually able to do, for launch's cards to gate on rather than
      // guess from role/machine. relayJoin is false on darwin until vyre-core exists (see
      // RELAY_JOIN_DARWIN_REASON above); every other platform can already join a relay today.
      const can = canRelayJoin(process.platform);
      return { mode, role: ctx.config.role, machine: ctx.config.machine, platform: process.platform, can,
        owner: net().owner || null, address: n && n.phase === "serving" ? n.address : null,
        host: (t && t.node && t.node.name) || os.hostname(), name: ctx.config.name || null, person: ob().person || null, assistant: ob().assistant || null,
        // arrived: the owner has reached the address over the tailnet (the page's Switch), so the
        // loopback page is done with and `vyre box add` may close its tunnel.
        current, finished: Boolean(ob().finished), arrived: Boolean(net().ownerSeen), steps, detail };
    }

    /** How the name step serves: what it already uses, else a vyre.run claim when a zone token or own domain is here, else ts.net. */
    function via(n) {
      const d = Boolean(net().domain);
      if (n && n.via === "vyre.run") return d ? "domain" : "vyre.run";
      // A persisted "ts.net" is trusted only once the box is actually serving under it. Before
      // that (blocked, failed, or a fallback attempt never finished), it was only ever the
      // fallback default at the time, not a commitment — so a zone token that appears afterward
      // (e2e review, 28 Sep: fallback() can throw before it ever saves this, but a later success
      // does persist it, and nothing re-checked after that) is offered again rather than the
      // person being stuck retrying a blocked ts.net forever.
      if (n && n.via === "ts.net" && (n.phase === "serving" || n.address)) return "ts.net";
      return d ? "domain" : n && n.zone ? "vyre.run" : "ts.net";
    }

    const stepOf = async (k, caller) => (await status(caller)).detail[k];
    /** The address step as progress rows (reserve, dns, cert), and its url once it serves. */
    const progress = s => {
      if (s.phase !== "failed") lastPhase = s.phase;
      const failed = s.phase === "failed", i = Math.min(PHASES.indexOf(failed ? lastPhase : s.phase), failed ? 2 : 3);
      const steps = ROWS.map((id, j) => ({ id, state: j < i ? "done" : j > i ? "todo" : failed ? "failed" : i === 0 ? "todo" : "doing", note: failed && j === i ? s.why : null }));
      return { ...s, steps, url: s.phase === "serving" ? s.address : null };
    };
    /** Tailscale as the page reads it: state is off, needs-login, connected or blocked (with why and operator.fix); the step's own state is `step`. */
    const link = s => ({ ...s, step: s.state, state: s.state === "done" ? "connected" : s.state === "blocked" ? "blocked" : s.loginUrl ? "needs-login" : "off" });

    /**
     * One merged tailnet policy snippet instead of one per feature (see docs/design/tailscale-plan.md,
     * "Simplest install"). Always covers SSH (vyre box add needs it) and Taildrive/Taildrop (on by
     * default). Adds egress's tagOwners/grant only while computers.egress is turned on. Real names
     * where this machine already knows them (its own tailnet node, the paired Mac, the owner's
     * login); a bracketed placeholder where it does not, same as docs/adr/0014-tailnet.md's sample.
     * Read-only: never touches the tailnet itself (ADR 0014 rule 1).
     */
    async function policy(caller) {
      const s = await stepOf("tailscale", caller);
      if (s.state !== "connected" && s.state !== "done") return { ready: false, why: "connect Tailscale first", policy: null, notes: [] };
      const node = s.node || {};
      const boxHost = node.dns ? node.dns.split(".")[0] : node.name || "[this server's name]";
      const owner = net().owner || "[your Tailscale login]";
      const peers = await tryCall("link.peers");
      const mac = Array.isArray(peers) && peers[0] && (peers[0].name || peers[0].node) || "[your Mac's name]";
      const drive = await tryCall("files.drive.status");
      const shares = !drive.__error && Array.isArray(drive.shares) ? drive.shares.map(x => x.name) : ["projects", "glass-files"];

      const policyOut = {
        hosts: { [boxHost]: node.ip || "[this server's tailnet IP]" },
        nodeAttrs: [
          { target: [boxHost], attr: ["drive:share"] },
          { target: [owner], attr: ["drive:access"] },
        ],
        grants: [
          { src: [mac], dst: [boxHost], app: { "tailscale.com/cap/drive": [{ shares, access: "ro" }] } },
          // Owner-only (reviewer HOLD, 28 Sep): autogroup:member would let anyone sharing or
          // family-sharing into this tailnet drop a file onto the box, where an agent may read it.
          { src: [owner], dst: [boxHost], app: { "https://tailscale.com/cap/file-sharing-target": [{}] } },
        ],
        // check, not accept (reviewer HOLD, 28 Sep): accept would let any of the owner's own
        // devices — a phone included — SSH straight in with no fresh sign-in, as whatever unix
        // account "users" names. users names the account `vyre box add` actually uses (their own
        // admin login on that server, with sudo), never the vyre daemon account or an agent's.
        ssh: [{ action: "check", src: [owner], dst: [boxHost], users: ["[the admin account you set up this server with]"] }],
      };
      const notes = [
        "Add hosts." + boxHost + " once (its tailnet IP may change less often than you'd think, but check `tailscale status` if this stops working).",
        "The Taildrive grant's src names your Mac by its own node, not your whole account, so your phone does not also get the server's folders.",
        "For read-write Taildrive, change that grant's \"access\" to \"rw\", then run files.drive.access to match.",
        "The SSH rule's \"users\" is the unix account on the server itself, not a Tailscale login. Put the admin account you set it up with (never a service account like vyre or vyre-agent); \"check\" asks for a fresh sign-in each time rather than trusting the device forever.",
      ];
      const egress = await tryCall("computers.egress.status");
      if (!egress.__error && egress.enabled) {
        policyOut.tagOwners = { "tag:vyre-egress": [owner] };
        policyOut.grants.push({ src: ["tag:vyre-egress"], dst: ["autogroup:internet"], ip: ["*"] });
        notes.push("Egress is on: tag:vyre-egress needs its own OAuth client or reusable ephemeral pre-authorized key, made separately in the admin console (Keys).");
      }
      return { ready: true, why: null, policy: policyOut, notes };
    }

    ctx.tool("onboard.status", {
      description: "Where the onboarding stands: every step's state and what it needs.",
      input: obj(),
      run: async (_, { caller }) => status(caller),
    });

    ctx.tool("onboard.you", {
      description: "Step 1: your name as you like it shown, and your assistant's name. A name that is also a valid vyre.run name becomes the default candidate.",
      input: obj({ name: { type: "string" }, assistant: { type: "string" } }, ["name"]),
      run: async ({ name, assistant }, { caller }) => {
        boxOnly();
        const p = String(name ?? "").trim(), a = String(assistant ?? "").trim();
        if (!p || p.length > 60 || /[\u0000-\u001f]/.test(p)) throw new Error("your name is one line of up to 60 characters");
        if (a.length > 40 || /[\u0000-\u001f]/.test(a)) throw new Error("the assistant's name is one line of up to 40 characters");
        const c = checkName(p);
        // Continue is the person confirming this name, so it replaces any earlier candidate, unless
        // an address already serves under the old one.
        save({ ...(c.valid && !net().address ? { name: c.name } : {}), onboard: { person: p, ...(a ? { assistant: a } : {}) } });
        return stepOf("you", caller);
      },
    });

    ctx.tool("onboard.machine", {
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
          if (!["module:onboard", "module:relay"].includes(raw)) throw Object.assign(new Error("device is set once a connection to another server is confirmed, not chosen directly"), { code: "denied" });
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
      description: "Checks <name>.vyre.run and saves it; reserve serves this machine at its address (DNS and certificate, as progress rows): the vyre.run name with a zone token or own domain, else the ts.net name. `via` says which; again retries.",
      input: obj({ name: { type: "string" }, action: { type: "string", enum: ["check", "reserve", "claim", "status", "ts.net"] }, confirm: { type: "boolean" } }),
      run: async ({ name, action = "check", confirm }, { caller }) => {
        boxOnly();
        if (action === "check") {
          if (!name) throw new Error("name is required to check");
          // No zone token and no own domain: the address is this machine's ts.net name, so there
          // is nothing on vyre.run to check and every valid name is free.
          const n = await tryCall("names.status");
          if (!n.__error && via(n) === "ts.net") {
            // A check only answers. It saves nothing: a name typed in step 1 and then skipped must
            // not become the address (step 4 claims only a name the person confirmed).
            const v = checkName(name), dns = n.tailscale && n.tailscale.node && n.tailscale.node.dnsName;
            return { name: v.name, valid: v.valid, available: v.valid, why: v.why, via: "ts.net", address: dns ? `https://${String(dns).replace(/\.$/, "")}` : null };
          }
          return call("names.check", { name });
        }
        if (action === "reserve" && via(await call("names.status")) === "ts.net") action = "ts.net";
        if (action === "reserve" || action === "claim") {
          // A vyre.run name is public DNS. It is claimed only when the person typed it and pressed
          // Continue in step 1 (onboard.you saved it), or confirmed it here with confirm: true.
          const want = checkName(name || ctx.config.name || "");
          if (!want.valid) throw Object.assign(new Error("pick a name first, or use this machine's tailnet name"), { code: "confirm_name" });
          if (confirm === true) save({ name: want.name });
          else if (!(ob().person && ctx.config.name === want.name)) {
            throw Object.assign(new Error(`${want.name}.vyre.run is a public name: confirm it first, or use this machine's tailnet name`), { code: "confirm_name" });
          }
        }
        if (action !== "status") await call(action === "ts.net" ? "names.fallback" : "names.claim", action !== "ts.net" && name ? { name } : {});
        return progress(await stepOf("name", caller));
      },
    });

    ctx.tool("onboard.claude", {
      description: "Store Claude Code's sign-in in the Vault: a subscription setup token or an API key. The value is never returned. setup-token alone starts `claude setup-token` and returns its sign-in url; setup-token with the code the page showed finishes it.",
      input: obj({ mode: { type: "string", enum: ["detect", "setup-token", "api-key"] }, key: { type: "string" }, code: { type: "string" },
        kind: { type: "string", enum: ["subscription", "api-key"] }, token: { type: "string" } }),
      run: async ({ mode, key, code, kind, token }, { caller }) => {
        boxOnly();
        if (mode === "setup-token" && !key && !token) {
          if (!code) return { ...(await stepOf("claude", caller)), url: await signin.start(), needsCode: true };
          [kind, token] = ["subscription", await signin.finish(code)];
        }
        kind ||= mode === "api-key" ? "api-key" : mode === "setup-token" ? "subscription" : undefined;
        token ??= key;
        if (kind) {
          const t = String(token || "").trim();
          if (!t.startsWith(PREFIX[kind]) || t.length < 40 || /\s/.test(t)) {
            throw new Error(kind === "subscription" ? "that does not look like a token from `claude setup-token`" : "that does not look like an Anthropic API key");
          }
          await call("vault.put", { name: VAULT_ITEM[kind], kind: VAULT_KIND[kind], description: VAULT_ABOUT[kind], value: t, grants: CREDENTIAL_READERS });
          save({ onboard: { claude: kind } });
        }
        return { ...(await stepOf("claude", caller)), url: null, needsCode: signin.active() };
      },
    });

    ctx.tool("onboard.tailscale", {
      description: "Tailscale on this machine; connect starts `tailscale up` and returns its sign-in link. lock reads Tailnet Lock (read-only): whether it is on, this box's lock key, how many keys are trusted, whether this box is signed, and the commands the person runs on their Mac to turn it on. policy merges the tailnet policy JSON for whatever is turned on today (Taildrive, Taildrop, SSH, and egress if it is on) into one snippet to paste, instead of one per feature.",
      input: obj({ action: { type: "string", enum: ["status", "detect", "poll", "connect", "lock", "policy"] } }),
      run: async ({ action = "status" }, { caller }) => {
        boxOnly();
        if (action === "lock") {
          const l = await lockStatus();
          return { ...l, key: l.nodeKey, commands: lockCommands(l.nodeKey) };
        }
        if (action === "connect") {
          const s = await stepOf("tailscale", caller);
          if (s.state === "done" || !s.installed || !s.operator.ok) return link(s);
          const r = await call("names.connect");
          const after = await stepOf("tailscale", caller);
          return link({ ...after, loginUrl: after.loginUrl || r.loginUrl || null });
        }
        if (action === "policy") return policy(caller);
        return link(await stepOf("tailscale", caller));
      },
    });

    /**
     * Adding a second device or a server, or pointing this device at one — the "Vyre anywhere"
     * decision (28 Sep 2026): Tailscale and the relay never matter for Solo, only once something
     * joins. One tool, an action per step, the same shape as onboard.tailscale/claude/name so
     * launch's onboarding cards need one import and one error-shape for every screen. Reads the
     * tailscale step's own status/connect/policy/lock through the functions above (no self-call);
     * relay and reachability go through ctx.call, since those live in other modules.
     */
    ctx.tool("onboard.join", {
      description: "Adding a second device or a server: status says whether Tailscale or the relay is ready to pair with; tailscale (step: status|connect|policy|lock) is onboard.tailscale's own logic, callable any time; relay mints a QR/link pairing code; verify checks a device or node is reachable now (link.health) and, when becomeDevice is true, flips this machine to \"device\" once reachability is confirmed (per ADR 0039 section 5; never on the Solo/server side accepting a join). The owner's alone: a guest, an agent (its own node, its thread, or an mcp/harness claim) and hook/anonymous callers are refused outright, whatever proof they carry, the same as relay.pair.start already refuses them.",
      input: obj({ action: { type: "string", enum: ["status", "tailscale", "relay", "verify"] }, step: { type: "string", enum: ["status", "connect", "policy", "lock"] }, node: { type: "string" }, becomeDevice: { type: "boolean" } }),
      callers: ["cli", "local", "deck", "capsule"],
      presence: { when: i => i && (i.action === "relay" || (i.action === "tailscale" && i.step === "connect")),
        summary: async i => i && i.action === "relay" ? "Pair a new device with this box, without Tailscale" : "Connect this box to your Tailscale network" },
      run: async ({ action = "status", step = "status", node, becomeDevice = false }, meta) => {
        const { caller } = meta;
        joinOwnerOnly(caller, meta, "adding a device or a server");
        if (action === "tailscale") {
          if (step === "lock") { const l = await lockStatus(); return { ...l, key: l.nodeKey, commands: lockCommands(l.nodeKey) }; }
          if (step === "connect") {
            const s = await stepOf("tailscale", caller);
            if (s.state === "done" || !s.installed || !s.operator.ok) return link(s);
            // tailscaleUp() directly, not ctx.call("names.connect"): the names module (the box's
            // own TLS listener/cert claiming) is box-role only, but starting Tailscale itself is
            // not — a Solo Mac joining someone else's tailnet needs this same step. up() is the
            // plain function names.connect already forwards to, so onboard.tailscale (the
            // box-only tool) keeps calling names.connect unchanged.
            const r = await tailscaleUp();
            const after = await stepOf("tailscale", caller);
            return link({ ...after, loginUrl: after.loginUrl || r.loginUrl || null });
          }
          if (step === "policy") return policy(caller);
          return link(await stepOf("tailscale", caller));
        }
        if (action === "relay") return call("relay.pair.start");
        if (action === "verify") {
          const health = await call("link.health", node ? { node } : {});
          if (becomeDevice && health.online) await tryCall("onboard.machine", { machine: "device" });
          return health;
        }
        const relay = await tryCall("relay.status");
        return {
          tailscale: link(await stepOf("tailscale", caller)),
          relay: relay.__error ? { available: false, why: relay.__error } : { available: true, enabled: relay.enabled, connected: relay.connected, pairing: relay.pairing },
        };
      },
    });

    ctx.tool("onboard.history", {
      description: "Find and index this machine's Claude Code sessions, in the background.",
      input: obj({ action: { type: "string", enum: ["status", "start"] } }),
      run: async ({ action = "status" }, { caller }) => {
        boxOnly();
        if (action === "start" && !indexing) {
          save({ onboard: { history: true } });
          indexing = call("recall.index").catch(e => ctx.log("onboard: indexing failed: " + e.message)).finally(() => { indexing = null; });
        }
        return stepOf("history", caller);
      },
    });

    ctx.tool("onboard.skip", {
      description: "Skip a step for now; it can be finished later from Settings.",
      input: obj({ step: { type: "string", enum: STEPS } }, ["step"]),
      run: async ({ step }, { caller }) => {
        boxOnly();
        save({ onboard: { skipped: [...new Set([...skipped(), step])] } });
        return status(caller);
      },
    });

    /**
     * The assistant (spec section 10): made once, on every project, signed in with what the Claude
     * step put in the Vault, and greeting the person in its first thread. Without a Claude sign-in
     * there is nothing to run it on yet, so it waits for Settings; a failure never blocks finishing.
     */
    async function meet() {
      const auth = ob().claude;
      if (!auth) return null;
      if (ob().greeted) return { name: ob().greeted.agent, display: ob().assistant || null, thread: ob().greeted.thread };
      try {
        const display = ob().assistant || "Juno";
        const list = await call("agents.list");
        let a = (Array.isArray(list) ? list : list.agents || []).find(x => x.kind === "assistant");
        if (!a) {
          const name = slug(display);
          const person = ob().person ? ` You work for ${ob().person}.` : "";
          a = await call("agents.create", { name, kind: "assistant", projects: "*",
            // agents reads auth.vault as a subscription token and auth.fallback as an API key.
            auth: auth === "api-key" ? { fallback: VAULT_ITEM["api-key"] } : { vault: VAULT_ITEM.subscription, fallback: VAULT_ITEM["api-key"] },
            instructions: `Your name is ${display}.${person} You are their assistant in Vyre: you can see every project and start, drive and stop any session.` });
        }
        const r = await call("agents.ask", { agent: a.name, text: GREETING, wait: false, surface: "onboard" });
        save({ onboard: { greeted: { agent: a.name, thread: r.thread } } });
        return { name: a.name, display, thread: r.thread };
      } catch (e) {
        ctx.log("onboard: the assistant was not made: " + /** @type {Error} */ (e).message);
        return { name: null, display: ob().assistant || null, thread: null, why: /** @type {Error} */ (e).message };
      }
    }

    /**
     * The first passkey is made at the box's own address (a passkey made on the loopback page
     * would belong to 127.0.0.1). While none exists, presence mints a one-time code, which rides
     * in the fragment to the page that enrolls it; the code proves presence.enroll and nothing else.
     */
    async function passkeyUrl(address) {
      const keys = await tryCall("presence.keys");
      if (keys.__error) return null;
      const list = Array.isArray(keys) ? keys : keys.keys || [];
      if (list.some(k => k.kind === "passkey")) return null;
      const c = await tryCall("presence.code");
      return c.__error || !c.code ? null : `${String(address).replace(/\/$/, "")}/onboard/passkey#e=${encodeURIComponent(c.code)}`;
    }

    ctx.tool("onboard.passkey", {
      description: "A one-time link to make the first passkey at this box's address, while none exists. Only to the loopback session or the box's terminal.",
      input: obj(),
      run: async (_, { caller }) => {
        boxOnly();
        const address = (await status(caller)).address || net().address || null;
        return { address, passkeyUrl: address && HANDS_CODE.has(String(caller)) ? await passkeyUrl(address) : null };
      },
    });

    ctx.tool("onboard.finish", {
      description: "Finish the onboarding.",
      input: obj(),
      run: async (_, { caller }) => {
        boxOnly();
        const assistant = await meet();
        save({ onboard: { finished: new Date().toISOString() } });
        ctx.events.emit("onboard.finished", {});
        if (net().ownerSeen) await lb.close();
        const s = await status(caller);
        return { ...s, url: s.address, passkeyUrl: HANDS_CODE.has(String(caller)) && (s.address || net().address) ? await passkeyUrl(s.address || net().address) : null, assistant, thread: assistant && assistant.thread, ready: "Vyre is ready." };
      },
    });

    ctx.tool("onboard.link", {
      description: "A one-time link to the onboarding page on this machine's loopback address. Only from this machine's own socket. With mint false it makes nothing and says whether an unused link is still open (url null, pending with its expiry), so an update never voids the link the user was sent.",
      input: obj({ mint: { type: "boolean" } }),
      run: async (input, { caller }) => {
        boxOnly(); // revisit once the Solo Deck loopback design (docs/design/anywhere.md) lands and reuses this link
        if (!["cli", "local", "capsule"].includes(String(caller))) throw new Error("links are made only from the box's own terminal");
        const address = net().address || null;
        // Once the owner has come in over the tailnet, or onboarding is finished and the address
        // serves, the way in is the address: no more one-time links (the open one may still finish).
        if (net().ownerSeen || (ob().finished && address)) {
          // A passkey link is a one-time code too: mint false makes none.
          const mint = !(input && input.mint === false);
          return { url: null, address, passkeyUrl: mint && address && HANDS_CODE.has(String(caller)) ? await passkeyUrl(address) : null, port: null, expires: null, user: os.userInfo().username };
        }
        if (input && input.mint === false) {
          const p = lb.pending();
          return { url: null, address, passkeyUrl: null, port: p ? p.port : null, expires: p ? p.expires : null, pending: Boolean(p), user: os.userInfo().username };
        }
        return { ...(await lb.link()), address, user: os.userInfo().username };
      },
    });

    // The owner reached the box over the tailnet, so the loopback door is no longer needed.
    const off = ctx.events.on("owner.seen", () => { lb.close().catch(() => {}); });
    return { async stop() { if (typeof off === "function") off(); for (const o of offLink) if (typeof o === "function") o(); signin.stop(); await lb.close({ forget: false }); await indexing; } };
  },
};
