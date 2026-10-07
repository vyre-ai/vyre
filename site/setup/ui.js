// @ts-check
// ui: draws the setup flow's state. Everything a person reads goes in through textContent or a text node,
// never innerHTML, and no element is made from a progress line: a line is display-only text, since anyone who
// saw the code could post one (a forged "Done, open https://..." must stay words on the screen).
//
// The screen is a few regions, each rebuilt only when what it shows changes, so a progress line arriving never
// takes the caret out of the name being typed or the focus off a button.

import { stepList, stepNumber } from "./flow.js";

/** @param {Document} doc @param {string} tag @param {Record<string, string>|null} attrs @param {...(string|Node|null|false)} kids */
export function h(doc, tag, attrs, ...kids) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const kid of kids) if (kid) el.appendChild(typeof kid === "string" ? doc.createTextNode(kid) : kid);
  return el;
}

/** @typedef {{ begin: (machine?: "linux"|"mac") => void, copy: (text: string, button: HTMLElement) => Promise<boolean>|boolean, setName: (text: string) => void, claim: () => void, confirmWords: () => void, denyWords: () => void, markSaved: () => void, openDomain: (open: boolean) => void, setDomain: (text: string) => void, checkDomain: () => void,
 *   continueToAi: () => void, continueToNetwork: () => void, skipAi?: () => void, readNetwork: () => void, startAi: (provider: string) => void, openAiKey: (kind: string) => void, submitAiKey: (f: { kind: string, key: string, base_url?: string, model?: string }) => void, submitAiCode: (id: string, code: string) => void,
 *   continueToDevices: () => void, addPhone: () => void, drawRing: (slot: HTMLElement) => void,
 *   continueToClaim: () => void, mintClaim: () => void, drawQr: (slot: HTMLElement, text: string) => void,
 *   openDomain: (open: boolean) => void, setDomain: (text: string) => void, checkDomain: () => void }} Actions */

/** Per root: the region elements and the key each was last built for. @type {WeakMap<object, { regions: Record<string, any>, keys: Record<string, string>, stage: string|null }>} */
const memory = new WeakMap();
const REGIONS = ["timeline", "head", "words", "naming", "domain", "ai", "network", "devices", "claim", "log"];

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
  const steps = stepList(s), at = stepNumber(s), cur = steps[at - 1] || null;
  /** The small label above each heading: where this is in the ten. */
  const stepLabel = () => (cur ? `Step ${at} of ${steps.length}${cur.optional ? ", optional" : ""}` : "Set up");

  // ---- timeline: ten steps, the same list as a rail (wide) and a segmented bar with the list one tap away (narrow) ----
  const tlKey = at ? steps.map(x => x.status).join(",") : "none";
  region("timeline", tlKey, () => {
    if (!at) return [];
    const mark = x => (x.status === "done" ? "Done" : x.status === "skipped" ? "Skipped" : x.status === "failed" ? "Stopped here" : x.status === "current" ? "Now" : "");
    const list = cls => {
      let last = "";
      const kids = [];
      for (const x of steps) {
        if (x.where !== last) { kids.push(el("li", { class: "tl-group", "aria-hidden": "true" }, x.where)); last = x.where; }
        kids.push(el("li", { class: `tl-step ${x.status}`, ...(x.status === "current" ? { "aria-current": "step" } : {}) },
          el("span", { class: "tl-dot", "aria-hidden": "true" }, x.status === "done" ? "\u2713" : x.status === "skipped" ? "\u2013" : ""),
          el("span", { class: "tl-name" }, x.title), x.optional ? el("span", { class: "tl-opt" }, "optional") : null,
          mark(x) ? el("span", { class: "sr" }, `, ${mark(x).toLowerCase()}`) : null));
      }
      return el("ol", { class: cls, "aria-label": "Setup steps" }, ...kids);
    };
    const segs = el("div", { class: "tl-segs", "aria-hidden": "true" }, ...steps.map(x => el("span", { class: `seg ${x.status}` })));
    return [
      list("tl-rail"),
      el("div", { class: "tl-bar" }, segs,
        el("details", { class: "tl-more" }, el("summary", null, el("span", { class: "tl-now" }, `Step ${at} of ${steps.length}`, " ", el("b", null, cur ? cur.title : "")), el("span", { class: "tl-all" }, "All steps")), list("tl-list"))),
    ];
  });

  // ---- head: what this screen is, in words ----
  const headKey = `${at}|${s.stage}|${s.stage === "stopped" ? s.error?.code : ""}|${found?.name || ""}|${s.installLine}`;
  const rebuiltHead = region("head", headKey, () => {
    if (s.stage === "start") return [
      el("p", { class: "lbl" }, "Set up"),
      el("h1", { tabindex: "-1" }, "Put Vyre on your server"),
      el("p", { class: "lead" }, "Your agents run on a server you own. This takes a few minutes, and nothing changes without asking. Where will it live?"),
      el("div", { class: "actions" }, button("A Linux server", "primary", () => actions.begin("linux")), button("A Mac that stays on", "secondary", () => actions.begin("mac"))),
      el("p", { class: "note" }, "Vyre never hosts your server and never sees what runs on it."),
    ];
    if (s.stage === "install") {
      const copy = el("button", { type: "button", class: "btn secondary" }, "Copy");
      copy.addEventListener("click", ev => actions.copy(s.installLine, /** @type {HTMLElement} */ (ev.currentTarget)));
      return [
        el("p", { class: "lbl" }, stepLabel()),
        el("h1", { tabindex: "-1" }, s.machine === "mac" ? "Run the line on the Mac" : "Run the line on your server"),
        el("p", { class: "lead" }, s.machine === "mac"
          ? "Open Terminal on the Mac as yourself, not root, and paste the line. It asks for your Mac password once, to set Vyre up as a service that starts when the Mac does, with nobody signed in."
          : "Open a terminal on the server as yourself, not root, and paste the line. It asks for sudo itself only when it needs it."),
        el("div", { class: "cmd" }, el("pre", null, el("code", null, s.installLine)), copy),
        s.machine === "mac" ? el("p", { class: "note", "data-role": "filevault" }, "After a power cut: with FileVault on, the Mac waits for someone to unlock it at the screen, and Vyre is off until then. With FileVault off, anyone who takes the Mac can read Vyre's files, notes and conversations; the vault stays locked behind its password. Either way the Mac switches itself back on only if \"Start up automatically after a power failure\" is on in System Settings, under Energy, and it starts off on a Mac mini. Vyre keeps the Mac awake while it runs, so leave it plugged in. The installer reads these two settings on your Mac and tells you which applies.") : null,
        el("p", { class: "status", role: "status" }, el("span", { class: "ring", "aria-hidden": "true" }), "Waiting for your server"),
        el("p", { class: "note" }, "The line holds a one-time code. It works for one hour and for one server."),
        el("div", { class: "actions" }, button("Start again", "quiet", () => actions.begin())),
      ];
    }
    if ((s.stage === "found" || s.stage === "named") && found) return [
      el("p", { class: "lbl" }, stepLabel()),
      el("h1", { tabindex: "-1" }, s.stage === "named" && s.named ? (s.named.address || s.named.name) : s.confirm === "pending" ? "Check the four words" : found.name),
      s.stage === "found" && s.confirm === "pending" ? el("p", { class: "lead" }, "Your server answered this page. Look at its terminal: it printed four words. Do they match these?") : null,
    ];
    if (s.stage === "ai") return [
      el("p", { class: "lbl" }, stepLabel()),
      el("h1", { tabindex: "-1" }, "Sign in to your AI"),
      el("p", { class: "lead" }, "Each one signs in with its own provider's page, on any browser. Vyre never sees your password. One is enough to go on. Your assistant needs one to answer, and you can add more later."),
    ];
    if (s.stage === "claim") return [
      el("p", { class: "lbl" }, stepLabel()),
      el("h1", { tabindex: "-1" }, "Open your server"),
      el("p", { class: "lead" }, `Your server is ready at ${s.named ? `${s.named.name}.vyre.run` : "its own address"}. Open it to make your passkey, which makes you its owner. Steps 8 to 10 continue there.`),
    ];
    if (s.stage === "done") return [
      el("p", { class: "lbl" }, stepLabel()),
      el("h1", { tabindex: "-1" }, "You're in"),
      el("p", { class: "lead" }, `Your passkey is made and your server knows you now. Steps 8 to 10, you and your assistant, your computers and your history, continue at ${s.named ? `${s.named.name}.vyre.run` : "its own address"}.`),
      s.skipped.length ? el("p", { class: "note" }, `Skipped: ${s.skipped.map(id => (stepList(s).find(x => x.id === id) || { title: id }).title).join(", ")}. You can do them later in Settings, under Setup.`) : null,
      s.named ? el("div", { class: "actions" }, el("a", { class: "btn primary", href: `https://${s.named.name}.vyre.run/`, rel: "noopener" }, `Open ${s.named.name}.vyre.run`)) : null,
    ];
    if (s.stage === "devices") return [
      el("p", { class: "lbl" }, stepLabel()),
      el("h1", { tabindex: "-1" }, "Add your phone"),
      el("p", { class: "lead" }, "This page pairs nothing. Your first device pairs at the server's own terminal: it shows a QR and a long code, and you confirm three words. Your phone and everything else is added from the Vyre app afterwards."),
    ];
    if (s.stage === "network") return [
      el("p", { class: "lbl" }, stepLabel()),
      el("h1", { tabindex: "-1" }, "Your server's network"),
      el("p", { class: "lead" }, "Vyre's private network is built in. Your devices and this server find each other with nothing to install and nothing to sign in to."),
    ];
    return [
      el("p", { class: "lbl" }, "Stopped"),
      el("h1", { tabindex: "-1" }, "Setup stopped"),
      el("p", { class: "lead", role: "alert" }, s.error ? s.error.message : "Something stopped the setup."),
      el("div", { class: "actions" }, button("Start again", "primary", () => actions.begin())),
    ];
  });

  // ---- words: the four check words, until the server is named ----
  const pendingWords = s.stage === "found" && s.confirm === "pending";
  region("words", s.stage === "found" && found ? `w:${found.words.join(" ")}:${s.confirm}` : "none", () => s.stage === "found" && found ? [
    el("ol", { class: "words", "aria-label": "Check words" }, ...found.words.map(w => el("li", null, w))),
    pendingWords ? el("div", { class: "actions" }, button("These match my server's terminal", "primary", () => actions.confirmWords()), button("They don't match", "quiet", () => actions.denyWords())) : null,
    el("p", { class: "note" }, pendingWords ? "Anyone who saw the install line could answer this page, so the words are how you know it is your server. If they are different, choose \"They don't match\"." : "The words matched."),
  ] : []);

  // ---- naming: built once when the connection is ready, then updated in place ----
  const saved = Boolean(s.named && s.named.saved);
  const namingKey = s.stage === "found" && s.confirm === "pending" ? "none" : s.stage === "found" && s.channel === "ready" ? "form" : s.stage === "found" ? `wait:${s.channel}` : s.stage === "named" && s.named ? `done:${s.named.name}:${saved}` : "none";
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
      const code = saved ? null : s.named.recoveryCode;
      const copy = el("button", { type: "button", class: "btn secondary" }, "Copy");
      if (code) copy.addEventListener("click", ev => actions.copy(code, /** @type {HTMLElement} */ (ev.currentTarget)));
      const go = el("div", { class: "actions" }, button("Continue", "primary", () => actions.continueToNetwork()));
      return code ? [
        el("h2", { class: "sub" }, "Your recovery code"),
        el("p", { class: "lead" }, "Save this somewhere safe. It is shown once. If you ever reinstall, it takes this address back."),
        el("div", { class: "cmd" }, el("pre", null, el("code", null, code)), copy),
        el("p", { class: "note" }, "Copying puts it on your clipboard, where a clipboard history tool may keep it: clear that afterwards, or write it down instead."),
        el("p", { class: "warn", role: "alert" }, "This page is the only place it is shown. If you close it or reload before you have saved the code, it is gone."),
        el("div", { class: "actions" }, button("I saved it", "primary", () => actions.markSaved())),
      ] : [el("p", { class: "lead" }, s.named.recoveryCode ? "Saved." : "This address was already yours."), go];
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

  // ---- domain: optional, after the address is claimed and the recovery code saved ----
  const dm = s.domain;
  const domainShown = s.stage === "named" && s.named && (!s.named.recoveryCode || s.named.saved) && s.named.name;
  const domainKey = !domainShown ? "none" : !dm.open ? "closed" : `open:${dm.checking}|${dm.error}|${dm.result ? `${dm.result.domain}/${dm.result.ok}/${dm.result.cname.found.join(",")}/${dm.result.caa.ok}` : ""}`;
  region("domain", domainKey, () => {
    if (domainKey === "none") return [];
    if (domainKey === "closed") return [el("div", { class: "actions" }, button("Use a domain of your own too", "secondary", () => actions.openDomain(true)))];
    const input = el("input", { type: "text", class: "name", name: "domain", autocomplete: "off", autocapitalize: "none", spellcheck: "false", "aria-label": "Your domain", "aria-describedby": "domain-status", maxlength: "100", placeholder: "juniperstudio.example" });
    /** @type {any} */ (input).value = dm.input;
    input.addEventListener("input", ev => actions.setDomain(/** @type {any} */ (ev.currentTarget).value));
    input.addEventListener("keydown", ev => { if (/** @type {any} */ (ev).key === "Enter") actions.checkDomain(); });
    const check = button(dm.checking ? "Checking" : dm.result ? "Check again" : "Check", "primary", () => actions.checkDomain());
    if (dm.checking) check.setAttribute("disabled", "disabled");
    const r = dm.result;
    const status = dm.error ? dm.error : dm.checking ? "Looking up your DNS" : r ? (r.ok ? "The record is in place." : "The record is not there yet. DNS can take a few minutes to show it: check again after adding it.") : "";
    const record = r ? el("div", { class: "cmd" }, el("pre", null, el("code", null, `${r.cname.host}  CNAME  ${r.cname.expected}`))) : null;
    return [
      el("h2", { class: "sub" }, "Your own domain"),
      el("p", { class: "lead" }, `Your server stays ${s.named && s.named.name}.vyre.run. To use a domain you own as well, add one DNS record for it. Type the domain and this page looks it up.`),
      el("div", { class: "field" }, input),
      el("div", { class: "actions" }, check, button("Not now", "secondary", () => actions.openDomain(false))),
      el("p", { id: "domain-status", class: "hint", role: "status", "data-role": "domain-hint" }, status),
      record,
      r && r.cname.found.length && !r.cname.ok ? el("p", { class: "note" }, `Found instead: ${r.cname.found.join(", ")}`) : null,
      r && r.caa.present && r.caa.ok === false ? el("p", { class: "note" }, "A CAA record on this domain does not name this server's certificate account. Certificates for it may be refused.") : null,
    ];
  });

  // ---- ai: each provider's own sign-in ----
  const providers = [["claude", "Claude"], ["codex", "ChatGPT (Codex)"], ["grok", "Grok"]];
  const keyKinds = [["openai-compatible", "OpenAI-compatible"], ["anthropic-compatible", "Anthropic-compatible"], ["openrouter", "OpenRouter"]];
  const aiKey = s.stage === "ai" ? "a:" + s.ai.accounts.map(a => `${a.id}/${a.step}/${a.url}/${a.code}/${a.error}`).join("|") + `|k:${s.ai.keyKind}/${s.ai.keyBusy}` : "none";
  region("ai", aiKey, () => s.stage !== "ai" ? [] : [
    el("div", { class: "providers" }, ...providers.map(([id, label]) => button(`Sign in with ${label}`, "secondary", () => actions.startAi(id)))),
    el("p", { class: "hint" }, "Or use an API key instead of signing in:"),
    el("div", { class: "providers" }, ...keyKinds.map(([id, label]) => button(`${label} key`, s.ai.keyKind === id ? "primary" : "secondary", () => actions.openAiKey(id)))),
    ...(s.ai.keyKind ? [(() => {
      const kind = s.ai.keyKind, custom = kind !== "openrouter";
      const field = (name, label, attrs = {}) => el("input", { type: "text", class: "name", name, autocomplete: "off", autocapitalize: "none", spellcheck: "false", "aria-label": label, placeholder: label, ...attrs });
      // type password and autocomplete off: the key is typed once, read once at the click, and never kept in the page's state.
      const key = field("apikey", "API key", { type: "password", maxlength: "400", autocomplete: "new-password" });
      const base = custom ? field("base_url", kind === "anthropic-compatible" ? "Address (empty for api.anthropic.com)" : "Address (empty for api.openai.com/v1)", { maxlength: "300", inputmode: "url" }) : null;
      const model = kind === "openai-compatible" ? field("model", "Model to use (optional)", { maxlength: "100" }) : null;
      const go = button(s.ai.keyBusy ? "Checking" : "Check and save", "primary", () => { actions.submitAiKey({ kind, key: /** @type {any} */ (key).value, base_url: base ? /** @type {any} */ (base).value : "", model: model ? /** @type {any} */ (model).value : "" }); /** @type {any} */ (key).value = ""; });
      if (s.ai.keyBusy) go.setAttribute("disabled", "");
      return el("div", { class: "account", "data-role": "key-form" },
        el("p", { class: "row-title" }, (keyKinds.find(k => k[0] === kind) || [0, kind])[1]),
        el("div", { class: "field" }, key), base ? el("div", { class: "field" }, base) : null, model ? el("div", { class: "field" }, model) : null,
        el("p", { class: "hint" }, "Your server checks the key with one small request, keeps it in its vault, and never shows it again."),
        el("div", { class: "actions" }, go));
    })()] : []),
    ...s.ai.accounts.map(a => {
      const label = ((providers.concat(keyKinds)).find(p => p[0] === a.provider) || [0, a.provider])[1];
      const kids = [el("p", { class: "row-title" }, label)];
      if (a.step === "starting") kids.push(el("p", { class: "status", role: "status" }, el("span", { class: "ring", "aria-hidden": "true" }), "Starting the sign-in"));
      if (a.step === "code" || a.step === "url") {
        if (a.url) kids.push(el("p", { class: "hint" }, "Open ", el("a", { href: a.url, target: "_blank", rel: "noopener noreferrer" }, "the sign-in page"), a.code && !a.paste ? " and enter this code:" : a.paste ? ", sign in, and paste the code it shows you here:" : "."));
        if (a.code && !a.paste) kids.push(el("p", { class: "code-line" }, a.code), el("p", { class: "status", role: "status" }, el("span", { class: "ring", "aria-hidden": "true" }), "Waiting for you to finish"));
        if (a.paste) {
          const input = el("input", { type: "text", class: "name", name: "code", autocomplete: "off", spellcheck: "false", "aria-label": `Code from ${label}`, maxlength: "400" });
          const go = button("Finish", "primary", () => actions.submitAiCode(a.id, /** @type {any} */ (input).value));
          kids.push(el("div", { class: "field" }, input), el("div", { class: "actions" }, go));
        }
      }
      if (a.step === "waiting") kids.push(el("p", { class: "status", role: "status" }, el("span", { class: "ring", "aria-hidden": "true" }), a.id.startsWith("key-") ? "Checking the key" : "Finishing the sign-in"));
      if (a.step === "done") kids.push(el("p", { class: "hint" }, a.id.startsWith("key-") ? `${label} key saved.` : `${label} is signed in.`));
      if (a.error) kids.push(el("p", { class: "warn", role: "alert" }, a.error));
      return el("div", { class: "account" }, ...kids);
    }),
    s.ai.accounts.some(a => a.step === "done")
      ? el("div", { class: "actions" }, button("Continue", "primary", () => actions.continueToDevices()))
      : el("div", { class: "actions" }, button("Skip for now", "quiet", () => actions.skipAi && actions.skipAi())),
    s.ai.accounts.some(a => a.step === "done") ? null : el("p", { class: "note" }, "Skipping is fine. Add one later in Settings, under Your AI. Until you do, your assistant cannot answer."),
  ]);

  // ---- network: built in, so the page only shows how the server is reachable ----
  const nt = s.network, ns = nt.status;
  const ntKey = s.stage === "network" ? `n:${ns ? ns.state + "|" + ns.path : "?"}|${nt.busy}|${nt.error}` : "none";
  region("network", ntKey, () => {
    if (s.stage !== "network") return [];
    const kids = [];
    if (ns) {
      const line = ns.state === "connected" ? "Your server is reachable directly." : ns.state === "relayed" ? "Your server is reachable through Vyre's relay, which carries the connection end-to-end encrypted. This is normal." : ns.state === "joining" ? "Your server's network is coming up." : ns.state === "offline" ? "Your server's link is down for now. Setup can carry on." : "Your server's network is ready.";
      kids.push(el("p", { class: "hint" }, line));
    } else if (nt.busy || !nt.error) {
      kids.push(el("p", { class: "status", role: "status" }, el("span", { class: "ring", "aria-hidden": "true" }), "Looking at your server's network"));
    }
    if (nt.error) { kids.push(el("p", { class: "warn", role: "alert" }, nt.error)); kids.push(el("div", { class: "actions" }, button("Look again", "quiet", () => actions.readNetwork()))); }
    if (ns || nt.error) kids.push(el("div", { class: "actions" }, button("Continue", "primary", () => actions.continueToAi())));
    return kids;
  });

  // ---- devices: the phone's ring, drawn from a ticket that never reaches the DOM as text ----
  const dv = s.devices;
  const dvKey = s.stage === "devices" ? `d:${dv.phone}|${dv.error}|${dv.paired}` : "none";
  const rebuiltDevices = region("devices", dvKey, () => {
    if (s.stage !== "devices") return [];
    const address = s.named && (s.named.address || s.named.name);
    const next = el("div", { class: "actions" }, button(dv.phone === "paired" ? "Continue" : "Skip for now", dv.phone === "paired" ? "primary" : "quiet", () => actions.continueToClaim()));
    if (dv.phone === "idle" || dv.phone === "failed" || dv.phone === "minting") return [
      el("p", { class: "lead" }, "Your first device pairs from the server's own terminal."),
      el("p", { class: "note" }, "The install shows a QR code and a long code there. Scan it with the Vyre app on your phone, or paste the code into the app on a computer, and confirm the three words. Then you finish setting up in the app, not here."),
      next,
    ];
    if (dv.phone === "showing") return [
      el("div", { class: "ring-slot", "data-role": "ring", role: "img", "aria-label": "The ring to scan with the Vyre app on your phone" }),
      el("p", { class: "status", role: "status" }, el("span", { class: "ring", "aria-hidden": "true" }), "Waiting for your phone"),
      el("p", { class: "note" }, "Open the Vyre app on your phone and point its camera at the ring."),
      next,
    ];
    if (dv.phone === "paired") return [el("p", { class: "lead" }, `${dv.paired || "Your phone"} is connected.`), el("p", { class: "hint" }, `You will finish on your phone or here, at ${address}.`), next];
    return [el("p", { class: "warn", role: "alert" }, "The ring expired. You can add your phone from your server's own page once setup is done."), next];
  });
  if (rebuiltDevices && dvKey.startsWith("d:showing")) { const slot = findByRole(m.regions.devices, "ring"); if (slot) actions.drawRing(slot); }

  // ---- claim: a fresh one-time link, and the same link as a code for a phone ----
  const cl = s.claim;
  const clKey = s.stage === "claim" ? `c:${cl.phase}|${cl.url}|${cl.error}` : "none";
  const rebuiltClaim = region("claim", clKey, () => {
    if (s.stage !== "claim") return [];
    const host = s.named ? `${s.named.name}.vyre.run` : "your server";
    if (cl.phase === "ready" && cl.url) return [
      el("div", { class: "actions" }, el("a", { class: "btn primary", href: cl.url, rel: "noopener" }, `Open ${host}`)),
      el("p", { class: "note" }, "This link works once, for two minutes. Open it in the browser you will use with your server."),
      el("h2", { class: "sub" }, "Or on your phone"),
      el("div", { class: "qr-slot", "data-role": "qr", role: "img", "aria-label": "A code that opens the same link on your phone" }),
      el("div", { class: "actions" }, button("Get a new link", "quiet", () => actions.mintClaim())),
    ];
    return [
      el("div", { class: "actions" }, button(cl.phase === "minting" ? "Making your link" : cl.phase === "expired" ? "Get a new link" : "Get my link", "primary", () => actions.mintClaim())),
      cl.phase === "expired" ? el("p", { class: "hint" }, "That link expired.") : null,
      cl.error ? el("p", { class: "warn", role: "alert" }, cl.error) : null,
    ];
  });
  if (rebuiltClaim && clKey.startsWith("c:ready") && cl.url) { const slot = findByRole(m.regions.claim, "qr"); if (slot) actions.drawQr(slot, cl.url); }

  // ---- log: the install as the server tells it, as plain text ----
  region("log", `${s.lines.length}|${s.lines[s.lines.length - 1] || ""}|${s.activity.length}`, () => s.lines.length || s.activity.length ? [
    el("h2", { class: "sub" }, "What is happening"),
    el("ul", { class: "log", "aria-live": "polite" }, ...s.activity.map(t => el("li", { class: "mine" }, t)), ...s.lines.map(t => el("li", null, t))),
  ] : []);

  // A new screen puts focus on its heading; progress lines arriving on the same screen do not.
  if (rebuiltHead && m.stage !== s.stage) { const hd = findTag(m.regions.head, "h1"); if (hd) hd.focus({ preventScroll: false }); }
  m.stage = s.stage;
}

/** @param {any} node @param {string} tag */
function findTag(node, tag) { for (const c of node.children || []) { if (c.tagName ? c.tagName.toLowerCase() === tag : c.tag === tag) return c; const f = findTag(c, tag); if (f) return f; } return null; }
/** @param {any} node @param {string} role */
function findByRole(node, role) { for (const c of node.children || []) { if (c.getAttribute && c.getAttribute("data-role") === role) return c; const f = findByRole(c, role); if (f) return f; } return null; }
