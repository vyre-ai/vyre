// @ts-check
// Follow and jump (design idea 7): the view follows the stream until the reader scrolls up, then a
// "jump to latest" pill shows (with how many rows came in meanwhile) until they jump or scroll back.
// Pure state machine; the transcript reports `scroll` and `rows`, the pill reads the state.

/** @typedef {{ following: boolean, unread: number }} Follow */
/** @typedef {{ type: "scroll", atBottom: boolean } | { type: "rows", added: number } | { type: "jump" }} FollowEvent */

/** @returns {Follow} */
export const createFollow = () => ({ following: true, unread: 0 });

/** @param {Follow} s @param {FollowEvent} e @returns {Follow} */
export function follow(s, e) {
  switch (e.type) {
    case "scroll":
      return e.atBottom ? (s.following && s.unread === 0 ? s : { following: true, unread: 0 }) : s.following ? { following: false, unread: 0 } : s;
    case "rows":
      return s.following || e.added <= 0 ? s : { following: false, unread: s.unread + e.added };
    case "jump":
      return s.following && s.unread === 0 ? s : { following: true, unread: 0 };
    default:
      return s;
  }
}

/** The pill's words. @param {number} unread */
export const pillLabel = (unread) => (unread > 0 ? `${unread} new, jump to latest` : "Jump to latest");
