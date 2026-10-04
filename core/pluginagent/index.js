// @ts-check
// pluginagent: "Claude Code on <this computer>" is an agent like any other, granted ONCE (the lead's ruling, 4 Oct). The plugin's MCP server asks the first time it runs here (`pluginagent.ask`, a
// plain model call that only files a request). The person approves it from a surface of theirs, with presence (`pluginagent.grant`): vyred registers the agent (agents.create, personal, every project),
// makes it an actor of the Space (the kernel act the presence proof covers) and writes its key to a file only this OS user can read. From then on the MCP server names that agent and sends the key; the
// daemon (core/daemon route) checks it with `pluginagent.vouch`, binds the call to the agent and stamps the agent's kernel token itself. It is never the person: it cannot approve or prove presence, and
// it holds only what the grant names. `pluginagent.revoke` ends it. The key is never kept here, only its hash.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MIGRATIONS = [
  `CREATE TABLE pluginagent_asks (id TEXT PRIMARY KEY, computer TEXT NOT NULL, asked_at INTEGER NOT NULL, state TEXT NOT NULL);
   CREATE TABLE pluginagent_agents (agent TEXT PRIMARY KEY, computer TEXT NOT NULL, key_hash TEXT NOT NULL, created_at INTEGER NOT NULL);`,
];
/** The file the plugin's MCP server reads, in the home: { agent, key }. Mode 0600. */
export const KEY_FILE = "plugin-agent.json";
const ASK_MS = 24 * 3600_000, MAX_OPEN = 5;
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
    const open = () => { db.prepare("DELETE FROM pluginagent_asks WHERE state = 'waiting' AND asked_at < ?").run(now() - ASK_MS); return db.prepare("SELECT * FROM pluginagent_asks WHERE state = 'waiting' ORDER BY asked_at").all(); };
    const keyPath = () => path.join(root, KEY_FILE);

    ctx.tool("pluginagent.ask", {
      description: "Claude Code on this computer asks, once, to read the person's memory and the sessions of their projects. Files a request for the person to approve; changes nothing else. Answers { state: 'granted' | 'waiting' }.",
      input: obj({ computer: { type: "string", maxLength: 80 } }),
      callers: [...PEOPLE, "mcp", "harness"],
      run: async (/** @type {any} */ input) => {
        if (current()) return { state: "granted", agent: String(current().agent) };
        const computer = clean(input && input.computer);
        const waiting = open();
        const same = waiting.find(a => String(a.computer) === computer);
        if (same) return { state: "waiting", id: String(same.id) };
        if (waiting.length >= MAX_OPEN) return { state: "waiting", id: String(waiting[0].id) };
        const id = `pa_${crypto.randomBytes(9).toString("base64url")}`;
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
          : { granted: false, say: "Allow it in Vyre to give access to the sessions of your projects" };
      },
    });

    ctx.tool("pluginagent.pending", {
      description: "What is waiting for the person: [{ id, computer, asked_at, sentence }].",
      input: obj(), callers: PEOPLE,
      run: async () => open().map(a => ({ id: String(a.id), computer: String(a.computer), asked_at: Number(a.asked_at), sentence: `Let Claude Code on ${a.computer} read your memory and the sessions of your projects` })),
    });

    ctx.tool("pluginagent.grant", {
      description: "The person lets Claude Code on a computer read their memory and every project's sessions, once. Registers the agent, adds it to the Space (a kernel act that needs the person's presence) and writes its key where only this OS user can read it. It never becomes the person.",
      input: obj({ id: { type: "string", maxLength: 40 }, computer: { type: "string", maxLength: 80 } }),
      callers: PEOPLE,
      presence: { summary: async (/** @type {any} */ i) => `Let Claude Code on ${clean(i && i.computer) } read your memory and the sessions of your projects` },
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        if (current()) throw refuse("Claude Code on this computer is already granted; revoke it first to start over", "conflict");
        const ask = input && input.id ? db.prepare("SELECT * FROM pluginagent_asks WHERE id = ?").get(String(input.id)) : null;
        if (input && input.id && !ask) throw refuse("no such request", "not_found");
        const computer = ask ? String(ask.computer) : clean(input && input.computer);
        const agent = `claude-code-${slug(computer)}`;
        const k = ctx.kernel && ctx.kernel.grants ? ctx.kernel : null;
        // The Space's own act first, so a refusal (no presence, not the owner) leaves nothing half made.
        if (k) {
          const chain = await k.chain(meta);
          const given = k.proofFrom(meta);
          await k.grants.addActor(chain, { kind: "agent", id: agent, space: k.space }, given || {});
        }
        const made = await ctx.call("agents.create", { name: agent, projects: "*", personal: true });
        if (made && made.error) throw refuse(String(made.error.message || "the agent could not be made"), String(made.error.code || "failed"));
        const key = crypto.randomBytes(32).toString("base64url");
        const file = keyPath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ agent, key }), { mode: 0o600 });
        fs.chmodSync(file, 0o600);
        db.prepare("INSERT INTO pluginagent_agents (agent, computer, key_hash, created_at) VALUES (?,?,?,?)").run(agent, computer, hash(key), now());
        db.prepare("UPDATE pluginagent_asks SET state = 'granted' WHERE state = 'waiting'").run();
        try { ctx.events.emit("pluginagent.granted", { agent, computer }); } catch { /* an event never decides */ }
        return { granted: true, agent, computer };
      },
    });

    ctx.tool("pluginagent.revoke", {
      description: "The person takes Claude Code's reach on this computer away: the key stops working at once, the agent is removed.",
      input: obj(), callers: PEOPLE,
      presence: { summary: async () => "Take away Claude Code's reach to your memory and sessions on this computer" },
      run: async (/** @type {any} */ _input, /** @type {any} */ meta) => {
        const a = current();
        if (!a) return { revoked: false };
        db.prepare("DELETE FROM pluginagent_agents WHERE agent = ?").run(String(a.agent));
        try { fs.rmSync(keyPath(), { force: true }); } catch { /* the hash is gone: the key is already dead */ }
        const k = ctx.kernel && ctx.kernel.grants && typeof ctx.kernel.grants.removeActor === "function" ? ctx.kernel : null;
        if (k) { try { await k.grants.removeActor(await k.chain(meta), { kind: "agent", id: String(a.agent), space: k.space }, k.proofFrom(meta) || {}); } catch { /* not an actor (any more): nothing to remove */ } }
        await ctx.call("agents.delete", { agent: String(a.agent) }).catch(() => null);
        try { ctx.events.emit("pluginagent.revoked", { agent: String(a.agent) }); } catch { /* an event never decides */ }
        return { revoked: true, agent: String(a.agent) };
      },
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
