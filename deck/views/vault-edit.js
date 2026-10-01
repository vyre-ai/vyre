// @ts-check
// Add and edit, per kind, in the item pane. Values only go in: inputs are read once on save,
// cleared at once, and sent once with vault.update. An edit never pre-fills a value; each field
// says "Unchanged" until the person chooses Replace. The generator sends its settings
// (`generate: { field, length, symbols }` or `{ field, words }`), and vyred makes the value.

import { h, put } from "../js/dom.js";
import { icon, secretInput, clearSecrets, field, errText, toast } from "../vault/ui.js";
import { KIND } from "../vault/model.js";
import { generatePayload, settingsBits, strengthWord, luhn, brand, group, digits, expiry, LIMITS } from "../vault/gen.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KINDS = ["login", "card", "note", "api-key", "env-set", "secret", "ssh-key"];

/**
 * Slots per kind: the fields a person can fill. `gen` marks the one the generator can make.
 * @type {Record<string, { f: string, label: string, as?: "text"|"secret"|"area"|"card"|"expiry", gen?: boolean, optional?: boolean, hint?: string }[]>}
 */
const SLOTS = {
  login: [{ f: "username", label: "Username", as: "text" }, { f: "password", label: "Password", gen: true },
    { f: "totp", label: "One-time code seed", optional: true, hint: "Optional. The setup key the site shows; Vyre makes the codes." }],
  card: [{ f: "name", label: "Cardholder", as: "text", optional: true }, { f: "number", label: "Number", as: "card" },
    { f: "expiry", label: "Expiry", as: "expiry", optional: true }, { f: "cvc", label: "Security code", optional: true }],
  note: [{ f: "text", label: "Note", as: "area" }],
  "api-key": [{ f: "value", label: "Key", gen: true }],
  secret: [{ f: "value", label: "Value", gen: true }],
  "ssh-key": [],
};

/**
 * @param {any} app @param {HTMLElement} panel @param {{ name?: string, kind?: string }} what @param {boolean} focus
 */
export function editPane(app, panel, what, focus) {
  const { st, vc, ctx } = app;
  const it = what.name ? st.items.find(i => i.name === what.name) : null;
  const editing = Boolean(it);
  let kind = it ? it.kind : KINDS.includes(what.kind || "") ? /** @type {string} */ (what.kind) : "login";
  const canSsh = vc.has("vault.ssh.generate");
  app.onPane(() => clearSecrets(panel));
  ctx.cleanup(() => clearSecrets(panel));

  const status = h("p", { class: "vt-status", role: "status" });
  const nameIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input", id: "vt-e-name", autocomplete: "off", spellcheck: "false", placeholder: "acme-mail" }));
  const descIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input", id: "vt-e-desc", autocomplete: "off", placeholder: "What it is for", value: it?.description || "" }));
  const urlIn = /** @type {HTMLInputElement} */ (h("input", { type: "url", class: "input", id: "vt-e-url", autocomplete: "off", spellcheck: "false", placeholder: "https://mail.acme.test/login", value: it?.url || "" }));
  const hostsIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input", id: "vt-e-hosts", autocomplete: "off", spellcheck: "false", placeholder: "https://api.acme.test", value: it ? it.hosts.join(", ") : "" }));
  const values = h("div", { class: "vt-values" });
  const seg = h("div", { class: "seg vt-kseg", role: "group", "aria-label": "Kind" });
  /** @type {null | { payload: () => any, field: string }} */ let gen = null;
  /** env-set rows: { name input, value input, existing?: string, removed?: boolean } */
  let envRows = [];
  /** Fields the person chose to remove (edit). */
  const removed = new Set();

  const title = h("h2", { class: "vt-ptitle", tabindex: "-1", id: "vt-panel-h" }, editing ? `Edit ${it.name}` : "New item");
  panel.setAttribute("aria-labelledby", "vt-panel-h");

  function drawKind() {
    clearSecrets(values);
    gen = null; envRows = []; removed.clear();
    if (!editing) put(seg, KINDS.filter(k => k !== "ssh-key" || canSsh).map(k => h("button", { type: "button", "aria-pressed": k === kind ? "true" : "false",
      onclick: () => { kind = k; drawKind(); } }, k === "api-key" ? "API key" : k === "env-set" ? "Env set" : k === "ssh-key" ? "SSH key" : KIND[k])));
    const slots = SLOTS[kind] || [];
    const extra = kind === "login" ? [field("Website", urlIn, "Where it is used. Not secret: autofill matches on it.")]
      : kind === "api-key" || kind === "secret" ? [field("Hosts", hostsIn, "Origins it may be sent to, separated by commas. Needed for relayed passes.")] : [];
    if (kind === "ssh-key") {
      put(values, h("div", { class: "vt-sshgen" }, h("p", { class: "vt-hint" }, `Generates an ed25519 key on ${app.host}. The private half never leaves it; you get the public half to paste into GitHub or a server.`)));
      return;
    }
    if (kind === "env-set") { put(values, extra, envEditor()); return; }
    put(values, extra, slots.map(s => slotRow(s)));
  }

  /** One field: an input (new item), or "Unchanged" with Replace (edit). */
  function slotRow(s) {
    const has = editing && it.fields.includes(s.f);
    const holder = h("div", { class: "vt-slot" });
    const live = () => put(holder, field(s.label, ...inputFor(s)));
    if (!editing) { live(); return holder; }
    if (has) {
      put(holder, h("div", { class: "vt-field" }, h("span", { class: "lbl" }, s.label),
        h("div", { class: "vt-unchanged" }, h("span", { class: "vt-unch-t" }, "Unchanged"),
          h("button", { type: "button", class: "btn btn-sm", onclick: () => { live(); /** @type {HTMLElement|null} */ (holder.querySelector("input,textarea"))?.focus(); } }, "Replace"),
          s.optional ? h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => { removed.add(s.f); put(holder, h("div", { class: "vt-field" }, h("span", { class: "lbl" }, s.label), h("div", { class: "vt-unchanged" }, h("span", { class: "vt-unch-t" }, "Removed when you save")))); } }, "Remove") : null)));
    } else {
      put(holder, h("div", { class: "vt-field" }, h("span", { class: "lbl" }, s.label),
        h("div", { class: "vt-unchanged" }, h("span", { class: "vt-unch-t faint" }, "Not set"), h("button", { type: "button", class: "btn btn-sm", onclick: live }, "Add"))));
    }
    return holder;
  }

  /** @returns {any[]} [input, hint, extra] for field() */
  function inputFor(s) {
    const id = "vt-f-" + s.f;
    if (s.as === "area") {
      const ta = h("textarea", { class: "input vt-area", id, rows: "6", "data-vt-secret": "", "data-field": s.f, spellcheck: "false", "aria-label": s.label });
      return [ta, "Sealed like any other value."];
    }
    if (s.as === "card") {
      const inp = secretInput(s.label, id, { text: true });
      inp.dataset.field = s.f; inp.inputMode = "numeric"; inp.placeholder = "4242 4242 4242 4242"; inp.classList.add("mono");
      const note = h("span", { class: "vt-cardnote" });
      inp.addEventListener("input", () => {
        const pos = inp.selectionStart === inp.value.length;
        inp.value = group(inp.value);
        if (pos) inp.selectionStart = inp.selectionEnd = inp.value.length;
        const d = digits(inp.value), b = brand(d);
        put(note, b ? h("span", { class: "tag" }, b) : null, d.length >= 12 && !luhn(d) ? h("span", { class: "vt-hint" }, "The check digit does not match. Look at the number again.") : null);
      });
      return [inp, null, note];
    }
    if (s.as === "expiry") {
      const inp = secretInput(s.label, id, { text: true, optional: true });
      inp.dataset.field = s.f; inp.inputMode = "numeric"; inp.placeholder = "MM/YY"; inp.maxLength = 5; inp.classList.add("mono", "vt-short");
      inp.addEventListener("input", () => { inp.value = expiry(inp.value); });
      return [inp];
    }
    const inp = secretInput(s.label, id, { text: s.as === "text", optional: s.optional });
    inp.dataset.field = s.f;
    if (s.as !== "text") inp.classList.add("mono");
    if (!s.gen) return [inp, s.hint];
    return [inp, s.hint, generator(s.f, inp)];
  }

  /** The inline generator for one input. While on, the input is off and says where the value is made. */
  function generator(f, inp) {
    const set = { mode: /** @type {"chars"|"words"} */ ("chars"), length: 24, symbols: true, words: 5 };
    const box = h("div", { class: "vt-gen", hidden: true });
    const toggle = h("button", { type: "button", class: "btn btn-ghost btn-sm vt-gen-t", "aria-expanded": "false", onclick: () => on(box.hidden) }, icon("wand", 13), "Generate");
    const on = yes => {
      box.hidden = !yes;
      toggle.setAttribute("aria-expanded", String(yes));
      put(toggle, icon("wand", 13), yes ? "Type instead" : "Generate");
      inp.value = "";
      inp.disabled = yes;
      inp.placeholder = yes ? `Made on ${app.host} when you save` : "";
      inp.classList.toggle("vt-genon", yes);
      gen = yes ? { field: f, payload: () => generatePayload({ field: f, ...set }) } : null;
      if (yes) draw();
    };
    const draw = () => {
      const p = generatePayload({ field: f, ...set });
      const bits = settingsBits(p);
      const range = /** @type {HTMLInputElement} */ (h("input", { type: "range", class: "vt-range", min: String(set.mode === "words" ? LIMITS.words[0] : LIMITS.length[0]),
        max: String(set.mode === "words" ? LIMITS.words[1] : LIMITS.length[1]), value: String(set.mode === "words" ? set.words : set.length),
        "aria-label": set.mode === "words" ? "Words" : "Length",
        oninput: () => { if (set.mode === "words") set.words = Number(range.value); else set.length = Number(range.value); draw(); range.focus(); } }));
      put(box,
        h("div", { class: "vt-gen-row" },
          h("div", { class: "seg", role: "group", "aria-label": "Style" }, [["chars", "Characters"], ["words", "Words"]].map(([m, l]) =>
            h("button", { type: "button", "aria-pressed": set.mode === m ? "true" : "false", onclick: () => { set.mode = /** @type {any} */ (m); draw(); } }, l))),
          set.mode === "chars" ? h("label", { class: "vt-sym" }, h("button", { type: "button", role: "switch", class: "sw", "aria-checked": set.symbols ? "true" : "false", "aria-label": "Symbols",
            onclick: () => { set.symbols = !set.symbols; draw(); } }), "Symbols") : null),
        h("div", { class: "vt-gen-row" }, range, h("span", { class: "vt-gen-n mono" }, set.mode === "words" ? `${set.words} words` : `${set.length} characters`)),
        h("div", { class: "vt-gen-s" }, h("span", { class: "vt-meter" }, h("span", { style: { width: Math.min(100, bits / 1.5) + "%" } })),
          h("span", null, `${strengthWord(bits)} · about ${Math.round(bits)} bits`)),
        h("p", { class: "vt-hint" }, `The value is made on ${app.host} and sealed there. It never comes to this page.`));
    };
    return h("div", { class: "vt-gen-w" }, toggle, box);
  }

  function envEditor() {
    const list = h("div", { class: "vt-env" });
    const add = (existing = "") => {
      const nameI = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input mono vt-env-k", placeholder: "DATABASE_URL", "aria-label": "Variable name", spellcheck: "false", autocomplete: "off", value: existing, disabled: !!existing }));
      const valI = secretInput("Value", "", { optional: true });
      valI.classList.add("mono");
      const row = { nameI, valI, existing, removed: false, replace: !existing };
      const slot = h("div", { class: "vt-env-row" });
      const drawRow = () => put(slot, nameI,
        row.removed ? h("span", { class: "vt-unch-t" }, "Removed when you save")
          : row.replace ? valI
          : h("span", { class: "vt-unchanged" }, h("span", { class: "vt-unch-t" }, "Unchanged"), h("button", { type: "button", class: "btn btn-sm", onclick: () => { row.replace = true; drawRow(); valI.focus(); } }, "Replace")),
        h("button", { type: "button", class: "ibtn", "aria-label": `Remove ${existing || "this variable"}`, onclick: () => {
          if (existing) { row.removed = !row.removed; drawRow(); } else { valI.value = ""; slot.remove(); envRows = envRows.filter(r => r !== row); }
        } }, icon("close", 12)));
      drawRow();
      envRows.push(row);
      list.append(slot);
    };
    if (editing) for (const f of it.fields) add(f); else add();
    return h("div", { class: "vt-field" }, h("span", { class: "lbl" }, "Variables"), list,
      h("button", { type: "button", class: "btn btn-ghost btn-sm vt-env-add", onclick: () => add() }, icon("plus", 12), "Add variable"),
      h("span", { class: "vt-hint" }, "Names are listed; values are sealed. vyre vault run puts them in one command's environment."));
  }

  async function save(e) {
    e.preventDefault();
    put(status);
    // Read every value once, then clear the inputs before anything is sent.
    const fields = {};
    for (const el of values.querySelectorAll("[data-field]")) {
      const inp = /** @type {HTMLInputElement} */ (el);
      if (inp.disabled) continue;
      let v = inp.value;
      if (inp.dataset.field === "number") v = digits(v);
      if (v) fields[/** @type {string} */ (inp.dataset.field)] = v;
    }
    const remove = [...removed];
    let envBad = "";
    for (const r of envRows) {
      const k = r.nameI.value.trim();
      if (r.removed) { remove.push(r.existing); continue; }
      if (!r.valI.value) { if (!r.existing && k) envBad = `Give ${k} a value.`; continue; }
      if (!ENV.test(k)) envBad = `${k || "A variable"} is not an environment variable name.`;
      else fields[k] = r.valI.value;
    }
    clearSecrets(panel);
    const name = editing ? it.name : nameIn.value.trim();
    const say = t => { put(status, t); };
    if (!NAME.test(name)) return say("A name is letters, digits, dot, dash and underscore, with no spaces. Nothing was sent.");
    if (!editing && st.items.some(i => i.name === name)) return say(`There is already an item called ${name}. Nothing was sent.`);
    if (envBad) return say(envBad + " Nothing was sent.");
    if (kind === "card" && fields.number && !luhn(fields.number)) return say("That card number fails its check digit. Nothing was sent.");
    const g = gen ? gen.payload() : null;
    if (!editing) {
      const need = { login: ["password"], card: ["number"], note: ["text"], "api-key": ["value"], secret: ["value"] }[kind] || [];
      const miss = need.filter(f => !fields[f] && !(g && g.field === f) && !(kind === "login" && fields.username));
      if (kind === "env-set" && !Object.keys(fields).length) return say("Add at least one variable. Nothing was sent.");
      if (miss.length) return say(`Type the ${miss.map(m => (SLOTS[kind].find(s => s.f === m) || { label: m }).label.toLowerCase()).join(" and ")}, or generate it. Nothing was sent.`);
    }
    if (kind === "ssh-key") {
      const r = await vc.call("vault.ssh.generate", { name, ...(descIn.value.trim() ? { description: descIn.value.trim() } : {}) });
      if (!ctx.alive()) return;
      if (r.error) return say(errText({ ...r.error, tool: "vault.ssh.generate" }));
      toast({ text: `Made ${name} on ${app.host}. Its public half is on the item.` });
      await app.load();
      app.open({ mode: "item", name });
      return;
    }
    const hosts = hostsIn.value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    const input = {
      name, ...(editing ? {} : { kind }),
      ...(descIn.value.trim() !== (it?.description || "") ? { description: descIn.value.trim() } : {}),
      ...(kind === "login" && urlIn.value.trim() !== (it?.url || "") ? { url: urlIn.value.trim() } : {}),
      ...((kind === "api-key" || kind === "secret") && hosts.join(",") !== (it?.hosts || []).join(",") ? { hosts } : {}),
      ...(Object.keys(fields).length ? { fields } : {}), ...(remove.length ? { remove } : {}), ...(g ? { generate: g } : {}),
    };
    const btn = /** @type {HTMLButtonElement} */ (form.querySelector("button[type=submit]"));
    btn.disabled = true;
    const r = await vc.call("vault.update", input);
    btn.disabled = false;
    for (const k of Object.keys(fields)) fields[k] = "";
    if (!ctx.alive()) return;
    if (r.error) return say(r.error.code === "presence_refused" || r.error.code === "cancelled" ? "Not saved. Nothing was sent." : errText({ ...r.error, tool: "vault.update" }));
    toast({ text: r.data?.generated ? `Saved ${name}. A new ${r.data.generated} was made on ${app.host}.` : `Saved ${name}. The values are sealed on ${app.host}.` });
    await app.load();
    app.open({ mode: "item", name });
  }

  const form = h("form", { class: "vt-form", autocomplete: "off", onsubmit: save },
    editing ? null : field("Name", nameIn, "Agents and the CLI ask for it by this name."),
    editing ? null : h("div", { class: "vt-field" }, h("span", { class: "lbl" }, "Kind"), seg),
    field("Description", descIn),
    values,
    h("p", { class: "vt-hint" }, editing ? "Values you do not replace stay exactly as they are. Nothing is shown to fill in." : "What you type is sealed when you save and is not shown again here."),
    h("div", { class: "vt-form-acts" },
      h("button", { type: "submit", class: "btn btn-primary" }, icon("lock", 14), editing ? "Save" : kind === "ssh-key" ? "Generate" : "Seal it"),
      h("button", { type: "button", class: "btn btn-ghost", onclick: () => (editing ? app.open({ mode: "item", name: it.name }) : app.close()) }, "Cancel")),
    status);

  put(panel,
    h("div", { class: "vt-ptop" },
      h("button", { type: "button", class: "btn btn-ghost vt-back", onclick: app.close }, icon("back", 14), "Vault"),
      h("span", { class: "lbl" }, editing ? it.kindLabel : "Add item"),
      h("button", { type: "button", class: "ibtn vt-closex", "aria-label": "Close panel", onclick: app.close }, icon("close", 13))),
    title, form);
  drawKind();
  if (focus) (editing ? title : nameIn).focus({ preventScroll: true });
  if (!vc.has("vault.update")) put(status, "This vyred has no vault.update yet, so the Deck cannot save items.");
}

/**
 * Replace the key of an API credential: one hidden box. Its hosts, endpoints and readers stay as
 * the person wrote them, because vault.put carries the stored config over when only the key is given.
 * @param {any} app @param {HTMLElement} panel @param {string} name @param {boolean} focus
 */
export function replaceKeyPane(app, panel, name, focus) {
  const { vc, ctx } = app;
  app.onPane(() => clearSecrets(panel));
  ctx.cleanup(() => clearSecrets(panel));
  const status = h("p", { class: "vt-status", role: "status" });
  const keyIn = secretInput("The new key", "vt-e-key");
  const title = h("h2", { class: "vt-ptitle", tabindex: "-1", id: "vt-panel-h" }, `Replace the key for ${name}`);
  panel.setAttribute("aria-labelledby", "vt-panel-h");
  async function save(/** @type {Event} */ e) {
    e.preventDefault();
    const secret = keyIn.value;
    if (!secret) return put(status, "Paste the new key.");
    const btn = /** @type {HTMLButtonElement} */ (form.querySelector("button[type=submit]"));
    btn.disabled = true;
    const r = await vc.call("vault.put", { name, kind: "api-credential", fields: { secret } });
    btn.disabled = false;
    keyIn.value = "";
    if (!ctx.alive()) return;
    if (r.error) return put(status, r.error.code === "presence_refused" || r.error.code === "cancelled" ? "Not saved. Nothing was sent." : errText({ ...r.error, tool: "vault.put" }));
    toast({ text: `Replaced the key for ${name}. Its hosts and what it may do stay as they were.` });
    await app.load();
    app.open({ mode: "item", name });
  }
  const form = h("form", { class: "vt-form", autocomplete: "off", onsubmit: save },
    field("New key", keyIn, "Sealed when you save, and never shown again. Everything else about this credential stays as it is."),
    h("div", { class: "vt-form-acts" },
      h("button", { type: "submit", class: "btn btn-primary" }, icon("lock", 14), "Replace the key"),
      h("button", { type: "button", class: "btn btn-ghost", onclick: () => app.open({ mode: "item", name }) }, "Cancel")),
    status);
  put(panel,
    h("div", { class: "vt-ptop" },
      h("button", { type: "button", class: "btn btn-ghost vt-back", onclick: app.close }, icon("back", 14), "Vault"),
      h("span", { class: "lbl" }, "Key"),
      h("button", { type: "button", class: "ibtn vt-closex", "aria-label": "Close panel", onclick: app.close }, icon("close", 13))),
    title, form);
  if (focus) keyIn.focus({ preventScroll: true });
}
