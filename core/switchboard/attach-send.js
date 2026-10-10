// @ts-check
// Attachments on a send (R031-53; team/contracts/attachments.md): the files a person added to this chat, named by id on the message, become what the model hears. An image rides the message inline (the
// `images` every provider's adapter already turns into its own native form); any other file is put in the session's folder and named in one sentence beside the words. Under the person's own chain: a
// file of a chat they are not in is not found. A bad list, or a file that is not this chat's, is refused before anything is said, so a send is never half attached.
import fs from "node:fs";
import { checkList, resolve, noteFor } from "../../lib/attachments.js";
import { list as listFiles, read, materialise } from "../../lib/attachments-store.js";

const bad = (/** @type {string} */ message) => Object.assign(new Error(message), { code: "bad_input" });

/**
 * @param {{ kernel: any, chain: () => any, cwdOf: (thread: string) => string | null }} o
 * @returns {(i: { thread?: unknown, attachments?: unknown }) => Promise<{ images: { media_type: string, data: string }[], note: string }>}
 */
export function attachFor({ kernel, chain, cwdOf }) {
  return async i => {
    const checked = checkList(i.attachments);
    if (!checked.ok) throw bad(checked.error);
    if (!checked.list.length) return { images: [], note: "" };
    const c = chain(), thread = String(i.thread || "");
    if (!kernel || !c) throw bad("files can be attached by a person at their own surface");
    const have = new Map((await listFiles(kernel, c, thread).catch(() => [])).map(a => [a.id, a]));
    for (const a of checked.list) { const h = have.get(a.id); if (!h) throw bad(`${a.name} is not a file of this chat: add it again`); }
    const cwd = cwdOf(thread);
    const resolved = await resolve(checked.list.map(a => ({ ...a, bytes: have.get(a.id)?.bytes || a.bytes })), async (id, as) => {
      const a = /** @type {any} */ (checked.list.find(x => x.id === id));
      if (as === "base64") return { base64: (await read(kernel, c, thread, id)).toString("base64") };
      if (!cwd || !fs.existsSync(cwd)) return { path: `(in this chat's files; this session's folder is not on this machine)` };
      return { path: await materialise(kernel, c, thread, cwd, a) };
    });
    return { images: resolved.filter(r => r.form === "image").map(r => ({ media_type: r.mime, data: String(r.base64) })), note: noteFor(resolved) };
  };
}
