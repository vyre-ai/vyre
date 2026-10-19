// @ts-check
// The Space switcher (the Space's name at the top of the sidebar, and the title row on a phone) and the account menu (your face at the foot of the sidebar). Pure: which rows each shows and where
// each goes. The menus draw these with the library's Menu; the routes are the screens that already exist.

/** Where each action opens. Space settings is the Look and name page; Invite people is the People invite. */
export const SWITCHER_HREF = Object.freeze({ create: "/onboard?path=create", join: "/onboard?path=join", invite: "/u/wink/invite", settings: "/u/spaces" });
export const ACCOUNT_HREF = Object.freeze({ profile: "/u/profile", ai: "/u/settings/ai", settings: "/u/settings" });

/**
 * The Spaces, in the order given, with a check on the one showing. "All spaces" (allId) stays first when it is there.
 * @param {{ id: string, name: string }[]} spaces @param {string} current @param {string} [allId]
 * @returns {{ id: string, name: string, all: boolean, on: boolean }[]}
 */
export function switcherRows(spaces, current, allId = "all") {
  const all = spaces.filter((s) => s.id === allId), rest = spaces.filter((s) => s.id !== allId);
  return [...all, ...rest].map((s) => ({ id: s.id, name: s.name, all: s.id === allId, on: s.id === current }));
}

/**
 * The actions under the Spaces. Invite people and Space settings are for the Space showing, so they are not offered under All spaces; a Space with no server (basic) takes no one else.
 * @param {{ id: string, basic?: boolean } | undefined} cur @param {string} [allId]
 * @returns {{ id: keyof typeof SWITCHER_HREF, label: string, href: string }[]}
 */
export function switcherActions(cur, allId = "all") {
  const one = Boolean(cur) && cur?.id !== allId;
  /** @type {{ id: keyof typeof SWITCHER_HREF, label: string, href: string }[]} */
  const out = [{ id: "create", label: "Make a new Space", href: SWITCHER_HREF.create }, { id: "join", label: "Join a Space", href: SWITCHER_HREF.join }];
  if (one && !cur?.basic) out.push({ id: "invite", label: "Invite people", href: SWITCHER_HREF.invite });
  if (one) out.push({ id: "settings", label: "Space settings", href: SWITCHER_HREF.settings });
  return out;
}

/** The theme choices in the account menu, in the order a person reads them. The values are Appearance's own (appearance.scheme). */
export const THEME_CHOICES = Object.freeze(/** @type {const} */ ([["paper", "Light"], ["system", "Match this device"], ["dark", "Dark"]]));

/**
 * The account menu's top lines: the name, and the username under it (the Vyre name without the domain, as @name). No name yet reads "You".
 * @param {{ name?: string, sub?: string }} user @returns {{ name: string, handle: string }}
 */
export function accountHeader(user) {
  const name = String(user.name || "").trim() || "You";
  const sub = String(user.sub || "").trim().replace(/\.vyre\.run$/i, "");
  return { name, handle: sub && sub !== name ? (/\s/.test(sub) ? sub : `@${sub}`) : "" };
}
