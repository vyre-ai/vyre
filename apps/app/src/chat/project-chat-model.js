// @ts-check
// A project has one group chat (work.project.chat). What a device does with its answer, as a plan: make the chat (the answer asks for a ring), add the people who are missing, take out those who should not be
// in it, wait (a teammate's device makes it first), or nothing. Pure; project-chat.ts does the calls.

/** @typedef {{ do: "none" } | { do: "wait" } | { do: "make", id: string, people: string[] } | { do: "add", chat: string, people: string[] } | { do: "drop", chat: string, people: string[], remaining: string[] }} Plan */

/** @param {any} a work.project.chat's answer @returns {Plan} */
export function projectChatPlan(a) {
  if (!a || typeof a !== "object") return { do: "none" };
  if (a.needs_ring && typeof a.id === "string") return { do: "make", id: a.id, people: Array.isArray(a.people) ? a.people.map(String) : [] };
  if (a.pending || a.waiting || (a.chat && a.member === false)) return { do: "wait" };
  if (!a.chat || a.member !== true) return { do: "none" };
  const missing = Array.isArray(a.missing) ? a.missing.map(String) : [], extra = Array.isArray(a.extra) ? a.extra.map(String) : [];
  if (missing.length) return { do: "add", chat: String(a.chat), people: missing };
  if (extra.length) return { do: "drop", chat: String(a.chat), people: extra, remaining: (Array.isArray(a.people) ? a.people.map(String) : []).filter((/** @type {string} */ p) => !extra.includes(p)) };
  return { do: "none" };
}
