// @ts-check
// One timeline per record and per project (R031-46), and a chat's link to a record (R031-41).
//   work.timeline { record | project }   everything that links to that record, newest first: tasks, documents, messages, files, chats, whatever the kernel lets this person read
//   work.chat.link { chat, record, shared? }   a chat is about a record (null takes the link off); `shared` shows the chat on the record's timeline to everyone who can see the record
// The timeline is the kernel's own `records.linked`: it already answers only with rows the caller may read, row by row, so a record type someone cannot see never shows. The one rule added here is for chats:
// a chat is its people's until they share it, so another person sees it on a timeline only when it is shared, and then only its title.

const TITLE_KEYS = ["title", "name", "subject", "label", "summary"];
/** @param {any} r a record row */
const titleOf = r => { const d = (r && r.data) || {}; for (const k of TITLE_KEYS) if (typeof d[k] === "string" && d[k].trim()) return d[k].trim().slice(0, 160); return String(r.type || "record"); };
/** The urn a chat record's `about` link holds, or null. @param {any} r */
const aboutOf = r => (r && r.data && r.data.about && r.data.about.urn) || null;
const URN = /^vyre:\/\/[^/]+\/[a-z0-9][a-z0-9-]*\/[0-9a-f-]{36}$/;

/**
 * @param {{ kernelOf: () => any, hub: () => any, inChat: (chain: any, chat: string) => boolean, me: (chain: any) => string }} o
 */
export function createTimeline({ kernelOf, hub, inChat, me }) {
  /** The rows that link to a record, as timeline entries. A chat the caller is not in shows only when it is shared, by its title. @param {any} chain @param {string} urn @param {number} limit */
  async function entries(chain, urn, limit) {
    const k = kernelOf();
    const { rows, truncated } = await k.records.linked(chain, urn, { limit });
    /** @type {any[]} */ const out = [];
    const seen = new Set();
    for (const x of rows) {
      const r = x.record;
      const key = `${x.type}/${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (x.type === "chat-record") {
        const mine = inChat(chain, String(r.data.chat || ""));
        if (!mine && r.data.shared !== true) continue;
        out.push({ type: "chat", id: r.id, urn: r.urn, title: titleOf(r), at: Number(r.updated_at || 0), mine, shared: r.data.shared === true, field: x.field, ...(mine ? { chat: String(r.data.chat) } : {}) });
        continue;
      }
      out.push({ type: x.type, id: r.id, urn: r.urn, title: titleOf(r), at: Number(r.updated_at || 0), field: x.field });
    }
    out.sort((a, b) => b.at - a.at);
    return { entries: out, truncated: Boolean(truncated) };
  }

  /** @param {any} chain @param {{ record?: string, project?: string, limit?: number }} i */
  async function timeline(chain, i) {
    const k = kernelOf();
    let urn = String(i.record || "");
    if (!urn && i.project) {
      const p = ((await k.records.query(chain, "project", { filter: { field: "slug", op: "eq", value: String(i.project) }, page: { limit: 1 } })).rows || [])[0];
      if (!p) throw Object.assign(new Error("no such project"), { code: "not_found" });
      urn = p.urn;
    }
    if (!URN.test(urn)) throw Object.assign(new Error("name a record (its urn) or a project"), { code: "bad_input" });
    return { record: urn, ...(await entries(chain, urn, Math.min(Number(i.limit) || 100, 200))) };
  }

  /** @param {any} chain @param {{ chat: string, record?: string | null, shared?: boolean }} i */
  async function link(chain, i) {
    const chat = String(i.chat);
    if (!inChat(chain, chat)) throw Object.assign(new Error("no such chat"), { code: "not_found" });
    const rec = await hub().chatRecord(chat);
    if (!rec) throw Object.assign(new Error("no record of that chat"), { code: "not_found" });
    /** @type {any} */ const patch = {};
    if (i.record !== undefined) {
      if (i.record !== null && !URN.test(String(i.record))) throw Object.assign(new Error("name the record by its urn"), { code: "bad_input" });
      // the person must be able to read the record they link a chat to
      if (i.record !== null) { const [, , , type, id] = String(i.record).split("/"); const got = await kernelOf().records.get(chain, type, id).catch(() => null); if (!got) throw Object.assign(new Error("no such record"), { code: "not_found" }); }
      patch.about = i.record === null ? null : { urn: String(i.record) };
      if (i.record === null) patch.shared = false;
    }
    if (typeof i.shared === "boolean") patch.shared = i.shared;
    if (!Object.keys(patch).length) return { chat, about: aboutOf(rec), shared: rec.data.shared === true };
    const r = await hub().setChatFields(rec, patch);
    return { chat, about: aboutOf(r), shared: r.data.shared === true, by: me(chain) };
  }
  /** Which records of the Space a piece of chat text names ("Northwind"): a client, a contact or a project whose name appears as whole words. At most three; never one the person cannot read. @param {any} chain @param {{ text: string }} i */
  async function suggest(chain, i) {
    const text = String(i.text || "").slice(0, 4000).toLowerCase();
    if (text.length < 4) return { suggestions: [] };
    const k = kernelOf();
    /** @type {any[]} */ const out = [];
    for (const type of ["organization", "contact", "project"]) {
      const rows = (await k.records.query(chain, type, { page: { limit: 200 } }).catch(() => ({ rows: [] }))).rows || [];
      for (const r of rows) {
        const name = String((r.data && (r.data.name || r.data.title)) || "").trim();
        if (name.length < 4 || (r.data && r.data.personal_of)) continue;
        const esc = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(text)) out.push({ urn: r.urn, type, title: name });
      }
    }
    return { suggestions: out.slice(0, 3) };
  }
  return { timeline, link, suggest };
}
