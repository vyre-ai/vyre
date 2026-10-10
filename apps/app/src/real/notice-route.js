// @ts-check
// The route a notice's button opens (no imports: the notice model and its CI run without the box's packages). Answered by notice-act.js.

/** The app route a button opens: a device's card by `card`, a held call's group by `group`. @param {string} id @param {"approve" | "deny"} act @param {"card" | "group"} [of] */
export const actRoute = (id, act, of = "card") => `/u/now?act=${act}&${of}=${encodeURIComponent(id)}`;
