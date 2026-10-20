// @ts-check
// core/files/agent-folder.js: Files > Agents > <agent> is the agent's folder ON ITS COMPUTER (owner decision, 20 Oct 2026). That folder (Inbox, Work, Done, Scripts, Notes and Downloads, in the
// agent's home on the computer) is the one real copy: Files reads and writes it there through the computers module (computers.agent.files, which runs each operation as the agent's own Linux user
// with computerd's path guard). Nothing syncs and nothing is copied. The trade-off the owner accepted: these files sit on the server's computer volume without the Drive's extra encryption and
// version history, and Files says so on the folder ("Kept on this agent's computer").
//
// The Drive tools route here for any path under agents/<agent id>/ (space-drive.js, space-edit.js, space-links.js), so the app keeps one Files screen and one set of calls. What the Drive alone
// has (versions, restore, links) is not offered for an agent's folder; the versions of the Drive copy from before stay readable for one release.
//
// THE RULE for who may open an agent's folder (AGENT_FOLDER_RULE, one place):
//   - a person, never an agent or a model: a caller that claims an agent, or carries a verified agent, is refused, and agents.level (asked as the person, the relay) refuses every caller that is
//     not a person's own surface, so an unnamed model session gets "none" too. An agent works in its own folder, on its own computer, as its own Linux user; it never reaches another agent's.
//   - see (list, read): Can use or Can edit on that agent. Can edit is its maker, the Space's owner, an admin, or a person it was shared with at Can edit; Can use is a person it was shared with
//     at Can use (core/agents/config.js levelOf, the kernel's grants). The same level that lets a person watch the agent's screen (computers.agent.watch).
//   - change (upload, new folder, move, rename, delete) and the move from the Drive: Can edit, the level that lets a person type in the agent's terminal or run a command as it.
//   - anyone else, including a member with no share: refused, and the folder is not listed in files.places either.
//
// The move from the Drive (owner, 20 Oct 2026): the first time a person who may change the agent opens its folder after this change (files.agent.open, which also starts the computer), the
// agent's old Drive folder (agents/<id>/) and its plain sessions folder are put into the computer folder, under Inbox at their old paths, NEVER over a file that is there (a different file gets
// a new name; the same bytes are skipped). Then the move is recorded (files_agent_moves) and the Drive copy is left as it was, read-only (nothing here writes it again, and restore refuses),
// for one release, so nothing is lost. Files too large to carry are named in the record and stay in the Drive.

import fs from "node:fs";
import path from "node:path";
import { isAgent } from "../../lib/caller.js";
import { whereIs, agentDir } from "../../lib/files/layout.js";
import { filesMigrations } from "./migrations.js";
import { createDoor } from "../../lib/gateway-door.js";

export const KEPT_NOTE = "Kept on this agent's computer: not in the Space Drive, so without the Drive's extra encryption and version history.";
export const WAKING = "Opening this agent's computer…";
/** Who may do what in an agent's folder, by the person's level on that agent (agents.level). */
export const AGENT_FOLDER_RULE = Object.freeze({ see: Object.freeze(["use", "edit"]), change: Object.freeze(["edit"]) });
/** The largest one file the move from the Drive carries; a larger one is named in the record and stays in the Drive. */
export const MOVE_MAX = 64 * 1024 * 1024;
/** The Drive copy stays read-only until this release, then a later change may remove it. */
export const KEEP_UNTIL = "0.6.5";
const FOLDER_MARK = ".folder";

export const AGENT_FOLDER_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS files_agent_moves (
     agent_uid TEXT PRIMARY KEY,
     state TEXT NOT NULL,
     at INTEGER NOT NULL,
     by TEXT,
     moved INTEGER NOT NULL DEFAULT 0,
     detail TEXT NOT NULL DEFAULT '{}',
     keep_until TEXT NOT NULL
   );`,
];

const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** The agent folder a Drive path is in: { uid, rest } for agents/<id> and anything under it, else null (the agents/ folder itself is the Drive's). @param {string} p */
export function agentPathOf(p) {
  const w = whereIs(String(p || "").replace(/\/+$/, ""));
  if (!w || w.kind !== "agent" || !w.id) return null;
  return { uid: w.id, rest: w.rest || "" };
}

/**
 * May this caller do this? Throws the plain refusal; returns nothing when allowed. `level` is agents.level's answer, asked as the person.
 * @param {any} meta @param {string} level @param {"see" | "change"} need
 */
export function mayOpen(meta, level, need) {
  if (isAgent(meta) || (meta && meta.agent)) throw refuse("An agent's folder is opened by a person in Files. An agent works in its own folder on its own computer and never opens another agent's.", "denied");
  if (!AGENT_FOLDER_RULE.see.includes(level)) throw refuse("You cannot open this agent's folder: ask its owner to share the agent with you.", "denied");
  if (need === "change" && !AGENT_FOLDER_RULE.change.includes(level)) throw refuse("You can see this agent's folder but not change it: ask its owner for Can edit.", "denied");
}

/** The name to show for a computer entry, as Drive listing entries: a folder is held by its folder mark, as an empty Drive folder is. @param {string} base @param {any[]} entries */
export function entriesOf(base, entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const name = String(e && e.name || "");
    if (!name || name.includes("/")) continue;
    const kind = e.kind === "link" ? e.to : e.kind;
    const at = typeof e.mtime === "number" ? e.mtime : 0;
    if (kind === "dir") out.push({ path: `${base}/${name}/${FOLDER_MARK}`, name: FOLDER_MARK, size: 0, ver: 0, at, ...(e.readOnly ? { read_only: true } : {}) });
    else if (kind === "file") out.push({ path: `${base}/${name}`, name, size: Number(e.size) || 0, ver: 1, at });
    // a link that leads out of the home, or anything that is neither, is not shown: it could not be opened
  }
  return out;
}

/**
 * The agent folder part of Files.
 * @param {any} ctx the files module's context
 * @param {{ plainRoot?: () => string | null }} [o] where vyred's plain sessions folders are (agents/<id> under it); core/agents keeps them beside the projects
 */
export function createAgentFolder(ctx, o = {}) {
  const plainRoot = o.plainRoot || (() => {
    const pd = ctx.config && typeof ctx.config.projectsDir === "string" && ctx.config.projectsDir ? path.dirname(ctx.config.projectsDir) : (ctx.paths && ctx.paths.root) || "";
    return pd || null;   // the same base core/agents/index.js uses for an agent's working folder (agentsBase)
  });
  let ready = false;
  const db = () => { if (!ready) { ctx.store.migrate(filesMigrations()); ready = true; } return ctx.store.db; };
  /** @type {Map<string, Promise<any>>} */ const moving = new Map();

  /** The computers module's answer, or its refusal as an error with its code. @param {any} input */
  async function computer(input) {
    let r;
    try { r = await ctx.call("computers.agent.files", input); }
    catch (e) { throw refuse(`this agent's computer could not be reached (${/** @type {Error} */ (e).message}): try again in a moment`, "unavailable"); }
    if (r && r.error) {
      if (r.error.code === "no_such_tool" || (r.error.code === "not_found" && /computers\.agent\.files|no such tool|unknown tool|no tool/i.test(String(r.error.message)))) throw refuse("Agent computers are not set up on this server, and an agent's files are kept on its computer, so this folder cannot open here. Ask the Space's owner to set up agent computers.", "unavailable");
      throw refuse(String(r.error.message || "the agent's computer refused"), String(r.error.code || "failed"));
    }
    return r && r.data !== undefined ? r.data : r;
  }

  /** The agent behind agents/<uid>, as the caller sees it (the kernel shows each person only the agent records they may read), and the caller's level on it. @param {any} d the door @param {any} meta @param {string} uid */
  async function agentFor(d, meta, uid) {
    if (isAgent(meta) || (meta && meta.agent)) mayOpen(meta, "none", "see");
    let rows = [];
    try { rows = (await d.gateway.records.query(d.chain, "agent", { page: { limit: 500 } })).rows || []; }
    catch (e) { const c = /** @type {any} */ (e).code; if (c !== "not_found" && c !== "unknown_type" && c !== "bad_input") throw e; }
    const row = rows.find((/** @type {any} */ r) => r && r.data && r.data.folder === agentDir(uid) && typeof r.data.name === "string");
    if (!row) throw refuse("there is no such agent folder, or it is not yours to open: files.places lists the agents you can open", "not_found");
    const name = String(row.data.name);
    let level = "none";
    try { const x = /** @type {any} */ (await ctx.call("agents.level", { agent: name }, { relay: true })); const v = x && x.data !== undefined ? x.data : x; level = v && !v.error && !x.error ? String(v.level) : "none"; }
    catch { level = "none"; }
    return { name, level };
  }

  /** @param {string} uid @param {string} rest */
  const base = (uid, rest) => (rest ? `${agentDir(uid)}/${rest}` : agentDir(uid));

  /** Put one file into the computer folder at `dest`, never over another: the same bytes there already is a skip, a different file gets a new name. @param {string} agent @param {string} dest @param {Buffer} bytes */
  async function place(agent, dest, bytes) {
    const parts = dest.split("/");
    for (let i = 1; i < parts.length; i++) {
      try { await computer({ agent, op: "mkdir", path: parts.slice(0, i).join("/") }); } catch (e) { if (/** @type {any} */ (e).code !== "conflict") throw e; }
    }
    const dot = parts[parts.length - 1].lastIndexOf("."), file = parts[parts.length - 1];
    const stem = dot > 0 ? file.slice(0, dot) : file, ext = dot > 0 ? file.slice(dot) : "", dir = parts.slice(0, -1).join("/");
    for (let n = 0; n < 50; n++) {
      const name = n === 0 ? file : `${stem} (${n === 1 ? "from before" : `from before ${n}`})${ext}`, at = dir ? `${dir}/${name}` : name;
      try { await computer({ agent, op: "write", path: at, base64: bytes.toString("base64"), overwrite: false }); return { at, kept: false }; }
      catch (e) {
        if (/** @type {any} */ (e).code !== "conflict") throw e;
        // something is there already: the same file is not copied twice
        try { const there = await computer({ agent, op: "read", path: at }); if (Buffer.from(String(there.base64 || ""), "base64").equals(bytes)) return { at, kept: true }; } catch { /* a folder, or too large to compare: pick another name */ }
      }
    }
    throw refuse(`no free name for ${dest}: rename a file in Inbox, then open the folder again`, "conflict");
  }

  /** The plain sessions folder's files, as relative paths, never following a link, at most 5,000. @param {string} dir */
  function plainFiles(dir) {
    /** @type {string[]} */ const out = [];
    const walk = (/** @type {string} */ rel) => {
      let names = []; try { names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        if (out.length >= 5000) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(r); else if (e.isFile() && e.name !== ".vyre-moved") out.push(r);
      }
    };
    walk("");
    return out;
  }

  /**
   * The move from the Drive and the plain sessions folder into the computer folder, once per agent, by a person who may change it. Never overwrites; records what it did.
   * @param {any} d @param {string} uid @param {string} agent @param {string} by
   */
  async function moveIn(d, uid, agent, by) {
    const done = /** @type {any} */ (db().prepare("SELECT * FROM files_agent_moves WHERE agent_uid = ?").get(uid));
    if (done && done.state === "done") return { moved: Number(done.moved), already: true };
    if (moving.has(uid)) return moving.get(uid);
    const run = (async () => {
      /** @type {{ from: string, path: string, at?: string, why?: string }[]} */ const notes = [];
      let moved = 0, driveRead = true;
      // the Drive folder, as this person sees it (their own grants decide what is read)
      if (d.gateway.drive) {
        let entries = [];
        try { entries = await d.gateway.drive.list(d.chain, `${agentDir(uid)}/`); }
        catch { driveRead = false; }
        for (const e of entries) {
          const p = String(e && (e.path ?? e.name) || ""), rel = p.slice(agentDir(uid).length + 1);
          if (!rel || rel.split("/").pop() === FOLDER_MARK || rel === ".vyre-moved") continue;
          if (typeof e.size === "number" && e.size > MOVE_MAX) { notes.push({ from: "drive", path: rel, why: "too large to carry: it stays in the Drive" }); continue; }
          try {
            const bytes = Buffer.from(await d.gateway.drive.get(d.chain, p, { maxBytes: MOVE_MAX }));
            const r = await place(agent, `Inbox/${rel}`, bytes);
            if (!r.kept) moved++;
            notes.push({ from: "drive", path: rel, at: r.at, ...(r.kept ? { why: "already there" } : {}) });
          } catch (err) { notes.push({ from: "drive", path: rel, why: String(/** @type {Error} */ (err).message).slice(0, 200) }); }
        }
      }
      // vyred's plain sessions folder for this agent: copied in the same way. It stays where it is, because sessions still run there until they run inside the computer.
      const root = plainRoot(), plain = root ? path.join(root, agentDir(uid)) : null;
      if (plain) {
        for (const rel of plainFiles(plain)) {
          try {
            const st = fs.statSync(path.join(plain, rel));
            if (st.size > MOVE_MAX) { notes.push({ from: "sessions", path: rel, why: "too large to carry: it stays in the sessions folder" }); continue; }
            const r = await place(agent, `Inbox/${rel}`, fs.readFileSync(path.join(plain, rel)));
            if (!r.kept) moved++;
            notes.push({ from: "sessions", path: rel, at: r.at, ...(r.kept ? { why: "already there" } : {}) });
          } catch (err) { notes.push({ from: "sessions", path: rel, why: String(/** @type {Error} */ (err).message).slice(0, 200) }); }
        }
      }
      const failed = notes.filter(n => n.why && n.why !== "already there" && !/too large/.test(n.why));
      // done only when everything that can be carried was: a failure (or a Drive this person may not read) is tried again at the next open
      const state = failed.length || !driveRead ? "partial" : "done";
      db().prepare("INSERT INTO files_agent_moves (agent_uid, state, at, by, moved, detail, keep_until) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_uid) DO UPDATE SET state = excluded.state, at = excluded.at, by = excluded.by, moved = files_agent_moves.moved + excluded.moved, detail = excluded.detail")
        .run(uid, state, Date.now(), by, moved, JSON.stringify({ notes: notes.slice(0, 500), drive_read: driveRead }), KEEP_UNTIL);
      if (state === "done" && plain) { try { fs.writeFileSync(path.join(plain, ".vyre-moved"), JSON.stringify({ to: "the agent's computer, Inbox", at: Date.now() }) + "\n", { flag: "wx" }); } catch { /* a mark only */ } }
      return { moved, state, notes: notes.length };
    })();
    moving.set(uid, run);
    try { return await run; } finally { moving.delete(uid); }
  }

  /** Has this agent's Drive copy been moved (and so is read-only)? @param {string} uid */
  const wasMoved = uid => Boolean(db().prepare("SELECT 1 FROM files_agent_moves WHERE agent_uid = ?").get(uid));

  return {
    agentPathOf, wasMoved,
    /** files.agent.open: start the agent's computer if it is not running, and on the first open by a person who may change the agent, move its Drive and sessions folders in. @param {any} d @param {any} meta @param {string} uid */
    async open(d, meta, uid) {
      const a = await agentFor(d, meta, uid);
      mayOpen(meta, a.level, "see");
      try { await computer({ agent: a.name, op: "open" }); }
      catch (e) { if (/** @type {any} */ (e).code === "waking") return { state: "waking", message: WAKING, note: KEPT_NOTE, can: a.level }; throw e; }
      let move = null;
      if (AGENT_FOLDER_RULE.change.includes(a.level)) {
        const hop = d.chain && d.chain.hops && d.chain.hops[0] && d.chain.hops[0].actor;
        move = await moveIn(d, uid, a.name, hop ? `${hop.kind}:${hop.id}` : "person");
      }
      return { state: "open", note: KEPT_NOTE, can: a.level, ...(move ? { moved: move } : {}) };
    },
    /** @param {any} d @param {any} meta @param {string} prefix */
    async list(d, meta, prefix) {
      const at = /** @type {{ uid: string, rest: string }} */ (agentPathOf(prefix));
      const a = await agentFor(d, meta, at.uid); mayOpen(meta, a.level, "see");
      const r = await computer({ agent: a.name, op: "list", path: at.rest });
      return { prefix: `${base(at.uid, at.rest)}/`, entries: entriesOf(base(at.uid, at.rest), r.entries), next: null, agent_folder: { note: KEPT_NOTE, can: a.level, truncated: Boolean(r.truncated) } };
    },
    /** @param {any} d @param {any} meta @param {string} p */
    async read(d, meta, p) {
      const at = /** @type {{ uid: string, rest: string }} */ (agentPathOf(p));
      const a = await agentFor(d, meta, at.uid); mayOpen(meta, a.level, "see");
      const r = await computer({ agent: a.name, op: "read", path: at.rest });
      return { path: p, version: null, size: Number(r.size) || 0, base64: String(r.base64 || "") };
    },
    /** An upload: a new file, or (with `base`, the person had it open) a new content for the one there. @param {any} d @param {any} meta @param {string} p @param {string} base64 @param {boolean} replace */
    async upload(d, meta, p, base64, replace) {
      const at = /** @type {{ uid: string, rest: string }} */ (agentPathOf(p));
      const a = await agentFor(d, meta, at.uid); mayOpen(meta, a.level, "change");
      if (!at.rest) throw refuse("name the file inside the agent's folder", "bad_input");
      const r = await computer({ agent: a.name, op: "write", path: at.rest, base64, overwrite: replace });
      return { path: p, version: 1, conflict: false, size: Number(r.size) || 0 };
    },
    /** @param {any} d @param {any} meta @param {string} p */
    async mkdir(d, meta, p) {
      const at = /** @type {{ uid: string, rest: string }} */ (agentPathOf(p));
      const a = await agentFor(d, meta, at.uid); mayOpen(meta, a.level, "change");
      await computer({ agent: a.name, op: "mkdir", path: at.rest });
      return { path: p };
    },
    /** A move or rename inside one agent's folder. @param {any} d @param {any} meta @param {string} from @param {string} to */
    async move(d, meta, from, to) {
      const f = agentPathOf(from), t = agentPathOf(to);
      if (!f || !t || f.uid !== t.uid) throw refuse("a file moves inside one agent's folder only: download it and upload it where it should go", "bad_input");
      if (!f.rest || !t.rest) throw refuse("the agent's folder itself does not move: move what is inside it instead", "bad_input");
      const a = await agentFor(d, meta, f.uid); mayOpen(meta, a.level, "change");
      await computer({ agent: a.name, op: "move", from: f.rest, to: t.rest });
      return { from, to, kind: "item", moved: 1 };
    },
    /** A delete moves the item to the agent's trash on its computer (never listed). @param {any} d @param {any} meta @param {string} p */
    async remove(d, meta, p) {
      const at = /** @type {{ uid: string, rest: string }} */ (agentPathOf(p));
      if (!at.rest) throw refuse("the agent's folder itself is not deleted here: delete what is inside it instead", "bad_input");
      const a = await agentFor(d, meta, at.uid); mayOpen(meta, a.level, "change");
      await computer({ agent: a.name, op: "trash", path: at.rest });
      return { path: p, kind: "item", deleted: 1 };
    },
  };
}

/** @type {WeakMap<object, ReturnType<typeof createAgentFolder>>} */
const made = new WeakMap();
/** The one agent folder part per files module (the Drive tools and files.agent.open share its record and its one-move-at-a-time lock). @param {any} ctx */
export function agentFolderOf(ctx) { let a = made.get(ctx); if (!a) { a = createAgentFolder(ctx); made.set(ctx, a); } return a; }

/** What the Drive alone does (restore, a link) is not offered for an agent's folder: its files are on its computer, which keeps no versions. */
export const NOT_IN_DRIVE = "This agent's files are kept on its computer, which keeps no versions or links. Download the file and put it in the Drive to share it. The Drive copy from before is read-only.";

/** files.agent.open, the one write the agent's folder needs before it is listed: it starts the agent's computer when it is not running, and moves the Drive folder in once. @param {any} ctx */
export function registerAgentFolder(ctx) {
  const door = createDoor(ctx), agents = agentFolderOf(ctx);
  ctx.tool("files.agent.open", {
    description: `Open an agent's folder in Files: { space?, path } where path is agents/<agent id> (files.places lists them). Its files are kept on the agent's computer: this starts the computer when it is not running (answering { state: "waking" } until it answers; ask again in a few seconds), and the first time a person who may change the agent opens it, puts the agent's old Drive folder and sessions folder into its Inbox, never over a file that is there. Answers { state, note, can: "use" | "edit", moved? }. Needs Can use on the agent; the move needs Can edit.`,
    input: { type: "object", required: ["path"], properties: { space: { type: "string" }, path: { type: "string" } } },
    callers: ["cli", "local", "deck", "capsule", "mobile", "device"],
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      const at = agentPathOf(String(i && i.path || ""));
      if (!at) throw refuse("path is an agent's folder, agents/<agent id>: files.places lists the ones you can open", "bad_input");
      const d = await door.open(i || {}, meta);
      return agents.open(d, meta, at.uid);
    },
  });
}
