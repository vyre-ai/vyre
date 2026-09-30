// @ts-check
// ui: draws the setup flow's state. Everything a person reads goes in through textContent or a text node,
// never innerHTML, and no element is made from a progress line: a line is display-only text, since anyone who
// saw the code could post one (a forged "Done, open https://..." must stay words on the screen).
//
// The screen is a few regions, each rebuilt only when what it shows changes, so a progress line arriving never
// takes the caret out of the name being typed or the focus off a button.

/** @param {Document} doc @param {string} tag @param {Record<string, string>|null} attrs @param {...(string|Node|null|false)} kids */
export function h(doc, tag, attrs, ...kids) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const kid of kids) if (kid) el.appendChild(typeof kid === "string" ? doc.createTextNode(kid) : kid);
  return el;
}

/** @typedef {{ begin: () => void, copy: (text: string, button: HTMLElement) => Promise<boolean>|boolean, setName: (text: string) => void, claim: () => void }} Actions */

/** Per root: the region elements and the key each was last built for. @type {WeakMap<object, { regions: Record<string, any>, keys: Record<string, string>, stage: string|null }>} */
const memory = new WeakMap();
const REGIONS = ["head", "words", "naming", "log"];

/**
 * @param {import("./flow.js").FlowState} s
 * @param {{ doc: Document, root: HTMLElement, actions: Actions }} ctx
 */
export function render(s, ctx) {
  const { doc, root, actions } = ctx;
  const el = (tag, attrs, ...kids) => h(doc, tag, attrs, ...kids);
  const button = (label, cls, on) => { const b = el("button", { type: "button", class: `btn ${cls}` }, label); b.addEventListener("click", on); return b; };
  let mem = memory.get(root);
  if (!mem) {
    mem = { regions: {}, keys: {}, stage: null };
    memory.set(root, mem);
    root.replaceChildren(...REGIONS.map(r => (mem.regions[r] = el("section", { "data-region": r }))));
  }
  const m = mem;
  /** Rebuild a region only when its key changed. @param {string} name @param {string} key @param {() => (Node|null|false)[]} build */
  const region = (name, key, build) => {
    if (m.keys[name] === key) return false;
    m.keys[name] = key;
    m.regions[name].replaceChildren(...build().filter(Boolean));
    return true;
  };
  const found = s.stage === "found" || s.stage === "named" ? s.box : null;

  // ---- head: what this screen is, in words ----
  const headKey = `${s.stage}|${s.stage === "stopped" ? s.error?.code : ""}|${found?.name || ""}|${s.installLine}`;
  const rebuiltHead = region("head", headKey, () => {
    if (s.stage === "start") return [
      el("p", { class: "lbl" }, "Set up"),
      el("h1", { tabindex: "-1" }, "Put Vyre on your server"),
      el("p", { class: "lead" }, "Your agents run on a server you own. This takes a few minutes, and nothing changes without asking."),
      el("div", { class: "actions" }, button("Set up my server", "primary", () => actions.begin())),
      el("p", { class: "note" }, "Vyre never hosts your server and never sees what runs on it."),
    ];
    if (s.stage === "install") {
      const copy = el("button", { type: "button", class: "btn secondary" }, "Copy");
      copy.addEventListener("click", ev => actions.copy(s.installLine, /** @type {HTMLElement} */ (ev.currentTarget)));
      return [
        el("p", { class: "lbl" }, "Install"),
        el("h1", { tabindex: "-1" }, "Run this on your server"),
        el("p", { class: "lead" }, "Open a terminal on the server as yourself, not root, and paste the line. It asks for sudo itself only when it needs it."),
        el("div", { class: "cmd" }, el("pre", null, el("code", null, s.installLine)), copy),
        el("p", { class: "status", role: "status" }, el("span", { class: "ring", "aria-hidden": "true" }), "Waiting for your server"),
        el("p", { class: "note" }, "The line holds a one-time code. It works for one hour and for one server."),
        el("div", { class: "actions" }, button("Start again", "quiet", () => actions.begin())),
      ];
    }
    if ((s.stage === "found" || s.stage === "named") && found) return [
      el("p", { class: "lbl" }, s.stage === "named" ? "Named" : "Found your server"),
      el("h1", { tabindex: "-1" }, s.stage === "named" && s.named ? (s.named.address || s.named.name) : found.name),
      s.stage === "found" ? el("p", { class: "lead" }, "It answered this page. Check that these four words are on your server's terminal too.") : null,
    ];
    return [
      el("p", { class: "lbl" }, "Stopped"),
      el("h1", { tabindex: "-1" }, "Setup stopped"),
      el("p", { class: "lead", role: "alert" }, s.error ? s.error.message : "Something stopped the setup."),
      el("div", { class: "actions" }, button("Start again", "primary", () => actions.begin())),
    ];
  });

  // ---- words: the four check words, until the server is named ----
  region("words", s.stage === "found" && found ? `w:${found.words.join(" ")}` : "none", () => s.stage === "found" && found ? [
    el("ol", { class: "words", "aria-label": "Check words" }, ...found.words.map(w => el("li", null, w))),
    el("p", { class: "note" }, "If the words are different, this is not your server. Close this page."),
  ] : []);

  // ---- naming: built once when the connection is ready, then updated in place ----
  const namingKey = s.stage === "found" && s.channel === "ready" ? "form" : s.stage === "found" ? `wait:${s.channel}` : s.stage === "named" && s.named ? `done:${s.named.name}` : "none";
  const rebuiltNaming = region("naming", namingKey, () => {
    if (namingKey === "form") {
      const input = el("input", { type: "text", class: "name", name: "address", autocomplete: "off", autocapitalize: "none", spellcheck: "false", "aria-label": "Address", "aria-describedby": "name-status", maxlength: "40" });
      /** @type {any} */ (input).value = s.naming.input;
      input.addEventListener("input", ev => actions.setName(/** @type {any} */ (ev.currentTarget).value));
      const claim = button("Claim this address", "primary", () => actions.claim());
      claim.setAttribute("data-role", "claim");
      return [
        el("h2", { class: "sub" }, "Choose its address"),
        el("p", { class: "lead" }, "This is where you will reach your server. It is yours for good."),
        el("div", { class: "field" }, input, el("span", { class: "suffix" }, ".vyre.run")),
        el("p", { id: "name-status", class: "hint", role: "status", "data-role": "hint" }, ""),
        el("div", { class: "actions" }, claim),
      ];
    }
    if (namingKey.startsWith("wait:")) return [el("p", { class: "status", role: "status" }, el("span", { class: "ring", "aria-hidden": "true" }), s.channel === "failed" ? "Could not connect to your server" : "Connecting to your server")];
    if (namingKey.startsWith("done:") && s.named) {
      const code = s.named.recoveryCode;
      const copy = el("button", { type: "button", class: "btn secondary" }, "Copy");
      if (code) copy.addEventListener("click", ev => actions.copy(code, /** @type {HTMLElement} */ (ev.currentTarget)));
      return code ? [
        el("h2", { class: "sub" }, "Your recovery code"),
        el("p", { class: "lead" }, "Save this somewhere safe. It is shown once. If you ever reinstall, it takes this address back."),
        el("div", { class: "cmd" }, el("pre", null, el("code", null, code)), copy),
      ] : [el("p", { class: "lead" }, "This address was already yours.")];
    }
    return [];
  });
  if (namingKey === "form") {
    const hint = m.regions.naming.querySelector ? findByRole(m.regions.naming, "hint") : null;
    const claim = findByRole(m.regions.naming, "claim");
    const c = s.naming.check;
    const text = s.naming.error ? s.naming.error
      : s.naming.checking ? "Checking"
      : c ? (c.available ? `${c.address || c.name} is free` : (c.why || "That name is not available")) : "";
    if (hint) hint.textContent = text;
    if (claim) { const ok = Boolean(c && c.available) && !s.naming.claiming; if (ok) claim.removeAttribute?.("disabled"); else claim.setAttribute("disabled", "disabled"); claim.textContent = s.naming.claiming ? "Claiming" : "Claim this address"; }
  }
  void rebuiltNaming;

  // ---- log: the install as the server tells it, as plain text ----
  region("log", `${s.lines.length}|${s.lines[s.lines.length - 1] || ""}`, () => s.lines.length ? [
    el("h2", { class: "sub" }, "What your server is doing"),
    el("ul", { class: "log", "aria-live": "polite" }, ...s.lines.map(t => el("li", null, t))),
  ] : []);

  // A new screen puts focus on its heading; progress lines arriving on the same screen do not.
  if (rebuiltHead && m.stage !== s.stage) { const hd = findTag(m.regions.head, "h1"); if (hd) hd.focus({ preventScroll: false }); }
  m.stage = s.stage;
}

/** @param {any} node @param {string} tag */
function findTag(node, tag) { for (const c of node.children || []) { if (c.tagName ? c.tagName.toLowerCase() === tag : c.tag === tag) return c; const f = findTag(c, tag); if (f) return f; } return null; }
/** @param {any} node @param {string} role */
function findByRole(node, role) { for (const c of node.children || []) { if (c.getAttribute && c.getAttribute("data-role") === role) return c; const f = findByRole(c, role); if (f) return f; } return null; }
