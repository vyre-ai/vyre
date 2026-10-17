// @ts-check
// browser: Glass live view for an agent on the shared headless browser (agent-browsers.md level 2).
//
// The stream is Page.startScreencast on the agent's tab, relayed at
// /v1/streams/computers/browser-glass. Take-over sends CDP input on that tab when the surface
// holds the keyboard — the same computers.takeover / glass.take path as a desktop, without VNC.

/** @typedef {{ mode: "screencast", path: string, ticket: string, width: number, height: number }} BrowserScreen */

/**
 * Build the screen descriptor computers.watch returns in browser mode (used in tests and docs).
 * @param {string} ticket
 * @param {number} w
 * @param {number} h
 */
export function browserScreen(ticket, w, h) {
  return {
    mode: "screencast",
    ticket,
    path: `/v1/streams/computers/browser-glass?ticket=${encodeURIComponent(ticket)}`,
    width: w,
    height: h,
  };
}
