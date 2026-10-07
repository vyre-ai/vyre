// @ts-check
// The command bar's prefixes on the phone's Find (team/0.2.2/ux-research.md section 3.4): `p ` narrows to
// projects, `t ` to threads, `u ` to people and agents. Strict word start: the letter, a space, then the
// words, so "park" never reads as `p ark`; muscle memory holds. The prefix is stripped before searching.

/** @typedef {{ prefix: "p" | "t" | "u", scope: "projects" | "chats" | "people", rest: string }} Prefixed */
const SCOPE = Object.freeze({ p: "projects", t: "chats", u: "people" });

/**
 * @param {string} raw what is in the box
 * @returns {Prefixed | null} null when the box does not start with a prefix and a space
 */
export function parsePrefix(raw) {
  const m = /^([ptu])\s+(.*)$/is.exec(String(raw || "").replace(/^\s+/, ""));
  if (!m) return null;
  const prefix = /** @type {"p" | "t" | "u"} */ (m[1].toLowerCase());
  return { prefix, scope: SCOPE[prefix], rest: m[2].trim() };
}

/** What the box says to a person who has typed nothing: the three prefixes in one line. */
export const PREFIX_HINT = "p projects, t threads, u people";
