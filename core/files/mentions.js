// @ts-check
// mentions: files as a # tag. Typing #report in a chat searches the person's shared folders by file
// name; picking one tags that single file, and the thread the tag was sent in may read it.
//
// The mechanism (the picker, the fan-out, the chips) belongs to core/mentions; this is Drive's
// side of it: a search tool that runs as the asking person, and a resolve tool that only the
// sessions module (or the assistant) may call, which records "this thread may read this file".
// The grant is one file, remembered as its real path, so a link put in its place later reads
// nothing. files.drive.read honours it for a named agent in that thread (browse.js).

import fs from "node:fs";
import path from "node:path";

export const MIGRATIONS = [`
  CREATE TABLE files_mention_grants (
    thread TEXT NOT NULL,
    share TEXT NOT NULL,
    path TEXT NOT NULL,         -- relative to the share, no leading slash
    real TEXT NOT NULL,         -- the file's real path when it was tagged
    said TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (thread, share, path)
  );
`];

const refuse = (message, code = "denied") => Object.assign(new Error(message), { code });
const CALLERS = /^module:(sessions|assistant)$/;
const THREAD = /^[A-Za-z0-9_-]{1,100}$/;

/** Pure: an opaque tag id for a file in a share, and back. Share names never hold a colon. */
export const mentionId = (share, rel) => `${share}:${String(rel).replace(/^\/+/, "")}`;
export function parseMentionId(id) {
  const s = String(id || "");
  const i = s.indexOf(":");
  if (i < 1) return null;
  return { share: s.slice(0, i), rel: s.slice(i + 1) };
}

/**
 * @param {any} ctx
 * @param {{ store: any, folder: (p: string) => string, shares: () => Record<string, string>, resolveIn: Function }} d
 */
export function mentions(ctx, { folder, shares, resolveIn }) {
  const db = () => ctx.store.db;

  /** What browse.js asks: the real path this thread was given for exactly this file, or null. */
  const tagged = (thread, share, rel) => {
    try {
      const r = /** @type {any} */ (db().prepare("SELECT real FROM files_mention_grants WHERE thread = ? AND share = ? AND path = ?").get(thread, share, rel));
      return r ? String(r.real) : null;
    } catch { return null; }
  };

  // A tag's grant ends with its chat (an archived chat can come back, so archiving keeps it). Sessions emits thread.deleted with the thread's id; the
  // 30 day sweep is the net for a chat that went away some other way.
  const drop = e => {
    const p = (e && e.payload) || e || {};
    const id = String((e && e.thread) || p.thread || p.uuid || p.id || "");
    if (id) try { db().prepare("DELETE FROM files_mention_grants WHERE thread = ?").run(id); } catch { /* table not there yet */ }
  };
  try { ctx.events.on("thread.deleted", drop); } catch { /* no event bus in a bare test */ }
  try { db().prepare("DELETE FROM files_mention_grants WHERE at < ?").run(Date.now() - 30 * 86_400_000); } catch { /* same */ }

  ctx.tool("files.mentions.search", {
    description: "Files on the box's VyreDrive shares whose name matches what you typed after #, for tagging one in a chat. Runs as the person asking.",
    input: { type: "object", properties: { q: { type: "string" }, limit: { type: "integer" } } },
    callers: ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "space", "agent"],
    run: async ({ q = "", limit = 30 }) => {
      q = String(q || "").trim();
      limit = Math.min(50, Math.max(1, Number(limit) || 30));
      if (!q) return { items: [] };
      const r = await ctx.call("files.drive.search", { q, limit: limit * 2 });
      if (r.error) return { items: [] };
      const map = shares();
      const items = [];
      for (const d of (r.data && r.data.results) || []) {
        if (items.length >= limit) break;
        if (d.kind === "folder" || !Object.prototype.hasOwnProperty.call(map, d.share)) continue;
        let top;
        try { top = folder(map[d.share]); } catch { continue; }
        const rel = path.relative(top, String(d.path));
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
        items.push({ id: mentionId(d.share, rel), name: String(d.name), hint: `${d.share}/${path.dirname(rel) === "." ? "" : path.dirname(rel)}`.replace(/\/$/, ""), icon: "file" });
      }
      return { items };
    },
  });

  ctx.tool("files.mentions.resolve", {
    description: "Make a tagged file readable in the chat it was tagged in: records that thread and that one file, and tells the model how to read it. Only the sessions module or the assistant call it.",
    input: { type: "object", required: ["id", "thread"], properties: { id: { type: "string" }, thread: { type: "string" }, said: { type: "string" } } },
    callers: ["module"],
    run: async ({ id, thread, said }, meta = {}) => {
      if (!CALLERS.test(String(meta && meta.caller))) throw refuse("only the chat itself resolves a tag: tag the file again with # in the chat", "denied");
      const m = parseMentionId(id);
      if (!m || !THREAD.test(String(thread))) throw refuse("that file is not available (tag it again with # in the chat)", "not_found");
      let safe;
      try { ({ safe } = await resolveIn(m.share, m.rel, { caller: "module:files" })); } catch { throw refuse("that file is not available (tag it again with # in the chat)", "not_found"); }
      let st;
      try { st = fs.statSync(safe.real); } catch { throw refuse("that file is not available (tag it again with # in the chat)", "not_found"); }
      if (!st.isFile()) throw refuse("that is a folder, not a file (tag a file inside it)", "not_found");
      const rel = m.rel.replace(/^\/+/, "");
      db().prepare("INSERT OR REPLACE INTO files_mention_grants (thread, share, path, real, said, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(String(thread), m.share, rel, safe.real, said ? String(said) : null, Date.now());
      const name = path.basename(safe.path);
      return { name, hint: `${m.share}/${path.dirname(rel) === "." ? "" : path.dirname(rel)}`.replace(/\/$/, ""),
        note: `The person tagged the file "${rel}" in the share "${m.share}". Read it with files.drive.read {share: "${m.share}", path: "${rel}"}.`,
        grant: { read: mentionId(m.share, rel) } };
    },
  });

  return { tagged };
}
