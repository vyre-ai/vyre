// @ts-check
// The Space switcher (the footer row of the sidebar, and the title row on a phone) and the account menu (your face at the foot of the sidebar). Pure: which rows each shows and where
// each goes. The menus draw these with the library's Menu; the routes are the screens that already exist.

/** Where each action opens. Space settings is the Look and name page; Invite people is the People invite. */
export const SWITCHER_HREF = Object.freeze({ create: "/onboard?path=create", join: "/onboard?path=join", invite: "/u/wink/invite", settings: "/u/spaces" });
export const ACCOUNT_HREF = Object.freeze({ profile: "/u/profile", ai: "/u/settings/ai", settings: "/u/settings" });

/**
 * The Spaces, in the order given, with a check on the one showing and its shortcut (Cmd 1 to Cmd 9). There is no "All spaces": a person is in exactly one Space at a time.
 * @param {{ id: string, name: string }[]} spaces @param {string} current
 * @returns {{ id: string, name: string, on: boolean, shortcut: string }[]}
 */
export function switcherRows(spaces, current) {
  return spaces.map((s, i) => ({ id: s.id, name: s.name, on: s.id === current, shortcut: i < 9 ? `Cmd ${i + 1}` : "" }));
}

/** The Space a Cmd 1 to Cmd 9 key picks, or "" when there is none. @param {{ id: string }[]} spaces @param {string} key */
export function spaceForKey(spaces, key) {
  const n = Number(key);
  return Number.isInteger(n) && n >= 1 && n <= 9 ? spaces[n - 1]?.id ?? "" : "";
}

/** Only an owner or an admin invites people. @param {{ sub?: string } | undefined} cur */
export const canInvite = (cur) => /^(owner|admin)$/i.test(String(cur?.sub ?? "").trim());

/**
 * The actions of the Add a Space submenu, then the Space's own: Space settings, and Invite people for an owner or an admin (a Space with no server takes no one else).
 * @param {{ id: string, basic?: boolean, sub?: string } | undefined} cur
 * @returns {{ add: { id: "create" | "join", label: string, href: string }[], own: { id: "invite" | "settings", label: string, href: string, shortcut: string }[] }}
 */
export function switcherActions(cur) {
  const own = [];
  if (cur) own.push({ id: /** @type {const} */ ("settings"), label: "Space settings", href: SWITCHER_HREF.settings, shortcut: "Cmd ," });
  if (cur && !cur.basic && canInvite(cur)) own.push({ id: /** @type {const} */ ("invite"), label: "Invite people", href: SWITCHER_HREF.invite, shortcut: "" });
  return { add: [{ id: "create", label: "Make a new Space", href: SWITCHER_HREF.create }, { id: "join", label: "Join a Space", href: SWITCHER_HREF.join }], own };
}

/** The theme choices in the account menu, in the order a person reads them. The values are Appearance's own (appearance.scheme). */
export const THEME_CHOICES = Object.freeze(/** @type {const} */ ([["paper", "Light"], ["dark", "Dark"], ["system", "Match this computer"]]));

/**
 * The account menu's top lines: the name, and the username under it (the Vyre name without the domain, as @name). No name yet reads "You".
 * @param {{ name?: string, sub?: string }} user @returns {{ name: string, handle: string }}
 */
export function accountHeader(user) {
  const name = String(user.name || "").trim() || "You";
  const sub = String(user.sub || "").trim().replace(/\.vyre\.run$/i, "");
  return { name, handle: sub && sub !== name ? (/\s/.test(sub) ? sub : `@${sub}`) : "" };
}
