// @ts-check
// The Vault's three groups and its breach banner, as pure functions (team/0.6/CALM-UI-SPEC.md, Vault). No React, no calls.
// "AI and apps" holds keys an agent or an app uses. "Logins" holds sign-ins. "Notes and other" holds everything else: secure notes,
// Wi-Fi, codes and cards. A breach banner shows only when an item is marked breached, and never for a shared item the person cannot change.

export const GROUPS = /** @type {const} */ (["ai-and-apps", "logins", "notes-and-other"]);
export const GROUP_LABEL = /** @type {Record<string, string>} */ ({
  "ai-and-apps": "AI and apps",
  logins: "Logins",
  "notes-and-other": "Notes and other",
});

/** @param {{ kind: string }} item */
export const groupOf = (item) => (item.kind === "Key" ? "ai-and-apps" : item.kind === "Login" ? "logins" : "notes-and-other");

/**
 * The items in their three groups, in the order each arrived.
 * @template {{ kind: string }} T
 * @param {T[]} items
 * @returns {Record<"ai-and-apps" | "logins" | "notes-and-other", T[]>}
 */
export function groupsOf(items) {
  /** @type {Record<"ai-and-apps" | "logins" | "notes-and-other", T[]>} */
  const out = { "ai-and-apps": [], logins: [], "notes-and-other": [] };
  for (const it of items) out[/** @type {keyof typeof out} */ (groupOf(it))].push(it);
  return out;
}

/**
 * The banner's words, or null when there is nothing to say. Only the person's own items count: a shared one is the owner's to fix.
 * @param {{ breached?: boolean, mine?: boolean }[]} items
 * @returns {string | null}
 */
export function breachBanner(items) {
  const n = items.filter((i) => i.breached && i.mine !== false).length;
  if (!n) return null;
  return `${n === 1 ? "1 password showed up" : `${n} passwords showed up`} in a known breach. Change ${n === 1 ? "it" : "them"} now. It takes about a minute each.`;
}

/** The three sections the list shows (the prototype's words). */
export const SECTIONS = ["AI and apps", "Logins", "Notes and other"];

/**
 * The section an item of the Vault's own groups goes under. A card, a note, an identity and anything with no group go under Notes and
 * other; a login, a passkey or an authenticator goes under Logins; the rest (AI models, apps you connected, code, mail and so on) under AI and apps.
 * @param {string} group the item's group, as redesign.js names it
 * @param {string} [kind] the item's kind (login, card, note, ...)
 */
export function sectionOf(group, kind = "") {
  if (["card", "note", "identity"].includes(kind) || group === "Secure notes" || !group) return "Notes and other";
  if (["login", "passkey", "authenticator"].includes(kind) || group === "Logins") return "Logins";
  return "AI and apps";
}
