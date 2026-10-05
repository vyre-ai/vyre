// @ts-check
// memory.room.*: a project's memory moves between two Spaces of one home (team/0.3/DESIGN-memory-layers.md, flows' DESIGN-project-move.md). One approval, given where the move starts; these
// calls carry no second prompt, but each refuses unless the Space's own log holds the kernel's event for THIS move (project.move_started in the source, project.move_in in the target) for this
// project and plan hash.
//
// What moves is what is not derived: the project's writes (facts, notes, decisions agents and people filed), the corrections scoped to it, and the decisions read from its sessions with what the
// person did to them. The graph (nodes, edges, evidence) is derived from sessions, so the target derives it again from the sessions that arrive with the project; the Work engine's rows
// move with flows' own receipt. Four calls, in order:
//   offer   (target)  makes a one-use P-256 key for this move and returns its public half. The private half lives in this process's memory only and lapses with the move's hour.
//   export  (source)  reads the project's memory and seals it to that key: nothing but ciphertext leaves, and the receipt-to-be (a digest of the plain package) rides in the clear.
//   import  (target)  opens it, checks the digest, writes the rows under the target project (one transaction, idempotent), and returns the receipt.
//   forget  (source)  needs the receipt; recomputes the digest of what is still there (a project that changed since export is refused, nothing is lost unseen), removes the rows for good and leaves
//                     a `moved_to` marker (memory_moves) so a later read says where the memory went.

import crypto from "node:crypto";
import { newDeviceKey, wrapForDevice, unwrapWithDevice, seal, open, newKey, sha256 } from "../../lib/keywrap.js";

const HOUR = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });

/** A project as the slug memory keys its rows by: a project's urn (vyre://<space>/project/<id>) or a slug. @param {string} ref @param {{ slug: string, id?: string }[]} projects */
export function slugOf(ref, projects) {
  const r = String(ref || "").trim();
  if (!r) throw bad("name the project by its record urn");
  const last = r.split("/").pop() || r;
  const hit = projects.find(p => p.slug === r || p.slug === last || (p.id && (p.id === r || p.id === last)));
  if (hit) return hit.slug;
  if (!/^[a-z0-9][a-z0-9_-]{0,80}$/i.test(last)) throw bad("no such project");
  return last;
}

/** @param {any} v @returns {string} */
const canon = v => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v ?? null);

/**
 * @param {{ db: any, events: (type: string) => any[], clock?: () => number, space: string }} d `events(type)` reads this Space's own log.
 */
export function createMoves(d) {
  const clock = d.clock || Date.now;
  const db = d.db;
  /** move_id to { key, at } for offers held in memory only. @type {Map<string, { privateJwk: any, at: number, project: string, plan_hash: string }>} */
  const offers = new Map();

  /** The kernel's event for this move in this Space's own log, or a refusal. @param {"project.move_started"|"project.move_in"} type @param {{ move_id: string, plan_hash: string, project: string }} i */
  const proof = (type, i) => {
    if (!UUID.test(String(i.move_id)) || !HASH.test(String(i.plan_hash))) throw bad("a move names its move id and plan hash");
    const ev = d.events(type).find(e => e && e.data && e.data.move_id === i.move_id);
    const ok = ev && ev.data.plan_hash === i.plan_hash && (type === "project.move_started" ? ev.subject === i.project : ev.data.project === i.project) && clock() - Number(ev.time || 0) <= HOUR * 24;
    if (!ok) throw bad("no such move", "not_found");
    return ev;
  };

  /** The portable memory of one project, plain. @param {string} slug */
  const gather = slug => {
    const links = db.prepare("SELECT write, at FROM memory_write_links WHERE project = ? AND state = 'live' ORDER BY write").all(slug);
    const writes = links.map((/** @type {any} */ l) => db.prepare("SELECT * FROM memory_writes WHERE id = ? AND state = 'live'").get(l.write)).filter(Boolean);
    const decisions = db.prepare("SELECT * FROM memory_decisions WHERE project = ? ORDER BY id").all(slug);
    const corrections = db.prepare("SELECT action, src, rel, dst, object, at, scope, note, who, created, undone FROM memory_corrections WHERE scope = ? AND undone IS NULL ORDER BY id").all(slug);
    const fixes = db.prepare("SELECT at, project, topic, action, value, display, statement, source, undone FROM memory_decision_fixes WHERE project = ? ORDER BY id").all(slug);
    return { writes, links: links.map((/** @type {any} */ l) => ({ write: l.write, at: l.at })), decisions, corrections, fixes };
  };
  const counts = (/** @type {any} */ p) => ({ writes: p.writes.length, decisions: p.decisions.length, corrections: p.corrections.length, decision_fixes: p.fixes.length });

  return Object.freeze({
    /** Target side: a key for this move. @param {{ move_id: string, plan_hash: string, project: string }} i */
    offer(i) {
      proof("project.move_in", i);
      for (const [k, v] of offers) if (clock() - v.at > HOUR) offers.delete(k);
      const k = newDeviceKey();
      offers.set(i.move_id, { privateJwk: k.privateJwk, at: clock(), project: i.project, plan_hash: i.plan_hash });
      return { move_id: i.move_id, to_key: k.publicJwk };
    },

    /** Source side. @param {{ move_id: string, plan_hash: string, project: string, slug: string, to_key: any }} i */
    export(i) {
      proof("project.move_started", i);
      if (!i.to_key || i.to_key.kty !== "EC") throw bad("seal to the key the target's memory.room.offer returned");
      const plain = gather(i.slug);
      const body = canon({ v: 1, slug: i.slug, project: i.project, ...plain });
      const digest = sha256(body);
      const key = newKey();
      const aad = `room-move:${i.move_id}:${i.plan_hash}`;
      return { move_id: i.move_id, counts: counts(plain), digest, package: { v: 1, wrap: wrapForDevice(key, i.to_key, aad), box: seal(Buffer.from(body, "utf8"), key, aad) } };
    },

    /** Target side. @param {{ move_id: string, plan_hash: string, project: string, slug?: string, package: any }} i */
    import(i) {
      proof("project.move_in", i);
      const done = db.prepare("SELECT receipt FROM memory_moves WHERE move_id = ? AND side = 'in'").get(i.move_id);
      if (done) return JSON.parse(done.receipt);
      const o = offers.get(i.move_id);
      if (!o || o.project !== i.project || o.plan_hash !== i.plan_hash) throw bad("no offer is held for this move: ask memory.room.offer again", "not_found");
      const aad = `room-move:${i.move_id}:${i.plan_hash}`;
      let body;
      try { body = JSON.parse(Buffer.from(open(i.package.box, unwrapWithDevice(i.package.wrap, o.privateJwk, aad), aad)).toString("utf8")); } catch { throw bad("the package does not open with this move's key"); }
      const digest = sha256(canon(body));
      if (body.project !== i.project) throw bad("the package is for another project");
      const slug = i.slug || body.slug;
      // The rows say the project they belong to; here that is the target's slug. Ids are kept (a re-import is a no-op).
      db.exec("SAVEPOINT room_in");
      try {
        const w = db.prepare(`INSERT OR IGNORE INTO memory_writes (id, kind, text, subject, source_ref, from_kind, from_name, provider, thread, seq, untrusted, state, at, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const r of body.writes) w.run(r.id, r.kind, r.text, r.subject ?? null, r.source_ref ?? null, r.from_kind, r.from_name, r.provider ?? null, r.thread ?? null, r.seq ?? null, r.untrusted, r.state, r.at, r.updated);
        const l = db.prepare("INSERT OR IGNORE INTO memory_write_links (write, project, state, at) VALUES (?,?, 'live', ?)");
        for (const x of body.links) l.run(x.write, slug, x.at);
        const dc = db.prepare(`INSERT OR IGNORE INTO memory_decisions (id, session, seq, project, cwd, topic, label, value, display, statement, revert, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const r of body.decisions) dc.run(r.id, r.session, r.seq, slug, r.cwd, r.topic, r.label, r.value, r.display, r.statement, r.revert, r.decided_at);
        const c = db.prepare(`INSERT INTO memory_corrections (action, src, rel, dst, object, at, scope, note, who, created, undone) SELECT ?,?,?,?,?,?,?,?,?,?,NULL WHERE NOT EXISTS (SELECT 1 FROM memory_corrections WHERE scope = ? AND action = ? AND src = ? AND IFNULL(rel,'') = IFNULL(?,'') AND IFNULL(dst,'') = IFNULL(?,'') AND created = ?)`);
        for (const r of body.corrections) c.run(r.action, r.src, r.rel ?? null, r.dst ?? null, r.object ?? null, r.at ?? null, slug, r.note ?? null, r.who ?? null, r.created, slug, r.action, r.src, r.rel ?? null, r.dst ?? null, r.created);
        const f = db.prepare(`INSERT INTO memory_decision_fixes (fix, at, project, topic, action, value, display, statement, source, undone) SELECT 0,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM memory_decision_fixes WHERE project = ? AND at = ? AND topic = ? AND action = ?)`);
        for (const r of body.fixes) f.run(r.at, slug, r.topic, r.action, r.value ?? null, r.display ?? null, r.statement ?? null, r.source ?? null, r.undone ?? null, slug, r.at, r.topic, r.action);
        const receipt = { v: 1, move_id: i.move_id, project: i.project, plan_hash: i.plan_hash, space: d.space, slug, digest, counts: counts(body), at: clock(), derived: "the graph is derived again here from the sessions that arrive with the project" };
        db.prepare("INSERT INTO memory_moves (move_id, side, project, other, receipt, at) VALUES (?, 'in', ?, ?, ?, ?)").run(i.move_id, i.project, null, JSON.stringify(receipt), clock());
        db.exec("RELEASE room_in");
        offers.delete(i.move_id);
        return receipt;
      } catch (e) { db.exec("ROLLBACK TO room_in"); db.exec("RELEASE room_in"); throw e; }
    },

    /** Source side. @param {{ move_id: string, plan_hash: string, project: string, slug: string, receipt: any, to?: string }} i */
    forget(i) {
      proof("project.move_started", i);
      const r = i.receipt;
      if (!r || r.move_id !== i.move_id || r.project !== i.project || r.plan_hash !== i.plan_hash) throw bad("forgetting needs the receipt memory.room.import returned for this move");
      const now = gather(i.slug);
      const digest = sha256(canon({ v: 1, slug: i.slug, project: i.project, ...now }));
      if (digest !== r.digest) throw bad("this project's memory changed since it was exported; export and import it again before forgetting", "conflict");
      db.exec("SAVEPOINT room_out");
      try {
        for (const l of now.links) {
          db.prepare("DELETE FROM memory_write_links WHERE write = ? AND project = ?").run(l.write, i.slug);
          if (!db.prepare("SELECT 1 FROM memory_write_links WHERE write = ?").get(l.write)) db.prepare("DELETE FROM memory_writes WHERE id = ?").run(l.write);
        }
        db.prepare("DELETE FROM memory_decisions WHERE project = ?").run(i.slug);
        db.prepare("DELETE FROM memory_corrections WHERE scope = ?").run(i.slug);
        db.prepare("DELETE FROM memory_decision_fixes WHERE project = ?").run(i.slug);
        db.prepare("INSERT OR REPLACE INTO memory_moves (move_id, side, project, other, receipt, at) VALUES (?, 'out', ?, ?, ?, ?)").run(i.move_id, i.project, r.space || i.to || null, JSON.stringify({ moved_to: r.space || i.to || null, receipt: r }), clock());
        db.exec("RELEASE room_out");
      } catch (e) { db.exec("ROLLBACK TO room_out"); db.exec("RELEASE room_out"); throw e; }
      return { forgotten: counts(now), moved_to: r.space || i.to || null, move_id: i.move_id };
    },

    /** Where a project's memory went, if it moved. @param {string} project */
    movedTo(project) {
      const row = db.prepare("SELECT receipt FROM memory_moves WHERE project = ? AND side = 'out' ORDER BY at DESC LIMIT 1").get(project);
      return row ? JSON.parse(row.receipt).moved_to : null;
    },
  });
}
