// @ts-check
// core/files/space-drive.js: the Space's own Drive (kernel/storage/drive.js, behind kernel/gateway/drive.js) for the app: upload a new version of a file, list a file's versions, restore one.
// The box's shared folders (the mounted VyreDrive) are gone until the mounted Drive returns in 0.3.0. Every call is the CALLER'S own chain in the Space it names (lib/gateway-door.js): a call that proved
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
/** How many Drive entries one name search looks through before it stops. */
const SEARCH_SCAN = 20_000;

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

  /** The Space's Drive state for the person asking: is one wired, and can they list the top of it? Never throws. */
  const state = async (/** @type {any} */ meta) => {
    try {
      const d = await door.open({}, meta);
      if (!d.gateway.drive) return { enabled: false, why: "this Space has no Drive yet" };
      try { const r = await d.gateway.drive.listPage(d.chain, "", { limit: 1000 }); return { enabled: true, files: r.entries.length, more: r.next !== null }; }
      catch { return { enabled: true, readable: false, why: "you may not list this Drive" }; }
    } catch { return { enabled: null, why: "the Drive's state is for a signed-in person" }; }
  };
  ctx.tool("files.drive.status", {
    description: "The Space's own Drive: whether one is wired here and how many files the caller can see at the top. { enabled, files?, more?, why? }.",
    input: obj({}), run: async (/** @type {any} */ _i, /** @type {any} */ meta) => ({ space: await state(meta) }),
  });

  /** Names in the Space's Drive that hold every word of `q`, under the caller's own grants (the Drive keeps no plain index, so this reads names, never contents). Up to `scan` entries are looked at. */
  const find = async (/** @type {string} */ q, /** @type {number} */ limit, /** @type {any} */ i, /** @type {any} */ meta) => {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const d = await door.open(i || {}, meta);
    if (!d.gateway.drive) throw refuse("this Space has no Drive yet", "unavailable");
    const out = []; let after = null, looked = 0;
    for (;;) {
      const r = await d.gateway.drive.listPage(d.chain, "", { limit: 1000, after });
      for (const e of r.entries) {
        const path = String(e.path ?? e.name ?? e), hay = path.toLowerCase();
        if (words.every(w => hay.includes(w))) { out.push({ path, name: path.split("/").pop(), ...(typeof e.size === "number" ? { size: e.size } : {}) }); if (out.length >= limit) return out; }
      }
      looked += r.entries.length;
      if (!r.next || looked >= SEARCH_SCAN) return out;
      after = r.next;
    }
  };
  ctx.tool("files.drive.search", {
    description: "Find files in the Space's Drive by name, under the caller's own grants: { space?, q, limit? }. Answers { results: [{ path, name, size? }] }. Names only: the Drive keeps its contents sealed.",
    input: obj({ space: str, q: str, limit: { type: "integer" } }, ["q"]), callers: CALLERS,
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      const q = String((i || {}).q ?? "").trim();
      if (!q) throw refuse("q is required", "bad_input");
      return { results: await find(q, Math.min(500, Math.max(1, Number(i.limit) || 50)), i, meta) };
    },
  });

  // The # tag for files (core/mentions): the picker searches the Drive by name as the person asking; picking one tags that file.
  ctx.tool("files.mentions.search", {
    description: "Files in the Space's Drive whose name matches what you typed after #, for tagging one in a chat. Runs as the person asking.",
    input: obj({ q: str, limit: { type: "integer" }, space: str }), callers: [...CALLERS, "space", "agent"],
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      const q = String((i || {}).q ?? "").trim(), limit = Math.min(50, Math.max(1, Number((i || {}).limit) || 30));
      if (!q) return { items: [] };
      let found;
      try { found = await find(q, limit, i, meta); } catch { return { items: [] }; }
      return { items: found.map((/** @type {any} */ f) => ({ id: f.path, name: f.name, hint: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "", icon: "file" })) };
    },
  });
  ctx.tool("files.mentions.resolve", {
    description: "Say which Drive file a # tag names, for the chat it was tagged in. Only the sessions module or the assistant call it. Reading stays under the reader's own grants: this grants nothing.",
    input: obj({ id: str, thread: str, said: str }, ["id", "thread"]), callers: ["module"],
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      if (!/^module:(sessions|assistant)$/.test(String((meta && meta.caller) || ""))) throw refuse("only the chat itself resolves a tag", "denied");
      const p = pathOf(i.id);
      return { name: p.split("/").pop(), hint: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "",
        note: `The person tagged the file "${p}" in the Space's Drive. Read it with files.drive.space.read {path: "${p}"}; your own grants decide whether you may.` };
    },
  });

  tool("files.drive.upload", `Put a file in the Space's Drive as a new version, under the caller's own grants: { space?, path, base64, base? }. \`path\` is relative (Clients/A/retainer.pdf), \`base64\` the bytes (at most ${MAX_UPLOAD / 1048576} MB here), \`base\` the version you edited from (a second writer on one file makes a new version flagged conflict, never a merge). Answers { path, version, conflict }.`,
    obj({ space: str, path: str, base64: str, base: { type: "integer" } }, ["path", "base64"]), async (i, d, drive) => {
      const p = pathOf(i.path), text = String(i.base64 ?? "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw refuse("base64 is the file's bytes, standard base64", "bad_input");
      // Check the size before decoding: 4 base64 characters carry 3 bytes.
      if (Math.floor(text.length / 4) * 3 > MAX_UPLOAD + 3) throw refuse(`a file here is at most ${MAX_UPLOAD / 1048576} MB; a larger one goes through a Flow`, "too_large");
      const bytes = new Uint8Array(Buffer.from(text, "base64"));
      if (bytes.length > MAX_UPLOAD) throw refuse(`a file here is at most ${MAX_UPLOAD / 1048576} MB; a larger one goes through a Flow`, "too_large");
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
      return { prefix, entries: r.entries, next: r.next };
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
