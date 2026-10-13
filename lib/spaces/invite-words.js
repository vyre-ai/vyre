// @ts-check
// The four words of a Space that an invitee reads to an inviter before an admin or owner invite is let in (spaces.invites.confirm). They are the Space's own: derived from its id and root key, the same words
// the join card shows. They show that the invitee is looking at THIS Space; they do not show who the invitee is. Plain functions so the module and the app compare the same way.

export const WORDS_REFUSED = "These are not the words of this Space. Ask them to read the four words on their card again.";
export const TOO_MANY = "Too many wrong tries for this invite. Cancel it and make a new one.";
/** How many wrong tries an invite takes before it stops listening. */
export const MAX_TRIES = 5;

/** Lower case, letters only, single spaces: "  Apple,  BRIDGE " is "apple bridge". @param {unknown} s */
export const normalizeWords = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();

/** Are these the Space's words? An empty or missing side is never a match. @param {unknown} typed @param {unknown} expected */
export function sameWords(typed, expected) {
  const a = normalizeWords(typed), b = normalizeWords(expected);
  return a.length > 0 && b.length > 0 && a === b;
}

/** A counter of wrong tries per invite, kept in memory (a restart gives a fresh count). */
export function triesCounter(max = MAX_TRIES) {
  /** @type {Map<string, number>} */ const n = new Map();
  return {
    /** Has this invite used up its tries? @param {string} id */ spent: (id) => (n.get(id) || 0) >= max,
    /** One more wrong try. @param {string} id */ miss: (id) => { n.set(id, (n.get(id) || 0) + 1); },
    /** The invite was confirmed. @param {string} id */ clear: (id) => { n.delete(id); },
  };
}
