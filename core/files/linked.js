// @ts-check
// core/files/linked.js: Files > Linked. A link says "this folder at a source appears at Linked/<name>" in one Space, and who linked it. The source is a provider (linked-provider.js: Google
// Drive first, then SharePoint, a GitHub repo); this file knows nothing of any of them. Linking records a pointer and moves no bytes: the index (linked-index.js) and the read-through
// open (linked-read.js) do the rest, each as the person asking.
//
//   files.linked.link    { space?, name, provider, source }  -> { id, name, path, provider, source, linked_by, at }
//   files.linked.list    { space? }                          -> { links: [{ id, name, path, provider, source, linked_by, at }] }
//   files.linked.unlink  { space?, id }                      -> { unlinked: true }      only who linked it, or the Space owner; the source is never touched; the index of it goes too
//   files.linked.sync    { space?, id, full? }               -> { status, count, at, error? }   bring the CALLER'S index of this folder up to date, as the caller (linked-index.js)
//   (open, edit and write back: linked-read.js: ls, read, write, rename, delete, versions)
//   files.linked.status  { space?, id }                      -> { link, sync: null | { status, count, at, error? } }
//   files.linked.search  { space?, q, id?, limit? }          -> { hits: [{ link, link_name, path, name, mime, size, modified, snippet }] }   the caller's own index only
import crypto from "node:crypto";
import { createDoor } from "../../lib/gateway-door.js";
import { linkedDir } from "../../lib/files/layout.js";
import { assertProvider } from "./linked-provider.js";
import { linkedIndex } from "./linked-index.js";
import { filesMigrations } from "./migrations.js";
import { registerLinkedIO } from "./linked-read.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const CALLERS = ["cli", "local", "deck", "capsule", "mobile", "device"];
/** A model working a team chat's turn may read what the asking member can read; writing stays the person's. */
const READ_CALLERS = [...CALLERS, "mcp"];
export const LINK_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

export const LINKED_MIGRATIONS = [
  `CREATE TABLE files_linked (id TEXT PRIMARY KEY, space TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, source TEXT NOT NULL, linked_by TEXT NOT NULL, at INTEGER NOT NULL, removed_at INTEGER);
   CREATE UNIQUE INDEX files_linked_name ON files_linked (space, name) WHERE removed_at IS NULL`,
];

/** The last person hop of a chain: who the call is for. @param {any} chain */
export const personOf = (chain) => {
  const hops = chain && Array.isArray(chain.hops) ? chain.hops : [];
  const h = [...hops].reverse().find((/** @type {any} */ x) => x && x.actor && x.actor.kind === "person");
  if (!h) throw refuse("this call is not from a signed-in person. Sign in with `vyre signin` (approve on your phone)", "denied");
  return String(h.actor.id);
};

/** @param {any} ctx @param {{ providers: any[], now?: () => number }} o */
export function registerLinked(ctx, o) {
  const now = o.now || (() => Date.now());
  const door = createDoor(ctx);
  /** @type {Map<string, any>} */ const providers = new Map();
  for (const p of o.providers || []) providers.set(assertProvider(p).id, p);
  let ready = false;
  const db = () => { if (!ready) { ctx.store.migrate(filesMigrations()); ready = true; } return ctx.store.db; };
  /** @type {any} */ let idx;
  const index = () => idx || (idx = linkedIndex({ db: db(), providers, now }));
  const view = (/** @type {any} */ r) => ({ id: r.id, name: r.name, path: linkedDir(r.name), provider: r.provider, source: JSON.parse(r.source), linked_by: r.linked_by, at: r.at });

  const t = (/** @type {string} */ name, /** @type {string} */ description, /** @type {any} */ input, /** @type {any} */ extra, /** @type {(i: any, d: any, who: string) => Promise<any>} */ run) =>
    ctx.tool(name, { description, input, callers: extra.readCallers || /^files\.linked\.(list|status|search|ls|read|versions)$/.test(name) ? READ_CALLERS : CALLERS, ...extra, readCallers: undefined, run: async (/** @type {any} */ i, /** @type {any} */ meta) => { const d = await door.open(i || {}, meta || {}); return run(i || {}, d, personOf(d.chain)); } });

  t("files.linked.link", "Link a folder from a source (Google Drive first) so it appears live at Linked/<name> in this Space: { space?, name, provider, source }. `source` is what the provider needs to find the folder (Drive: { folder }). Nothing is copied; each person sees it through their own account.",
    obj({ space: str, name: str, provider: str, source: { type: "object" } }, ["name", "provider", "source"]),
    { presence: { summary: async (/** @type {any} */ i) => `Link ${String(i && i.provider || "a folder")} as Linked/${String(i && i.name || "")}` } },
    async (i, d, who) => {
      const name = String(i.name ?? "");
      if (!LINK_NAME.test(name)) throw refuse("a link's name is letters, digits, dash and underscore, up to 64", "bad_input");
      if (!providers.has(String(i.provider))) throw refuse(`no such source: ${String(i.provider)} (${[...providers.keys()].join(", ") || "none installed"})`, "bad_input");
      const src = i.source;
      if (!src || typeof src !== "object" || Array.isArray(src) || !Object.keys(src).length) throw refuse("source names the folder at the provider", "bad_input");
      const json = JSON.stringify(src);
      if (json.length > 2000) throw refuse("source is too large", "bad_input");
      const row = { id: `lnk_${crypto.randomBytes(9).toString("base64url")}`, space: d.space, name, provider: String(i.provider), source: json, linked_by: who, at: now() };
      try { db().prepare("INSERT INTO files_linked (id, space, name, provider, source, linked_by, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(row.id, row.space, row.name, row.provider, row.source, row.linked_by, row.at); }
      catch (e) { if (/UNIQUE/i.test(String(/** @type {any} */ (e).message))) throw refuse(`Linked/${name} is already a linked folder`, "conflict"); throw e; }
      return view(row);
    });

  t("files.linked.list", "The folders linked in this Space: { space? } -> { links }.", obj({ space: str }), {}, async (_i, d) =>
    ({ links: db().prepare("SELECT * FROM files_linked WHERE space = ? AND removed_at IS NULL ORDER BY name").all(d.space).map(view) }));

  t("files.linked.unlink", "Stop showing a linked folder: { space?, id }. Only who linked it or the Space owner. The source folder is not touched.", obj({ space: str, id: str }, ["id"]),
    { presence: { summary: async () => "Unlink a linked folder" } },
    async (i, d, who) => {
      const r = db().prepare("SELECT * FROM files_linked WHERE id = ? AND space = ? AND removed_at IS NULL").get(String(i.id ?? ""), d.space);
      if (!r) throw refuse("no such linked folder", "not_found");
      if (r.linked_by !== who && who !== String(ctx.kernel.owner)) throw refuse("only who linked this folder, or the Space owner, can unlink it", "denied");
      db().prepare("UPDATE files_linked SET removed_at = ? WHERE id = ?").run(now(), r.id);
      index().forget(r.id);
      return { unlinked: true };
    });

  const linkOf = (/** @type {any} */ i, /** @type {any} */ d) => {
    const r = db().prepare("SELECT * FROM files_linked WHERE id = ? AND space = ? AND removed_at IS NULL").get(String(i.id ?? ""), d.space);
    if (!r) throw refuse("no such linked folder", "not_found");
    return r;
  };
  const asLink = (/** @type {any} */ r) => ({ id: r.id, provider: r.provider, source: JSON.parse(r.source) });

  t("files.linked.sync", "Bring your own index of a linked folder up to date, as you (what your account sees there): { space?, id, full? }.", obj({ space: str, id: str, full: { type: "boolean" } }, ["id"]), {},
    async (i, d, who) => index().sync(asLink(linkOf(i, d)), who, { full: i.full === true }));

  t("files.linked.status", "A linked folder and how your index of it stands: { space?, id }.", obj({ space: str, id: str }, ["id"]), {},
    async (i, d, who) => { const r = linkOf(i, d); return { link: view(r), sync: index().status(r.id, who) }; });

  t("files.linked.search", "Search the linked folders by name, path and text, among what your account sees: { space?, q, id?, limit? }.", obj({ space: str, q: str, id: str, limit: { type: "integer" } }, ["q"]), {},
    async (i, d, who) => {
      const names = new Map(db().prepare("SELECT id, name FROM files_linked WHERE space = ? AND removed_at IS NULL").all(d.space).map((/** @type {any} */ r) => [r.id, r.name]));
      const hits = index().search(who, String(i.q ?? ""), { limit: i.limit, ...(i.id ? { link: String(i.id) } : {}) }).filter((/** @type {any} */ h) => names.has(h.link));
      return { hits: hits.map((/** @type {any} */ h) => ({ link: h.link, link_name: names.get(h.link), path: `${linkedDir(names.get(h.link))}/${h.path}`, name: h.name, mime: h.mime, size: h.size, modified: h.modified, snippet: h.snippet })) };
    });

  registerLinkedIO({ t, linkOf, asLink, index, providers, view });

  /** The scheduler's pass: every (link, person) pair that has synced once, one after another; a failing pair records its error and the rest go on. Answers how many it ran. */
  async function syncKnown() {
    let n = 0;
    for (const k of index().known()) {
      const r = db().prepare("SELECT * FROM files_linked WHERE id = ? AND removed_at IS NULL").get(k.link);
      if (!r) { index().forget(k.link); continue; }
      await index().sync(asLink(r), k.person); n++;
    }
    return n;
  }

  return { providers, db, view, syncKnown, index };
}
