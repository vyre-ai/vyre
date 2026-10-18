// @ts-check
// requests: asking to join a Space by its address (0.6.2; sec53's conditions in team/0.6/DESIGN-join-requests.md). A person with no invite asks a Space that takes requests; the owner or an admin sees the ask and answers it
// through the existing invite path (grants.invites.create with their own presence, then requests.decide links that invite to the ask); the asker then accepts the invite as any invitee does.
//
// What is kept, per Space and identity (one row; a second device of the same identity gets the same row): the identity id (from the door's verified chain, never typed), the device entry that signed the ask, the username the
// directory confirmed for it, the note (untrusted text, 200 characters, plain), times, the state, and the invite once approved. What an asker is ever told is fixed words (model.js).
// The setting "this Space takes requests" is OFF for every Space until its owner turns it on, with their presence.

import { isPerson } from "../../lib/caller.js";
import crypto from "node:crypto";
import { CLOSED_WORDS, ENTRY, IDENTITY, INVITE, LIMITS, NAME, SPACE, cleanNote, statusFor } from "./model.js";
import { createRequestsService } from "./service.js";

const MIGRATIONS = [
  `CREATE TABLE join_requests (id TEXT PRIMARY KEY, space TEXT NOT NULL, identity TEXT NOT NULL, entry TEXT NOT NULL, name TEXT, note TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, decided INTEGER, decided_by TEXT, invite TEXT, UNIQUE (space, identity))`,
  `CREATE TABLE join_settings (space TEXT PRIMARY KEY, accepting INTEGER NOT NULL, refused INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL)`,
];
const DOOR = "module:vyred";
const PERSON = /^per_[a-z2-7]{26}$/;
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const str = { type: "string" };

export default {
  async start(/** @type {any} */ ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const now = () => (typeof ctx.now === "function" ? ctx.now() : Date.now());
    /** @type {Map<string, number[]>} identity -> ask times in the last hour (kept in memory: the cap is per hour) */ const asks = new Map();
    /** @type {Map<string, number[]>} identity -> status reads in the last minute: an ask stream has no call count of its own */ const reads = new Map();
    const spaceOk = (/** @type {unknown} */ s) => { if (typeof s !== "string" || !SPACE.test(s)) throw refuse("That is not a Space.", "bad_input"); return s; };
    const accepting = (/** @type {string} */ space) => { const r = /** @type {any} */ (db.prepare("SELECT accepting FROM join_settings WHERE space = ?").get(space)); return Boolean(r && r.accepting); };
    const openRows = (/** @type {string} */ space) => /** @type {any[]} */ (db.prepare("SELECT * FROM join_requests WHERE space = ? AND state = 'open' AND created > ? ORDER BY created").all(space, now() - LIMITS.ttlMs));
    const closed = () => ({ state: "closed", words: CLOSED_WORDS });
    const noteRefusal = (/** @type {string} */ space) => { db.prepare("INSERT INTO join_settings (space, accepting, refused, updated) VALUES (?, 1, 1, ?) ON CONFLICT(space) DO UPDATE SET refused = refused + 1").run(space, now()); };

    /** The ask. Everything that is not a plain, allowed ask answers the same fixed words, so nothing says whether a Space exists, takes requests, is full or knows this person. */
    const doAsk = (/** @type {string} */ space, /** @type {string} */ person, /** @type {string | null} */ role, /** @type {any} */ i) => {
      if (!IDENTITY.test(person) || !ENTRY.test(String(i.entry || ""))) throw refuse("That is not a valid ask.", "bad_input");
      if (role) return closed();                                   // already a member
      if (!accepting(space)) return closed();                      // off, or not a Space that takes them
      const t = now();
      const mine = /** @type {any} */ (db.prepare("SELECT * FROM join_requests WHERE space = ? AND identity = ?").get(space, person));
      if (mine) {
        // a declined or expired ask may be made again after a day: the SAME row is reopened (one row per Space and identity), under the same caps below
        const endedAt = mine.state === "declined" ? Number(mine.decided || 0) : mine.state === "open" && t - mine.created >= LIMITS.ttlMs ? mine.created + LIMITS.ttlMs : null;
        if (endedAt === null || t - endedAt < LIMITS.askAgainMs) return statusFor(mine, t);   // the same row, never a second one, however many devices
        const recentA = (asks.get(person) || []).filter(x => t - x < LIMITS.hourMs);
        if (recentA.length >= LIMITS.perIdentityHour) { asks.set(person, recentA); return closed(); }
        if (openRows(space).length >= LIMITS.open) { noteRefusal(space); return closed(); }
        recentA.push(t); asks.set(person, recentA);
        db.prepare("UPDATE join_requests SET state = 'open', created = ?, entry = ?, note = ?, name = ?, decided = NULL, decided_by = NULL, invite = NULL WHERE id = ?").run(t, String(i.entry), cleanNote(i.note), typeof i.name === "string" && NAME.test(i.name) ? i.name : null, mine.id);
        ctx.events.emit("requests.asked", { space, request: mine.id });
        return { state: "waiting" };
      }
      const recent = (asks.get(person) || []).filter(x => t - x < LIMITS.hourMs);
      if (recent.length >= LIMITS.perIdentityHour) { asks.set(person, recent); return closed(); }
      if (openRows(space).length >= LIMITS.open) { noteRefusal(space); return closed(); }
      recent.push(t); asks.set(person, recent);
      const name = typeof i.name === "string" && NAME.test(i.name) ? i.name : null;
      const id = `req_${crypto.randomBytes(8).toString("hex")}`;
      db.prepare("INSERT INTO join_requests (id, space, identity, entry, name, note, state, created) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)").run(id, space, person, String(i.entry), name, cleanNote(i.note), t);
      ctx.events.emit("requests.asked", { space, request: id });
      return { state: "waiting" };
    };
    const doStatus = (/** @type {string} */ space, /** @type {string} */ person, /** @type {string | null} */ role) => {
      const t = now(), seen = (reads.get(person) || []).filter(x => t - x < 60_000);
      if (seen.length >= LIMITS.statusPerMinute) { reads.set(person, seen); return closed(); }
      seen.push(t); reads.set(person, seen);
      if (role) return closed();
      const mine = /** @type {any} */ (db.prepare("SELECT * FROM join_requests WHERE space = ? AND identity = ?").get(space, person));
      return mine ? statusFor(mine, now()) : closed();             // a person with no row learns no more than anyone: closed
    };
    const doList = (/** @type {string} */ space) => {
      const s = /** @type {any} */ (db.prepare("SELECT accepting, refused FROM join_settings WHERE space = ?").get(space));
      const rows = openRows(space).map(r => ({ id: r.id, identity: r.identity, entry: r.entry, name: r.name, note: r.note, created: r.created }));
      return { accepting: Boolean(s && s.accepting), requests: rows, refused: s ? Number(s.refused) : 0, open: rows.length, cap: LIMITS.open };
    };
    const doDecide = (/** @type {string} */ space, /** @type {string} */ by, /** @type {any} */ i) => {
      const row = /** @type {any} */ (db.prepare("SELECT * FROM join_requests WHERE id = ? AND space = ?").get(String(i.id || ""), space));
      if (!row || row.state !== "open") throw refuse("No such request is waiting.", "not_found");
      if (i.approve === true) {
        // approval is only through the existing invite path: the approver created an invite (their own presence) and names it here. The SPACE'S DOOR has already checked, under the approver's own chain, that it exists, is theirs,
        // unused and unexpired, grants no role above theirs; here it must also be made for THIS asker and not already linked to another ask.
        if (typeof i.invite !== "string" || !INVITE.test(i.invite) || typeof i.invite_id !== "string" || !i.invite.startsWith(i.invite_id)) throw refuse("Approve by creating the invite first, then name it.", "bad_input");
        if (i.invitee !== row.identity) throw refuse("That invite was not made for this person.", "bad_input");
        const taken = /** @type {any} */ (db.prepare("SELECT id FROM join_requests WHERE invite LIKE ? AND id != ?").get(`${i.invite_id}%`, row.id));
        if (taken) throw refuse("That invite is already linked to another request.", "bad_input");
        db.prepare("UPDATE join_requests SET state = 'approved', invite = ?, decided = ?, decided_by = ? WHERE id = ?").run(i.invite, now(), by, row.id);
      } else db.prepare("UPDATE join_requests SET state = 'declined', decided = ?, decided_by = ? WHERE id = ?").run(now(), by, row.id);
      ctx.events.emit("requests.decided", { space, request: row.id, approved: i.approve === true });
      return { ok: true };
    };
    const doClear = (/** @type {string} */ space, /** @type {string} */ by) => {
      db.prepare("UPDATE join_requests SET state = 'declined', decided = ?, decided_by = ? WHERE space = ? AND state = 'open'").run(now(), by, space);
      db.prepare("UPDATE join_settings SET refused = 0 WHERE space = ?").run(space);
      ctx.events.emit("requests.decided", { space, request: "*", approved: false });
      return { ok: true };
    };

    // ---- the owner's tools (a person at their own surface: never a model, never a module) --------------------------------------------------------------------------
    /** The person at the surface: the chain's person hop, else the box's owner. Recorded as who decided, so the audit says who. @param {any} meta */
    const personOf = (meta) => { const h = meta && Array.isArray(meta.hops) ? meta.hops.find((/** @type {any} */ x) => x && x.actor && x.actor.kind === "person") : null; return String(h ? h.actor.id : (ctx.kernel && ctx.kernel.owner) || "owner"); };
    const personOnly = (/** @type {any} */ meta) => { if (!isPerson(meta || {})) throw refuse("Only a person at their own device changes who may ask to join.", "denied"); };
    ctx.tool("requests.accepting", {
      effect: "read", callers: ["cli", "local", "deck", "capsule", "tailnet", "device"],
      description: "Whether a Space takes requests to join, and how many are waiting.",
      input: { type: "object", required: ["space"], properties: { space: str } },
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => { personOnly(meta); return doList(spaceOk(i.space)); },
    });
    ctx.tool("requests.accept", {
      effect: "write", callers: ["cli", "local", "deck", "capsule", "tailnet", "device"],
      description: "Turn on or off whether a Space takes requests to join (off by default). The owner's own presence.",
      presence: { when: () => true, summary: async (/** @type {any} */ i) => (i && i.accepting ? "Let people ask to join this Space" : "Stop taking requests to join this Space") },
      input: { type: "object", required: ["space", "accepting"], properties: { space: str, accepting: { type: "boolean" } } },
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        personOnly(meta);
        const space = spaceOk(i.space);
        db.prepare("INSERT INTO join_settings (space, accepting, refused, updated) VALUES (?, ?, 0, ?) ON CONFLICT(space) DO UPDATE SET accepting = excluded.accepting, updated = excluded.updated").run(space, i.accepting === true ? 1 : 0, now());
        ctx.events.emit("requests.setting", { space, accepting: i.accepting === true });
        return doList(space);
      },
    });
    ctx.tool("requests.list", {
      effect: "read", callers: ["cli", "local", "deck", "capsule", "tailnet", "device"],
      description: "The requests waiting for a Space: who asked (identity, device key, username), the note as plain text, and when.",
      input: { type: "object", required: ["space"], properties: { space: str } },
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => { personOnly(meta); return doList(spaceOk(i.space)); },
    });
    ctx.tool("requests.attention", {
      effect: "read", callers: ["cli", "local", "deck", "capsule", "tailnet", "device", "module"],
      description: "The requests waiting across the Spaces that take them, for the owner's Needs-you list: who asked (username the directory confirmed, device key) and when, never the note; and, when the open cap is full, how many asks were refused.",
      input: { type: "object", properties: {} },
      run: async (/** @type {any} */ _i, /** @type {any} */ meta = {}) => {
        // the approvals module is the only reader; another module is refused, and a person gets the list only when they are the box's owner
        const caller = String(meta.caller || "");
        if (caller.startsWith("module:")) { if (caller !== "module:approvals") throw refuse("Only the approvals list reads the requests waiting.", "denied"); }
        else { personOnly(meta); const owner = ctx.kernel && ctx.kernel.owner ? String(ctx.kernel.owner) : ""; if (owner && personOf(meta) !== owner) throw refuse("Only the Space's owner sees the requests waiting.", "denied"); }
        const t = now();
        const rows = /** @type {any[]} */ (db.prepare("SELECT id, space, identity, entry, name, created FROM join_requests WHERE state = 'open' AND created > ? ORDER BY created").all(t - LIMITS.ttlMs));
        const full = /** @type {any[]} */ (db.prepare("SELECT space, refused FROM join_settings WHERE accepting = 1 AND refused > 0").all());
        return { requests: rows.map(r => ({ id: r.id, space: r.space, identity: r.identity, entry: r.entry, name: r.name, at: r.created })), refusing: full.map(f => ({ space: f.space, refused: Number(f.refused), waiting: rows.filter(r => r.space === f.space).length })) };
      },
    });
    ctx.tool("requests.decide", {
      effect: "write", callers: ["cli", "local", "deck", "capsule", "tailnet", "device"],
      description: "Answer a request: approve it by naming the invite just made for that person (the invite itself needs the approver's own presence), or decline it.",
      input: { type: "object", required: ["space", "id"], properties: { space: str, id: str, approve: { type: "boolean" }, invite: str, clear: { type: "boolean" } } },
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        personOnly(meta);
        const space = spaceOk(i.space);
        // approving is made only through the Space's door, where the invite is checked under the approver's own chain (core/requests/service.js); this tool declines and clears
        if (i.approve === true) throw refuse("Approve through the Space's own door, with the invite you made for this person.", "bad_input");
        const by = personOf(meta);
        return i.clear === true ? doClear(space, by) : doDecide(space, by, i);
      },
    });

    // ---- the Space's door: the ask door's non-member and an admin's calls, from the Space's kernel (core/requests/service.js) --------------------------------------------
    ctx.tool("requests.serve", {
      internal: true, effect: "write",
      description: "A request call from the Space's remote server: ask and status for the person the door proved, list, decide and clear for an owner or admin the kernel names. Only the daemon's own door runs it.",
      input: { type: "object", required: ["call", "person", "space", "input"], properties: { call: str, person: str, role: { type: ["string", "null"] }, space: str, input: { type: "object" } } },
      run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => {
        if (String(meta.caller || "") !== DOOR) throw refuse("Only the Space's own door calls this.", "denied");
        const space = spaceOk(i.space), person = String(i.person), role = typeof i.role === "string" && i.role ? i.role : null;
        if (!PERSON.test(person)) throw refuse("That is not a person.", "bad_input");
        const input = i.input && typeof i.input === "object" ? i.input : {};
        switch (String(i.call)) {
          case "ask": return doAsk(space, person, role, input);
          case "status": return doStatus(space, person, role);
          case "list": case "decide": case "clear":
            if (role !== "owner" && role !== "admin") throw refuse("not found", "not_found");
            return i.call === "list" ? doList(space) : i.call === "clear" ? doClear(space, person) : doDecide(space, person, input);
          default: throw refuse("call is ask, status, list, decide or clear", "bad_input");
        }
      },
    });
    return { peerService: (/** @type {{ space: string, kernel: any, registry: any }} */ o) => createRequestsService(o) };
  },
};
