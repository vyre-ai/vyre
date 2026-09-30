// @ts-check
// passkey-bridge: the isolated content script beside passkey-page.js. It takes the page's passkey
// request off this window, asks the person, and relays it to the background worker. Registered
// for every page (every frame, document_start) while "Use Vyre for passkeys" is on.
//
// Why it is built this way:
//   - Nothing happens without the person. A save or a sign-in goes to the worker only on a click
//     whose event isTrusted, on a prompt drawn in a closed shadow root: a page can post a request
//     but cannot read the prompt, restyle it, or click it for the person.
//   - It sends the request, never a site. The worker names the page's origin from the browser's
//     sender and vyred refuses an rpId the origin may not claim, so a page lying in its options
//     gets a SecurityError, not someone else's passkey.
//   - A sign-in first asks the worker which Vyre passkeys this site has (names only, no session
//     needed). None means the browser's own authenticator answers and no prompt appears, so
//     sites whose passkeys live elsewhere work as before.
//   - [Use another device] hands the request back to the browser's own authenticator; [Cancel]
//     answers NotAllowedError, as the browser's own dialog does. A locked vault says so and
//     waits for the person to unlock from the toolbar button, then [Try again].
//   - One request at a time per frame; another while a prompt is up is refused.

/* global chrome */

(() => {
  const g = /** @type {any} */ (globalThis);
  if (g.vyrePasskeyBridge) return;
  g.vyrePasskeyBridge = true;

  /** @param {any} msg @returns {Promise<any>} */
  const ask = msg => new Promise(resolve => {
    try { chrome.runtime.sendMessage(msg, r => resolve(chrome.runtime.lastError ? { error: { code: "gone", message: "the extension restarted" } } : r)); }
    catch { resolve({ error: { code: "gone", message: "the extension restarted" } }); }
  });

  const where = () => (location.origin && location.origin !== "null" ? location.origin : "*");
  const FALLBACK = { fallback: true };
  const CANCELLED = { error: { code: "NotAllowedError", message: "The person cancelled the passkey request." } };

  // ---- the shadow host, drawn as inline.js draws its prompts ----------------------------

  const host = document.createElement("vyre-passkey");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 16px; right: 16px;";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .box { font: 13px/1.4 system-ui, sans-serif; background: #fff; color: #16181d; border: 1px solid #d5d8de;
      border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 4px; min-width: 240px; max-width: 340px; }
    @media (prefers-color-scheme: dark) { .box { background: #1d2027; color: #eceef2; border-color: #333844; } }
    button { all: unset; display: block; width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
    button:hover, button:focus-visible { background: rgba(43, 89, 195, .14); }
    .muted { opacity: .7; padding: 6px 8px; font-size: 12px; }
    .row { display: flex; gap: 6px; } .row button { text-align: center; }
    .title { padding: 6px 8px; font-weight: 600; }`;
  root.append(style);
  const box = document.createElement("div");
  box.className = "box";
  root.append(box);

  function hide() { host.remove(); box.replaceChildren(); }

  /** A button that acts only on a trusted click. @param {string} text @param {() => void} act */
  function button(text, act) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", e => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      act();
    });
    return b;
  }

  function line(text, cls = "muted") {
    const p = document.createElement("div");
    p.className = cls;
    p.textContent = text;
    return p;
  }

  /**
   * @param {string} title @param {string[]} lines
   * @param {[string, () => void][]} stacked one per line (accounts, Continue)
   * @param {[string, () => void][]} row side by side (the other ways out)
   */
  function show(title, lines, stacked, row) {
    box.replaceChildren(line(title, "title"), ...lines.map(t => line(t)), ...stacked.map(([t, a]) => button(t, a)));
    if (row.length) {
      const r = document.createElement("div");
      r.className = "row";
      r.append(...row.map(([t, a]) => button(t, a)));
      box.append(r);
    }
    if (!host.isConnected) document.documentElement.append(host);
  }

  // ---- one request ----------------------------------------------------------------------

  /** @typedef {{ channel: string, id: number, kind: "create"|"get", options: any }} Req */
  /** @type {Req|null} */
  let current = null;

  /** @param {Req} req @param {any} reply null for the acknowledgement */
  function answer(req, reply) {
    window.postMessage({ vyre: "passkey-reply", channel: req.channel, id: req.id, ...(reply ? { reply } : { ack: true }) }, where());
  }

  /** @param {Req} req @param {any} reply */
  function finish(req, reply) {
    if (current !== req) return;
    current = null;
    hide();
    answer(req, reply);
  }

  /** The site as the page names it; vyred checks the claim against the real origin. @param {Req} req */
  const site = req => {
    const o = req.options || {};
    const id = req.kind === "create" ? o.rp && o.rp.id : o.rpId;
    return typeof id === "string" && id ? id : location.hostname;
  };

  /** A passkey's account, from its description ("alex@harlow.test · harlow.test"). @param {any} p */
  const account = p => String((p && p.description) || "").split(" · ")[0] || String((p && p.name) || "this account");

  /** @param {Req} req @returns {[string, () => void][]} */
  const ways = req => [["Use another device", () => finish(req, FALLBACK)], ["Cancel", () => finish(req, CANCELLED)]];

  /** Send the person's choice to the worker and deal with its answer. @param {Req} req @param {any} msg */
  async function run(req, msg) {
    if (current !== req) return;
    box.replaceChildren(line("Asking Vyre..."));
    const r = await ask(msg);
    if (current !== req) return;
    if (!r || typeof r !== "object") return finish(req, { error: { code: "UnknownError", message: "the extension did not answer" } });
    if (r.fallback) return finish(req, FALLBACK);
    if (r.error && (r.error.code === "session_required" || r.error.code === "session_expired")) {
      return show("Vyre is locked.", ["Click the Vyre Vault button in the toolbar and unlock, then choose Try again."],
        [["Try again", () => run(req, msg)]], ways(req));
    }
    if (r.data && Array.isArray(r.data.choose)) return pick(req, r.data.choose);
    finish(req, r);
  }

  /** @param {Req} req @param {any[]} passkeys */
  function pick(req, passkeys) {
    show(`Sign in to ${site(req)} with Vyre`, ["Choose an account."],
      passkeys.map(p => [account(p), () => run(req, { type: "passkey-get", options: req.options, id: String(p.id) })]), ways(req));
  }

  /** @param {Req} req */
  function create(req) {
    const user = req.options && req.options.user;
    show(`Save a passkey for ${site(req)} in Vyre?`, user && user.name ? [String(user.name)] : [],
      [["Continue", () => run(req, { type: "passkey-create", options: req.options })]], ways(req));
  }

  /** @param {Req} req */
  async function get(req) {
    const r = await ask({ type: "passkey-list", options: req.options });
    if (current !== req) return;
    const keys = r && r.data && Array.isArray(r.data.passkeys) ? r.data.passkeys : [];
    if (!keys.length) return finish(req, FALLBACK);
    if (keys.length > 1) return pick(req, keys);
    show(`Sign in to ${site(req)} as ${account(keys[0])} with Vyre?`, [],
      [["Continue", () => run(req, { type: "passkey-get", options: req.options, id: String(keys[0].id) })]], ways(req));
  }

  window.addEventListener("message", e => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.vyre !== "passkey" || typeof d.channel !== "string" || typeof d.id !== "number") return;
    if (d.kind === "cancel") {
      if (current && current.channel === d.channel && current.id === d.id) { current = null; hide(); }
      return;
    }
    if (d.kind !== "create" && d.kind !== "get") return;
    /** @type {Req} */
    let req;
    // A plain copy: only JSON crosses from the page, whatever it put in the message.
    try { req = { channel: d.channel, id: d.id, kind: d.kind, options: JSON.parse(JSON.stringify(d.options || {})) }; } catch { return; }
    answer(req, null);
    if (current) return answer(req, { error: { code: "NotAllowedError", message: "another passkey request is waiting" } });
    current = req;
    if (req.kind === "create") create(req); else get(req);
  });

  document.addEventListener("keydown", e => { if (e.isTrusted && e.key === "Escape" && current && host.isConnected) finish(current, CANCELLED); }, true);
})();
