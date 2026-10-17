// kernel/tasks/scrub.js: forget the words of tasks (the lead's TR-1 ruling). It takes free text out of the task store and the task records when a value moves into a sealed field or a record is erased. It
// decides no grant, approves nothing and reads nothing but the text it removes, so it is not part of the trusted base (kernel/size.test.js); tasks.js hands it the stores it clears.

/** @param {{ tasks: Map<string, any>, bodies: Map<string, any>, texts: any, recs: any, recUpdate: (id: string, patch: any) => Promise<any>, withoutText: (t: any) => any, deepFreeze: (o: any) => any }} d */
export function createScrub({ tasks, bodies, texts, recs, recUpdate, withoutText, deepFreeze }) {
  /**
   * Take free text out of the task store (the lead's TR-1 ruling: the log holds only hashes, the store can forget). Called by the paths that forget a record or seal a field late, never by a surface.
   * `values`: plain values (strings) that moved into a sealed field: every task whose stored text contains one, as a substring, loses its whole text. `record`: every task about that record loses its text.
   * The task keeps its structure with a plain title, a task waiting for its check goes back to ready, and the log's `text_hash` no longer resolves to anything. @param {{ values?: string[], record?: string }} o @returns {{ cleared: number }}
   */
  return async function scrubTexts(o = {}) {
    const values = (Array.isArray(o.values) ? o.values : []).filter((/** @type {any} */ v) => typeof v === "string" && v.length >= 3);
    let cleared = 0;
    /** @type {Set<string>} */ const hit = new Set();
    // Every task about one of these records loses its text, whatever it says: a person's name or number can be written in more ways than any comparison can know ("Ana M. Lopez", "LOPEZ, Ana").
    const aboutRecs = new Set([...(typeof o.record === "string" && o.record ? [o.record] : []), ...(Array.isArray(o.records) ? o.records.filter((/** @type {any} */ r) => typeof r === "string") : [])]);
    if (aboutRecs.size) for (const t of tasks.values()) if (t.record && aboutRecs.has(t.record)) hit.add(t.id);
    if (values.length) {
      // A value is looked for in the normalised text: compatibility-folded (NFKC), case-folded, without spaces (of any kind), punctuation or zero-width marks, so "123-45-6789", "123 45 6789",
      // "ANA  MARIA" and a value split across two form fields (the leaves are joined) all match. Plain and JSON-escaped spellings are checked too.
      const norm = (/** @type {string} */ x) => x.normalize("NFKC").toLowerCase().replace(/[\s\p{Z}\p{P}\p{Cf}]+/gu, "");
      const wants = values.map((/** @type {string} */ v) => norm(v)).filter((/** @type {string} */ n) => n.length >= 3);
      const leaves = (/** @type {any} */ x, /** @type {string[]} */ out) => { if (typeof x === "string") out.push(x); else if (Array.isArray(x)) for (const y of x) leaves(y, out); else if (x && typeof x === "object") for (const y of Object.values(x)) leaves(y, out); return out; };
      const rows = typeof texts.all === "function" ? texts.all() : [...tasks.keys()].map(id => [id, texts.get(id)]);
      for (const [id, x] of rows) {
        let j = ""; try { j = JSON.stringify(x) || ""; } catch { j = ""; }
        const flat = norm(leaves(x, []).join(""));
        if (values.some((/** @type {string} */ v) => j.includes(v) || j.includes(JSON.stringify(v).slice(1, -1))) || wants.some((/** @type {string} */ n) => flat.includes(n))) hit.add(String(id));
      }
      // The words of a task are its record's: look there too, in every text field of the type (custom ones included).
      const defs = await recs.types();
      const names = (((defs.find((/** @type {any} */ d) => d.name === "task") || {}).fields) || []).filter((/** @type {any} */ f) => ["text", "rich_text"].includes(f.kind) && !["status", "stage", "record", "parent", "project"].includes(f.name)).map((/** @type {any} */ f) => f.name);
      for (let cursor; ;) {
        const page = await recs.query("task", { page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        for (const row of page.rows) {
          const text = names.map((/** @type {string} */ n) => (typeof row.data[n] === "string" ? row.data[n] : "")).join("");
          const flat = norm(text);
          if (values.some((/** @type {string} */ v) => text.includes(v)) || wants.some((/** @type {string} */ n) => flat.includes(n))) hit.add(String(row.id));
        }
        cursor = page.next_cursor;
        if (!cursor) break;
      }
    }
    for (const id of hit) {
      const t = tasks.get(id);
      try { texts.drop(id); } catch { texts.set(id, undefined); }
      bodies.delete(id);
      if (t) {
        const { payload, ...rest } = /** @type {any} */ (t);
        const plain = withoutText(rest);
        tasks.set(id, deepFreeze({ ...plain, title: "(the text of this task was removed)", ...(t.state === "needs_check" ? { state: "ready" } : {}) }));
      }
      // and the words on its record go too: the title is replaced, the note and every other text field emptied
      {
        const defs = await recs.types();
        const names = (((defs.find((/** @type {any} */ d) => d.name === "task") || {}).fields) || []).filter((/** @type {any} */ f) => ["text", "rich_text"].includes(f.kind) && !["title", "status", "stage", "record", "parent", "project"].includes(f.name)).map((/** @type {any} */ f) => f.name);
        try { await recUpdate(id, { title: "(the text of this task was removed)", ...Object.fromEntries(names.map((/** @type {string} */ n) => [n, null])) }); } catch { /* a record that is not there has nothing to clear */ }
      }
      cleared++;
    }
    return { cleared, ids: [...hit], fields: await (async () => { const defs = await recs.types(); return (((defs.find((/** @type {any} */ d) => d.name === "task") || {}).fields) || []).filter((/** @type {any} */ f) => ["text", "rich_text"].includes(f.kind) && !["status", "stage", "record", "parent", "project"].includes(f.name)).map((/** @type {any} */ f) => f.name); })() };
  };
}
