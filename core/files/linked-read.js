// @ts-check
// core/files/linked-read.js: the open, edit and write-back side of Files > Linked. Listing a folder comes from the caller's own index; a file's CONTENT is never kept here: `read` asks the
// source now, as the person, so an edit made elsewhere is what opens. A write goes back through the same provider with the revision the person opened (a stale one answers `conflict`
// and writes nothing), then the person's index is brought up to date so the edit is searchable at once. Reads are the person's and models' (the asking member's chat). Writing, renaming
// and deleting follow the rule of editing the Space's own Drive (space-drive.js): the person's own call asks for no extra proof, the manifest marks them outward so an assistant's is held, and
// a delete goes to the source's own recoverable trash where it has one. Drive has no conditional upload, so a write racing another inside the gap between the revision check and the upload is
// last write wins at the source.
//
//   files.linked.ls        { space?, id, path? }                              -> { path, entries: [{ name, path, dir, size, modified, rev }] }
//   files.linked.read      { space?, id, path }                               -> { path, name, mime, rev, size, base64 }       (at most MAX_BYTES)
//   files.linked.write     { space?, id, path, base64, base_rev? }            -> { path, rev }
//   files.linked.rename    { space?, id, path, to }                           -> { path, rev }
//   files.linked.delete    { space?, id, path }                               -> { deleted: true }
//   files.linked.versions  { space?, id, path }                               -> { versions: [{ rev, modified, by? }] }
import { linkedDir } from "../../lib/files/layout.js";
import { safePath } from "../../kernel/seal/uses.js";
import { MAX_UPLOAD } from "./space-drive.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
export const MAX_BYTES = MAX_UPLOAD;

/** @param {{ t: Function, linkOf: (i: any, d: any) => any, asLink: (r: any) => any, index: () => any, providers: Map<string, any> }} d */
export function registerLinkedIO({ t, linkOf, asLink, index, providers }) {
  const pathOf = (/** @type {any} */ p, /** @type {boolean} */ allowRoot = false) => {
    if (allowRoot && (p === undefined || p === null || p === "")) return "";
    try { return safePath(String(p ?? "")); } catch { throw refuse("that is not a path in the linked folder: no leading slash, dot segments, backslash or control characters", "bad_input"); }
  };
  /** The link, its provider and the person's index, synced once if this person has never synced it. */
  async function open(/** @type {any} */ i, /** @type {any} */ d, /** @type {string} */ who) {
    const r = linkOf(i, d), link = asLink(r), provider = providers.get(r.provider);
    if (!provider) throw refuse(`the source ${r.provider} is not installed here. Try a folder from a source you have, or ask the owner to add it`, "unavailable");
    const ix = index();
    if (!ix.status(r.id, who)) await ix.sync(link, who);
    return { r, link, provider, ix };
  }
  const full = (/** @type {any} */ r, /** @type {string} */ p) => `${linkedDir(r.name)}${p ? `/${p}` : ""}`;
  const entryAt = (/** @type {any} */ ix, /** @type {any} */ r, /** @type {string} */ who, /** @type {string} */ p) => {
    const e = ix.entryAt(r.id, who, p);
    if (!e || !e.entry) throw refuse("no such file in the linked folder, or your account cannot see it: list the folder and pick another file", "not_found");
    return e;
  };
  const outward = (/** @type {string} */ _verb) => ({});
  const ref = (/** @type {string} */ p, /** @type {any} */ e) => ({ id: e.entry, path: p, name: e.name, mime: e.mime, size: e.size, rev: e.rev });

  t("files.linked.ls", "List a folder in a linked folder, from your own index: { space?, id, path? }.", obj({ space: str, id: str, path: str }, ["id"]), {}, async (/** @type {any} */ i, /** @type {any} */ d, /** @type {string} */ who) => {
    const dir = pathOf(i.path, true), { r, ix } = await open(i, d, who);
    return { path: full(r, dir), entries: ix.children(r.id, who, dir).map((/** @type {any} */ e) => ({ name: e.name, path: full(r, e.path), dir: e.dir, size: e.size, modified: e.modified, rev: e.rev })) };
  });

  t("files.linked.read", `Open a file in a linked folder: { id, path }. Fetched from the source as you, up to ${MAX_BYTES / 1048576} MB. Keep rev to write it back.`,
    obj({ space: str, id: str, path: str }, ["id", "path"]), {}, async (/** @type {any} */ i, /** @type {any} */ d, /** @type {string} */ who) => {
      const p = pathOf(i.path), { r, link, provider, ix } = await open(i, d, who), e = entryAt(ix, r, who, p);
      if (e.dir) throw refuse("that is a folder; list it instead", "bad_input");
      if (Number(e.size || 0) > MAX_BYTES) throw refuse(`a file here is at most ${MAX_BYTES / 1048576} MB; open it at the source`, "too_large");
      const f = await provider.read(link, who, ref(p, e));
      const bytes = Buffer.from(f.bytes);
      if (bytes.length > MAX_BYTES) throw refuse(`a file here is at most ${MAX_BYTES / 1048576} MB; open it at the source`, "too_large");
      return { path: full(r, p), name: e.name, mime: f.mime || e.mime || "application/octet-stream", rev: f.rev, size: bytes.length, base64: bytes.toString("base64") };
    });

  t("files.linked.write", `Save a file into a linked folder, at the source: { space?, id, path, base64, base_rev? }. \`base_rev\` is the rev you opened; if the file changed since, nothing is written and the answer is conflict. Without it the file is created (or replaced). At most ${MAX_BYTES / 1048576} MB.`,
    obj({ space: str, id: str, path: str, base64: str, base_rev: str }, ["id", "path", "base64"]), outward("Save"), async (/** @type {any} */ i, /** @type {any} */ d, /** @type {string} */ who) => {
      const p = pathOf(i.path), text = String(i.base64 ?? "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw refuse("base64 is the file's bytes, standard base64", "bad_input");
      if (Math.floor(text.length / 4) * 3 > MAX_BYTES + 3) throw refuse(`a file here is at most ${MAX_BYTES / 1048576} MB: use a smaller file`, "too_large");
      const bytes = new Uint8Array(Buffer.from(text, "base64"));
      if (bytes.length > MAX_BYTES) throw refuse(`a file here is at most ${MAX_BYTES / 1048576} MB: use a smaller file`, "too_large");
      const { r, link, provider, ix } = await open(i, d, who);
      const w = await provider.write(link, who, p, bytes, i.base_rev === undefined ? {} : { baseRev: String(i.base_rev) });
      await ix.sync(link, who);
      return { path: full(r, p), rev: w.rev };
    });

  t("files.linked.rename", "Rename or move a file inside a linked folder, at the source: { space?, id, path, to }.", obj({ space: str, id: str, path: str, to: str }, ["id", "path", "to"]), outward("Rename"), async (/** @type {any} */ i, /** @type {any} */ d, /** @type {string} */ who) => {
    const p = pathOf(i.path), to = pathOf(i.to), { r, link, provider, ix } = await open(i, d, who), e = entryAt(ix, r, who, p);
    const out = await provider.rename(link, who, ref(p, e), to);
    await ix.sync(link, who);
    return { path: full(r, to), rev: out.rev };
  });

  t("files.linked.delete", "Delete a file in a linked folder, at the source (the source decides whether it can be got back): { space?, id, path }.", obj({ space: str, id: str, path: str }, ["id", "path"]), outward("Delete"), async (/** @type {any} */ i, /** @type {any} */ d, /** @type {string} */ who) => {
    const p = pathOf(i.path), { r, link, provider, ix } = await open(i, d, who), e = entryAt(ix, r, who, p);
    await provider.delete(link, who, ref(p, e));
    await ix.sync(link, who);
    return { deleted: true };
  });

  t("files.linked.versions", "A file's history at the source: { space?, id, path } -> { versions: [{ rev, modified, by? }] }.", obj({ space: str, id: str, path: str }, ["id", "path"]), {}, async (/** @type {any} */ i, /** @type {any} */ d, /** @type {string} */ who) => {
    const p = pathOf(i.path), { r, link, provider, ix } = await open(i, d, who), e = entryAt(ix, r, who, p);
    return { versions: await provider.versions(link, who, ref(p, e)) };
  });
}
