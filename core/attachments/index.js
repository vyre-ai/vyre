// @ts-check
// attachments: files a person adds to a chat (R031-53; team/contracts/attachments.md). `attachments.put` keeps one in the chat's received folder of the Space's Drive, sealed like every chat file, under the
// person's own chain, and answers the reference a message carries: { id, name, mime, bytes }. The send path opens it by id (lib/attachments-store.js); this module only adds and lists.
import { createDoor } from "../../lib/gateway-door.js";
import { PERSON_SURFACES } from "../../lib/caller.js";
import { put, list } from "../../lib/attachments-store.js";
import { LIMITS } from "../../lib/attachments.js";

const str = { type: "string" };
const obj = (/** @type {any} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });
const PERSON = [...PERSON_SURFACES, "tailnet", "device"];
const fail = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** @param {any} ctx @param {{ door?: any }} [seam] a test hands in the Space door */
export function registerAttachments(ctx, seam = /** @type {any} */ ({})) {
  const door = seam.door || createDoor(ctx);
  ctx.tool("attachments.put", {
    description: "Add a file to a chat: { thread, name, mime?, data } with data as base64. Returns { id, name, mime, bytes } to attach to the next message.",
    input: obj({ thread: str, name: str, mime: str, data: str }, ["thread", "name", "data"]), callers: PERSON,
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      const text = String(i.data || "");
      if (!/^[A-Za-z0-9+/\s]*={0,2}$/.test(text)) throw fail("data is the file's bytes, standard base64", "bad_input");
      // Check the size before decoding: 4 base64 characters carry 3 bytes.
      if (Math.floor(text.replace(/\s+/g, "").length / 4) * 3 > LIMITS.fileBytes + 3) throw fail(`a file here is at most ${LIMITS.fileBytes / 1048576} MB`, "bad_input");
      const d = await door.open({}, meta);
      const bytes = new Uint8Array(Buffer.from(text, "base64"));
      const a = await put(d.gateway, d.chain, String(i.thread || ""), { name: String(i.name || ""), mime: i.mime ? String(i.mime) : undefined, bytes });
      ctx.events.emit("attachment.added", { thread: String(i.thread), id: a.id, name: a.name, mime: a.mime, bytes: a.bytes }, { thread: String(i.thread) });
      return a;
    },
  });
  ctx.tool("attachments.list", {
    description: "The files added to a chat: { thread }. Returns { attachments: [{ id, name, mime, bytes }] }.",
    input: obj({ thread: str }, ["thread"]), callers: PERSON,
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      const d = await door.open({}, meta);
      return { attachments: (await list(d.gateway, d.chain, String(i.thread || ""))).map(({ path: _p, ...a }) => a) };
    },
  });
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default { async start(ctx) { registerAttachments(ctx); return { async stop() {} }; } };
