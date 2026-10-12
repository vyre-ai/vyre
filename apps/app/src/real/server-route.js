// @ts-check
// Which paired server a call goes to, when a device is paired to several. One rule: the server follows the Space. A call that names a server (the Space-making calls, which name a server and no Space yet) goes
// there; else the server that hosts the Space the call is for; else the one that hosts the Space showing; else the active one (box undefined). A server this device is not paired to is never swapped for another:
// it is refused in words that name the next step. Pure; src/real/space-servers.ts keeps the map and src/real/box.ts asks it.

import { chatsFrom } from "../../screens/chats/chats-model.js";

const SPACE = /^spc_[a-z2-7]{12}$/;
const ADDRESS = /^vyre:\/\/(spc_[a-z2-7]{12})\//;
const NOT_PAIRED = "This device is not paired to that server. Add it in Settings, Servers, then try again.";

/**
 * A chat goes to the server that holds it, whatever is showing, and one whose server is not known is refused (a message for one server's chat must never land on another). A record address (`urn`) names its Space.
 * @param {{ explicit?: string, input?: Record<string, unknown>, showing?: string, spaceServers: Record<string, string>, paired: string[], chatServers?: Record<string, string> }} o
 * @returns {{ box?: string, error?: { code: string, message: string } }}
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
  const urn = o.input && typeof o.input.urn === "string" ? ADDRESS.exec(o.input.urn) : null;
  const named = urn ? urn[1] : o.input && typeof o.input.space === "string" ? o.input.space : "";
  const space = SPACE.test(named) ? named : SPACE.test(o.showing ?? "") ? /** @type {string} */ (o.showing) : "";
  const box = space ? o.spaceServers[space] : undefined;
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
