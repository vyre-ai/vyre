// @ts-check
// proto: the one wire format between the module (in vyred), the native host and the extension.
//
//   module -> extension   {id, op, args}                    a request; op is "<cap>.<name>"
//   extension -> module   {id, ok: true, result}            its answer
//                         {id, ok: false, error: {code, message}}
//   extension -> module   {event, ...}                      unsolicited: hello, stop, net.event, ...
//
// The host relays frames between Chrome's stdio (stdio.js) and a local socket (bridge.js) and
// reads none of them. Every result is redacted (redact.js) before it leaves the extension.

export const HOST_NAME = "run.vyre.chrome";
export const PROTOCOL = 1;

/** Error codes a caller can act on. */
export const CODES = Object.freeze({
  no_extension: "the Vyre extension is not connected",
  no_tab: "no tab matches",
  blocked: "the floor does not allow this page",
  stopped: "the person pressed stop",
  not_found: "nothing matches that selector",
  tied: "more than one control matches that selector",
  timeout: "timed out",
  detached: "Chrome detached the debugger from that tab",
  bad_request: "the request is malformed",
  unknown_op: "no such operation",
  covered: "another element covers the control",
  changed: "the page changed since it was held",
  modal: "a dialog is blocking the page",
  not_saved: "the save could not be confirmed",
  login_required: "the page is asking the person to sign in",
});

/** @param {string} code @param {string} [detail] */
export const fail = (code, detail) => ({ code, message: detail || CODES[/** @type {keyof typeof CODES} */ (code)] || code });

/** Ops a capability may register are named cap.name, lowercase, no spaces. @param {string} op */
export const validOp = op => /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/.test(String(op));

/**
 * Ops that can change a page, send something or move money on the person's behalf. The module
 * classifies the request before it reaches the browser (floor-url.js); the extension re-checks.
 */
export const ACTING = new Set(["point.act", "page.act", "page.fill", "page.eval", "dev.console.eval", "page.submit", "tabs.navigate", "net.intercept", "net.on", "net.replay", "api.call", "ghl.run", "ghl.section", "ghl.save", "batch.run", "frames.clicktest", "recipe.run"]);

/** Ops that only read. */
export const READING = new Set(["recipe.list", "site.card", "site.flush", "login.check", "tabs.presence", "tabs.list", "tabs.find", "page.snapshot", "page.screenshot", "dev.inspect", "dev.sources.list", "dev.sources.get", "dev.sources.search", "dev.console.read", "net.list", "net.get", "api.learn", "api.catalog", "frames.list", "frames.probe"]);
