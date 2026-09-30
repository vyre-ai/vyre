// @ts-check
// Routes that act the moment they load (a live terminal on the box) only act when this page opened
// them itself. A link from anywhere else (another site, a vyre://open deep link, a pasted URL)
// shows the page with a button instead, so no outside page can make the app do something just by
// linking to it (reviewer-2 H4 on the 0.2 plan). Per page load, in memory only.

/** @type {Set<string>} */ const opened = new Set();

/** Note that this page itself is opening `key` (for example "term:<id>") just before it navigates there. @param {string} key */
export function markOpened(key) { opened.add(String(key)); }

/** Whether this page opened `key` itself; true once, so a later back-and-forth link needs a click again. @param {string} key */
export function openedHere(key) { return opened.delete(String(key)); }
