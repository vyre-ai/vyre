// @ts-check
// Which paired server a call goes to, when a device is paired to several. One rule: the server follows the Space. A call that names a server (the Space-making calls, which name a server and no Space yet) goes
// there; else the server that hosts the Space the call is for; else the one that hosts the Space showing; else the active one (box undefined). A server this device is not paired to is never swapped for another:
// it is refused in words that name the next step. Pure; src/real/space-servers.ts keeps the map and src/real/box.ts asks it.

import { chatsFrom } from "../../screens/chats/chats-model.js";

const SPACE = /^spc_[a-z2-7]{12}$/;
const ADDRESS = /^vyre:\/\/(spc_[a-z2-7]{12})\//;
const NOT_PAIRED = "This device is not paired to that server. Add it in Settings, Servers, then try again.";

/**
 * What is NOT routed or refused: the device's own tools (pairing, relay, presence, identity, approvals, push, onboarding), the tools about Spaces themselves (a Space they name is still followed), and a server's own settings
 * and meta. Everything else, including any family added later, is treated as acting inside a Space: it follows the Space showing and is refused under All spaces when several servers are paired.
 */
const ALLOW = ["relay.", "wink.", "presence.", "identity.", "spaces.", "approvals.", "push.", "names.", "onboard.", "settings.", "appearance.", "sidebar.", "update.", "system.", "spend.", "about.", "tips.", "commands.", "events.", "providers.", "statusline.", "vyre.", "releases."];
/** A plain read of many (or of status) carries nothing private: under All spaces it is the active server's, as it always was. The vault has no such exemption: even its list names what a person keeps. */
const PLAIN_READ = /\.(list|types|me|actors|library|events|status|catalog|catalogue|accounts|agenda|holders|serve|serve-create|serve-update|serve-request|serve-work)$/;
/** The inputs that name an item by an id alone. */
const ID_KEYS = ["id", "task", "project", "template", "thread"];

/** Must the Space (and with it the server) be known for this tool? Yes unless it is on the allow-list or is a plain read; the vault is always yes. @param {string | undefined} tool */
export const needsSpace = (tool) => {
  if (!tool) return false;
  if (tool.startsWith("vault.")) return true;
  if (PLAIN_READ.test(tool) || ALLOW.some((p) => tool.startsWith(p))) return false;
  return true;
};

/**
 * A chat goes to the server that holds it, whatever is showing, and one whose server is not known is refused (a message for one server's chat must never land on another). A record address (`urn`) names its Space.
 * @param {{ tool?: string, explicit?: string, input?: Record<string, unknown>, showing?: string, spaceServers: Record<string, string>, paired: string[], chatServers?: Record<string, string>, itemSpaces?: Record<string, string> }} o
 * @returns {{ box?: string, space?: string, error?: { code: string, message: string } }}
 */
export function serverFor(o) {
  const refuse = () => ({ error: { code: "server_not_paired", message: NOT_PAIRED } });
  if (o.explicit) return o.paired.includes(o.explicit) ? { box: o.explicit } : refuse();
  const chat = o.input && typeof o.input.chat === "string" ? o.input.chat : "";
  if (chat && o.paired.length > 1) {
    const at = (o.chatServers ?? {})[chat];
    if (!at) return { error: { code: "chat_unknown_server", message: "Vyre does not know which server this chat is on yet. Open Chats to refresh the list, then try again. Nothing was sent." } };
    return o.paired.includes(at) ? { box: at } : refuse();
  }
  // An action that names an item by its id alone goes to the Space the id was seen in (a list, or the call that made it), whatever is showing. An id never seen is refused when several servers are paired.
  if (o.paired.length > 1 && needsSpace(o.tool) && !(o.input && typeof o.input.space === "string" && o.input.space) && !(o.input && typeof o.input.urn === "string")) {
    const idv = ID_KEYS.map((k) => (o.input ? o.input[k] : undefined)).find((v) => typeof v === "string" && v);
    if (typeof idv === "string") {
      const sp = (o.itemSpaces ?? {})[idv];
      if (!sp) return { error: { code: "item_unknown_server", message: "Vyre does not know which Space this belongs to. Open the Space it is in, so its list loads, then try again. Nothing was changed." } };
      const at = o.spaceServers[sp];
      if (!at) return { error: { code: "space_unknown_server", message: "Vyre does not know which server holds that Space yet. Open Settings, Servers, wait a moment and try again. Nothing was changed." } };
      return o.paired.includes(at) ? { box: at, space: sp } : refuse();
    }
  }
  const urn = o.input && typeof o.input.urn === "string" ? ADDRESS.exec(o.input.urn) : null;
  const named = urn ? urn[1] : o.input && typeof o.input.space === "string" ? o.input.space : "";
  const space = SPACE.test(named) ? named : SPACE.test(o.showing ?? "") ? /** @type {string} */ (o.showing) : "";
  const box = space ? o.spaceServers[space] : undefined;
  if (!box && o.paired.length > 1 && needsSpace(o.tool)) {
    // An action on a record, file, task, rule, flow or project goes to the server that holds its Space and nowhere else: with no Space, or one whose server is unknown, it is refused, never sent to the active server.
    return space
      ? { error: { code: "space_unknown_server", message: "Vyre does not know which server holds that Space yet. Open Settings, Servers, wait a moment and try again. Nothing was changed." } }
      : { error: { code: "pick_a_space", message: "Pick the Space this is for first. Each Space lives on one server, and this goes only there. Nothing was changed." } };
  }
  if (!box) return { box: undefined };
  return o.paired.includes(box) ? { box } : refuse();
}

/**
 * The Space-to-server map from what each paired server says it hosts (its own spaces.list). A row for a team the person only JOINED (`member`) is not hosted there; a Space listed by two servers stays with the first.
 * @param {Record<string, Array<{ id?: unknown, member?: unknown } | null> | undefined>} lists by box id
 * @returns {Record<string, string>}
 */
export function spaceServersFrom(lists) {
  /** @type {Record<string, string>} */ const out = {};
  for (const [box, rows] of Object.entries(lists)) {
    for (const r of rows ?? []) {
      const id = r && typeof r.id === "string" ? r.id : "";
      if (SPACE.test(id) && r && r.member !== true && !out[id]) out[id] = box;
    }
  }
  return out;
}

/**
 * Every paired server's Spaces as one list (the switcher): each row keeps what its server said and gains `server`, the box id it is on. A Space listed by two servers appears once, under the first.
 * @param {Record<string, Array<Record<string, any> | null> | undefined>} lists by box id
 * @returns {Array<Record<string, any>>}
 */
export function mergeSpaceLists(lists) {
  /** @type {Array<Record<string, any>>} */ const out = [];
  const seen = new Set();
  for (const [box, rows] of Object.entries(lists)) {
    for (const r of rows ?? []) {
      if (!r || typeof r.id !== "string" || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ ...r, server: box });
    }
  }
  return out;
}

/**
 * The chat-to-server map from what each server's work.chat.list answered. A chat listed by two servers stays with the first.
 * @param {Record<string, any>} lists by box id (the raw answers)
 * @returns {Record<string, string>}
 */
export function chatServersFrom(lists) {
  /** @type {Record<string, string>} */ const out = {};
  for (const [box, data] of Object.entries(lists)) for (const c of data ? chatsFrom(data) : []) if (!out[c.id]) out[c.id] = box;
  return out;
}

/**
 * The ids a list (or a call that made something) shows, each with the Space it was in: the row's own address, else its `space`, else the Space the call was for. A row with none of these remembers nothing.
 * @param {any} answer a list, an object holding one (tasks, rows, records, items, chats), or one thing just made @param {string | undefined} space the Space the call was for
 * @returns {Record<string, string>}
 */
export function itemSpacesFrom(answer, space) {
  /** @type {Record<string, string>} */ const out = {};
  const rows = Array.isArray(answer) ? answer : answer && typeof answer === "object" ? (["tasks", "rows", "records", "items", "chats", "rules", "flows", "projects", "templates"].map((k) => answer[k]).find(Array.isArray) ?? [answer]) : [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const addr = typeof r.urn === "string" ? ADDRESS.exec(r.urn) : null;
    const sp = addr ? addr[1] : SPACE.test(String(r.space ?? "")) ? String(r.space) : space && SPACE.test(space) ? space : "";
    if (!sp) continue;
    const last = typeof r.urn === "string" ? r.urn.split("/").pop() : "";
    for (const id of [r.id, r.slug, r.task, last]) if (typeof id === "string" && id) out[id] = sp;
  }
  return out;
}
