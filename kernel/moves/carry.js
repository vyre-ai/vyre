// @ts-check
// kernel/moves/carry.js: a project's files move from one Space's Drive to another's without anyone reading them. `carryFiles(fromChain, toChain, { entries, move_id })` re-seals each file from the
// source Space's pool key to the target's, here, inside the home's kernel: the bytes go from the source pool (opened with the source Space's own key) into the target pool (sealed with the target's own
// key) and nowhere else. They are never returned, never handed to a module and never given to the mover: the answer is only `[{ dest, sha256 }]`, the hash of what is now stored in the target.
//
// It runs only for an open move: the kernel's own `project.move_started` for this `move_id` in the source Space, by the same one person who calls it, within a day; and that person must be an owner or
// an admin of BOTH Spaces (the restore act on the project's folder, the same one the move's survey and inventory rest on). A chat's files are its participants' only: the mover is not one, which is
// exactly why this is a kernel act and not a read.
//
// Resumable: a file already in the target with the entry's hash is not written again, so a move that stopped half way is run again with the same entries and finishes. The source is never changed here
// (its files are removed only after the target is verified, by the Drive gateway's removeMoved).
import { KernelError } from "../core/errors.js";

/** The raw Drive of each Space's kernel, kept here and nowhere on the kernel object a module can reach: only this file's carry opens it. @type {WeakMap<object, any>} */
const cores = new WeakMap();
/** @param {object} kernel the Space's booted kernel @param {any} drive its Drive (kernel/storage/drive.js) */
export function holdDrive(kernel, drive) { if (drive) cores.set(kernel, drive); return kernel; }

const DAY = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const SAFE = /^Projects\/[^/]+\/.+/;

/**
 * `entries[i].dest` may be left out when the caller gives `project_to` (the target project's folder id) and, for a chat's files, `chat_map` (old chat id -> the id of the chat the move made in the target, work.chat.carry's answer):
 * the file then lands at `Projects/<project_to>/<rest>` and a chat's own folders at `Projects/<project_to>/chat|made/<new chat id>/<rest>`; a chat's file whose chat is not in the map is refused (it would be orphaned).
 * @param {{ spaceOf: (space: string) => any }} o `spaceOf(id)` is the home's hosted handle for a Space (`spaces.for`): `{ kernel }`, whose log and `gateway.authorize` the carry uses, and whose Drive it holds through `holdDrive`
 */
export function createMoves(o) {
  const one = (/** @type {any} */ chain, /** @type {string} */ what) => {
    if (!chain || !Array.isArray(chain.hops) || chain.hops.length !== 1 || chain.hops[0].actor.kind !== "person" || typeof chain.space !== "string") throw new KernelError("bad_input", `${what} needs one person's chain`);
    return String(chain.hops[0].actor.id);
  };
  const side = (/** @type {any} */ chain, /** @type {string} */ what) => {
    const h = o.spaceOf(chain.space);
    const k = h && h.kernel;
    if (!k || !cores.get(k) || !k.gateway || typeof k.gateway.authorize !== "function") throw new KernelError("unavailable", `the ${what} Space has no Drive on this home`);
    return k;
  };
  return Object.freeze({
    /**
     * @param {any} fromChain the mover's chain in the source Space @param {any} toChain the same person's chain in the target Space
     * @param {{ entries: { path: string, dest: string, sha256: string, size: number }[], move_id: string }} q
     * @returns {Promise<{ dest: string, sha256: string }[]>}
     */
    async carryFiles(fromChain, toChain, q) {
      const who = one(fromChain, "a carry"), whoTo = one(toChain, "a carry");
      if (who !== whoTo) throw new KernelError("not_allowed", "a move is carried by one person in both Spaces");
      const upgrade = Boolean(q) && q.upgrade_id !== undefined;
      if (!q || (upgrade ? typeof q.upgrade_id !== "string" || q.move_id !== undefined : typeof q.move_id !== "string") || !Array.isArray(q.entries) || q.entries.length > MAX_ENTRIES) throw new KernelError("bad_input", "name the move and its files");
      if (fromChain.space === toChain.space) throw new KernelError("bad_input", "a move goes to another Space");
      const src = side(fromChain, "source"), dst = side(toChain, "target");
      // An open move (project.move_started) or an open upgrade of a Personal Space into My Cloud (space.upgrade_started, whose `to` is this target): the same person, within a day. An upgrade has no one project:
      // each file's own source project is checked below, with the same restore act.
      const ev = typeof src.log.read === "function" ? src.log.read({ type: upgrade ? "space.upgrade_started" : "project.move_started" }).find((/** @type {any} */ e) => e.data && (upgrade ? e.data.upgrade_id === q.upgrade_id && e.data.to === toChain.space && e.subject === `vyre://${fromChain.space}/space/upgrade` : e.data.move_id === q.move_id)) : null;
      if (!ev || !String(ev.actor).startsWith(`person:${who}@`) || !(Date.now() - Number(ev.time) <= DAY)) throw new KernelError("not_found", upgrade ? "no such upgrade" : "no such move");
      const id = upgrade ? "" : String(ev.subject).split("/").pop();
      const projOf = (/** @type {string} */ p) => { const m = /^Projects\/([^/]+)\/.+/.exec(p); return m ? m[1] : null; };
      // an owner or admin of both Spaces: the restore act on the project's folder (the move's own survey and inventory ask the same)
      const may = async (/** @type {any} */ k, /** @type {any} */ chain, /** @type {string} */ folder) => (await k.gateway.authorize({ chain, action: "drive.restore", resource: `vyre://${chain.space}/file/${folder}` })).effect === "allow";
      if (!upgrade && !(await may(src, fromChain, `Projects/${id}`))) throw new KernelError("not_found", "no such move");
      /** @type {Set<string>} source projects already checked for an upgrade */ const okSrc = new Set();
      /** @type {{ dest: string, sha256: string }[]} */ const out = [];
      const ID = /^[A-Za-z0-9_-]{1,64}$/;
      const map = q.chat_map && typeof q.chat_map === "object" ? q.chat_map : null;
      if (map && !Object.entries(map).every(([a, b]) => ID.test(a) && typeof b === "string" && ID.test(b))) throw new KernelError("bad_input", "the chat map names chats by id");
      if (q.project_to !== undefined && !(typeof q.project_to === "string" && ID.test(q.project_to))) throw new KernelError("bad_input", "name the target project");
      /** Where a file lands in the target, when the caller did not say: under the target project, a chat's folders under the chat the move made there. */
      const destOf = (/** @type {string} */ p) => {
        const rest = p.slice(`Projects/${projOf(p)}/`.length);
        const m = /^(chat|made)\/([^/]+)\/(.+)$/.exec(rest);
        if (!m) return `Projects/${q.project_to}/${rest}`;
        const to = map && Object.hasOwn(map, m[2]) ? map[m[2]] : null;
        if (!to) throw new KernelError("bad_input", "a chat's files need the chat the move made in the target");
        return `Projects/${q.project_to}/${m[1]}/${to}/${m[3]}`;
      };
      for (const raw of q.entries) {
        const e = raw && typeof raw === "object" && raw.dest === undefined && typeof raw.path === "string" && q.project_to !== undefined && projOf(raw.path) !== null && (upgrade || raw.path.startsWith(`Projects/${id}/`)) ? { ...raw, dest: destOf(raw.path) } : raw;
        if (!e || typeof e.path !== "string" || typeof e.dest !== "string" || typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(e.sha256) || !Number.isInteger(e.size)) throw new KernelError("bad_input", "a file to carry names its path, its destination, its hash and its size");
        if (upgrade) {
          const sp = projOf(e.path);
          if (sp === null || e.path.split("/").some((/** @type {string} */ x) => x === ".." || x === ".")) throw new KernelError("bad_input", "only a project's own files go, into a project folder");
          if (!okSrc.has(sp)) { if (!(await may(src, fromChain, `Projects/${sp}`))) throw new KernelError("not_found", "that folder is not yours to move"); okSrc.add(sp); }
        }
        if ((!upgrade && !e.path.startsWith(`Projects/${id}/`)) || !SAFE.test(e.dest) || e.dest.split("/").some(p => p === ".." || p === ".")) throw new KernelError("bad_input", "only the moved project's own files go, into a project folder");
        const destFolder = e.dest.split("/").slice(0, 2).join("/");
        if (!(await may(dst, toChain, destFolder))) throw new KernelError("not_found", "that folder is not yours to move into");
        // resume: already there with this hash
        let have = null; try { have = cores.get(dst).stat(e.dest, {}); } catch { have = null; }
        if (have && have.sha256 === e.sha256 && !have.deleted) { out.push({ dest: e.dest, sha256: String(have.sha256) }); continue; }
        let st; try { st = cores.get(src).stat(e.path, {}); } catch { throw new KernelError("not_found", "a file of the move is not in the source"); }
        if (st.sha256 !== e.sha256 || Number(st.size) !== e.size) throw new KernelError("conflict", "a file of the move is not what the plan approved");
        const bytes = await cores.get(src).get(e.path, {});
        await cores.get(dst).put(e.dest, bytes, { by: `person:${who}`, base: have ? have.version ?? null : null });
        const now = cores.get(dst).stat(e.dest, {});
        if (now.sha256 !== e.sha256) throw new KernelError("unavailable", "a carried file did not arrive intact");
        out.push({ dest: e.dest, sha256: String(now.sha256) });
      }
      return out;
    },
  });
}
