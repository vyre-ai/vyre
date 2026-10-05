// @ts-check
// Personal to My Cloud (user ruling, 0.2.9): the chats a person has in their Personal space move to their My Cloud space under the person's own chain in BOTH Spaces, inside the one approval the
// spaces module asks for. A chat keeps its id (a Space is its own namespace, and a chat's key ring is bound to the id), its title and its people; it is filed under the target's General project;
// its record and its folders (chat/ and made/) move with it, the files sealed through the move's own carry (`from.carry`), never read by the mover. Agents that exist in the target stay in it, others
// and people who are not members of the target are listed as `former`. Resumable: a chat already in the target is skipped.
import { carryChat } from "./chat-carry.js";

const CHAT = "chat-record", PROJECT = "project";

/** The folders a chat's files live in under its project's folder. @param {any} data */
const foldersOf = data => (data.drive && data.chat ? [`${data.drive}/chat/${data.chat}`, `${data.drive}/made/${data.chat}`] : []);

/**
 * What would move, read only. Counts go into the hash the person approves, so they are small and stable.
 * @param {{ from: any, rows: any[] }} o rows: the chat-records of the chats the person is in, in the source Space
 * @returns {Promise<{ counts: { chats: number, files: number, bytes: number }, blockers: string[], chats: string[] }>}
 */
export async function planUpgrade({ from, rows }) {
  let files = 0, bytes = 0;
  /** @type {string[]} */ const blockers = [];
  for (const r of rows) {
    if (r.data.status === "working") blockers.push(`"${r.data.title || r.data.chat}" is working: stop it or wait for it to finish`);
    for (const f of foldersOf(r.data)) {
      if (from.drive && typeof from.drive.survey === "function") { try { const sv = await from.drive.survey(from.chain, f); files += sv.files || 0; bytes += sv.bytes || 0; } catch { /* a folder that is not there holds nothing */ } }
    }
  }
  if (files && typeof from.carry !== "function") blockers.push("this kernel cannot carry a chat's sealed files between Spaces yet");
  return { counts: { chats: rows.length, files, bytes }, blockers, chats: rows.map(r => String(r.data.chat)).sort() };
}

/** The target's General project, made if it has none. @param {any} to */
async function generalIn(to) {
  const have = await to.records.query(to.chain, PROJECT, { filter: { field: "slug", op: "eq", value: "general" }, page: { limit: 1 } });
  if (have.rows && have.rows[0]) return have.rows[0];
  const made = await to.records.create(to.chain, PROJECT, { name: "General", slug: "general", status: "active", memory_scope: "project:general" });
  return to.records.update(to.chain, PROJECT, made.id, { drive_path: `Projects/${made.id}` }, made.version);
}

/**
 * Move the chats. A throw for one chat is named in `left` and does not stop the others.
 * @param {{ from: any, to: any, rows: any[], ports?: { move_id?: string } }} o
 * @returns {Promise<{ moved: number, files: number, left: { chat: string, why: string }[] }>}
 */
export async function runUpgrade({ from, to, rows, ports = {} }) {
  const general = await generalIn(to);
  const root = general.data.drive_path;
  let moved = 0, files = 0;
  /** @type {{ chat: string, why: string }[]} */ const left = [];
  for (const r of rows) {
    const id = String(r.data.chat);
    try {
      const there = await to.records.query(to.chain, CHAT, { filter: { field: "chat", op: "eq", value: id }, page: { limit: 1 } });
      if (!(there.rows && there.rows[0])) {
        const c = await carryChat({ to, src: r.data, newRoot: root, id });
        await to.records.create(to.chain, CHAT, { title: r.data.title, project: { urn: general.urn }, chat: c.chat, people: c.people.join(","), agents: c.agents.join(","), ...(c.former.length ? { former: c.former.join(",") } : {}), started: r.data.started, last_active: r.data.last_active, status: r.data.status === "working" ? "idle" : r.data.status, drive: root, location: `${root}/chat/${c.chat}/` });
      }
      if (from.drive && typeof from.drive.inventory === "function" && typeof from.carry === "function") {
        const inv = (await from.drive.inventory(from.chain, r.data.drive, { move_id: ports.move_id })).filter((/** @type {any} */ e) => e.chat && foldersOf(r.data).some(f => String(e.path).startsWith(`${f}/`)));
        const entries = inv.map((/** @type {any} */ e) => ({ path: e.path, dest: `${root}${String(e.path).slice(String(r.data.drive).length)}`, sha256: e.sha256, size: e.size }));
        if (entries.length) {
          const got = await from.carry(entries, { move_id: ports.move_id, to: to.space });
          const byPath = new Map((got || []).map((/** @type {any} */ g) => [g.dest, g.sha256]));
          for (const e of entries) if (e.sha256 && byPath.get(e.dest) !== e.sha256) throw new Error(`a chat file did not arrive intact (${e.path})`);
          files += entries.length;
          if (typeof from.drive.removeMoved === "function") await from.drive.removeMoved(from.chain, entries.map((/** @type {any} */ e) => e.path));
        }
      }
      await from.records.remove(from.chain, CHAT, r.id);
      moved++;
    } catch (e) { left.push({ chat: id, why: String(/** @type {Error} */ (e).message || e).slice(0, 200) }); }
  }
  return { moved, files, left };
}
