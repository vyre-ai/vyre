// kernel/storage/pool.js: one owner's storage pool (DESIGN-space-storage.md, DESIGN-wink.md sections 3 and 6). The owner (a person or a space) pairs servers,
// computers and storage devices; the pool encrypts every chunk before it leaves, keeps each class at its copy count, heals when a node goes, drains
// before a node is released, and answers with one number. Nothing here talks to a network itself: a node is a backend (backends.js).
//
// Classes: hot data (the record database, the log, keys) is NEVER pooled, it stays on the home. working = home plus one replica. cold = two copies on
// different nodes. backup = at least one copy off the home. rebuildable (indexes, thumbnails, previews) is one copy and the first thing given up.
// The index (which chunk is where) lives on the home and is part of the space's own backup; chunk ids are keyed hashes, so the index reveals no content.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const CLASSES = Object.freeze({
  working: { copies: 2, home: true },
  cold: { copies: 2 },
  backup: { copies: 1, offHome: true },
  rebuildable: { copies: 1, evictable: true },
});
export const CHUNK = 1 << 20;
export const GRACE_MS = 10 * 60_000;
const err = (code, message = code) => Object.assign(new Error(message), { code });

export class Pool {
  /** @param {{ dir: string, key: Buffer, now?: () => number, graceMs?: number, chunk?: number, policy?: { ownedOnly?: boolean, regions?: string[] }, quotas?: Record<string, number> }} o */
  constructor({ dir, key, now = Date.now, graceMs = GRACE_MS, chunk = CHUNK, policy = {}, quotas = {} }) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw err("bad_key", "the pool key is 32 bytes");
    this.dir = dir; this.now = now; this.graceMs = graceMs; this.chunk = chunk; this.policy = policy; this.quotas = quotas; this.nodes = new Map();
    this.enc = Buffer.from(crypto.hkdfSync("sha256", key, "vyre-pool", "chunk-enc", 32)); this.mac = Buffer.from(crypto.hkdfSync("sha256", key, "vyre-pool", "chunk-id", 32));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "index.json");
    this.ix = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : { v: 1, chunks: {}, manifests: {}, meters: {}, log: [] };
  }
  save() { const t = `${this.file}.tmp`; fs.writeFileSync(t, JSON.stringify(this.ix), { mode: 0o600 }); fs.renameSync(t, this.file); }

  /** Offer a node. kind: server | computer | network_drive | cloud_volume | s3. copies: how many copies the node keeps inside itself (a SeaweedFS service at replication 010 is 2). */
  addNode({ id, backend, kind = "server", home = false, site = id, owned = true, region = null, offered = Infinity, copies = 1 }) {
    if (this.nodes.has(id)) throw err("exists");
    if (kind === "phone") throw err("phones_do_not_offer_storage");
    if (home && [...this.nodes.values()].some(n => n.home)) throw err("one_home");
    this.nodes.set(id, { id, backend, kind, home, site, owned, region, offered, copies, online: true, offlineSince: null, draining: false, deviceFree: Infinity });
    return id;
  }
  eligible(n) { return !(this.policy.ownedOnly && !n.owned) && !(this.policy.regions && !this.policy.regions.includes(n.region)); }
  used(id) { let u = 0; for (const c of Object.values(this.ix.chunks)) if (c.nodes.includes(id)) u += c.size; return u; }
  free(n) { return Math.max(0, Math.min(n.offered - this.used(n.id), n.deviceFree)); }
  frac(n) { return Number.isFinite(n.offered) ? this.free(n) / n.offered : 1; }
  /** A copy counts while its node is online, or has been away less than the grace period (it is expected back). */
  counts(n) { return n && this.eligible(n) && !n.draining && (n.online || this.now() - n.offlineSince < this.graceMs); }

  // Chunks: a keyed hash names them (so equal content dedupes inside the owner and nobody else can test for it), then compress, then AES-256-GCM.
  seal(plain) {
    const id = crypto.createHmac("sha256", this.mac).update(plain).digest("hex"), z = zlib.deflateRawSync(plain), body = z.length < plain.length ? Buffer.concat([Buffer.from([1]), z]) : Buffer.concat([Buffer.from([0]), plain]);
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", this.enc, iv); c.setAAD(Buffer.from(id));
    return { id, blob: Buffer.concat([iv, c.update(body), c.final(), c.getAuthTag()]) };
  }
  open(id, blob) {
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", this.enc, blob.subarray(0, 12)); d.setAAD(Buffer.from(id)); d.setAuthTag(blob.subarray(-16));
      const b = Buffer.concat([d.update(blob.subarray(12, -16)), d.final()]), plain = b[0] === 1 ? zlib.inflateRawSync(b.subarray(1)) : b.subarray(1);
      if (crypto.createHmac("sha256", this.mac).update(plain).digest("hex") !== id) return null;
      return plain;
    } catch { return null; }
  }

  needs(c) {
    const n = { copies: 0, home: false, offHome: false };
    for (const cls of Object.values(c.refs)) { const k = CLASSES[cls]; n.copies = Math.max(n.copies, k.copies); n.home ||= !!k.home; n.offHome ||= !!k.offHome; }
    return n;
  }
  held(c) { return c.nodes.map(i => this.nodes.get(i)).filter(n => this.counts(n)); }
  satisfied(c, n = this.needs(c), held = this.held(c)) {
    return held.reduce((a, x) => a + x.copies, 0) >= n.copies && (!n.home || held.some(x => x.home)) && (!n.offHome || held.some(x => !x.home));
  }
  /** The best node for one more copy: the home first when a working chunk has none, a different site from what already holds it, then the emptiest. */
  place(c, held, n) {
    const have = new Set(c.nodes), sites = new Set(held.map(x => x.site));
    const cand = [...this.nodes.values()].filter(x => x.online && this.counts(x) && !have.has(x.id) && this.free(x) >= c.size);
    const homeWanted = n.home && !held.some(x => x.home), offWanted = n.offHome && !held.some(x => !x.home);
    return cand.filter(x => !(offWanted && x.home)).sort((a, b) => (homeWanted ? (b.home - a.home) : 0) || (sites.has(a.site) - sites.has(b.site)) || this.frac(b) - this.frac(a))[0];
  }
  /** Bring one chunk up to its needs. `blob` is the ciphertext when the caller has it. @returns {Promise<{ missing: boolean }>} */
  async ensure(id, blob) {
    const c = this.ix.chunks[id];
    for (let guard = 0; guard < 8 && !this.satisfied(c); guard++) {
      const n = this.needs(c), t = this.place(c, this.held(c), n);
      if (!t) break;
      blob ??= await this.fetch(id);
      if (!blob) break;
      try { await t.backend.put(`c/${id}`, blob); c.nodes.push(t.id); } catch { t.online = false; t.offlineSince ??= this.now(); }
    }
    return { missing: !this.satisfied(c) };
  }
  async fetch(id) {
    const c = this.ix.chunks[id], order = c.nodes.map(i => this.nodes.get(i)).filter(Boolean).sort((a, b) => (b.online - a.online) || (b.home - a.home));
    for (const n of order) { if (!n.online) continue; try { const b = await n.backend.get(`c/${id}`); if (b && this.open(id, b)) return b; } catch { n.online = false; n.offlineSince ??= this.now(); } }
    return null;
  }

  /** Store bytes as one object in a class. @returns {Promise<{ id: string, size: number, atRisk: boolean }>} atRisk: not every copy the class wants could be placed yet. */
  async put(bytes, { class: cls = "cold", meter = null } = {}) {
    if (cls === "hot") throw err("hot_not_pooled", "the record database, the log and keys stay on the home");
    if (!CLASSES[cls]) throw err("bad_class");
    const buf = Buffer.from(bytes);
    if (meter && this.quotas[meter] !== undefined && (this.ix.meters[meter] ?? 0) + buf.length > this.quotas[meter]) throw err("quota", `${meter} is over its limit`);
    const id = crypto.randomBytes(16).toString("hex"), ids = []; let atRisk = false;
    for (let o = 0; o < Math.max(buf.length, 1); o += this.chunk) {
      const { id: cid, blob } = this.seal(buf.subarray(o, o + this.chunk)); ids.push(cid);
      const c = this.ix.chunks[cid] ??= { size: blob.length, nodes: [], refs: {} };
      c.refs[id] = cls;
      let r = await this.ensure(cid, blob);
      if (r.missing && !c.nodes.length) { await this.evict(c.size); r = await this.ensure(cid, blob); }
      if (!c.nodes.length) { await this.drop(ids, id); throw err("no_room", "no node has room for this"); }
      atRisk ||= r.missing;
    }
    this.ix.manifests[id] = { size: buf.length, chunks: ids, class: cls, meter, at: this.now() };
    if (meter) this.ix.meters[meter] = (this.ix.meters[meter] ?? 0) + buf.length;
    this.ix.log.push([this.now(), buf.length]); this.ix.log = this.ix.log.filter(([t]) => t > this.now() - 14 * 86_400_000); this.save();
    return { id, size: buf.length, atRisk };
  }
  async get(id) {
    const m = this.ix.manifests[id]; if (!m) throw err("not_found");
    const parts = [];
    for (const cid of m.chunks) { const blob = await this.fetch(cid), p = blob && this.open(cid, blob); if (!p) throw err("unavailable", "no healthy copy of part of this is reachable right now"); parts.push(p); }
    return Buffer.concat(parts);
  }
  /** Let go of an object's hold on its chunks; a chunk nobody holds is deleted from every node that has it. */
  async drop(ids, mid) {
    for (const cid of ids) {
      const c = this.ix.chunks[cid]; if (!c) continue; delete c.refs[mid];
      if (!Object.keys(c.refs).length) { for (const nid of c.nodes) { try { await this.nodes.get(nid)?.backend.del(`c/${cid}`); } catch { /* an offline node keeps an orphan until it is cleaned */ } } delete this.ix.chunks[cid]; }
    }
  }
  async remove(id) {
    const m = this.ix.manifests[id]; if (!m) return false;
    delete this.ix.manifests[id]; if (m.meter) this.ix.meters[m.meter] -= m.size;
    await this.drop(m.chunks, id); this.save(); return true;
  }
  /** Give up rebuildable things (indexes, thumbnails, previews) to make `bytes` of room. Never anything else. */
  async evict(bytes) {
    let freed = 0;
    for (const [mid, m] of Object.entries(this.ix.manifests)) { if (freed >= bytes) break; if (CLASSES[m.class].evictable) { freed += m.size; await this.remove(mid); } }
    return freed;
  }

  /** Check every node, note who is away, and return the ids that changed state. */
  async probe() {
    const changed = [];
    for (const n of this.nodes.values()) {
      const was = n.online;
      try { const f = await n.backend.ping(); n.online = true; n.offlineSince = null; n.deviceFree = f ?? Infinity; } catch { n.online = false; n.offlineSince ??= this.now(); }
      if (was !== n.online) changed.push(n.id);
    }
    return changed;
  }
  /** Bring every chunk to its needs: copies lost with a node that is gone past the grace period are made again elsewhere. */
  async heal() {
    let copied = 0; const atRisk = [], lost = [];
    for (const [cid, c] of Object.entries(this.ix.chunks)) {
      if (this.satisfied(c)) continue;
      const before = c.nodes.length;
      if (!(await this.fetch(cid))) { lost.push(cid); continue; }
      const r = await this.ensure(cid); copied += c.nodes.length - before; if (r.missing) atRisk.push(cid);
    }
    this.save(); return { copied, atRisk: atRisk.length, unreachable: lost.length };
  }
  /** Withdraw a node: copy everything off first, then release it. Refuses when the others have no room. */
  async drain(id) {
    const n = this.nodes.get(id); if (!n) throw err("not_found");
    const mine = Object.entries(this.ix.chunks).filter(([, c]) => c.nodes.includes(id));
    const room = [...this.nodes.values()].filter(x => x.id !== id && x.online && this.counts(x)).reduce((a, x) => a + this.free(x), 0);
    if (room < mine.reduce((a, [, c]) => a + c.size, 0)) throw err("no_room", "the other places do not have room for what is here");
    n.draining = true;
    const r = await this.heal();
    if (r.atRisk || r.unreachable) throw err("drain_incomplete", "some of it could not be copied yet; the node stays");
    let bytes = 0;
    for (const [cid, c] of mine) { try { await n.backend.del(`c/${cid}`); } catch { /* the node is being released anyway */ } c.nodes = c.nodes.filter(i => i !== id); bytes += c.size; }
    this.nodes.delete(id); this.save(); return { moved: bytes };
  }
  /** A node is lost for good: forget where it held things, then heal makes the copies again. */
  forget(id) { this.nodes.delete(id); for (const c of Object.values(this.ix.chunks)) c.nodes = c.nodes.filter(i => i !== id); this.save(); }

  /** The one number and what to say about it. usable is bytes after copies, never raw. */
  report() {
    const live = [...this.nodes.values()].filter(n => n.online && this.counts(n)), raw = live.reduce((a, n) => a + this.free(n), 0);
    let stored = 0, weighted = 0; const onlyHere = new Map();
    for (const c of Object.values(this.ix.chunks)) { const k = this.needs(c).copies; stored += c.size; weighted += c.size * k; }
    const avg = stored ? weighted / stored : 2, usable = Math.floor(raw / avg);
    const week = this.ix.log.reduce((a, [, b]) => a + b, 0) / 2, runway = week > 0 && Number.isFinite(usable) ? usable / week : null;
    const nudges = [];
    for (const n of this.nodes.values()) if (!n.online && this.now() - n.offlineSince >= 0) {
      for (const c of Object.values(this.ix.chunks)) if (c.nodes.includes(n.id) && !this.held(c).some(x => x.id !== n.id)) onlyHere.set(n.id, true);
      nudges.push(onlyHere.get(n.id) ? `${n.id} is offline and some things live only there.` : `${n.id} is offline. Everything on it also lives elsewhere. Nothing is at risk.`);
    }
    if (Object.values(this.ix.chunks).some(c => this.needs(c).offHome) && ![...this.nodes.values()].some(n => !n.home && this.counts(n))) nudges.push("Backups need a second place.");
    if (Object.values(this.ix.chunks).some(c => !this.satisfied(c))) nudges.push("Some things have fewer copies than they should. Healing is on it.");
    if (runway !== null && runway < 8) nudges.push(`Room for about ${Math.max(1, Math.round(runway))} more weeks. Add storage?`);
    return { usable, raw_free: raw, stored, places: this.nodes.size, nodes: [...this.nodes.values()].map(n => ({ id: n.id, kind: n.kind, home: n.home, online: n.online, draining: n.draining, used: this.used(n.id), free: this.free(n) })), nudges, runway_weeks: runway };
  }
}
