// @ts-check
// ui: draws the setup flow's state. Everything a person reads goes in through textContent or a text node,
// never innerHTML, and no element is made from a progress line: a line is display-only text, since anyone who
// saw the code could post one (a forged "Done, open https://..." must stay words on the screen).

/** @param {Document} doc @param {string} tag @param {Record<string, string>|null} attrs @param {...(string|Node|null|false)} kids */
export function h(doc, tag, attrs, ...kids) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const kid of kids) if (kid) el.appendChild(typeof kid === "string" ? doc.createTextNode(kid) : kid);
  return el;
}

/**
 * @param {import("./flow.js").FlowState} s
 * @param {{ doc: Document, root: HTMLElement, actions: { begin: () => void, copy: (text: string, button: HTMLElement) => Promise<boolean>|boolean } }} ctx
 */
export function render(s, ctx) {
  const { doc, root } = ctx;
  const el = (tag, attrs, ...kids) => h(doc, tag, attrs, ...kids);
  const button = (label, cls, on) => { const b = el("button", { type: "button", class: `btn ${cls}` }, label); b.addEventListener("click", on); return b; };
  const kids = [];

  if (s.stage === "start") {
    kids.push(
      el("p", { class: "lbl" }, "Set up"),
      el("h1", { tabindex: "-1" }, "Put Vyre on your server"),
      el("p", { class: "lead" }, "Your agents run on a server you own. This takes a few minutes, and nothing changes without asking."),
      el("div", { class: "actions" }, button("Set up my server", "primary", () => ctx.actions.begin())),
      el("p", { class: "note" }, "Vyre never hosts your server and never sees what runs on it."),
    );
  } else if (s.stage === "install" || s.stage === "found") {
    const found = s.stage === "found" && s.box;
    kids.push(el("p", { class: "lbl" }, found ? "Found your server" : "Install"));
    if (found) {
      kids.push(
        el("h1", { tabindex: "-1" }, found.name),
        el("p", { class: "lead" }, "It answered this page. Check that these four words are on your server's terminal too."),
        el("ol", { class: "words", "aria-label": "Check words" }, ...found.words.map(w => el("li", null, w))),
        el("p", { class: "note" }, "If the words are different, this is not your server. Close this page."),
      );
    } else {
      const copy = el("button", { type: "button", class: "btn secondary" }, "Copy");
      copy.addEventListener("click", ev => ctx.actions.copy(s.installLine, /** @type {HTMLElement} */ (ev.currentTarget)));
      kids.push(
        el("h1", { tabindex: "-1" }, "Run this on your server"),
        el("p", { class: "lead" }, "Open a terminal on the server as yourself, not root, and paste the line. It asks for sudo itself only when it needs it."),
        el("div", { class: "cmd" }, el("pre", null, el("code", null, s.installLine)), copy),
        el("p", { class: "status", role: "status" }, el("span", { class: "ring", "aria-hidden": "true" }), "Waiting for your server"),
        el("p", { class: "note" }, "The line holds a one-time code. It works for one hour and for one server."),
        el("div", { class: "actions" }, button("Start again", "quiet", () => ctx.actions.begin())),
      );
    }
    if (s.lines.length) {
      kids.push(el("h2", { class: "sub" }, "What your server is doing"), el("ul", { class: "log", "aria-live": "polite" }, ...s.lines.map(t => el("li", null, t))));
    }
  } else {
    kids.push(
      el("p", { class: "lbl" }, "Stopped"),
      el("h1", { tabindex: "-1" }, "Setup stopped"),
      el("p", { class: "lead", role: "alert" }, s.error ? s.error.message : "Something stopped the setup."),
      el("div", { class: "actions" }, button("Start again", "primary", () => ctx.actions.begin())),
    );
  }

  const prev = root.getAttribute("data-stage");
  root.replaceChildren(...kids);
  root.setAttribute("data-stage", s.stage);
  // A new screen puts focus on its heading; progress lines arriving on the same screen do not.
  if (prev !== s.stage) { const hd = root.querySelector("h1"); if (hd) hd.focus({ preventScroll: false }); }
}
