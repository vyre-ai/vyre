// @ts-check
// mcpconn: the person's own AI, connected (the owner's rulings, 13 Oct: MCP is native and tied to the person's identity; the person makes a key per external agent and NAMES it).
// A key is made once, with presence (`mcpconn.connect`), and is shown once. Only its hash is kept here. A call on it runs as the person: the daemon vouches it (`mcpconn.vouch`), sets
// meta.viaMcp, and the call runs on the person's own one-person chain under the same kernel and door as the app (core/modules agent-reach mcpPersonMay names the few tools that stay out).
// The key's NAME is what shows afterwards, in Activity ("via <name>"), approvals and lists. An outward act is still held at the Gate, because the label stays `mcp`.
//
// Two ways to use a key, one tool surface (harness/mcp/server.js, the same `vyre mcp` serves):
//   local  `vyre mcp` on the computer: the key is written to <home>/mcp-connection.json (0600) and the stdio server sends it.
//   hosted POST /mcp (streamable HTTP, Authorization: Bearer <key>), reached through the public gate (core/wink/control/gate.js) or on loopback: each key gets its own stdio server child, so
//          the tools, their listing and their scope are exactly `vyre mcp`'s, and a revoked key is a 401 on the next request.
// The person lists the keys and revokes one (no presence needed); a revoke kills the key at once.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { newPrefixedId } from "../../lib/id.js";
import { listen, PATH } from "./listener.js";

export const MIGRATIONS = [
  `CREATE TABLE mcpconn_connections (id TEXT PRIMARY KEY, client TEXT NOT NULL, device TEXT NOT NULL, key_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER, revoked_at INTEGER);`,
  `CREATE TABLE mcpconn_activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, conn TEXT NOT NULL, client TEXT NOT NULL, tool TEXT NOT NULL, ok INTEGER NOT NULL);`,
  // `client` holds the key's NAME from here on (kept as the column so earlier rows read); hosted keys have no computer
  `ALTER TABLE mcpconn_connections ADD COLUMN hosted INTEGER NOT NULL DEFAULT 0;`,
];
/** The file `vyre mcp` reads, in the home: { id, key }. Mode 0600. */
export const KEY_FILE = "mcp-connection.json";
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "harness", "mcp", "server.js");
const PEOPLE = ["cli", "local", "deck", "capsule", "device"];
const IDLE_MS = 5 * 60_000, CALL_MS = 120_000;
const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required, additionalProperties: false });
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const hash = (/** @type {string} */ key) => crypto.createHash("sha256").update(key).digest("hex");
const clean = (/** @type {any} */ s, /** @type {string} */ dflt) => String(s || "").replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, 60) || dflt;
/** What an activity line says for a key: "via Claude Code on laptop". @param {string} name */
export const saysFor = name => `via ${name}`;
/** The one string a hosted client sends: the key's id and its secret. @param {string} id @param {string} key */
export const tokenOf = (id, key) => `${id}~${key}`;
/** @param {any} header @returns {{ id: string, key: string } | null} */
export function parseBearer(header) {
  const m = /^Bearer\s+([A-Za-z0-9_-]+)~([A-Za-z0-9_-]+)\s*$/.exec(String(header || ""));
  return m ? { id: m[1], key: m[2] } : null;
}
/** The ready-to-paste lines for a hosted key and for a local one. @param {string} url @param {string} token @param {string} name */
export function snippets(url, token, name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "vyre";
  return {
    claude: `claude mcp add --transport http vyre-${slug} ${url} --header "Authorization: Bearer ${token}"`,
    codex: `codex mcp add vyre-${slug} --url ${url} --bearer-token-env-var VYRE_MCP_KEY   # then: export VYRE_MCP_KEY=${token}`,
    json: JSON.stringify({ mcpServers: { [`vyre-${slug}`]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
  };
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const root = ctx.paths ? ctx.paths.root : process.env.VYRE_HOME || "";
    const now = typeof ctx.now === "function" ? ctx.now : Date.now;
    const keyPath = () => path.join(root, KEY_FILE);
    const device = () => clean(os.hostname(), "this computer");
    const emit = (/** @type {string} */ type, /** @type {any} */ payload) => { try { ctx.events.emit(type, payload); } catch { /* an event never decides */ } };
    const view = (/** @type {any} */ r) => ({ id: String(r.id), name: String(r.client), where: Number(r.hosted) === 1 ? "hosted" : String(r.device), hosted: Number(r.hosted) === 1, created: Number(r.created_at), lastUsed: r.last_used == null ? null : Number(r.last_used), revoked: r.revoked_at != null });
    /** @type {{ port: number, url: string, close: () => Promise<void> } | null} */ let listener = null;
    /** @type {string | null} */ let publicBase = null;
    const hostedUrl = () => (publicBase ? `${publicBase}${PATH}` : listener ? listener.url : "");

    // ---- vouching: one function, used by the daemon's route (mcpconn.vouch) and by the hosted listener
    /** @param {string} id @param {string} key */
    const vouch = (id, key) => {
      const r = /** @type {any} */ (db.prepare("SELECT * FROM mcpconn_connections WHERE id = ?").get(String(id)));
      if (!r || r.revoked_at != null) return { ok: false };
      const want = Buffer.from(String(r.key_hash)), got = Buffer.from(hash(String(key || "")));
      const ok = want.length === got.length && crypto.timingSafeEqual(want, got);
      if (ok && (r.last_used == null || now() - Number(r.last_used) > 60_000)) db.prepare("UPDATE mcpconn_connections SET last_used = ? WHERE id = ?").run(now(), String(r.id));
      return ok ? { ok: true, id: String(r.id), name: String(r.client), hosted: Number(r.hosted) === 1 } : { ok: false };
    };

    ctx.tool("mcpconn.connect", {
      description: "The person makes a key for one of their AI agents and names it (\"Claude Code on laptop\", \"Codex\", \"Zapier agent\"); the name shows in Activity, approvals and lists. The agent then acts as them, with the access they have, and outward acts still wait for them. Needs presence once. { name, hosted? }: hosted gives a URL and a key for any MCP client over HTTP; otherwise the key is for `vyre mcp` on this computer. Returns { id, name, key, url?, local, snippets }; the key is shown only now.",
      input: obj({ name: { type: "string", maxLength: 60 }, hosted: { type: "boolean" } }),
      callers: PEOPLE,
      presence: { summary: async (/** @type {any} */ i) => `Make a key for ${clean(i && i.name, "your AI")} to act as you in Vyre` },
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        // A key runs as the home's owner on the facts of their own terminal; a member's device (whose facts name her) is refused rather than given the owner's chain. Members come with the per-person routing.
        const who = meta && meta.kernelFacts && typeof meta.kernelFacts.person === "string" ? meta.kernelFacts.person : null;
        const owner = ctx.kernel && ctx.kernel.id && typeof ctx.kernel.id.owner === "string" ? ctx.kernel.id.owner : null;
        if (who && owner && who !== owner) throw refuse("connecting your AI works for the person who owns this Vyre, on their own computer, for now", "unavailable");
        const hosted = Boolean(input && input.hosted);
        const name = clean(input && input.name, hosted ? "Hosted AI" : `Claude Code on ${device()}`);
        const at = now();
        // The same name on the same computer is the same agent: its earlier key is replaced.
        db.prepare("UPDATE mcpconn_connections SET revoked_at = ? WHERE revoked_at IS NULL AND client = ? AND hosted = ? AND device = ?").run(at, name, hosted ? 1 : 0, hosted ? "hosted" : device());
        const id = newPrefixedId("mcn");
        const key = crypto.randomBytes(32).toString("base64url");
        if (!hosted) {
          const file = keyPath();
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ id, key }), { mode: 0o600 });
          fs.chmodSync(file, 0o600);
        }
        db.prepare("INSERT INTO mcpconn_connections (id, client, device, key_hash, created_at, hosted) VALUES (?,?,?,?,?,?)").run(id, name, hosted ? "hosted" : device(), hash(key), at, hosted ? 1 : 0);
        emit("mcpconn.connected", { id, name, where: hosted ? "hosted" : device() });
        const url = hostedUrl();
        return {
          id, name, key: tokenOf(id, key), local: !hosted, ...(hosted ? { url, urlIsLoopback: Boolean(url) && !publicBase } : {}),
          snippets: hosted ? snippets(url || "<the address Vyre shows when this server is reachable>", tokenOf(id, key), name)
            : { claude: "claude mcp add -s user vyre -- vyre mcp", codex: "codex mcp add vyre -- vyre mcp", json: JSON.stringify({ mcpServers: { vyre: { command: "vyre", args: ["mcp"] } } }, null, 2) },
        };
      },
    });

    ctx.tool("mcpconn.list", {
      description: "The person's AI keys: [{ id, name, where, hosted, created, lastUsed, revoked }], newest first. Never the key.",
      input: obj(), callers: PEOPLE,
      run: async () => db.prepare("SELECT * FROM mcpconn_connections ORDER BY created_at DESC").all().map(view),
    });

    ctx.tool("mcpconn.revoke", {
      description: "The person ends a key: it stops working at once (the next call is a 401 over HTTP). No presence needed, so it is always possible.",
      input: obj({ id: { type: "string", maxLength: 60 } }, ["id"]), callers: PEOPLE,
      run: async (/** @type {any} */ input) => {
        const r = /** @type {any} */ (db.prepare("SELECT * FROM mcpconn_connections WHERE id = ?").get(String(input.id)));
        if (!r) throw refuse("no such key. Open Settings > Your AI keys to see yours, or run vyre mcp list", "not_found");
        if (r.revoked_at == null) db.prepare("UPDATE mcpconn_connections SET revoked_at = ? WHERE id = ?").run(now(), String(r.id));
        try { const f = JSON.parse(fs.readFileSync(keyPath(), "utf8")); if (f && f.id === r.id) fs.rmSync(keyPath(), { force: true }); } catch { /* no file, or not this one */ }
        stopChild(String(r.id));
        emit("mcpconn.revoked", { id: String(r.id), name: String(r.client) });
        return { revoked: true, id: String(r.id) };
      },
    });

    ctx.tool("mcpconn.activity", {
      description: "What the person's AI keys changed lately: [{ at, name, tool, ok, says }], newest first, at most 50. Tool names only, never what was in the call.",
      input: obj(), callers: PEOPLE,
      run: async () => db.prepare("SELECT at, client, tool, ok FROM mcpconn_activity ORDER BY seq DESC LIMIT 50").all().map((/** @type {any} */ r) => ({ at: Number(r.at), name: String(r.client), tool: String(r.tool), ok: Number(r.ok) === 1, says: saysFor(String(r.client)) })),
    });

    ctx.tool("mcpconn.guide", {
      description: "The walk-through for setting Vyre up from the work on this computer: look, propose, confirm, make it, bring the sessions in. Read it first.",
      input: obj(), callers: [...PEOPLE, "mcp", "harness"],
      run: async () => ({ guide: fs.readFileSync(new URL("../../harness/mcp/setup-vyre.md", import.meta.url), "utf8") }),
    });

    ctx.tool("mcpconn.vouch", {
      description: "vyred asks: is this the live key of the connection it names? Answers { ok, id, name }. Never the key.",
      internal: true, callers: ["module"],
      input: obj({ id: { type: "string" }, key: { type: "string" } }, ["id", "key"]),
      run: async (/** @type {any} */ i) => vouch(String(i.id), String(i.key)),
    });

    ctx.tool("mcpconn.note", {
      description: "vyred records that a connected client changed something: an event for Activity, the tool's name only, never its input.",
      internal: true, callers: ["module"],
      input: obj({ conn: { type: "string", maxLength: 60 }, tool: { type: "string", maxLength: 120 }, ok: { type: "boolean" } }, ["conn", "tool"]),
      run: async (/** @type {any} */ i) => {
        const r = /** @type {any} */ (db.prepare("SELECT client FROM mcpconn_connections WHERE id = ?").get(String(i.conn)));
        const name = r ? String(r.client) : "";
        db.prepare("UPDATE mcpconn_connections SET last_used = ? WHERE id = ?").run(now(), String(i.conn));
        db.prepare("INSERT INTO mcpconn_activity (at, conn, client, tool, ok) VALUES (?,?,?,?,?)").run(now(), String(i.conn), name, String(i.tool).slice(0, 120), i.ok !== false ? 1 : 0);
        db.prepare("DELETE FROM mcpconn_activity WHERE seq <= (SELECT MAX(seq) FROM mcpconn_activity) - 200").run();
        emit("mcpconn.did", { conn: String(i.conn), name, tool: String(i.tool).slice(0, 120), ok: i.ok !== false, says: saysFor(name) });
        return { noted: true };
      },
    });

    ctx.tool("mcpconn.status", {
      internal: true, description: "Whether POST /mcp is listening on loopback, and its port: { listening, port }. Only the wink module (the public gate) asks.", input: obj(),
      run: async (/** @type {any} */ _i, /** @type {any} */ { caller: who }) => {
        if (who !== "module:wink") throw refuse("only the public gate asks where /mcp listens", "denied");
        return { listening: Boolean(listener), port: listener ? listener.port : null };
      },
    });
    ctx.tool("mcpconn.base", {
      internal: true, description: "The public address the gate serves this box on, or null: { base }. Only the wink module sets it; hosted keys made afterwards name it.", input: obj({ base: { type: ["string", "null"] } }),
      run: async (/** @type {any} */ { base }, /** @type {any} */ { caller: who }) => {
        if (who !== "module:wink") throw refuse("only the public gate sets the public address", "denied");
        publicBase = typeof base === "string" && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base) ? base : null;
        return { ok: true };
      },
    });

    // ---- hosted: one `vyre mcp` stdio server per key, spoken to over streamable HTTP (single JSON reply per POST)
    /** @type {Map<string, { child: import("node:child_process").ChildProcess, waiting: Map<any, (m: any) => void>, idle: NodeJS.Timeout }>} */
    const children = new Map();
    function stopChild(/** @type {string} */ id) {
      const c = children.get(id);
      if (!c) return;
      clearTimeout(c.idle);
      children.delete(id);
      for (const w of c.waiting.values()) w({ jsonrpc: "2.0", error: { code: -32000, message: "this key was revoked" } });
      try { c.child.kill(); } catch { /* gone */ }
    }
    function childFor(/** @type {string} */ id, /** @type {string} */ key) {
      let c = children.get(id);
      if (c) { clearTimeout(c.idle); c.idle = setTimeout(() => stopChild(id), IDLE_MS); c.idle.unref?.(); return c; }
      const env = { ...process.env, VYRE_HOME: root, VYRE_MCP_ID: id, VYRE_MCP_KEY: key };
      delete env.VYRE_SOCKET; delete env.VYRE_AGENT;
      const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "ignore"] });
      child.stdin?.on("error", () => {});
      /** @type {Map<any, (m: any) => void>} */ const waiting = new Map();
      let buf = "";
      child.stdout.on("data", d => { buf += d; for (let i; (i = buf.indexOf("\n")) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); if (m && m.id !== undefined && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); w?.(m); } } catch { /* not a reply */ } } });
      child.on("exit", () => { if (children.get(id)?.child === child) children.delete(id); for (const w of waiting.values()) w({ jsonrpc: "2.0", error: { code: -32000, message: "the tool server stopped; try again" } }); });
      c = { child, waiting, idle: setTimeout(() => stopChild(id), IDLE_MS) };
      c.idle.unref?.();
      children.set(id, c);
      return c;
    }
    /** @type {Map<string, number[]>} */ const misses = new Map();
    /** Bearer-token door: a bad or revoked key is a 401; five wrong keys from one source in ten minutes lock that source out (429). */
    async function handle(/** @type {{ headers: Record<string, any>, body: string, source: string }} */ q) {
      const t = now();
      const recent = (misses.get(q.source) || []).filter(x => x > t - 600_000);
      if (recent.length >= 5) return { status: 429, body: { error: "too many wrong keys; wait ten minutes" } };
      const b = parseBearer(q.headers.authorization);
      const v = b ? vouch(b.id, b.key) : { ok: false };
      if (!b || !v.ok) {
        misses.set(q.source, [...recent, t]);
        // Only a revoked key's server is stopped here: a wrong secret for a known id must not let a stranger kill a live key's server.
        if (b) { const row = /** @type {any} */ (db.prepare("SELECT revoked_at FROM mcpconn_connections WHERE id = ?").get(b.id)); if (row && row.revoked_at != null) stopChild(b.id); }
        return { status: 401, body: { error: "this key is not valid or was revoked" }, headers: { "www-authenticate": 'Bearer realm="vyre"' } };
      }
      let msg; try { msg = JSON.parse(q.body); } catch { return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } } }; }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "send one JSON-RPC message per request" } } };
      const c = childFor(b.id, b.key);
      if (msg.id === undefined) { c.child.stdin?.write(JSON.stringify(msg) + "\n"); return { status: 202 }; }
      const reply = await new Promise(resolve => {
        const timer = setTimeout(() => { c.waiting.delete(msg.id); resolve({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "no answer in time" } }); }, CALL_MS);
        timer.unref?.();
        c.waiting.set(msg.id, m => { clearTimeout(timer); resolve(m); });
        c.child.stdin?.write(JSON.stringify(msg) + "\n");
      });
      return { status: 200, body: reply };
    }

    if (ctx.kernel) {
      const o = (ctx.config && ctx.config.mcpconn) || {};
      try { listener = await listen({ host: o.host || "127.0.0.1", port: Number(o.port || 0), handle }); ctx.log(`mcpconn: POST /mcp listening on ${listener.url}`); }
      catch (e) { ctx.log.warn(`mcpconn: no hosted listener (${/** @type {Error} */ (e).message})`); }
    }
    return { handle, async stop() { for (const id of [...children.keys()]) stopChild(id); if (listener) await listener.close(); listener = null; } };
  },
};
