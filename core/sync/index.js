// @ts-check
// sync — a paired device sends its own Claude Code session files to the box (ADR 0008 5a,
// session import). Not link's: link owns pairing and what capability a peer's kind carries
// (link.macs and link.macs.call never see a "device" kind peer at all); this module owns the
// upload protocol only, and asks link.peer-of (internal) to turn a connection's own tailnet node
// into the peer it is, since a device's claimed name is never trusted.
//
// sync.upload.plan and sync.upload.start are ordinary tool calls (small JSON). The chunk bytes
// ride a dedicated route (core/daemon/index.js POST /v1/sync/upload/<id>) as
// application/octet-stream, never JSON (e2e's review), and land in sync.upload.chunk through
// registry.call with the raw Buffer in the input. The box, not the device, decides whether a
// peer's sync switch is on (sync.consent): the device's own claim is never trusted, and turning
// it off, or unpairing the device entirely (link.unpaired), deletes everything it sent.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { scanText } from "./scrub.js";

const SAFE_NAME = /[^A-Za-z0-9._-]/g;
const DEFAULT_QUOTA = 500 * 1024 * 1024;
const CHUNK_CAP = 4 * 1024 * 1024;
const UPLOAD_TTL = 30 * 60_000;
const insideDir = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    if (ctx.config.role !== "box") return { async stop() {} }; // the device side is federation's sender (sync.send), not built here yet
    const db = ctx.store.db;
    ctx.store.migrate([
      `CREATE TABLE sync_peers (peer TEXT PRIMARY KEY, name TEXT NOT NULL, sync_on INTEGER NOT NULL DEFAULT 0, used_bytes INTEGER NOT NULL DEFAULT 0, quota_bytes INTEGER)`,
      // One row per file this box already has for a peer, by its relative path: sync.upload.plan's
      // dedupe (a file whose hash has not changed is already "done"), and what used_bytes sums to.
      `CREATE TABLE sync_files (peer TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, at INTEGER NOT NULL,
         PRIMARY KEY (peer, path))`,
    ]);
    const now = () => Date.now();

    /** A folder name safe on disk for this peer's machine label; never trusted as typed at pairing. */
    const folderName = (name, id) => (String(name || "").replace(SAFE_NAME, "_").slice(0, 80) || id);
    const syncedRoot = (name, id) => path.join(ctx.paths.root, "synced", folderName(name, id));
    const quarantineRoot = (name, id) => path.join(ctx.paths.root, "synced", ".quarantine", folderName(name, id));
    const tmpDir = () => path.join(ctx.paths.root, "synced", ".tmp");

    /** Delete everything a peer's machine sent: synced/<machine>/, its tmp and quarantine entries. */
    function deleteSynced(name) {
      const safe = String(name || "").replace(SAFE_NAME, "_").slice(0, 80);
      if (!safe) return;
      for (const dir of [path.join(ctx.paths.root, "synced", safe), path.join(ctx.paths.root, "synced", ".quarantine", safe)]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }

    /** A safe destination inside this peer's synced root: no symlink at any segment, never outside it. */
    function safeDest(root, rel) {
      const parts = String(rel).split("/").filter(p => p && p !== "." && p !== "..");
      if (!parts.length) throw Object.assign(new Error("no relative path"), { code: "bad_input" });
      let dir = root;
      for (const seg of parts.slice(0, -1)) {
        dir = path.join(dir, seg);
        let st; try { st = fs.lstatSync(dir); } catch { continue; }
        if (st.isSymbolicLink()) throw Object.assign(new Error("a symlink in the path is refused"), { code: "denied" });
      }
      const full = path.join(root, ...parts);
      if (!insideDir(full, root)) throw Object.assign(new Error("outside the synced root"), { code: "denied" });
      try { if (fs.lstatSync(full).isSymbolicLink()) throw Object.assign(new Error("a symlink is refused"), { code: "denied" }); } catch {}
      return full;
    }

    /** The link_peers row this connection's own tailnet node is, or null. Never trusts a claimed name. */
    async function peerOf(peer) {
      if (!peer || !peer.stableId) return null;
      const r = await ctx.call("link.peer-of", { stableId: String(peer.stableId) });
      return r && r.data ? r.data : null;
    }

    /** This peer's sync row, made on first need (off, no quota set). */
    function syncRow(id, name) {
      db.prepare("INSERT INTO sync_peers (peer, name) VALUES (?, ?) ON CONFLICT (peer) DO UPDATE SET name = excluded.name").run(id, name);
      return /** @type {any} */ (db.prepare("SELECT * FROM sync_peers WHERE peer = ?").get(id));
    }

    /** @type {Map<string, { peer: string, full: string, tmp: string, rel: string, bytes: number, hash: string, got: number, at: number }>} */
    const uploads = new Map();
    const sweepUploads = () => { for (const [id, u] of uploads) if (now() - u.at > UPLOAD_TTL) { try { fs.rmSync(u.tmp, { force: true }); } catch {} uploads.delete(id); } };

    const off = ctx.events.on("link.unpaired", e => {
      const p = e.payload || {};
      if (typeof p.peer !== "string") return;
      db.prepare("DELETE FROM sync_files WHERE peer = ?").run(p.peer);
      db.prepare("DELETE FROM sync_peers WHERE peer = ?").run(p.peer);
      if (typeof p.name === "string") { deleteSynced(p.name); ctx.events.emit("sync.revoked", { machine: p.name }); }
    });

    ctx.tool("sync.consent", {
      description: "Turn a paired peer's session import on or off, on the box's own record — never the device's say-so. Turning it off deletes everything that peer sent and everything derived from it (sync.revoked).",
      input: { type: "object", required: ["machine", "on"], properties: { machine: { type: "string" }, on: { type: "boolean" } } },
      callers: ["cli", "local", "module", "deck", "capsule"],
      run: async ({ machine, on }) => {
        const peers = await ctx.call("link.peers", {});
        const row = (peers.data || []).find(p => p.id === machine || p.name === machine);
        if (!row) throw Object.assign(new Error(`no paired device named "${machine}"`), { code: "no_link" });
        syncRow(row.id, row.name);
        db.prepare("UPDATE sync_peers SET sync_on = ? WHERE peer = ?").run(on ? 1 : 0, row.id);
        if (!on) {
          db.prepare("DELETE FROM sync_files WHERE peer = ?").run(row.id);
          db.prepare("UPDATE sync_peers SET used_bytes = 0 WHERE peer = ?").run(row.id);
          deleteSynced(row.name);
          ctx.events.emit("sync.revoked", { machine: row.name });
        }
        return { machine: row.name, on: Boolean(on) };
      },
    });

    ctx.tool("sync.upload.plan", {
      description: "For a paired peer's own connection: which of its files are new, changed, or already here, and its quota. Internal to the device's sender.",
      input: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "object", required: ["path", "bytes", "hash"], properties: { path: { type: "string" }, bytes: { type: "number" }, hash: { type: "string" } } } } } },
      callers: ["tailnet"],
      run: async ({ files }, meta) => {
        const peer = await peerOf(meta.peer);
        if (!peer) throw Object.assign(new Error("this connection is not a paired device"), { code: "no_link" });
        const row = syncRow(peer.id, peer.name);
        if (!row.sync_on) throw Object.assign(new Error(`"${peer.name}"'s session import is off; turn it on for this device first`), { code: "sync_disabled" });
        const known = new Map(/** @type {any[]} */ (db.prepare("SELECT path, hash FROM sync_files WHERE peer = ?").all(peer.id)).map(r => [r.path, r.hash]));
        const news = [], changed = [], done = [];
        for (const f of files) {
          const have = known.get(f.path);
          if (have === undefined) news.push(f.path);
          else if (have !== f.hash) changed.push(f.path);
          else done.push(f.path);
        }
        const limit = Number.isFinite(row.quota_bytes) && row.quota_bytes > 0 ? row.quota_bytes : DEFAULT_QUOTA;
        return { new: news, changed, done, quota: { used: row.used_bytes, limit } };
      },
    });

    ctx.tool("sync.upload.start", {
      description: "Start (or resume) sending one file: offset is 0 for new, or how many bytes the box already holds for a retry of the exact same path and hash.",
      input: { type: "object", required: ["path", "bytes", "hash"], properties: { path: { type: "string" }, bytes: { type: "number" }, hash: { type: "string" } } },
      callers: ["tailnet"],
      run: async ({ path: rel, bytes, hash }, meta) => {
        sweepUploads();
        const peer = await peerOf(meta.peer);
        if (!peer) throw Object.assign(new Error("this connection is not a paired device"), { code: "no_link" });
        const row = syncRow(peer.id, peer.name);
        if (!row.sync_on) throw Object.assign(new Error(`"${peer.name}"'s session import is off; turn it on for this device first`), { code: "sync_disabled" });
        const limit = Number.isFinite(row.quota_bytes) && row.quota_bytes > 0 ? row.quota_bytes : DEFAULT_QUOTA;
        const had = /** @type {any} */ (db.prepare("SELECT bytes FROM sync_files WHERE peer = ? AND path = ?").get(peer.id, rel));
        const delta = Number(bytes) - (had ? Number(had.bytes) : 0);
        if (row.used_bytes + Math.max(0, delta) > limit) throw Object.assign(new Error(`"${peer.name}" is over its import quota (${row.used_bytes} of ${limit} bytes used)`), { code: "quota_exceeded" });
        // A retry of the exact same upload resumes from what the temp file already holds; anything
        // else (a different hash, or none in flight) starts over from a fresh UUID temp name.
        const existing = [...uploads.values()].find(u => u.peer === peer.id && u.rel === rel && u.hash === hash);
        if (existing) { existing.at = now(); let got = 0; try { got = fs.statSync(existing.tmp).size; } catch {} return { upload: existing.id, offset: got }; }
        fs.mkdirSync(tmpDir(), { recursive: true, mode: 0o700 });
        const id = crypto.randomUUID();
        const tmp = path.join(tmpDir(), id);
        const full = safeDest(syncedRoot(peer.name, peer.id), rel);
        uploads.set(id, { id, peer: peer.id, full, tmp, rel: String(rel), bytes: Number(bytes), hash: String(hash), got: 0, at: now() });
        return { upload: id, offset: 0 };
      },
    });

    // Reached only from core/daemon/index.js's dedicated route: the body is a raw Buffer, never
    // parsed as JSON, since a chunk is arbitrary bytes (e2e: "application/octet-stream only").
    ctx.tool("sync.upload.chunk", {
      description: "One chunk of an upload's bytes, at an exact offset. Internal: the daemon's own route calls this after reading the request body.",
      input: { type: "object", required: ["upload", "offset", "data"], properties: { upload: { type: "string" }, offset: { type: "number" }, data: {} } },
      callers: ["tailnet"],
      run: async ({ upload, offset, data }, meta) => {
        const u = uploads.get(String(upload));
        if (!u) throw Object.assign(new Error("no such upload (it may have expired; start again)"), { code: "denied" });
        const peer = await peerOf(meta.peer);
        // Resume state is keyed by machine + path hash, and an upload is never another peer's to
        // write into, even one that somehow names the same id (e2e's condition).
        if (!peer || peer.id !== u.peer) throw Object.assign(new Error("this upload belongs to another device"), { code: "denied" });
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "base64");
        if (buf.length > CHUNK_CAP) throw Object.assign(new Error(`a chunk is at most ${CHUNK_CAP} bytes`), { code: "bad_input" });
        let have = 0; try { have = fs.statSync(u.tmp).size; } catch {}
        if (Number(offset) !== have) throw Object.assign(new Error(`offset ${offset} does not match what this upload holds (${have})`), { code: "offset_mismatch" });
        fs.appendFileSync(u.tmp, buf, { mode: 0o600 });
        u.got = have + buf.length;
        u.at = now();
        ctx.events.emit("sync.progress", { machine: peer.name, path: u.rel, bytes: u.got, total: u.bytes });
        return { offset: u.got };
      },
    });

    ctx.tool("sync.upload.finish", {
      description: "Verify and land a finished upload: checks its hash, scrubs it for secrets, and renames it into synced/<machine>/ (or quarantines it).",
      input: { type: "object", required: ["upload", "hash"], properties: { upload: { type: "string" }, hash: { type: "string" } } },
      callers: ["tailnet"],
      run: async ({ upload, hash }, meta) => {
        const u = uploads.get(String(upload));
        if (!u) throw Object.assign(new Error("no such upload (it may have expired; start again)"), { code: "denied" });
        const peer = await peerOf(meta.peer);
        if (!peer || peer.id !== u.peer) throw Object.assign(new Error("this upload belongs to another device"), { code: "denied" });
        uploads.delete(String(upload));
        let text = "";
        try { text = fs.readFileSync(u.tmp, "utf8"); } catch { throw Object.assign(new Error("the upload is missing on the box"), { code: "denied" }); }
        const gotHash = crypto.createHash("sha256").update(text).digest("hex");
        if (String(hash) !== gotHash) { try { fs.rmSync(u.tmp, { force: true }); } catch {} throw Object.assign(new Error("the finished upload's hash does not match what was sent"), { code: "bad_input" }); }
        const scan = scanText(text);
        if (!scan.safe) {
          const qfull = safeDest(quarantineRoot(peer.name, peer.id), u.rel);
          fs.mkdirSync(path.dirname(qfull), { recursive: true, mode: 0o700 });
          fs.renameSync(u.tmp, qfull);
          ctx.events.emit("sync.progress", { machine: peer.name, path: u.rel, done: true, quarantined: true });
          return { ok: true, quarantined: true, why: scan.found };
        }
        fs.mkdirSync(path.dirname(u.full), { recursive: true, mode: 0o700 });
        fs.renameSync(u.tmp, u.full);
        const had = /** @type {any} */ (db.prepare("SELECT bytes FROM sync_files WHERE peer = ? AND path = ?").get(peer.id, u.rel));
        const delta = u.bytes - (had ? Number(had.bytes) : 0);
        db.prepare("INSERT INTO sync_files (peer, path, hash, bytes, at) VALUES (?,?,?,?,?) ON CONFLICT (peer, path) DO UPDATE SET hash = excluded.hash, bytes = excluded.bytes, at = excluded.at")
          .run(peer.id, u.rel, gotHash, u.bytes, now());
        db.prepare("UPDATE sync_peers SET used_bytes = used_bytes + ? WHERE peer = ?").run(delta, peer.id);
        ctx.events.emit("sync.progress", { machine: peer.name, path: u.rel, done: true });
        return { ok: true, path: u.rel };
      },
    });

    return {
      async stop() { off(); uploads.clear(); },
    };
  },
};
