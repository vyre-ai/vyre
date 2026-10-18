// @ts-check
// core/files/space-mentions.js: the Space's Drive as a # tag. Typing #brief in a chat searches the files the PERSON may read in the Space's Drive; picking one tags that single file. Search runs under the
// caller's own chain (lib/gateway-door.js, the kernel's own listing), so a chip never names a file the person cannot open. Resolve is the chat's alone (sessions or the assistant): it checks the tag is a
// plain Drive path and tells the model how to read it; it stores no grant and returns none, because a model in a team chat's turn reads the Drive as the member who spoke (files.drive.space.read), and the kernel decides
// that read when it happens, so a tag for a file the member cannot open still opens nothing.
import { createDoor } from "../../lib/gateway-door.js";
import { safePath } from "../../kernel/seal/uses.js";

const refuse = (/** @type {string} */ message, /** @type {string} */ code = "denied") => Object.assign(new Error(message), { code });
const CALLERS = /^module:(sessions|assistant)$/;
const THREAD = /^[A-Za-z0-9_-]{1,100}$/;
const SEARCH_CALLERS = ["cli", "local", "deck", "capsule", "mobile", "device", "mcp"];
const PAGES = 6;

/** Pure: the entries whose path holds every word, files only, as picker items, shortest path first. @param {readonly any[]} entries @param {string} q @param {number} limit */
export function spaceMatches(entries, q, limit) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const e of entries) {
    const p = e && typeof e.path === "string" ? e.path : "";
    if (!p || p.endsWith("/") || e.dir === true || !words.every((w) => p.toLowerCase().includes(w))) continue;
    const name = typeof e.name === "string" && e.name ? e.name : p.slice(p.lastIndexOf("/") + 1);
    out.push({ id: p, name, hint: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "", icon: "file" });
  }
  return out.sort((a, b) => a.id.length - b.id.length).slice(0, limit);
}

/** @param {any} ctx */
export function registerSpaceMentions(ctx) {
  const door = createDoor(ctx);
  ctx.tool("files.space.mentions.search", {
    description: "Files in the Space's Drive whose path matches what you typed after #, for tagging one in a chat. Runs as the person asking, so only files they may read are offered.",
    input: { type: "object", properties: { q: { type: "string" }, limit: { type: "integer" }, space: { type: "string" } } },
    callers: SEARCH_CALLERS,
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      const q = String((i && i.q) || "").trim();
      const limit = Math.min(50, Math.max(1, Number(i && i.limit) || 30));
      if (!q) return { items: [] };
      const d = await door.open(i || {}, meta);
      if (!d.gateway.drive) return { items: [] };
      /** @type {any[]} */ const seen = [];
      let after = null;
      for (let n = 0; n < PAGES; n++) {
        const r = await d.gateway.drive.listPage(d.chain, "", { limit: 500, after });
        seen.push(...(r.entries || []));
        if (!r.next) break;
        after = r.next;
      }
      return { items: spaceMatches(seen, q, limit) };
    },
  });
  ctx.tool("files.space.mentions.resolve", {
    description: "A file of the Space's Drive tagged in a chat: checks the tag is a plain Drive path and tells the model how to read it. Only the sessions module or the assistant call it. The read itself is the kernel's, as the member who spoke.",
    input: { type: "object", required: ["id", "thread"], properties: { id: { type: "string" }, thread: { type: "string" }, said: { type: "string" }, asker: { type: "string" } } },
    callers: ["module"],
    run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => {
      if (!CALLERS.test(String(meta && meta.caller))) throw refuse("only the chat itself resolves a tag: tag the file again with # in the chat", "denied");
      if (!THREAD.test(String(i && i.thread))) throw refuse("that file is not available (tag it again with # in the chat)", "not_found");
      let p;
      try { p = safePath(String((i && i.id) || "")); } catch { throw refuse("that file is not available (tag it again with # in the chat)", "not_found"); }
      if (!p || p.endsWith("/")) throw refuse("that is a folder, not a file (tag a file inside it)", "not_found");
      const name = p.slice(p.lastIndexOf("/") + 1);
      return { name, hint: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "",
        // the path goes into the model's context as one JSON string, so a quote or any odd character in it cannot end the sentence; nothing is stored and no grant is returned (the read is the kernel's)
        note: `The person tagged the file ${JSON.stringify(p)} in the Space's Drive. Read it with files.drive.space.read {path: ${JSON.stringify(p)}}; it opens only if you may read it.` };
    },
  });
}
