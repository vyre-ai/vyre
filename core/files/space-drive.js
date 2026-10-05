// @ts-check
// core/files/space-drive.js: the Space's own Drive (kernel/storage/drive.js, behind kernel/gateway/drive.js) for the app: upload a new version of a file, list a file's versions, restore one.
// Not the box's shared folders (files.drive.list and files.drive.read in browse.js are those). Every call is the CALLER'S own chain in the Space it names (lib/gateway-door.js): a call that proved
// no person is refused, the kernel's `drive.write`, `drive.read` and `drive.restore` grants decide, a path is checked in one form (kernel/seal/uses.js safePath) and an upload is size-capped.
// A Space with no Drive wired answers `unavailable`.
import { createDoor } from "../../lib/gateway-door.js";
import { safePath } from "../../kernel/seal/uses.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const CALLERS = ["cli", "local", "deck", "capsule", "mobile", "device"];
/** The most one upload call carries, decoded. A larger file goes through the Flow or the VyreDrive mount, not a tool call. */
export const MAX_UPLOAD = 8 * 1024 * 1024;


/**
 * The Project hub names its Drive folders by id (Projects/<project id>/chat|made/<session id>/), so a screen shows the project's and the session's own names over them. Answered for the folders the
 * entries are in, under the caller's own chain (a record the caller cannot read has no name here, and the id shows). { "Projects/<id>": "Rivera Estate", "Projects/<id>/chat/<thread>": "Draft the welcome email" }.
 * @param {any} d @param {any[]} entries @returns {Promise<Record<string, string>>}
 */
async function namesOf(d, entries) {
  /** @type {Record<string, string>} */ const names = {};
  const seen = new Set();
  for (const e of entries) {
    const p = String((e && (e.path ?? e.name)) ?? e);
    const m = /^Projects\/([^/]+)(?:\/(chat|made)\/([^/]+))?/.exec(p);
    if (!m) continue;
    const root = `Projects/${m[1]}`;
    if (!seen.has(root)) {
      seen.add(root);
      try { const rec = await d.gateway.records.get(d.chain, "project", m[1]); if (rec && rec.data.name) names[root] = String(rec.data.name); } catch { /* not readable: the id shows */ }
    }
    if (m[2]) {
      const folder = `${root}/${m[2]}/${m[3]}`;
      if (!seen.has(folder)) {
        seen.add(folder);
        try {
          const page = await d.gateway.records.query(d.chain, "session-summary", { filter: { field: "thread", op: "eq", value: m[3] }, page: { limit: 1 } });
          const rec = page.rows[0];
          if (rec && rec.data.title) names[folder] = String(rec.data.title);
        } catch { /* not readable: the id shows */ }
      }
    }
  }
  return names;
}

/**
 * The session folders of a project, for a screen that lists `Projects/<id>/chat` or `.../made`: each session record the caller may read (they are visible to the project) as a folder with its own name
 * and whether the caller may open it. A chat the caller is not in still shows its name, and `open: false` tells the screen not to offer it; the kernel refuses the open all the same. A project the
 * caller cannot read has no records to show, so it is not here at all, not even as an id.
 * @param {any} d @param {any} drive @param {string} prefix @returns {Promise<{ path: string, name: string, open: boolean }[]>}
 */
async function foldersOf(d, drive, prefix) {
  const m = /^Projects\/([^/]+)\/(chat|made)\/$/.exec(prefix);
  if (!m) return [];
  /** @type {{ path: string, name: string, open: boolean }[]} */ const out = [];
  try {
    const project = await d.gateway.records.get(d.chain, "project", m[1]);
    if (!project) return [];
    const page = await d.gateway.records.query(d.chain, "session-summary", { filter: { field: "project", op: "eq", value: { urn: project.urn } }, page: { limit: 200 } });
    for (const rec of page.rows) {
      const thread = String(rec.data.thread || "");
      if (!thread) continue;
      const path = `Projects/${m[1]}/${m[2]}/${thread}`;
      let open = true;
      try { await drive.listPage(d.chain, `${path}/`, { limit: 1 }); } catch { open = false; }
      out.push({ path, name: String(rec.data.title || thread), open });
    }
  } catch { /* nothing readable here */ }
  return out;
}

/** @param {any} ctx */
export function registerSpaceDrive(ctx) {
  const door = createDoor(ctx);
  /** @param {string} name @param {string} description @param {any} input @param {(i: any, d: any, drive: any) => Promise<any>} fn */
  const tool = (name, description, input, fn) => ctx.tool(name, { description, input, callers: CALLERS, run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
    const d = await door.open(i || {}, meta);
    if (!d.gateway.drive) throw refuse("this Space has no Drive yet", "unavailable");
    return fn(i || {}, d, d.gateway.drive);
  } });
  const pathOf = (/** @type {any} */ p) => { try { return safePath(String(p ?? "")); } catch { throw refuse("that is not a path in the Drive: no leading slash, dot segments, backslash, encoded slash or control characters", "bad_input"); } };

  tool("files.drive.upload", `Put a file in the Space's Drive as a new version, under the caller's own grants: { space?, path, base64, base? }. \`path\` is relative (Clients/A/retainer.pdf), \`base64\` the bytes (at most ${MAX_UPLOAD / 1048576} MB here), \`base\` the version you edited from (a second writer on one file makes a new version flagged conflict, never a merge). Answers { path, version, conflict }.`,
    obj({ space: str, path: str, base64: str, base: { type: "integer" } }, ["path", "base64"]), async (i, d, drive) => {
      const p = pathOf(i.path), text = String(i.base64 ?? "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw refuse("base64 is the file's bytes, standard base64", "bad_input");
      // Check the size before decoding: 4 base64 characters carry 3 bytes.
      if (Math.floor(text.length / 4) * 3 > MAX_UPLOAD + 3) throw refuse(`a file here is at most ${MAX_UPLOAD / 1048576} MB; a larger one goes through a Flow or the VyreDrive mount`, "too_large");
      const bytes = new Uint8Array(Buffer.from(text, "base64"));
      if (bytes.length > MAX_UPLOAD) throw refuse(`a file here is at most ${MAX_UPLOAD / 1048576} MB; a larger one goes through a Flow or the VyreDrive mount`, "too_large");
      if (i.base !== undefined && (!Number.isInteger(i.base) || i.base < 1)) throw refuse("base is a version number", "bad_input");
      const r = await drive.put(d.chain, p, bytes, { base: i.base ?? null });
      return { path: p, version: r.version, conflict: Boolean(r.conflict), size: bytes.length };
    });

  tool("files.drive.versions", "The versions of one file in the Space's Drive, newest last, under the caller's own grants: { space?, path, after?, limit? }. Answers { path, versions: [{ ver, size, at, by, ... }], next } (at most `limit`, default 200, at most 1,000, those after version `after`; `next` is the version to pass as `after`, or null); a file the caller may not read is the same as one that is not there.",
    obj({ space: str, path: str, after: { type: "integer" }, limit: { type: "integer" } }, ["path"]), async (i, d, drive) => {
      const p = pathOf(i.path);
      if (i.after !== undefined && (!Number.isInteger(i.after) || i.after < 0)) throw refuse("after is a version number", "bad_input");
      if (i.limit !== undefined && (!Number.isInteger(i.limit) || i.limit < 1)) throw refuse("limit is a positive number", "bad_input");
      const limit = Math.min(i.limit ?? 200, 1000), rest = (await drive.history(d.chain, p)).filter((/** @type {any} */ v) => v.ver > (i.after ?? 0));
      return { path: p, versions: rest.slice(0, limit), next: rest.length > limit ? rest[limit - 1].ver : null };
    });

  tool("files.drive.restore", "Restore an old version of a file in the Space's Drive as a NEW version (nothing is lost): { space?, path, version }. The person's own act with their presence proof, which rides beside the request. Answers { path, from, version }.",
    obj({ space: str, path: str, version: { type: "integer" } }, ["path", "version"]), async (i, d, drive) => {
      const p = pathOf(i.path);
      if (!Number.isInteger(i.version) || i.version < 1) throw refuse("name a version number", "bad_input");
      const r = await drive.restore(d.chain, p, i.version, d.proof ? { presence: d.proof } : {});
      return { path: p, from: i.version, version: r.version };
    });

  tool("files.drive.space.list", "The files in the Space's Drive under a folder, under the caller's own grants: { space?, prefix?, limit?, after? }. Answers { prefix, entries: [...], next } with only what the caller may read, at most `limit` (default 500, at most 1,000) per call; `next` is the cursor to pass as `after`, or null at the end.",
    obj({ space: str, prefix: str, limit: { type: "integer" }, after: str }), async (i, d, drive) => {
      const raw = String(i.prefix ?? ""), prefix = raw === "" ? "" : pathOf(raw.replace(/\/+$/, "")) + "/";
      if (i.limit !== undefined && (!Number.isInteger(i.limit) || i.limit < 1)) throw refuse("limit is a positive number", "bad_input");
      if (i.after !== undefined && typeof i.after !== "string") throw refuse("after is the cursor the last page gave", "bad_input");
      const r = await drive.listPage(d.chain, prefix, { limit: i.limit, after: i.after ?? null });
      return { prefix, entries: r.entries, next: r.next, names: await namesOf(d, r.entries), folders: await foldersOf(d, drive, prefix) };
    });

  tool("files.drive.space.read", `Download one file from the Space's Drive, head or a named version, under the caller's own grants: { space?, path, version? }. Answers { path, version, size, base64 } for a file of at most ${MAX_UPLOAD / 1048576} MB (\`too_large\` beyond).`,
    obj({ space: str, path: str, version: { type: "integer" } }, ["path"]), async (i, d, drive) => {
      const p = pathOf(i.path);
      if (i.version !== undefined && (!Number.isInteger(i.version) || i.version < 1)) throw refuse("name a version number", "bad_input");
      const bytes = await drive.get(d.chain, p, { version: i.version ?? null, maxBytes: MAX_UPLOAD });
      if (bytes.length > MAX_UPLOAD) throw refuse(`a file here is at most ${MAX_UPLOAD / 1048576} MB to download in one call`, "too_large");
      return { path: p, version: i.version ?? null, size: bytes.length, base64: Buffer.from(bytes).toString("base64") };
    });
}
