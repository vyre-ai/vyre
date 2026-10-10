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

  /** The kind a timeline entry is drawn as (its icon), by the record type. @param {string} type @param {any} d */
const kindOf = (type, d) => (type === "communication" ? (d.kind === "text" ? "text" : d.kind === "call" ? "call" : d.kind === "meeting" ? "meeting" : "email") : type === "task" ? "task" : type === "team-member" ? "person" : type === "chat-record" ? "chat" : type === "file-share" ? "file" : type === "flow-run" ? "flow" : /document|letter|contract|agreement/.test(type) ? "document" : "record");
const dateOf = (/** @type {any} */ v) => { const n = typeof v === "number" ? v : Date.parse(String(v || "")); return Number.isFinite(n) ? n : 0; };
const cap = (/** @type {string} */ x) => (x ? x[0].toUpperCase() + x.slice(1) : x);
/** What a Flow run's state means to the person reading a record's story. */
const FLOW_RUN_WORDS = { running: "running", waiting: "waiting for a person", paused: "paused", queued: "held", done: "done", failed: "did not finish", cancelled: "stopped" };
/** One plain line for a row, in the partner's words: what happened and to what. @param {string} type @param {any} d the record's data @param {string} title */
export function lineOf(type, d, title) {
  if (type === "communication") {
    const what = d.kind === "text" ? "Text" : d.kind === "call" ? "Call" : d.kind === "meeting" ? "Meeting" : d.kind === "letter" ? "Letter" : "Email";
    const subj = String(d.subject || d.excerpt || "").trim().slice(0, 120);
    const who = String((d.direction === "inbound" ? d.from : d.to) || "").split(",")[0].trim();
    const way = d.direction === "inbound" ? "received" : d.direction === "internal" ? "noted" : "sent";
    return `${what} ${way}${who ? (d.direction === "inbound" ? ` from ${who}` : ` to ${who}`) : ""}${subj ? `: ${subj}` : ""}`;
  }
  if (type === "task") return d.status === "done" ? `Task done: ${title}` : d.status === "skipped" ? `Task skipped: ${title}` : d.status === "stuck" ? `Task stuck: ${title}` : `Task: ${title}`;
  if (type === "chat-record") return `Chat: ${title}`;
  if (type === "flow-run") return `${d.title || "A Flow"}: ${FLOW_RUN_WORDS[String(d.state)] || "ran"}`;
  if (type === "team-member") return `${title} joined the team${d.role ? ` as ${d.role}` : ""}`;
  const state = String(d.status || d.state || "").toLowerCase();
  if (/signed|completed|filed|sent|approved/.test(state)) return `${title} ${state}`;
  return state && !/^(draft|active|open)$/.test(state) ? `${title} (${state})` : title;
}

/**
 * @param {{ kernelOf: () => any, hub: () => any, inChat: (chain: any, chat: string) => boolean, me: (chain: any) => string, vaultUses?: (urn: string, limit: number) => Promise<{ item: string, at: number, line: string }[]> }} o
 */
export function createTimeline({ kernelOf, hub, inChat, me, vaultUses }) {
  /** Everything that links to a record as one story, newest first: the rows that link to it, the stages it moved through and, for a project, the files shared from its chats. A chat the caller is not in shows only when it is shared, by its title. @param {any} chain @param {string} urn @param {number} limit */
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
      const d = r.data || {};
      const at = x.type === "communication" ? dateOf(d.at) || Number(r.updated_at || 0) : Number(r.updated_at || 0);
      if (x.type === "chat-record") {
        const mine = inChat(chain, String(d.chat || ""));
        if (!mine && d.shared !== true) continue;
        out.push({ type: "chat", kind: "chat", id: r.id, urn: r.urn, title: titleOf(r), line: lineOf(x.type, d, titleOf(r)), at, mine, shared: d.shared === true, field: x.field, ...(mine ? { chat: String(d.chat) } : {}) });
        continue;
      }
      out.push({ type: x.type, kind: kindOf(x.type, d), id: r.id, urn: r.urn, title: titleOf(r), line: lineOf(x.type, d, titleOf(r)), at, field: x.field });
    }
    // the stages a project moved through: a stage's first task is made when the project enters it, so the earliest task of each stage dates the move (the stage engine keeps no history of its own)
    const entered = new Map();
    for (const x of rows) if (x.type === "task" && x.record.data && x.record.data.stage) { const st = String(x.record.data.stage), t = Number(x.record.created_at || x.record.updated_at || 0); if (!entered.has(st) || t < entered.get(st)) entered.set(st, t); }
    for (const [st, t] of entered) out.push({ type: "stage", kind: "stage", id: `stage:${st}`, urn, title: st, line: `Entered the ${st} stage`, at: t });
    // files shared with the project from its chats: the share records whose path is under the project's folder
    try {
      const proj = urn.split("/")[3] === "project" ? await k.records.get(chain, "project", urn.split("/")[4]) : null;
      // where the story begins: a project that started from a template says which one (the template's own words, kept on the project)
      if (proj && proj.data && proj.data.template_snapshot) {
        let tname = "";
        try { tname = String(JSON.parse(String(proj.data.template_snapshot)).name || ""); } catch { /* an unreadable snapshot says nothing */ }
        if (tname) out.push({ type: "project-start", kind: "project", id: `start:${proj.id}`, urn, title: tname, line: `Started from the ${tname} template`, at: Number(proj.created_at || proj.updated_at || 0) });
      }
      const root = proj && proj.data && proj.data.drive_path ? String(proj.data.drive_path) : "";
      if (root) {
        for (const r of (await k.records.query(chain, "file-share", { page: { limit: 200 } })).rows || []) {
          const path = String(r.data.path || "");
          if (path.startsWith(`${root}/`)) out.push({ type: "file-share", kind: "file", id: r.id, urn: r.urn, title: path.split("/").pop() || path, line: `File shared: ${path.split("/").pop() || path}`, at: Number(r.updated_at || 0) });
        }
      }
    } catch { /* no shares to show */ }
    // the uses of credentials linked to this record (R031-71): a line and a time, never the credential; shown only to someone who can read the record
    if (vaultUses) {
      try {
        const [, , , type, id] = urn.split("/");
        if (await k.records.get(chain, type, id)) for (const u of await vaultUses(urn, 20)) out.push({ type: "vault-use", kind: "vault", id: `vault:${u.item}:${u.at}`, urn, title: u.item, line: u.line, at: Number(u.at) || 0 });
      } catch { /* the vault is not here, or the record is not readable: no credential lines */ }
    }
    out.sort((a, b) => b.at - a.at);
    return { entries: out.slice(0, limit), truncated: Boolean(truncated) };
  }

  /** @param {any} chain @param {{ record?: string, project?: string, limit?: number }} i */
  async function timeline(chain, i) {
    const k = kernelOf();
    let urn = String(i.record || "");
    if (!urn && i.project) {
      const p = ((await k.records.query(chain, "project", { filter: { field: "slug", op: "eq", value: String(i.project) }, page: { limit: 1 } })).rows || [])[0];
      if (!p) throw Object.assign(new Error("no such project (projects.list shows them)"), { code: "not_found" });
      urn = p.urn;
    }
    if (!URN.test(urn)) throw Object.assign(new Error("name a record (its urn) or a project"), { code: "bad_input" });
    return { record: urn, ...(await entries(chain, urn, Math.min(Number(i.limit) || 100, 200))) };
  }

  /** @param {any} chain @param {{ chat: string, record?: string | null, shared?: boolean }} i */
  async function link(chain, i) {
    const chat = String(i.chat);
    if (!inChat(chain, chat)) throw Object.assign(new Error("no such chat (work.chat.list shows the chats you may see)"), { code: "not_found" });
    const rec = await hub().chatRecord(chat);
    if (!rec) throw Object.assign(new Error("no record of that chat (work.chat.list shows the chats you may see)"), { code: "not_found" });
    /** @type {any} */ const patch = {};
    if (i.record !== undefined) {
      if (i.record !== null && !URN.test(String(i.record))) throw Object.assign(new Error("name the record by its urn"), { code: "bad_input" });
      // the person must be able to read the record they link a chat to
      if (i.record !== null) { const [, , , type, id] = String(i.record).split("/"); const got = await kernelOf().records.get(chain, type, id).catch(() => null); if (!got) throw Object.assign(new Error("no such record: check the address (urn) you gave, and that you may read it"), { code: "not_found" }); }
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
