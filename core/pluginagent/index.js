// @ts-check
// pluginagent: "Claude Code on <this computer>" is an agent like any other, granted ONCE (the lead's ruling, 4 Oct). The plugin's MCP server asks the first time it runs here (`pluginagent.ask`, a
// plain model call that only files a request). The person approves it from a surface of theirs, with presence (`pluginagent.grant`): vyred registers the agent (agents.create, personal, every project),
// makes it an actor of the Space (the kernel act the presence proof covers) and writes its key to a file only this OS user can read. From then on the MCP server names that agent and sends the key; the
// daemon (core/daemon route) checks it with `pluginagent.vouch`, binds the call to the agent and stamps the agent's kernel token itself. It is never the person: it cannot approve or prove presence, and
// it holds only what the grant names: memory and recall reads, the sessions of the person's projects, and memory.remember (a pending suggestion). Every other tool, read or write, is refused for it
// with `not_in_grant`, decided HERE (`pluginagent.allows`, asked by the daemon's route for every call and every tool listing), never tool by tool. `pluginagent.revoke` ends it. A decline or a revoke
// means no until the person turns it back on (`pluginagent.on`, from Access); an ask nobody answers expires after 24 h and the next one waits 7 days. The key is never kept here, only its hash.
import { grantReach } from "../../lib/project-reach.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deviceLabel } from "../modules/index.js";
import { isNotSoftware } from "../presence/strengths.js";
import { newPrefixedId } from "../../lib/id.js";

export const MIGRATIONS = [
  `CREATE TABLE pluginagent_asks (id TEXT PRIMARY KEY, computer TEXT NOT NULL, asked_at INTEGER NOT NULL, state TEXT NOT NULL);
   CREATE TABLE pluginagent_agents (agent TEXT PRIMARY KEY, computer TEXT NOT NULL, key_hash TEXT NOT NULL, created_at INTEGER NOT NULL);`,
  `CREATE TABLE pluginagent_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);`,
  `ALTER TABLE pluginagent_agents ADD COLUMN agent_id TEXT`,
];
/** What the plugin agent is given, exactly (the card says the same words): reads of memory and recall, the sessions of the person's projects, and one write that lands as a pending suggestion. */
export const ALLOWED = Object.freeze(new Set([
  "memory.ask", "memory.answer", "memory.brief", "memory.card", "memory.context", "memory.contradictions", "memory.decisions", "memory.facts", "memory.graph", "memory.me", "memory.profile",
  "memory.read", "memory.relevant", "memory.retrieve", "memory.markers", "memory.follow", "memory.stats", "memory.today", "memory.why", "memory.remember",
  "recall.search", "recall.sessions", "recall.thread", "recall.turn", "recall.links", "recall.transcript", "recall.related", "recall.status",
  "projects.list", "projects.context", "projects.catalog", "projects.of", "projects.threads", "projects.history",
  "threads.list", "threads.get", "threads.history", "threads.lineage",
  "pluginagent.ask", "pluginagent.status",
]));
/** The file the plugin's MCP server reads, in the home: { agent, key }. Mode 0600. */
export const KEY_FILE = "plugin-agent.json";
const ASK_MS = 24 * 3600_000, QUIET_MS = 7 * 24 * 3600_000;
const PEOPLE = ["cli", "local", "deck", "capsule", "device"];
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required, additionalProperties: false });
const hash = (/** @type {string} */ key) => crypto.createHash("sha256").update(key).digest("hex");
/** What a computer is called, as a person reads it: printable, short. */
const clean = (/** @type {any} */ s) => String(s || "").replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, 60) || "this computer";
const slug = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "computer";

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const root = ctx.paths ? ctx.paths.root : process.env.VYRE_HOME || "";
    const now = typeof ctx.now === "function" ? ctx.now : Date.now;
    const current = () => db.prepare("SELECT * FROM pluginagent_agents ORDER BY created_at DESC LIMIT 1").get();
    /** An ask nobody answered in 24 h is `expired` (kept, so the next ask can wait out the quiet days); only a waiting one is open. */
    const open = () => { db.prepare("UPDATE pluginagent_asks SET state = 'expired' WHERE state = 'waiting' AND asked_at < ?").run(now() - ASK_MS); return db.prepare("SELECT * FROM pluginagent_asks WHERE state = 'waiting' ORDER BY asked_at").all(); };
    const getState = (/** @type {string} */ k) => { const r = db.prepare("SELECT v FROM pluginagent_state WHERE k = ?").get(k); return r ? String(r.v) : null; };
    const setState = (/** @type {string} */ k, /** @type {string|null} */ v) => { if (v === null) db.prepare("DELETE FROM pluginagent_state WHERE k = ?").run(k); else db.prepare("INSERT INTO pluginagent_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v); };
    /** The computer, as the daemon names it: never what the asker typed. */
    const computerName = () => clean(os.hostname());
    const keyPath = () => path.join(root, KEY_FILE);

    ctx.tool("pluginagent.ask", {
      description: "Claude Code on this computer asks once to read the person's memory and project sessions. Answers state: granted, waiting, declined or quiet.",
      input: obj(),
      callers: [...PEOPLE, "mcp", "harness"],
      run: async () => {
        if (current()) return { state: "granted", agent: String(current().agent) };
        // A decline or a revoke is no until the person turns it back on; it is never asked again before that.
        if (getState("off") === "1") return { state: "declined" };
        const waiting = open();
        if (waiting.length) return { state: "waiting", id: String(waiting[0].id) };
        // One pending ask at a time; after one ran out unanswered the next waits QUIET_MS from the day it expired.
        const last = db.prepare("SELECT asked_at FROM pluginagent_asks WHERE state = 'expired' ORDER BY asked_at DESC LIMIT 1").get();
        if (last && now() < Number(last.asked_at) + ASK_MS + QUIET_MS) return { state: "quiet", until: Number(last.asked_at) + ASK_MS + QUIET_MS };
        const computer = computerName();
        const id = newPrefixedId("pa");
        db.prepare("INSERT INTO pluginagent_asks (id, computer, asked_at, state) VALUES (?,?,?, 'waiting')").run(id, computer, now());
        try { ctx.events.emit("pluginagent.asked", { id, computer }); } catch { /* an event never decides */ }
        return { state: "waiting", id };
      },
    });

    ctx.tool("pluginagent.status", {
      description: "Whether Claude Code on this computer has been granted its reach, and the plain sentence to say when it has not.",
      input: obj(),
      callers: [...PEOPLE, "mcp", "harness"],
      run: async () => {
        const a = current();
        return a ? { granted: true, agent: String(a.agent), computer: String(a.computer) }
          : { granted: false, declined: getState("off") === "1", say: "Claude Code can read only this session's project until you allow it in Vyre." };
      },
    });

    ctx.tool("pluginagent.pending", {
      description: "What is waiting for the person: [{ id, computer, asked_at, sentence }].",
      input: obj(), callers: PEOPLE,
      run: async () => open().map(a => ({ id: String(a.id), computer: String(a.computer), asked_at: Number(a.asked_at), sentence: `Let Claude Code on ${a.computer} read your memory and the sessions of your projects` })),
    });

    ctx.tool("pluginagent.grant", {
      description: "The person lets Claude Code on a computer read their memory and every project's sessions, once. Registers the agent, adds it to the Space (a kernel act that needs the person's presence) and writes its key where only this OS user can read it. It never becomes the person.",
      input: obj({ id: { type: "string", maxLength: 40 } }),
      callers: PEOPLE,
      presence: { summary: async () => `Let Claude Code on ${computerName()} read your memory and the sessions of your projects` },
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        if (current()) throw refuse("Claude Code on this computer is already granted; revoke it first to start over", "conflict");
        const ask = input && input.id ? db.prepare("SELECT * FROM pluginagent_asks WHERE id = ?").get(String(input.id)) : null;
        if (input && input.id && !ask) throw refuse("no such request; Claude Code asks again with pluginagent.ask", "not_found");
        // An ask is granted only while it waits and is under 24 h old; the clock decides here, not whoever last swept the table.
        if (ask && (String(ask.state) === "expired" || (String(ask.state) === "waiting" && Number(ask.asked_at) < now() - ASK_MS))) throw refuse("that request ran out; Claude Code asks again on its own", "expired");
        if (ask && String(ask.state) !== "waiting") throw refuse(`that request is ${String(ask.state)}; Claude Code asks again with pluginagent.ask`, "conflict");
        const computer = ask ? String(ask.computer) : computerName();
        const agent = `claude-code-${slug(computer)}`;
        const k = ctx.kernel && ctx.kernel.grants ? ctx.kernel : null;
        // The agent holds grants only by its stable id (agents.uid), which exists once the agents module has made it; a refusal below leaves an agent with no grant, never one with a grant it should not have.
        const made = await ctx.call("agents.create", { name: agent, projects: "*", personal: true });
        if (made && made.error) throw refuse(String(made.error.message || "the agent could not be made"), String(made.error.code || "failed"));
        // "every project" is ONE kernel grant, made here in the person's own call with their proof (the agents module made the agent from a module call, which carries no person)
        if (k) { const u = await ctx.call("agents.uid", { name: agent }); if (!u || !u.data) throw refuse("the agent has no id", "failed"); await grantReach(k, meta, { urn: `vyre://${k.space}/project/*`, agent: String(u.data.uid) }); }
        const agentId = made && made.data && made.data.id ? String(made.data.id) : null;
        const key = crypto.randomBytes(32).toString("base64url");
        const file = keyPath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ agent, key }), { mode: 0o600 });
        fs.chmodSync(file, 0o600);
        db.prepare("INSERT INTO pluginagent_agents (agent, computer, key_hash, created_at, agent_id) VALUES (?,?,?,?,?)").run(agent, computer, hash(key), now(), agentId);
        db.prepare("UPDATE pluginagent_asks SET state = 'granted' WHERE state = 'waiting'").run();
        setState("off", null);
        try { ctx.events.emit("pluginagent.granted", { agent, computer }); } catch { /* an event never decides */ }
        return { granted: true, agent, computer };
      },
    });

    ctx.tool("pluginagent.revoke", {
      description: "The person takes Claude Code's reach on this computer away: the key stops working at once, the agent is removed, and it does not ask again until the person turns it back on (pluginagent.on).",
      input: obj(), callers: PEOPLE,
      presence: { summary: async () => "Take away Claude Code's reach to your memory and sessions on this computer" },
      run: async (/** @type {any} */ _input, /** @type {any} */ meta) => {
        const a = current();
        if (!a) return { revoked: false };
        // A paired phone revokes too, but its own agents.delete is the terminal's and the app's, never a device's: the delete is relayed as the person's own surface ("local"), and only for a session
        // whose key is not software (core/presence/strengths.js: enclave, enclave unattested or passkey; the door's rule). A software-strength device is refused HERE, before anything is turned off, so a refusal never leaves the key off and the agent standing.
        const caller = String(meta.caller || "");
        let as = caller;
        if (deviceLabel(caller)) {
          const sid = meta.person && meta.person.id ? String(meta.person.id) : "";
          const st = sid ? await ctx.call("presence.person.strength", { id: sid }).catch(() => null) : null;
          if (!(st && st.data && isNotSoftware(st.data.strength))) throw refuse("This device keeps its key in software, so it cannot take Claude Code's access away. Do it from the terminal, or from a phone with Face ID.", "software_key");
          as = "local";
        }
        db.prepare("DELETE FROM pluginagent_agents WHERE agent = ?").run(String(a.agent));
        setState("off", "1");
        try { fs.rmSync(keyPath(), { force: true }); } catch { /* the hash is gone: the key is already dead */ }
        // The person's own act (revoke needs presence): the delete runs as the person's surface that revoked (a device as "local", above), not as this module, so agents.delete's person-only rule is what decides.
        const gone = await ctx.call("agents.delete", { agent: String(a.agent), ...(a.agent_id ? { id: String(a.agent_id) } : {}) }, { as, relay: meta });
        // not_found: that agent (or one with that id) is already gone, or the name is someone else's agent now: not ours to delete.
        if (gone && gone.error && gone.error.code !== "not_found") throw refuse(`Claude Code's reach is off, but its agent could not be removed: ${gone.error.message}`, String(gone.error.code || "failed"));
        try { ctx.events.emit("pluginagent.revoked", { agent: String(a.agent) }); } catch { /* an event never decides */ }
        return { revoked: true, agent: String(a.agent) };
      },
    });

    ctx.tool("pluginagent.decline", {
      description: "The person says no to Claude Code's request (the card's Don't allow): the waiting ask ends and Claude Code does not ask again until the person turns it back on (pluginagent.on).",
      input: obj(), callers: PEOPLE,
      run: async () => {
        db.prepare("UPDATE pluginagent_asks SET state = 'declined' WHERE state = 'waiting'").run();
        setState("off", "1");
        try { ctx.events.emit("pluginagent.declined", {}); } catch { /* an event never decides */ }
        return { declined: true };
      },
    });

    ctx.tool("pluginagent.on", {
      description: "The person turns Claude Code's request back on after a decline or a revoke (from Access): the next time it runs here it asks again. Grants nothing by itself.",
      input: obj(), callers: PEOPLE,
      run: async () => { setState("off", null); return { on: true }; },
    });

    ctx.tool("pluginagent.allows", {
      description: "vyred asks, for a call or a tool listing by the plugin agent: which of these tools does the grant name? Answers { allowed: [tool] } for the ones it does, the rest are refused with not_in_grant.",
      internal: true, callers: ["module"],
      input: obj({ tools: { type: "array", items: { type: "string" }, maxItems: 5000 } }, ["tools"]),
      run: async (/** @type {any} */ i) => ({ allowed: (Array.isArray(i.tools) ? i.tools : []).map(String).filter(t => ALLOWED.has(t)) }),
    });

    ctx.tool("pluginagent.vouch", {
      description: "vyred asks: is this the key of the plugin agent it names? Answers { ok, agent }. Never the key.",
      internal: true, callers: ["module"],
      input: obj({ agent: { type: "string" }, key: { type: "string" } }, ["agent", "key"]),
      run: async (/** @type {any} */ i) => {
        const a = current();
        if (!a || String(a.agent) !== String(i.agent)) return { ok: false };
        const want = Buffer.from(String(a.key_hash)), got = Buffer.from(hash(String(i.key || "")));
        return { ok: want.length === got.length && crypto.timingSafeEqual(want, got), agent: String(a.agent) };
      },
    });
    return { async stop() {} };
  },
};
