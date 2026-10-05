// @ts-check
// The Chats list as one row type (CONTRACT-one-chat.md section 1): a chat is a record with a title, who is in it (people and assistants), the models on its slots, a project, a status and a last
// line. Solo, group and people-only chats are all the same row. work.chat.list answers these; until a box has it, the list is made from the box's older list of sessions (fromThread), so nothing
// the person sees names a session, a thread or a room.

/** @typedef {{ id: string, title: string, project: string, people: string[], agents: string[], models: string[], providers: string[], status: string, last: number, line: string, asks: number, open: boolean }} ChatRow */

const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
const strs = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const PROVIDERS = ["claude", "codex", "grok"];

/** The chat id out of a record address (vyre://<space>/chat/<id>) or the id itself. @param {string} urn */
export const chatIdOf = (urn) => { const m = /\/chat\/([^/?#]+)$/.exec(urn); return m ? m[1] : urn; };

/**
 * work.chat.list's rows. A row is the Chat record (its fields flat, or under `data`); `open` is only true when the box says the caller is in the chat, so a row for a chat the caller is not in
 * is greyed and cannot be opened. @param {any} data @returns {ChatRow[]}
 */
export function chatsFrom(data) {
  const rows = Array.isArray(data) ? data : data && Array.isArray(data.rows) ? data.rows : data && Array.isArray(data.chats) ? data.chats : [];
  /** @type {ChatRow[]} */ const out = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const d = r.data && typeof r.data === "object" ? { ...r.data, ...r } : r;
    const id = chatIdOf(str(d.id) || str(d.chat) || str(d.urn));
    if (!id) continue;
    out.push({
      id, title: str(d.title) || "New chat", project: str(d.project_name) || str(d.projectName) || "", people: strs(d.people), agents: strs(d.agents), models: strs(d.models),
      providers: strs(d.providers).filter((p) => PROVIDERS.includes(p)), status: str(d.status) || "idle",
      last: Number(d.last_active ?? d.updated_at ?? d.last ?? 0) || 0, line: str(d.summary), asks: Number(d.asks ?? 0) || 0, open: d.open === true,
    });
  }
  return out;
}

/** The state word, most urgent first. @param {ChatRow} c */
export function chatState(c) {
  if (c.asks > 0) return "needs-you";
  if (c.status === "failed") return "failed";
  if (c.status === "working" || c.status === "starting" || c.status === "waiting") return "running";
  return "done";
}

/** What the row says under the title: who is in it, the project, the last line. @param {ChatRow} c */
export function chatSub(c) {
  const who = [...c.people, ...c.agents];
  const names = who.length > 3 ? `${who.slice(0, 3).join(", ")} and ${who.length - 3} more` : who.join(", ");
  return [c.asks > 0 ? `${c.asks} waiting on you` : "", names, c.project, c.line].filter(Boolean).join(" · ");
}

/** Chats that need you first, then running, then the rest by last activity. @param {readonly ChatRow[]} list */
export function chatsOrdered(list) {
  const rank = { "needs-you": 0, failed: 1, running: 2, done: 3 };
  return [...list].sort((a, b) => rank[chatState(a)] - rank[chatState(b)] || b.last - a.last);
}

/** The three scripted chats of the sample world (CONTRACT-one-chat.md section 4): a solo chat, a three-model chat, a people-only chat and one where the assistant acted for the person. @param {number} now @returns {ChatRow[]} */
export function sampleChats(now) {
  return [
    { id: "demo", title: "Lease reply", project: "Northwind Bakery", people: ["alex"], agents: ["kit"], models: ["kit on Claude"], providers: ["claude"], status: "idle", last: now - 6 * 60_000, line: "Draft ready for your review", asks: 0, open: true },
    { id: "demo-three", title: "Which clause is riskier?", project: "Northwind Bakery", people: ["alex"], agents: ["kit"], models: ["kit on Claude", "kit on Codex", "Grok"], providers: ["claude", "codex", "grok"], status: "idle", last: now - 3_600_000, line: "Three answers, you kept one", asks: 0, open: true },
    { id: "demo-assistant", title: "Tests before the call", project: "Northwind Bakery", people: ["alex"], agents: ["kit"], models: [], providers: ["claude"], status: "idle", last: now - 7_200_000, line: "Sent by Vyre Assistant", asks: 0, open: true },
    { id: "demo-people", title: "Intake hand-off", project: "General", people: ["alex", "Sam"], agents: [], models: [], providers: [], status: "idle", last: now - 86_400_000, line: "Sam: I will call them Monday", asks: 0, open: true },
  ];
}

/** What the Chats screen says on a box that has no work.chat.list: the app and the box ship together, so there is one path. */
export const UNSUPPORTED = "Update your server to use Chats";

/** Is this the refusal of a tool the box does not have? @param {{ code?: string } | null | undefined} e */
export const noSuchTool = (e) => /unknown_tool|no_such_tool|not_found|unknown tool/.test(String(e?.code ?? ""));
