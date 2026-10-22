// @ts-check
// "Shared with me": one person shares one Drive file with one other person in the Space. The row is who shared what;
// the kernel grant is what lets the other person read it (drive.read on that one path, under their own chain).
// Not a link (files.drive.link keeps a copy), not a folder share, and not a write. An agent's folder is not in the Drive.
import crypto from "node:crypto";
import { createDoor } from "../../lib/gateway-door.js";
import { safePath } from "../../kernel/seal/uses.js";
import { MAX_UPLOAD } from "./space-drive.js";
import { filesMigrations } from "./migrations.js";
import { agentPathOf, NOT_IN_DRIVE } from "./agent-folder.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const CALLERS = ["cli", "local", "deck", "capsule", "device"];
const PERSON = /^per_[A-Za-z0-9]{8,64}$/;

export const WITH_MIGRATIONS = [
  `CREATE TABLE files_with (id TEXT PRIMARY KEY, space TEXT NOT NULL, path TEXT NOT NULL, by_person TEXT NOT NULL, with_person TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(space, path, with_person))`,
];

/** @param {any} chain */
function personOf(chain) {
  const h = chain && Array.isArray(chain.hops) ? chain.hops[0] : null;
  const id = h && h.actor && h.actor.kind === "person" ? String(h.actor.id) : "";
  if (!id) throw refuse("this call is not from a signed-in person. Sign in, then try again.", "denied");
  return id;
}

/** @param {any} ctx */
export function registerWithMe(ctx) {
  const door = createDoor(ctx);
  const db = () => { ctx.store.migrate(filesMigrations()); return ctx.store.db; };
  let ready = false;
  const open = () => { const d = ready ? ctx.store.db : db(); ready = true; return d; };
  const rowOf = (/** @type {any} */ r) => ({ path: r.path, by: r.by_person, at: r.at });

  const t = (/** @type {string} */ name, /** @type {string} */ description, /** @type {any} */ input, /** @type {(i: any, meta: any) => Promise<any>} */ run) =>
    ctx.tool(name, { description, input, callers: CALLERS, run: async (/** @type {any} */ i, /** @type {any} */ meta) => run(i || {}, meta || {}) });

  t("files.with.share", "Share one file in the Space's Drive with one other person: { space?, path, person }. They can read that file (files.with.read). Not a folder, not a link, and not a write. Sharing it again answers the same row.",
    obj({ space: str, path: str, person: str }, ["path", "person"]), async (i, meta) => {
      let p; try { p = safePath(String(i.path ?? "")); } catch { throw refuse("that is not a path in the Drive", "bad_input"); }
      if (!p) throw refuse("that is not a path in the Drive", "bad_input");
      if (agentPathOf(p)) throw refuse(NOT_IN_DRIVE, "unavailable");
      const person = String(i.person ?? "");
      if (!PERSON.test(person)) throw refuse("person is a member id", "bad_input");
      const d = await door.open(i, meta);
      if (!d.gateway.drive) throw refuse("this Space has no Drive yet; ask the owner or an admin of the Space", "unavailable");
      const me = personOf(d.chain);
      if (person === me) throw refuse("share a file with someone else", "bad_input");
      await d.gateway.drive.stat(d.chain, p);
      const had = open().prepare("SELECT id, path, by_person, at FROM files_with WHERE space = ? AND path = ? AND with_person = ?").get(d.space, p, person);
      if (had) return rowOf(had);
      const id = crypto.randomBytes(12).toString("hex"), at = Date.now();
      open().prepare("INSERT INTO files_with (id, space, path, by_person, with_person, at) VALUES (?,?,?,?,?,?)").run(id, d.space, p, me, person, at);
      try {
        await d.gateway.grants.create(d.chain, {
          subject: { kind: "actor", actor: { kind: "person", id: person, space: d.space } },
          actions: ["drive.read"],
          resource: { prefix: `vyre://${d.space}/file/${p}` },
          conditions: {},
          source: "files:with",
        }, d.proof ? { presence: d.proof } : {});
      } catch (e) {
        try { open().prepare("DELETE FROM files_with WHERE id = ?").run(id); } catch { /* the row is the share; without the grant it must not stay */ }
        const err = /** @type {any} */ (e);
        throw refuse(err instanceof Error ? err.message : "the share could not be granted", typeof err?.code === "string" ? err.code : "denied");
      }
      return { path: p, by: me, at };
    });

  t("files.with.list", "Files other people shared with you: { shares: [{ path, by, at }] }. Only your own rows.", obj({ space: str }), async (i, meta) => {
    const d = await door.open(i, meta);
    const me = personOf(d.chain);
    const rows = open().prepare("SELECT path, by_person, at FROM files_with WHERE space = ? AND with_person = ? ORDER BY at DESC").all(d.space, me);
    return { shares: rows.map(rowOf) };
  });

  t("files.with.read", `Read one file someone shared with you, under your own grants: { space?, path }. Answers { path, size, base64 } for a file of at most ${MAX_UPLOAD / 1048576} MB.`,
    obj({ space: str, path: str }, ["path"]), async (i, meta) => {
      let p; try { p = safePath(String(i.path ?? "")); } catch { throw refuse("that is not a path in the Drive", "bad_input"); }
      const d = await door.open(i, meta);
      if (!d.gateway.drive) throw refuse("this Space has no Drive yet; ask the owner or an admin of the Space", "unavailable");
      const me = personOf(d.chain);
      const row = open().prepare("SELECT path FROM files_with WHERE space = ? AND path = ? AND with_person = ?").get(d.space, p, me);
      if (!row) throw refuse("that file is not shared with you. Ask the person who has it to share it with you.", "not_found");
      const bytes = await d.gateway.drive.get(d.chain, p, { maxBytes: MAX_UPLOAD });
      if (bytes.length > MAX_UPLOAD) throw refuse(`a file here is at most ${MAX_UPLOAD / 1048576} MB to download in one call`, "too_large");
      return { path: p, size: bytes.length, base64: Buffer.from(bytes).toString("base64") };
    });
}
