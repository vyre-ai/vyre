// kernel/storage/indexbackup.js: the pool's index, backed up into the pool (reviewer-3 S-11, the lead's gap). Chunks are useless without the index (which chunk is
// where, and the Drive's paths and versions), and the index lives on the home. So it is written, encrypted under the owner's key, to every storage node that may hold a
// backup, as `i/<seq>` and `i/latest`, on a schedule and after large changes. A new home, with the owner's key (derived from the master, so from the recovered identity),
// reads `i/latest` from any node, takes the highest sequence it can open, and rebuilds.
//
// Rollback: the sequence is authenticated (it is the associated data of the encryption) so a node cannot raise it, but it can serve an older one. Every backup
// therefore returns a head `{ seq, hash }`, which the kernel records where the owner's devices already hold checkpoints (the `storage.index` event); a restore given
// that head refuses anything older or different. A restore with no head can only take the highest sequence the reachable nodes hold, and says `unverified`.
// What is lost: anything written after the last backup (the controller backs up when enough has changed, so the window is small and `report` can say how big).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from("VYIX1");
const err = (code, message = code) => Object.assign(new Error(message), { code });
const hk = (key, info) => Buffer.from(crypto.hkdfSync("sha256", key, "vyre-pool", info, 32));
const aad = (owner, seq) => Buffer.from(`vyre-index-v1|${owner}|${seq}`);

const plain = payload => Buffer.from(JSON.stringify(payload));
export function sealIndex(key, owner, seq, payload) {
  const body = zlib.deflateRawSync(plain(payload)), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", hk(key, "index-enc"), iv);
  c.setAAD(aad(owner, seq));
  const s = Buffer.alloc(8); s.writeBigUInt64BE(BigInt(seq));
  return Buffer.concat([MAGIC, s, iv, c.update(body), c.final(), c.getAuthTag()]);
}
export function openIndex(key, owner, blob) {
  try {
    if (!blob || blob.length < MAGIC.length + 8 + 12 + 16 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const seq = Number(blob.readBigUInt64BE(MAGIC.length)), iv = blob.subarray(MAGIC.length + 8, MAGIC.length + 20), d = crypto.createDecipheriv("aes-256-gcm", hk(key, "index-enc"), iv);
    d.setAAD(aad(owner, seq)); d.setAuthTag(blob.subarray(-16));
    const raw = zlib.inflateRawSync(Buffer.concat([d.update(blob.subarray(MAGIC.length + 20, -16)), d.final()])), payload = JSON.parse(raw.toString());
    return payload.owner === owner && payload.seq === seq ? { seq, payload, hash: crypto.createHash("sha256").update(raw).digest("hex") } : null;
  } catch { return null; }
}

/** Write the index of a pool (and its Drive) to every online node that may hold a backup. @returns {Promise<{ seq: number, hash: string, at: number, copies: number, atRisk: boolean }>} */
export async function backupIndex({ pool, drive = null, key, owner, keep = 3 }) {
  const seq = (pool.ix.index_seq ?? 0) + 1, at = pool.now();
  const payload = { v: 1, owner, seq, at, pool: pool.ix, drive: drive ? drive.ix : null };
  const blob = sealIndex(key, owner, seq, payload), hash = crypto.createHash("sha256").update(plain(payload)).digest("hex");
  let copies = 0;
  for (const n of pool.nodes.values()) {
    if (n.home || !n.online || !pool.eligible(n) || (n.classes && !n.classes.has("backup"))) continue;
    try { await n.backend.put(`i/${seq}`, blob); await n.backend.put("i/latest", blob); copies++; if (seq > keep) await n.backend.del(`i/${seq - keep}`).catch(() => {}); } catch { n.online = false; n.offlineSince ??= pool.now(); }
  }
  pool.ix.index_seq = seq; pool.ix.index_at = at; pool.dirty = 0; pool.save(); if (drive) drive.save();
  return { seq, hash, at, copies, atRisk: copies < 1 };
}

/**
 * Rebuild a home's index from the pool alone. `nodes` are the storage nodes the new home can reach ({ id, backend }); `expected` is the head the owner's devices hold.
 * Writes index.json and drive.json into `dir`, drops locations on nodes that are gone (the dead home), and returns what to do next (`heal`).
 * @returns {Promise<{ seq: number, hash: string, at: number, unverified: boolean, lost_nodes: string[] }>}
 */
export async function restoreIndex({ dir, key, owner, nodes, expected = null }) {
  let best = null;
  for (const n of nodes) {
    let blob = null; try { blob = await n.backend.get("i/latest"); } catch { continue; }
    const o = openIndex(key, owner, blob); if (o && (!best || o.seq > best.seq)) best = o;
  }
  if (!best) throw err("no_index", "no reachable node holds an index for this owner");
  if (expected && (best.seq < expected.seq || (best.seq === expected.seq && best.hash !== expected.hash))) throw err("rollback", "the newest index the nodes hold is older than the one the owner's devices recorded");
  const have = new Set(nodes.map(n => n.id)), lost = new Set(), ix = best.payload.pool;
  for (const c of Object.values(ix.chunks)) { for (const id of c.nodes) if (!have.has(id)) lost.add(id); c.nodes = c.nodes.filter(id => have.has(id)); }
  ix.index_seq = best.seq; ix.pending = (ix.pending ?? []).filter(p => have.has(p.node));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(ix), { mode: 0o600 });
  if (best.payload.drive) fs.writeFileSync(path.join(dir, "drive.json"), JSON.stringify(best.payload.drive), { mode: 0o600 });
  return { seq: best.seq, hash: best.hash, at: best.payload.at, unverified: !expected, lost_nodes: [...lost] };
}
