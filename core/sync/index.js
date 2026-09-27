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
// peer's sync switch is on (sync.consent): the device's own claim is never trusted. Turning it
// off, or unpairing, only stops new uploads — nothing already sent is touched (the user overruled
// the original design: what came from a device is the person's, not the device's). Deleting is
// sync.delete, its own explicit, person-only action.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanText } from "./scrub.js";

const SAFE_NAME = /[^A-Za-z0-9._-]/g;
const DEFAULT_QUOTA = 500 * 1024 * 1024;
const CHUNK_CAP = 4 * 1024 * 1024;
const UPLOAD_TTL = 30 * 60_000;
/** At most this many uploads open at once for one peer (e2e's review): a cap on parallel starts. */
const MAX_OPEN = 8;
/** A file over this is refused outright: a bound on disk, independent of the streaming below. */
const MAX_FILE = 100 * 1024 * 1024;
/** finish() scans every chunk as it streams past, not just a bounded prefix (reviewer MEDIUM: a
 * secret between SCRUB_PREFIX and MAX_FILE would have landed unquarantined and Recall would have
 * indexed it). SCRUB_OVERLAP carries the tail of one chunk into the next scan so a pattern split
 * across a chunk boundary is still caught. */
const SCRUB_OVERLAP = 4096;
const SCRUB_MAX_FOUND = 5;
const insideDir = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/** How many chunk bytes go in one request (link.upload's carrier: link.reply's own body sizing). */
const SEND_CHUNK = 1024 * 1024;

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    if (ctx.config.role !== "box") return deviceSide(ctx);
    const db = ctx.store.db;
    ctx.store.migrate([
      `CREATE TABLE sync_peers (peer TEXT PRIMARY KEY, name TEXT NOT NULL, sync_on INTEGER NOT NULL DEFAULT 0, used_bytes INTEGER NOT NULL DEFAULT 0, quota_bytes INTEGER)`,
      // One row per file this box already has for a peer, by its relative path: sync.upload.plan's
      // dedupe (a file whose hash has not changed is already "done"), and what used_bytes sums to.
      `CREATE TABLE sync_files (peer TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, at INTEGER NOT NULL,
         PRIMARY KEY (peer, path))`,
      // plan_hash: the import plan the person approved when this file landed (sync.consent's own
      // planHash, echoed onto sync_peers, copied here at finish time), so sync.delete.import can
      // remove just one import's files without touching what a later, separately-approved plan sent.
      `ALTER TABLE sync_peers ADD COLUMN plan_hash TEXT`,
      `ALTER TABLE sync_files ADD COLUMN plan_hash TEXT`,
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
      // The refusal itself must not be caught by the "does it exist" try (e2e's review: as
      // written, it was — a symlink at the final segment slipped through, harmless only because
      // rename() happens not to follow one, which is not a reason to leave the check broken).
      let finalSt = null;
      try { finalSt = fs.lstatSync(full); } catch {}
      if (finalSt && finalSt.isSymbolicLink()) throw Object.assign(new Error("a symlink is refused"), { code: "denied" });
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

    // the user overruled the original design: unpairing, turning sync off, or losing a device
    // deletes NOTHING. What came from a device is the person's, not the device's. Both events
    // below only stop new uploads (sync_on off, or the peer gone so peerOf finds nothing) and say
    // so (sync.revoked, informational); nothing here removes a file, a row or a derived fact.
    // Deleting is sync.delete, its own person-only action, elsewhere.
    const off = ctx.events.on("link.unpaired", e => {
      const p = e.payload || {};
      if (typeof p.name !== "string") return;
      db.prepare("UPDATE sync_peers SET sync_on = 0 WHERE peer = ?").run(String(p.peer || ""));
      ctx.events.emit("sync.revoked", { machine: p.name });
    });

    ctx.tool("sync.consent", {
      description: "Turn a paired peer's session import on or off, on the box's own record — never the device's say-so. Off only stops new uploads: nothing already sent is touched. sync.delete removes what a device sent, as its own action. planHash, when the surface computed one for the plan the person just reviewed, is stamped onto every file this consent lets land, so sync.delete.import can later remove just that import.",
      input: { type: "object", required: ["machine", "on"], properties: { machine: { type: "string" }, on: { type: "boolean" }, planHash: { type: "string" } } },
      // The person's own surfaces only, never a module (e2e's review: "module" let any home
      // module turn a device's import on). No presence needed to turn it off (ADR 0024); import
      // itself is not a secret action either, so this stays plain person-only, not presence-gated.
      callers: ["cli", "local", "deck", "capsule"],
      run: async ({ machine, on, planHash }) => {
        const peers = await ctx.call("link.peers", {});
        const row = (peers.data || []).find(p => p.id === machine || p.name === machine);
        if (!row) throw Object.assign(new Error(`no paired device named "${machine}"`), { code: "no_link" });
        syncRow(row.id, row.name);
        // Turning it on always sets plan_hash to whatever this call gave (or clears it, giving
        // none): a later approval without a planHash must not leave an earlier one in place for
        // new files to be silently tagged with (reviewer's LOW). Turning it off leaves plan_hash
        // alone — it stops new uploads either way, so it is nothing new files could be tagged with.
        if (on) db.prepare("UPDATE sync_peers SET sync_on = 1, plan_hash = ? WHERE peer = ?").run(planHash ? String(planHash) : null, row.id);
        else { db.prepare("UPDATE sync_peers SET sync_on = 0 WHERE peer = ?").run(row.id); ctx.events.emit("sync.revoked", { machine: row.name }); }
        return planHash ? { machine: row.name, on: Boolean(on), planHash: String(planHash) } : { machine: row.name, on: Boolean(on) };
      },
    });

    ctx.tool("sync.delete", {
      description: "Delete everything a device sent and everything derived from it: synced/<machine>/ and its quarantine, then sync.deleted. Its own person-only action, never implied by unpairing or turning sync off. Without confirm: true, answers a preview (file and byte counts) and deletes nothing; the person sees the counts, then calls it again with confirm: true.",
      input: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, confirm: { type: "boolean" } } },
      callers: ["cli", "local", "deck", "capsule"],
      run: async ({ machine, confirm }) => {
        const row = /** @type {any} */ (db.prepare("SELECT * FROM sync_peers WHERE peer = ? OR name = ?").get(machine, machine));
        if (!row) throw Object.assign(new Error(`no session data from "${machine}" is on this box`), { code: "no_link" });
        const n = /** @type {any} */ (db.prepare("SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM sync_files WHERE peer = ?").get(row.peer));
        if (!confirm) return { machine: row.name, files: n.files, bytes: n.bytes, deleted: false, confirm: "call again with confirm: true to delete" };
        db.prepare("DELETE FROM sync_files WHERE peer = ?").run(row.peer);
        db.prepare("DELETE FROM sync_peers WHERE peer = ?").run(row.peer);
        deleteSynced(row.name);
        ctx.events.emit("sync.deleted", { machine: row.name, files: n.files, bytes: n.bytes });
        return { machine: row.name, files: n.files, bytes: n.bytes, deleted: true };
      },
    });

    ctx.tool("sync.delete.import", {
      description: "Delete just one approved import's files — those sync.consent's planHash tagged as they landed — leaving anything a separately-approved plan sent for the same device untouched. Its own person-only action, same as sync.delete. Without confirm: true, answers a preview (file and byte counts) and deletes nothing.",
      input: { type: "object", required: ["machine", "planHash"], properties: { machine: { type: "string" }, planHash: { type: "string" }, confirm: { type: "boolean" } } },
      callers: ["cli", "local", "deck", "capsule"],
      run: async ({ machine, planHash, confirm }) => {
        const row = /** @type {any} */ (db.prepare("SELECT * FROM sync_peers WHERE peer = ? OR name = ?").get(machine, machine));
        if (!row) throw Object.assign(new Error(`no session data from "${machine}" is on this box`), { code: "no_link" });
        const rows = /** @type {any[]} */ (db.prepare("SELECT path, bytes FROM sync_files WHERE peer = ? AND plan_hash = ?").all(row.peer, String(planHash)));
        if (!rows.length) throw Object.assign(new Error(`no files from "${machine}" carry plan ${planHash}`), { code: "no_link" });
        const bytes = rows.reduce((sum, r) => sum + Number(r.bytes), 0);
        if (!confirm) return { machine: row.name, planHash: String(planHash), files: rows.length, bytes, deleted: false, confirm: "call again with confirm: true to delete" };
        const root = syncedRoot(row.name, row.peer);
        for (const r of rows) {
          // insideDir guards a weird stored path the same way safeDest does; unlink never follows
          // a symlink at the final segment, so a planted one is removed as a link, not chased.
          const full = path.join(root, ...String(r.path).split("/").filter(p => p && p !== "." && p !== ".."));
          if (insideDir(full, root)) { try { fs.rmSync(full, { force: true }); } catch {} }
        }
        db.prepare("DELETE FROM sync_files WHERE peer = ? AND plan_hash = ?").run(row.peer, String(planHash));
        db.prepare("UPDATE sync_peers SET used_bytes = MAX(0, used_bytes - ?) WHERE peer = ?").run(bytes, row.peer);
        ctx.events.emit("sync.deleted", { machine: row.name, planHash: String(planHash), files: rows.length, bytes });
        return { machine: row.name, planHash: String(planHash), files: rows.length, bytes, deleted: true };
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
        if (Number(bytes) > MAX_FILE) throw Object.assign(new Error(`a session file is at most ${MAX_FILE} bytes`), { code: "bad_input" });
        // A retry of the exact same upload resumes from what the temp file already holds; anything
        // else (a different hash, or none in flight) starts over from a fresh UUID temp name.
        const open = [...uploads.values()].filter(u => u.peer === peer.id);
        const existing = open.find(u => u.rel === rel && u.hash === hash);
        if (existing) { existing.at = now(); let got = 0; try { got = fs.statSync(existing.tmp).size; } catch {} return { upload: existing.id, offset: got }; }
        if (open.length >= MAX_OPEN) throw Object.assign(new Error(`"${peer.name}" already has ${MAX_OPEN} uploads open; finish or let one expire first`), { code: "too_many_open" });
        const limit = Number.isFinite(row.quota_bytes) && row.quota_bytes > 0 ? row.quota_bytes : DEFAULT_QUOTA;
        const had = /** @type {any} */ (db.prepare("SELECT bytes FROM sync_files WHERE peer = ? AND path = ?").get(peer.id, rel));
        const delta = Number(bytes) - (had ? Number(had.bytes) : 0);
        // In-flight declared bytes count against the quota too (e2e's review: many parallel
        // starts, none finished, each only checked against used_bytes, could each pass alone).
        const inFlight = open.reduce((sum, u) => sum + u.bytes, 0);
        if (row.used_bytes + inFlight + Math.max(0, delta) > limit) throw Object.assign(new Error(`"${peer.name}" is over its import quota (${row.used_bytes} of ${limit} bytes used, ${inFlight} more already starting)`), { code: "quota_exceeded" });
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
        // The quota was checked against what start() declared: a chunk that would grow the file
        // past that is refused rather than trusted, so a small declared size can't mask an
        // unbounded stream (e2e's review, the disk-fill bypass).
        if (have + buf.length > u.bytes) throw Object.assign(new Error(`this upload declared ${u.bytes} bytes and already holds more than that`), { code: "bad_input" });
        fs.appendFileSync(u.tmp, buf, { mode: 0o600 });
        u.got = have + buf.length;
        u.at = now();
        ctx.events.emit("sync.progress", { machine: peer.name, path: u.rel, bytes: u.got, total: u.bytes });
        return { offset: u.got };
      },
    });

    ctx.tool("sync.upload.cancel", {
      description: "Give up on an open upload before it finishes: drops its temp file and its slot, freeing one of the peer's " + MAX_OPEN + " open uploads without waiting for the idle sweep. Not an error if the id is already gone (finished, expired, or never existed) — cancel always succeeds.",
      input: { type: "object", required: ["upload"], properties: { upload: { type: "string" } } },
      callers: ["tailnet"],
      run: async ({ upload }, meta) => {
        const u = uploads.get(String(upload));
        if (!u) return { ok: true, cancelled: false };
        const peer = await peerOf(meta.peer);
        if (!peer || peer.id !== u.peer) throw Object.assign(new Error("this upload belongs to another device"), { code: "denied" });
        uploads.delete(String(upload));
        try { fs.rmSync(u.tmp, { force: true }); } catch {}
        return { ok: true, cancelled: true };
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
        const row = syncRow(peer.id, peer.name);
        uploads.delete(String(upload));
        // The real size on disk, not what start() declared (e2e's review: booking the declared
        // size let a small declared value hide a larger real one from the quota; chunk's own
        // check above already refuses more bytes than declared, but this is the number of record).
        let realBytes = 0;
        try { realBytes = fs.statSync(u.tmp).size; } catch { throw Object.assign(new Error("the upload is missing on the box"), { code: "denied" }); }
        if (realBytes > MAX_FILE) { try { fs.rmSync(u.tmp, { force: true }); } catch {} throw Object.assign(new Error(`a session file is at most ${MAX_FILE} bytes`), { code: "bad_input" }); }
        // Stream the file once: hash every byte as it goes by (e2e's review — reading the whole
        // file into one string to hash it undid MAX_FILE's own memory bound), and scrub-scan every
        // chunk too (reviewer's MEDIUM: scanning only a bounded prefix left a secret past that
        // point unquarantined and indexed by Recall). `tail` carries the last SCRUB_OVERLAP bytes
        // of what was already scanned into the next window, so a pattern split across a chunk
        // boundary is still caught.
        const hasher = crypto.createHash("sha256");
        let tail = Buffer.alloc(0);
        const found = new Set();
        try {
          for await (const chunk of fs.createReadStream(u.tmp)) {
            hasher.update(chunk);
            if (found.size < SCRUB_MAX_FOUND) {
              const window = tail.length ? Buffer.concat([tail, chunk]) : chunk;
              for (const label of scanText(window.toString("utf8"), { maxFound: SCRUB_MAX_FOUND }).found) found.add(label);
              tail = window.length > SCRUB_OVERLAP ? window.subarray(window.length - SCRUB_OVERLAP) : window;
            }
          }
        } catch { throw Object.assign(new Error("the upload is missing on the box"), { code: "denied" }); }
        const gotHash = hasher.digest("hex");
        if (String(hash) !== gotHash) { try { fs.rmSync(u.tmp, { force: true }); } catch {} throw Object.assign(new Error("the finished upload's hash does not match what was sent"), { code: "bad_input" }); }
        const scan = { safe: found.size === 0, found: [...found].slice(0, SCRUB_MAX_FOUND) };
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
        const delta = realBytes - (had ? Number(had.bytes) : 0);
        // Tagged with the peer's current plan_hash (sync.consent's own planHash, if the surface
        // gave one), so sync.delete.import can later remove just the files one approved import
        // plan produced, without touching a later, separately-approved plan's files.
        db.prepare("INSERT INTO sync_files (peer, path, hash, bytes, at, plan_hash) VALUES (?,?,?,?,?,?) ON CONFLICT (peer, path) DO UPDATE SET hash = excluded.hash, bytes = excluded.bytes, at = excluded.at, plan_hash = excluded.plan_hash")
          .run(peer.id, u.rel, gotHash, realBytes, now(), row.plan_hash || null);
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

/**
 * The device side: the sender import.start calls into (agreed with memory-iq, 28 Sep). Walks a
 * given file list through the box's sync.upload.plan/start/chunk/finish, module-only (never a
 * person or a model directly - import.start is the one door). Small control calls ride
 * ctx.remote (link.remote, JSON); the chunk bytes ride ctx.call("link.upload", ...) instead,
 * since link.remote cannot carry a Buffer over the wire the box's tools do.
 * @param {any} ctx
 */
/** Only core/sync itself and memory-iq's import module may trigger a send (e2e's review: "module" alone let any home module read and upload an arbitrary file). The label alone is not enough — a home module can name itself "import" too — so this is checked together with meta.firstParty (reviewer's LOW): the loader stamps that from the calling module's own directory, never from anything a manifest declares. */
const SEND_CALLERS = new Set(["module:sync", "module:import"]);

/** The person's own Claude Code folders: the only place sync.send may read a file from. */
function sessionRoots() {
  const home = os.homedir();
  const roots = [path.join(home, ".claude")];
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(process.env.CLAUDE_CONFIG_DIR);
  return roots.map(r => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
}

/** Resolve `p` for real (following symlinks) and refuse it unless it lands inside one of the person's own Claude folders. */
function allowedSessionPath(p) {
  let real;
  try { real = fs.realpathSync(String(p)); } catch (e) { throw Object.assign(new Error(/** @type {Error} */ (e).message), { code: "bad_input" }); }
  if (!sessionRoots().some(r => insideDir(real, r))) throw Object.assign(new Error(`${p} is not in this device's own Claude Code folder`), { code: "denied" });
  return real;
}

async function deviceSide(ctx) {
  ctx.tool("sync.send", {
    description: "Send this device's own files to the box: sync.upload.plan/start/chunk/finish per file, a per-file ack, and a completion summary (sync.sent, sent/failed/quarantined). mode: \"once\" sends this list and stops; \"sync\" is the same send, and the idle-batched watch for new and changed files after it is not yet built (see docs/work/federation.md). Only a file inside this device's own Claude Code folder (~/.claude or CLAUDE_CONFIG_DIR), no symlink escape, under the size cap, is ever read.",
    input: { type: "object", required: ["files", "mode"], properties: {
      files: { type: "array", items: { type: "object", required: ["path", "rel", "bytes", "hash"], properties: { path: { type: "string" }, rel: { type: "string" }, bytes: { type: "number" }, hash: { type: "string" } } } },
      mode: { type: "string", enum: ["once", "sync"] },
    } },
    callers: ["module"],
    run: async ({ files }, meta) => {
      if (!meta.firstParty || !SEND_CALLERS.has(String(meta.caller))) throw Object.assign(new Error("sync.send is core/sync's and core/import's own door, not a general module capability"), { code: "denied" });
      const byRel = new Map(files.map(f => [f.rel, f]));
      const plan = await ctx.remote("sync.upload.plan", { files: files.map(f => ({ path: f.rel, bytes: f.bytes, hash: f.hash })) });
      if (plan.error) return { sent: 0, failed: files.length, quarantined: 0, error: plan.error };
      const todo = [...plan.data.new, ...plan.data.changed].map(rel => byRel.get(rel)).filter(Boolean);
      let sent = 0, failed = 0, quarantined = 0;
      for (const f of todo) {
        const r = await sendOne(ctx, f);
        if (r.error) { failed++; ctx.events.emit("sync.sending", { path: f.rel, ok: false, error: r.error }); continue; }
        const q = Boolean(r.data && r.data.quarantined);
        if (q) quarantined++; else sent++;
        ctx.events.emit("sync.sending", { path: f.rel, ok: true, quarantined: q });
      }
      // The status line every other live-fact module in Vyre has (cohesion, 28 Sep): a "went
      // quiet" signal so a surface can say "synced from <machine>, just now" rather than nothing.
      ctx.events.emit("sync.sent", { sent, failed, quarantined, of: todo.length, skipped: plan.data.done.length });
      return { sent, failed, quarantined, of: todo.length, skipped: plan.data.done.length };
    },
  });
  return { async stop() {} };
}

/** Send one file's bytes, resuming from the box's own offset. @param {any} ctx @param {{ path: string, rel: string, bytes: number, hash: string }} f */
async function sendOne(ctx, f) {
  if (Number(f.bytes) > MAX_FILE) return { error: { code: "bad_input", message: `${f.path} is over the ${MAX_FILE} byte cap` } };
  let real;
  try { real = allowedSessionPath(f.path); } catch (e) { return { error: { code: /** @type {any} */ (e).code || "bad_input", message: /** @type {Error} */ (e).message } }; }
  const start = await ctx.remote("sync.upload.start", { path: f.rel, bytes: f.bytes, hash: f.hash });
  if (start.error) return start;
  let buf;
  try { buf = fs.readFileSync(real); } catch (e) { return { error: { code: "bad_input", message: /** @type {Error} */ (e).message } }; }
  if (buf.length > MAX_FILE) return { error: { code: "bad_input", message: `${f.path} is over the ${MAX_FILE} byte cap` } };
  let offset = Number(start.data.offset) || 0;
  while (offset < buf.length) {
    const chunk = buf.subarray(offset, Math.min(offset + SEND_CHUNK, buf.length));
    const r = await ctx.call("link.upload", { upload: start.data.upload, offset, data: chunk });
    if (r.error) return r;
    offset = Number(r.data ? r.data.offset : r.offset) || offset + chunk.length;
  }
  const gotHash = crypto.createHash("sha256").update(buf).digest("hex");
  return await ctx.remote("sync.upload.finish", { upload: start.data.upload, hash: gotHash });
}
