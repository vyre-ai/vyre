// @ts-check
// A record's history for the Records screens: who changed it (a person or an assistant), what a call, a meeting or a note said, and an undo for each change.
// records.history { urn } -> { items }, records.history.undo { id }, records.log { urn, kind, text }. Changes come from the signed event log the caller may read; calls and meetings are `communication` rows
// and notes are `note` rows that link to the record. An undo is a change of its own (the old values written back, a made record removed, a removed one restored), so it shows in the history too.

/** Notes are the planner's Note type (core/planner/note-share.js decides who reads one). */
export const NOTE = "note";
export const LOG_KINDS = ["call", "meeting", "note"];
const CHANGE = /^([a-z][a-z0-9-]*)\.(created|updated|removed|restored)$/;
const NOT_RECORDS = /^(grant|member|actor|offer|invite|chat|rule|team|vault|task|team-member|flow|kit|goal|memory_fact|planner)/;

/** A short line of a value. @param {any} v */
export function shown(v) {
  if (v === null || v === undefined || v === "") return "nothing";
  if (typeof v === "object") return v.urn ? "a link" : Array.isArray(v) ? `${v.length} items` : "a value";
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/** Who did it. The log keeps a person as person:id@space; an assistant acting for a person is marked and shown as the assistant. @param {any} e @param {Map<string, string>} [names] */
export function actorOf(e, names = new Map()) {
  const raw = String(e.actor || "");
  const [kind, rest] = raw.split(":");
  const id = (rest || raw).split("@")[0];
  if (e.acted_via === "assistant") return { kind: /** @type {"agent"} */ ("agent"), id: "assistant", name: "Assistant" };
  if (kind === "agent" || kind === "service") return { kind: /** @type {"agent"} */ ("agent"), id, name: names.get(id) || id };
  return { kind: /** @type {"person"} */ ("person"), id, name: names.get(id) || id };
}

/** The sentence for one change. @param {string} verb @param {string} typeLabel @param {string[]} changed @param {any} before @param {any} after @param {(name: string) => string} label */
export function sentence(verb, typeLabel, changed, before, after, label) {
  if (verb === "created") return `Created the ${typeLabel.toLowerCase()}`;
  if (verb === "removed") return "Moved to the bin";
  if (verb === "restored") return "Brought back from the bin";
  const fields = (changed || []).filter((c) => c !== "extra" && c !== "weighted_value");
  if (!fields.length) return "Changed the record";
  if (fields.length === 1) {
    const f = fields[0];
    const was = before && before[f], now = after && after[f];
    return was === undefined || was === null || was === "" ? `Set ${label(f)} to ${shown(now)}` : now === undefined || now === null || now === "" ? `Cleared ${label(f)}` : `Changed ${label(f)} from ${shown(was)} to ${shown(now)}`;
  }
  return `Changed ${fields.slice(0, 3).map(label).join(", ")}${fields.length > 3 ? ` and ${fields.length - 3} more` : ""}`;
}

/** Whether a value the log holds is a sealed placeholder, which an undo must never write back. @param {any} v */
const sealedShape = (v) => /\{\{field:/.test(JSON.stringify(v ?? null));

/**
 * What an undo does for one event, given the record as it is now (null when it is gone). Throws a plain sentence when it cannot: a later change touched the same fields, the values are sealed,
 * or the record is not in the state the change left it.
 * @param {{ verb: string, changed: string[], before: any, after: any }} ev @param {any} now
 * @returns {{ op: "update", patch: Record<string, any> } | { op: "remove" } | { op: "restore" }}
 */
export function undoPlan(ev, now) {
  if (ev.verb === "created") {
    if (!now) throw new Error("This record is already gone.");
    return { op: "remove" };
  }
  if (ev.verb === "removed") return { op: "restore" };
  if (ev.verb === "restored") {
    if (!now) throw new Error("This record is already gone.");
    return { op: "remove" };
  }
  if (!now) throw new Error("This record is in the bin. Bring it back first.");
  const patch = /** @type {Record<string, any>} */ ({});
  for (const f of ev.changed || []) {
    if (sealedShape(ev.before && ev.before[f]) || sealedShape(ev.after && ev.after[f])) throw new Error("A sealed value cannot be put back from the history.");
    const have = now.data ? now.data[f] : undefined;
    if (JSON.stringify(have ?? null) !== JSON.stringify((ev.after && ev.after[f]) ?? null)) throw new Error(`${f} was changed again after this. Undo the later change first, or set it by hand.`);
    patch[f] = ev.before && ev.before[f] !== undefined ? ev.before[f] : null;
  }
  if (!Object.keys(patch).length) throw new Error("There is nothing to put back.");
  return { op: "update", patch };
}

/** A logged row as a history item. @param {string} type @param {any} row @param {any} actor */
export function loggedItem(type, row, actor) {
  const d = row.data || {};
  if (type === NOTE) return { id: row.urn, kind: "note", actor, text: String(d.body || d.title || ""), at: Number(d.created || row.created_at || row.updated_at || 0), undo: true };
  const kind = d.kind === "meeting" ? "meeting" : d.kind === "call" ? "call" : d.kind === "text" ? "chat" : "email";
  const at = Number.isFinite(Date.parse(String(d.at || ""))) ? Date.parse(String(d.at)) : Number(row.created_at || row.updated_at || 0);
  return { id: row.urn, kind, actor, text: String(d.excerpt || d.subject || ""), at, undo: d.source_key === undefined || d.source_key === null || d.source_key === "" };
}

/** @param {{ tool: Function, obj: Function, str: any, refuse: Function, parseUrn: Function }} h */
export function registerHistory({ tool, obj, str, refuse, parseUrn }) {
  /** @type {(d: any) => Promise<Map<string, string>>} */
  const namesOf = async (d) => {
    try { return new Map(((await d.gateway.grants.members.list(d.chain)) || []).map((/** @type {any} */ m) => [String(m.person), String(m.name || m.person)])); } catch { return new Map(); }
  };
  const byUrn = (/** @type {any} */ i) => ({ space: parseUrn(i.urn).space });
  const personOf = (/** @type {any} */ d) => { const h = d.chain.hops.find((/** @type {any} */ x) => x.actor.kind === "person"); return h ? String(h.actor.id) : ""; };
  const firstEvent = async (/** @type {any} */ d, /** @type {string} */ urn) => {
    try { return (await d.gateway.events.read(d.chain, { subject_prefix: urn, limit: 1 }))[0] || null; } catch { return null; }
  };

  tool("records.history", "A record's history, newest first: changes with who made each, plus logged calls, meetings and notes. { urn, limit? }.",
    obj({ space: str, urn: str, limit: { type: "integer" } }, ["urn"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const u = parseUrn(i.urn);
      const limit = Number.isInteger(i.limit) ? Math.min(Math.max(i.limit, 1), 200) : 50;
      const names = await namesOf(d);
      const def = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ t) => t.name === u.type) || {};
      const label = (/** @type {string} */ n) => { const f = (def.fields || []).find((/** @type {any} */ x) => x.name === n); return String((f && f.label) || n).toLowerCase(); };
      const got = await d.gateway.events.read(d.chain, { subject_prefix: String(i.urn), limit: 500 });
      const items = [];
      for (const e of got) {
        if (e.subject !== i.urn) continue;
        const m = CHANGE.exec(String(e.type));
        if (!m || NOT_RECORDS.test(m[1])) continue;
        const data = e.data || {};
        items.push({ id: String(e.seq), kind: e.acted_via === "assistant" ? "agent" : "edit", actor: actorOf(e, names), text: sentence(m[2], String(def.label || u.type), data.changed || [], data.before, data.after, label), at: Number(e.time), undo: true });
      }
      {
        let rows = [];
        try { rows = ((await d.gateway.records.linked(d.chain, String(i.urn), { type: "communication", field: "record", limit: 50 })) || {}).rows || []; } catch { rows = []; }
        for (const r of rows) {
          const made = await firstEvent(d, String(r.record.urn));
          items.push(loggedItem("communication", r.record, made ? actorOf(made, names) : { kind: "person", id: "", name: "Someone" }));
        }
      }
      // notes about this record: the planner's Note rows, read as the planner and cut to what the caller may read (their own, or shared with the record or the Space). The caller reads the record, or there are none.
      if (await d.gateway.records.get(d.chain, u.type, u.id)) {
        const me = personOf(d);
        let rows = [];
        try { rows = ((await d.gateway.records.query(d.gateway.serviceChain("planner"), NOTE, { filter: { field: "record", op: "eq", value: String(i.urn) }, page: { limit: 100 } })).rows) || []; } catch { rows = []; }
        for (const r of rows) {
          const n = r.data || {};
          if (n.removed_at || !(n.person === me || n.visibility === "space" || n.visibility === "record")) continue;
          items.push(loggedItem(NOTE, { ...r, urn: r.urn || `vyre://${d.space}/${NOTE}/${r.id}` }, { kind: "person", id: String(n.person || ""), name: names.get(String(n.person)) || "Someone" }));
        }
      }
      items.sort((a, b) => b.at - a.at);
      return { items: items.slice(0, limit) };
    }, byUrn);

  tool("records.history.undo", "Undo one change in a record's history: { id } is an item's id from records.history. Writes the old values back, removes a record it made, or brings a removed one back; refused in plain words when a later change touched the same fields. The undo is itself a change in the history.",
    obj({ space: str, id: str, urn: str }, ["id"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const id = String(i.id || "");
      if (/^vyre:\/\//.test(id)) {
        // a logged call, meeting or note: undone by taking the row away (a synced message has no undo)
        const u = parseUrn(id);
        if (u.type !== "communication" && u.type !== NOTE) throw refuse("Only a logged call, meeting or note is undone this way.", "bad_input");
        // a note is the planner's: read and taken away as the planner, and only by the person who wrote it
        const keeper = u.type === NOTE ? d.gateway.serviceChain("planner") : d.chain;
        const row = await d.gateway.records.get(keeper, u.type, u.id);
        if (!row) throw refuse("That entry is already gone.", "not_found");
        if (u.type === NOTE && String((row.data || {}).person || "") !== personOf(d)) throw refuse("Only the person who wrote a note takes it back.", "not_allowed");
        if (u.type === "communication" && row.data && row.data.source_key) throw refuse("A message that came in from outside cannot be undone here.", "bad_input");
        await d.gateway.records.remove(keeper, u.type, u.id, row.version);
        return { undone: id };
      }
      if (!/^[0-9]+$/.test(id)) throw refuse("That is not an id from the history.", "bad_input");
      const seq = Number(id);
      const ev = (await d.gateway.events.read(d.chain, { since: seq - 1, limit: 1 }))[0];
      const m = ev && Number(ev.seq) === seq ? CHANGE.exec(String(ev.type)) : null;
      if (!ev || !m || NOT_RECORDS.test(m[1])) throw refuse("That change is not in the history, or you may not read it.", "not_found");
      const u = parseUrn(String(ev.subject));
      const now = await d.gateway.records.get(d.chain, u.type, u.id).catch(() => null);
      let plan;
      try { plan = undoPlan({ verb: m[2], changed: (ev.data && ev.data.changed) || [], before: ev.data && ev.data.before, after: ev.data && ev.data.after }, now); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "version_conflict"); }
      if (plan.op === "update") await d.gateway.records.update(d.chain, u.type, u.id, plan.patch, now.version);
      else if (plan.op === "remove") await d.gateway.records.remove(d.chain, u.type, u.id, now.version);
      else await d.gateway.records.restore(d.chain, u.type, u.id);
      return { undone: id, record: String(ev.subject) };
    });

  tool("records.log", "Log a call, a meeting or a note on a record: { urn, kind: call|meeting|note, text }. A note starts private.",
    obj({ space: str, urn: str, kind: str, text: str }, ["urn", "kind", "text"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const u = parseUrn(i.urn);
      if (!LOG_KINDS.includes(String(i.kind))) throw refuse(`Log a ${LOG_KINDS.join(", a ")}. ${i.kind} is not one of them.`, "bad_input");
      const text = String(i.text || "").trim();
      if (!text) throw refuse("Write a line first: { text }.", "bad_input");
      if (text.length > 5000) throw refuse("Keep it under 5,000 characters. Put the rest in a document and link it.", "bad_input");
      if (!(await d.gateway.records.get(d.chain, u.type, u.id))) throw refuse(`${i.urn} is not here, or you may not read it. Pick a record you can see in Records.`, "not_found");
      const link = { urn: String(i.urn) };
      const owner = `person:${personOf(d)}`;
      if (i.kind === "note") {
        const who = personOf(d);
        const now = Date.now();
        // the planner's Note, made by the planner's chain on the caller's behalf (the planner picks it up); private to the writer until shared
        return { record: await d.gateway.records.create(d.gateway.serviceChain("planner"), NOTE, { title: text.split("\n")[0].slice(0, 80), body: text, state: "open", visibility: "private", record: link.urn, person: who, source: "records", created: now, updated: now }, { on_behalf: d.chain }) };
      }
      const line = text.split("\n")[0];
      return { record: await d.gateway.records.create(d.chain, "communication", { kind: i.kind, direction: "internal", at: new Date().toISOString(), subject: line.slice(0, 120), excerpt: text.slice(0, 500), record: link, owner }) };
    }, byUrn);
}
