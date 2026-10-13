// @ts-check
// mcpconn: the person's own AI, connected (the owner's ruling, 13 Oct: MCP is native and tied to the person's identity). The person connects Claude Code or Codex once, with presence (`mcp.connect`);
// that makes a per-device connection: a random key whose hash is kept here and whose secret is written to a file only this OS user can read (<home>/mcp-connection.json), which `vyre mcp` sends on
// every call. The daemon vouches it (`mcp.vouch`) and then the call is the person's own: it runs on their chain, judged by the same kernel and door as in the app (core/modules agent-reach
// mcpPersonMay names the few tools that stay out). It is not the plugin agent and not an outside agent. An outward act is still held at the Gate, because the label stays `mcp`. The person lists the
// connections and revokes one (no presence needed); a revoke kills the key at once. Every change it makes is noted for Activity (`mcpconn.did`: the tool's name, never its input).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newPrefixedId } from "../../lib/id.js";

export const MIGRATIONS = [
  `CREATE TABLE mcpconn_connections (id TEXT PRIMARY KEY, client TEXT NOT NULL, device TEXT NOT NULL, key_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER, revoked_at INTEGER);`,
];
/** The file `vyre mcp` reads, in the home: { id, key }. Mode 0600. */
export const KEY_FILE = "mcp-connection.json";
/** What a line says in Activity. */
export const SAYS = "via your Claude Code";
const PEOPLE = ["cli", "local", "deck", "capsule", "device"];
const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required, additionalProperties: false });
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const hash = (/** @type {string} */ key) => crypto.createHash("sha256").update(key).digest("hex");
const clean = (/** @type {any} */ s, /** @type {string} */ dflt) => String(s || "").replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, 60) || dflt;

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
    const view = (/** @type {any} */ r) => ({ id: String(r.id), client: String(r.client), device: String(r.device), created: Number(r.created_at), lastUsed: r.last_used == null ? null : Number(r.last_used), revoked: r.revoked_at != null });
    const lines = () => ({ claude: "claude mcp add -s user vyre -- vyre mcp", codex: "codex mcp add vyre -- vyre mcp" });

    ctx.tool("mcpconn.connect", {
      description: "The person connects their own Claude Code or Codex on this computer: from then on `vyre mcp` acts as them, with the access they have, and outward acts still wait for them. Needs presence once. Replaces this computer's earlier connection of the same client. Returns { id, client, device, lines }.",
      input: obj({ client: { type: "string", maxLength: 60 } }),
      callers: PEOPLE,
      presence: { summary: async (/** @type {any} */ i) => `Connect ${clean(i && i.client, "your AI")} on ${device()} to act as you in Vyre` },
      run: async (/** @type {any} */ input) => {
        const client = clean(input && input.client, "Claude Code");
        const at = now();
        db.prepare("UPDATE mcpconn_connections SET revoked_at = ? WHERE revoked_at IS NULL AND device = ? AND client = ?").run(at, device(), client);
        const id = newPrefixedId("mcn");
        const key = crypto.randomBytes(32).toString("base64url");
        const file = keyPath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ id, key }), { mode: 0o600 });
        fs.chmodSync(file, 0o600);
        db.prepare("INSERT INTO mcpconn_connections (id, client, device, key_hash, created_at) VALUES (?,?,?,?,?)").run(id, client, device(), hash(key), at);
        emit("mcpconn.connected", { id, client, device: device() });
        return { id, client, device: device(), lines: lines() };
      },
    });

    ctx.tool("mcpconn.list", {
      description: "The connections of the person's own AI: [{ id, client, device, created, lastUsed, revoked }], newest first.",
      input: obj(), callers: PEOPLE,
      run: async () => db.prepare("SELECT * FROM mcpconn_connections ORDER BY created_at DESC").all().map(view),
    });

    ctx.tool("mcpconn.revoke", {
      description: "The person ends a connection: its key stops working at once. No presence needed, so it is always possible.",
      input: obj({ id: { type: "string", maxLength: 60 } }, ["id"]), callers: PEOPLE,
      run: async (/** @type {any} */ input) => {
        const r = db.prepare("SELECT * FROM mcpconn_connections WHERE id = ?").get(String(input.id));
        if (!r) throw refuse("no such connection (mcp.list shows them)", "not_found");
        if (r.revoked_at == null) db.prepare("UPDATE mcpconn_connections SET revoked_at = ? WHERE id = ?").run(now(), String(r.id));
        try { const f = JSON.parse(fs.readFileSync(keyPath(), "utf8")); if (f && f.id === r.id) fs.rmSync(keyPath(), { force: true }); } catch { /* no file, or not this one */ }
        emit("mcpconn.revoked", { id: String(r.id) });
        return { revoked: true, id: String(r.id) };
      },
    });

    ctx.tool("mcpconn.guide", {
      description: "The walk-through for setting Vyre up from the work on this computer (the same words as the setup-vyre MCP prompt): look, propose per client, confirm, make it, bring the sessions in. Read it first, then follow it.",
      input: obj(), callers: [...PEOPLE, "mcp", "harness"],
      run: async () => ({ guide: fs.readFileSync(new URL("../../harness/mcp/setup-vyre.md", import.meta.url), "utf8") }),
    });

    ctx.tool("mcpconn.vouch", {
      description: "vyred asks: is this the live key of the connection it names? Answers { ok, id }. Never the key.",
      internal: true, callers: ["module"],
      input: obj({ id: { type: "string" }, key: { type: "string" } }, ["id", "key"]),
      run: async (/** @type {any} */ i) => {
        const r = db.prepare("SELECT * FROM mcpconn_connections WHERE id = ?").get(String(i.id));
        if (!r || r.revoked_at != null) return { ok: false };
        const want = Buffer.from(String(r.key_hash)), got = Buffer.from(hash(String(i.key || "")));
        const ok = want.length === got.length && crypto.timingSafeEqual(want, got);
        if (ok && (r.last_used == null || now() - Number(r.last_used) > 60_000)) db.prepare("UPDATE mcpconn_connections SET last_used = ? WHERE id = ?").run(now(), String(r.id));
        return { ok, id: String(r.id) };
      },
    });

    ctx.tool("mcpconn.note", {
      description: "vyred records that a connected client changed something: an event for Activity, the tool's name only, never its input.",
      internal: true, callers: ["module"],
      input: obj({ conn: { type: "string", maxLength: 60 }, tool: { type: "string", maxLength: 120 }, ok: { type: "boolean" } }, ["conn", "tool"]),
      run: async (/** @type {any} */ i) => {
        const r = db.prepare("SELECT client FROM mcpconn_connections WHERE id = ?").get(String(i.conn));
        db.prepare("UPDATE mcpconn_connections SET last_used = ? WHERE id = ?").run(now(), String(i.conn));
        emit("mcpconn.did", { conn: String(i.conn), client: r ? String(r.client) : "", tool: String(i.tool).slice(0, 120), ok: i.ok !== false, says: SAYS });
        return { noted: true };
      },
    });
    return { async stop() {} };
  },
};
