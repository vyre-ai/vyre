// @ts-check
// What a chat message carries beside the words, made for the assistants only and never shown in the chat: the card of a record the person named exactly (R031-00t, lib/record-cards.js) and the files they
// attached (R031-53, lib/attachments.js; team/contracts/attachments.md). Both are read once per send, under the PERSON's own chain (the one the send was made under), so a record or a file the person may not
// read is not there for the assistants either. An image rides inline to an assistant that already has a session (its adapter turns it into the provider's own image form); every other file, and any file for an
// assistant that is just starting, is put in that assistant's folder and named in one sentence. A bad list refuses the whole send before anything is stored, so a message is never half attached.
import fs from "node:fs";
import { cardsFor } from "../../lib/record-cards.js";
import { checkList, noteFor, resolve } from "../../lib/attachments.js";
import { list as listFiles, read, materialise } from "../../lib/attachments-store.js";

const bad = (/** @type {string} */ message) => Object.assign(new Error(message), { code: "bad_input" });

/**
 * @param {{ kernel: any, call: (tool: string, input: any) => Promise<any> }} o
 * @returns {(q: { chain: any, grp: string, text: string, pasted?: unknown, attachments?: unknown, members: { who: string, cwd: string | null, session: boolean }[] }) => Promise<{
 *   saved: import("../../lib/attachments.js").Attachment[], noteOf: (who: string) => string, imagesOf: (who: string) => { media_type: string, data: string }[] }>}
 */
export function createSendContext({ kernel, call }) {
  let chainNow = /** @type {any} */ (null);
  const card = cardsFor({ kernel, call, chain: () => chainNow });
  return async ({ chain, grp, text, pasted, attachments, members }) => {
    const checked = checkList(attachments);
    if (!checked.ok) throw bad(checked.error);
    chainNow = chain;
    const cardNote = await card({ thread: grp, text, pasted });
    if (!checked.list.length) return { saved: [], noteOf: () => cardNote, imagesOf: () => [] };
    if (!kernel || !chain) throw bad("files can be attached by a person at their own surface");
    const have = new Map((await listFiles(kernel, chain, grp).catch(() => [])).map(a => [a.id, a]));
    for (const a of checked.list) if (!have.has(a.id)) throw bad(`${a.name} is not a file of this chat: add it again`);
    const list = checked.list.map(a => ({ ...a, bytes: have.get(a.id)?.bytes || a.bytes }));
    /** @type {Map<string, Buffer>} */ const bytes = new Map();
    const bytesOf = async (/** @type {string} */ id) => { let b = bytes.get(id); if (!b) bytes.set(id, b = await read(kernel, chain, grp, id)); return b; };
    /** @type {Map<string, { images: { media_type: string, data: string }[], note: string }>} */ const byWho = new Map();
    for (const m of members) {
      const here = m.cwd && fs.existsSync(m.cwd) ? m.cwd : null;
      const resolved = await resolve(m.session ? list : list.map(a => ({ ...a, mime: a.mime.startsWith("image/") ? "application/octet-stream" : a.mime })), async (id, as) => {
        const a = /** @type {any} */ (list.find(x => x.id === id));
        if (as === "base64") return { base64: (await bytesOf(id)).toString("base64") };
        if (!here) return { path: "(in this chat's files; this assistant's folder is not on this machine)" };
        return { path: await materialise(kernel, chain, grp, here, a) };
      });
      byWho.set(m.who, { images: resolved.filter(r => r.form === "image").map(r => ({ media_type: r.mime, data: String(r.base64) })), note: noteFor(resolved) });
    }
    return {
      saved: list,
      noteOf: who => [cardNote, (byWho.get(who) || { note: "" }).note].filter(Boolean).join("\n"),
      imagesOf: who => (byWho.get(who) || { images: [] }).images,
    };
  };
}
