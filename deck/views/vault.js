// @ts-check
// Vault: the person's password manager. Board: DeckVault. ADR 0006, section 6.
//
// The page never holds a value unless the person has just asked to see one. Listings carry names,
// kinds, hosts and field NAMES. Copy asks vyred to write the clipboard (vault.copy); the value
// does not come back. Reveal (vault.reveal) is off unless vyred's vault.caps says otherwise, and
// a revealed value is a text node that goes away after 30 seconds, on blur and on leaving. The
// unlock session's token lives in deck/vault/client.js's memory, nowhere else.
//
// Routes: /vault (all), /vault/<place>, and ?item=<name> for the item pane (a full-screen sheet
// on a phone). Places: model.js. Keys: vault/keys.js. Parts: vault-item.js, vault-edit.js,
// vault-places.js.

import { h, put, empty } from "../js/dom.js";
import { action } from "../js/empty-actions.js";
import { attempt, modules } from "../js/api.js";
import { clock, startOfToday } from "../js/fmt.js";
import * as vc from "../vault/client.js";
import { search } from "../vault/search.js";
import { actionFor, HELP } from "../vault/keys.js";
import { PLACES, place as placeOf, pickItems, pickPasses, pickPending, pickUsage, lastUsed, inPlace, mainField } from "../vault/model.js";
import { icon, kindIcon, tile, everySecond, mmss, sheet, toast, hideToast, favorites, errText } from "../vault/ui.js";
import { passkeysHere } from "../vault/presence.js";
import { itemPane } from "./vault-item.js";
import { editPane, replaceKeyPane } from "./vault-edit.js";
import { watchtower, passesView, sharedView, devicesView, shareSheet, offboardSheet } from "./vault-places.js";

const EVENTS = ["vault.item-added", "vault.item-changed", "vault.item-deleted", "vault.granted", "vault.revoked", "grant.requested",
  "pass.requested", "pass.created", "pass.revoked", "pass.accepted", "person.offboarded", "vault.device-paired", "vault.device-revoked",
  "vault.locked", "vault.unlocked"];

/** @param {any} ctx */
export default async function vault(ctx) {
  const st = {
    host: "", onTailnet: /\.vyre\.run$|\.ts\.net$/.test(location.hostname),
    place: placeOf(ctx.params.place || "all").id,
    items: /** @type {any[]} */ ([]), listErr: /** @type {any} */ (null), locked: false,
    passes: /** @type {any[]} */ ([]), passErr: /** @type {any} */ (null),
    pending: /** @type {any[]} */ ([]),
    used: new Map(), caps: { reveal: false, breach: "off" },
    health: /** @type {any} */ (null),
    fav: favorites.get(),
    query: "", cursor: 0,
    /** @type {null | { mode: "item", name: string } | { mode: "add", kind?: string } | { mode: "edit", name: string } | { mode: "replace", name: string }} */
    panel: null,
    flash: "",
  };
  const item0 = ctx.query.get("item");
  if (item0) st.panel = { mode: "item", name: item0 };
  if (ctx.query.get("new") !== null) st.panel = { mode: "add", kind: ctx.query.get("new") || undefined };

  // ---- skeleton ----
  const main = h("div", { class: "vt-main" });
  const panel = h("aside", { class: "vt-panel", hidden: true });
  const wrap = h("div", { class: "vt" }, main, panel);
  put(ctx.root, wrap);

  const head = h("div", { class: "vt-head" });
  const chips = h("nav", { class: "vt-chips", "aria-label": "Vault places" });
  const body = h("div", { class: "vt-body" });
  put(main, head, chips, body);

  /** Things to undo when the panel changes (a reveal timer, a TOTP tick). */
  let paneOff = [];
  const leavePane = () => { for (const f of paneOff.splice(0)) { try { f(); } catch {} } };
  ctx.cleanup(() => { leavePane(); hideToast(); });

  // ---- presence: the sheet vyred's refusal opens ----
  vc.setConfirm(ask => new Promise(resolve => {
    let answered = false;
    const finish = v => { if (answered) return; answered = true; s.close(); resolve(v); };
    const can = passkeysHere();
    const s = sheet({ label: "Confirm it's you", title: summaryFor(ask.tool, ask.input, st.host), onClose: () => { if (!answered) { answered = true; resolve(false); } },
      body: [
        h("p", { class: "vt-sheet-p" }, can
          ? "Vyre asks for proof that a person is here. Your device will ask for Touch ID or its PIN. Nothing happens until you confirm."
          : "Vyre asks for proof that a person is here, and this browser cannot use a passkey on this address. Open the Deck on localhost or over https, or confirm from a terminal or Lumen."),
        h("div", { class: "vt-sheet-meta" }, h("span", { class: "lbl" }, "Tool"), h("span", { class: "code" }, ask.tool)),
        h("div", { class: "vt-form-acts" },
          can ? h("button", { type: "button", class: "btn btn-primary", onclick: () => finish(true) }, icon("shield", 14), "Use passkey") : null,
          h("button", { type: "button", class: "btn btn-ghost", onclick: () => finish(false) }, "Cancel")),
      ] });
  }));

  // ---- data ----
  const info = await attempt("system.info");
  if (!ctx.alive()) return;
  st.host = String(info.data?.host || "") || location.hostname;
  await vc.loadTools();
  if (!ctx.alive()) return;

  async function load() {
    const [l, p, caps, audit, pend] = await Promise.all([
      attempt("vault.list"), attempt("vault.pass.list"), attempt("vault.caps"),
      attempt("vault.audit", { limit: 1000 }), vc.has("vault.pending") ? attempt("vault.pending") : Promise.resolve({ data: null })]);
    if (!ctx.alive()) return;
    st.listErr = l.error || null;
    st.locked = Boolean(l.data?.locked);
    st.items = l.error ? [] : pickItems(l.data);
    st.passErr = p.error || null;
    st.passes = p.error ? [] : pickPasses(p.data);
    st.pending = pend.data ? pickPending(pend.data) : [];
    if (caps.data) {
      st.caps = { reveal: caps.data.reveal === true, breach: caps.data.breach === "ask" ? "ask" : "off" };
      if (typeof caps.data.host === "string" && caps.data.host) st.host = caps.data.host;
    }
    st.used = audit.error ? new Map() : lastUsed(pickUsage(audit.data));
    for (const it of st.items) if (!it.last_used && st.used.has(it.name)) it.last_used = st.used.get(it.name);
    for (const it of st.items) it.passes = st.passes.filter(x => x.direction === "to" && x.items.includes(it.name)).length;
    drawAll();
  }
  let lt = 0;
  for (const t of EVENTS) ctx.on(t, () => { clearTimeout(lt); lt = window.setTimeout(load, 250); });
  ctx.cleanup(vc.watch(() => { drawHead(); if (st.panel && !formUp()) drawPanel(); }));

  // ---- navigation inside the view (no full re-render) ----
  function href(placeId = st.place, extra = "") {
    return (placeId === "all" ? "/vault" : `/vault/${placeId}`) + extra;
  }
  function goPlace(id) {
    st.place = id; st.cursor = 0;
    if (placeOf(id).view) st.panel = null;
    history.pushState(null, "", href(id));
    leavePane();
    drawAll();
  }
  function open(p, push = true) {
    leavePane();
    // Every way into Edit (the button, the key, a Watchtower fix) lands on Replace the key for an API credential, which is never read back.
    if (p.mode === "edit" && st.items.some(i => i.name === p.name && i.kind === "api-credential")) p = { mode: "replace", name: p.name };
    st.panel = p;
    if (push) history.pushState(null, "", href(st.place, p.mode === "item" ? `?item=${encodeURIComponent(p.name)}` : p.mode === "add" ? `?new=${p.kind || ""}` : `?item=${encodeURIComponent(p.name)}`));
    if (p.mode === "item") { const i = visible().findIndex(x => x.name === p.name); if (i >= 0) st.cursor = i; }
    drawBody(); drawPanel(true);
  }
  function close() {
    leavePane();
    st.panel = null;
    history.pushState(null, "", href());
    drawBody(); drawPanel();
    /** @type {HTMLElement|null} */ (body.querySelector(".vt-row.cursor"))?.focus({ preventScroll: true });
  }

  const visible = () => search(inPlace(st.items, st.place, st.fav), st.query);

  // ---- drawing ----
  function drawAll() { drawRail(); drawChips(); drawHead(); drawBody(); if (!formUp()) drawPanel(); }

  function counts() {
    const live = st.items.filter(i => i.state === "live");
    const c = { all: live.length, favorites: live.filter(i => st.fav.has(i.name)).length, archive: st.items.filter(i => i.state === "archived").length,
      trash: st.items.filter(i => i.state === "trashed").length, shared: st.passes.filter(p => p.direction === "from").length,
      passes: st.passes.filter(p => p.direction === "to").length, watchtower: st.health ? st.health.items.length : null };
    for (const p of PLACES) if (p.kind) c[p.id] = live.filter(i => i.kind === p.kind).length;
    return c;
  }

  function placeLink(p, cls, n) {
    const needs = p.id === "passes" && st.pending.length;
    return h("a", { href: href(p.id), class: cls, "aria-current": st.place === p.id ? "page" : false,
      onclick: (/** @type {MouseEvent} */ e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); goPlace(p.id); } },
      cls.includes("vt-rail-a") ? h("span", { class: "vt-rail-i" }, icon(p.icon, 14)) : null,
      h("span", { class: "ellipsis" }, cls.includes("vt-chip") ? p.short || p.label : p.label),
      needs ? h("span", { class: "vt-count beacon", "aria-label": `${st.pending.length} waiting for you` }, String(st.pending.length))
        : n !== null && n !== undefined && n > 0 ? h("span", { class: "vt-count" }, String(n)) : null);
  }

  function drawRail() {
    const c = counts();
    const groups = [["", PLACES.filter(p => !p.group)], ["Kinds", PLACES.filter(p => p.group === "kinds")], ["", PLACES.filter(p => p.group === "more")], ["", PLACES.filter(p => p.group === "end")]];
    window.dispatchEvent(new CustomEvent("deck:rail", { detail: h("div", { class: "vt-rail" },
      h("div", { class: "lbl", style: { padding: "0 10px 8px" } }, "Vault"),
      groups.map(([label, ps], i) => h("div", { class: "vt-rail-g" + (i ? " sep" : "") }, label ? h("div", { class: "vt-rail-l" }, label) : null,
        ps.filter(p => p.id !== "ssh-keys" || c["ssh-keys"] || vc.has("vault.ssh.generate")).map(p => placeLink(p, "pin-a vt-rail-a", c[p.id]))))) }));
  }

  function drawChips() {
    const c = counts();
    put(chips, PLACES.filter(p => (p.id !== "ssh-keys" || c["ssh-keys"]) && (!p.kind || c[p.id]) && (p.group !== "end" || c[p.id]))
      .map(p => placeLink(p, "vt-chip", p.view ? null : c[p.id])));
    const on = /** @type {HTMLElement|null} */ (chips.querySelector('[aria-current="page"]'));
    if (on) chips.scrollLeft = Math.max(0, on.offsetLeft - chips.offsetLeft - 16);
  }

  let sessionStop = () => {};
  function drawHead() {
    sessionStop();
    const p = placeOf(st.place);
    const title = p.id === "all" ? "Vault" : p.label;
    const lede = p.id === "watchtower" ? `Checked on ${st.host} against the sealed values. Only names and reasons come back to this page.`
      : p.id === "passes" ? `A pass lets another person's Vyre use an item. Relayed passes never let the value leave ${st.host}.`
      : p.id === "shared" ? "Items other people's Vyre let yours use. Their box makes each call; the value never comes here."
      : p.id === "devices" ? "Browsers paired for autofill. Revoking one ends its sessions at once."
      : `Keys and logins, listed by name. Values stay sealed on ${st.host}, and a copy never brings one into this page.`;
    const s = vc.current();
    const chip = h("span", { class: "vt-unlocked", role: "status" });
    const lockBits = s
      ? [chip, h("button", { type: "button", class: "btn btn-ghost", onclick: lockNow }, icon("lock", 14), "Lock")]
      : vc.has("vault.session.open") ? [h("button", { type: "button", class: "btn", onclick: unlockNow }, icon("lock", 14), "Unlock")] : [];
    const add = !p.view ? h("button", { type: "button", class: "btn btn-primary", onclick: () => open({ mode: "add", kind: p.kind }), disabled: !!st.listErr?.missing }, icon("plus", 14), "Add item") : null;
    put(head,
      h("div", { class: "vt-head-text" }, h("h1", { class: "h2" }, title), h("p", { class: "vt-lede" }, lede)),
      h("div", { style: { flexGrow: "1" } }),
      h("div", { class: "vt-head-acts" }, lockBits, add));
    if (s) sessionStop = everySecond(now => {
      const left = s.expires - now;
      if (left <= 0) { vc.current(); return; }
      put(chip, h("span", { class: "dot signal" }), "Unlocked ", h("span", { class: "vt-mm" }, mmss(left)));
    });
  }
  ctx.cleanup(() => sessionStop());

  async function unlockNow() {
    const r = await vc.unlock();
    if (!ctx.alive()) return;
    if (r.error) toast({ text: r.error.code === "presence_refused" || r.error.code === "cancelled" ? "Still locked. Nothing was opened." : errText(r.error) });
  }
  async function lockNow() {
    await vc.lock();
    if (!ctx.alive()) return;
    toast({ text: "Locked. The Vault forgets this browser's session." });
  }

  function drawBody() {
    const p = placeOf(st.place);
    if (p.id === "watchtower") return watchtower(app, body);
    if (p.id === "passes") return passesView(app, body);
    if (p.id === "shared") return sharedView(app, body);
    if (p.id === "devices") return devicesView(app, body);
    drawList();
  }

  const filter = /** @type {HTMLInputElement} */ (h("input", { type: "search", class: "vt-filter-in", placeholder: "Filter by name, site or field", "aria-label": "Filter items",
    autocomplete: "off", spellcheck: "false", oninput: () => { st.query = filter.value; st.cursor = 0; drawRows(); } }));
  const rowsBox = h("div", { class: "vt-items", role: "grid", "aria-label": "Items" });
  function drawList() {
    const lst = placeOf(st.place);
    put(body,
      h("label", { class: "vt-filter" }, icon("search", 14), filter, h("span", { class: "kbd" }, "/")),
      rowsBox);
    if (st.listErr) { put(rowsBox, empty("No items to list.", st.listErr)); return; }
    if (lst.id === "archive" || lst.id === "trash") {
      if (!inPlace(st.items, lst.id, st.fav).length) { put(rowsBox, h("div", { class: "empty" }, lst.id === "archive" ? "Nothing archived. Archived items stay sealed and out of the list, autofill and passes." : "Trash is empty. Deleted items wait here for 30 days before they are purged.")); return; }
    }
    drawRows();
  }
  function drawRows() {
    const list = visible();
    if (st.cursor >= list.length) st.cursor = Math.max(0, list.length - 1);
    const sel = st.panel && "name" in st.panel ? st.panel.name : null;
    if (!list.length) {
      // Empty because nothing is stored (not a filter, not favorites): the add editor, from here.
      const addHere = !st.query && st.place !== "favorites" ? action("Add item", () => open({ mode: "add", kind: placeOf(st.place).kind })) : null;
      put(rowsBox, h("div", { class: "empty" }, st.query ? `Nothing here matches “${st.query}”. The filter reads names, sites and field names, never values.`
        : st.place === "favorites" ? "No favorites yet. Press f on an item to keep it here."
        : st.items.length ? "Nothing of this kind yet." : "The Vault is empty. Add a login or a key and it is listed here by name.", addHere));
      return;
    }
    put(rowsBox,
      h("div", { class: "vt-grid vt-thead lbl", role: "row" }, h("span", { role: "columnheader" }), h("span", { role: "columnheader" }, "Name"), h("span", { role: "columnheader" }, "Kind"),
        h("span", { role: "columnheader" }, "Held by"), h("span", { role: "columnheader", class: "vt-r" }, "Last used")),
      list.map((it, i) => {
        const held = it.holders.filter(g => !g.pass).map(g => g.agent || g.module);
        return h("a", { href: href(st.place, `?item=${encodeURIComponent(it.name)}`), role: "row", "data-name": it.name,
          class: "vt-grid vt-row" + (i === st.cursor ? " cursor" : ""), "aria-current": it.name === sel ? "true" : false, tabindex: i === st.cursor ? "0" : "-1",
          onclick: (/** @type {MouseEvent} */ e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); st.cursor = i; open({ mode: "item", name: it.name }); } },
          h("span", { class: "vt-kicon", role: "gridcell" }, kindIcon(it.kind)),
          h("span", { class: "vt-name", role: "gridcell" }, h("span", { class: "ellipsis vt-name-t" }, it.name),
            st.fav.has(it.name) ? h("span", { class: "vt-fav", "aria-label": "Favorite" }, icon("starOn", 12)) : null,
            it.passes ? h("span", { class: "vt-passbadge" }, icon("pass", 12), it.passes === 1 ? "1 pass" : `${it.passes} passes`) : null,
            it.rotate ? h("span", { class: "tag" }, "Rotate") : null),
          h("span", { class: "vt-kind", role: "gridcell" }, it.kindLabel),
          h("span", { class: "vt-held", role: "gridcell" }, held.length ? [held.slice(0, 3).map(n => tile(n)), h("span", { class: "vt-held-names ellipsis" }, held.join(", "))] : h("span", { class: "faint" }, "Nobody")),
          h("span", { class: "vt-used vt-r", role: "gridcell" }, lastWord(it.last_used)));
      }));
  }

  // An open add or edit form is drawn once. Redrawing it on a vault event or a session change
  // cleared what the person typed and the error a refused vault.update put under it, which read
  // as the editor closing and saying nothing. It is drawn again only when its item first arrives.
  /** @type {{ key: string, whole: boolean } | null} */ let form = null;
  const formOf = p => p && p.mode !== "item" ? { key: `${p.mode}:${p.name || p.kind || ""}`, whole: (p.mode !== "edit" && p.mode !== "replace") || st.items.some(i => i.name === p.name) } : null;
  const formUp = () => { const f = formOf(st.panel); return Boolean(f && form && f.key === form.key && (form.whole || !f.whole)); };

  function drawPanel(focus = false) {
    const p = st.panel;
    form = formOf(p);
    wrap.classList.toggle("has-panel", !!p);
    // One primary action per view: while a form is open, Save is it.
    wrap.classList.toggle("editing", !!p && p.mode !== "item");
    if (!p) { put(panel); panel.hidden = true; return; }
    panel.hidden = false;
    if (p.mode === "item") itemPane(app, panel, p.name, focus);
    else if (p.mode === "replace") replaceKeyPane(app, panel, p.name, focus);
    else editPane(app, panel, p.mode === "edit" ? { name: p.name } : { kind: p.kind }, focus);
  }

  // ---- actions the keys and buttons share ----
  const cursorItem = () => (st.panel && "name" in st.panel ? st.items.find(i => i.name === st.panel?.["name"]) : visible()[st.cursor]) || null;

  async function copy(it, field, label = field) {
    if (!it) return;
    if (!vc.has("vault.copy")) { toast({ text: "This box cannot copy yet." }); return; }
    const r = await vc.call("vault.copy", { name: it.name, field });
    if (!ctx.alive()) return;
    if (r.error) { toast({ text: r.error.code === "presence_refused" || r.error.code === "cancelled" ? "Not copied." : errText({ ...r.error, tool: "vault.copy" }) }); return; }
    const clearsAt = Number(r.data?.clearsAt) || Date.now() + 90_000;
    toast({ text: `Copied the ${label} of ${it.name}.`, clearsAt,
      onClear: vc.has("vault.clipboard.clear") ? async () => { await vc.call("vault.clipboard.clear", {}); } : null });
  }

  function help() {
    sheet({ label: "Keyboard", title: "Keys in the Vault", body: [
      h("dl", { class: "vt-keys" }, HELP.map(([k, what]) => [h("dt", null, k.split(/\s+/).map(x => h("span", { class: "kbd" }, x))), h("dd", null, what)])),
      h("p", { class: "vt-hint" }, "Keys do nothing while you type in a field. Esc always closes.")] });
  }

  function onKey(/** @type {KeyboardEvent} */ e) {
    if (document.querySelector(".vt-backdrop")) return;
    const a = actionFor(e);
    if (!a) return;
    const list = visible();
    const it = cursorItem();
    const listPlace = !placeOf(st.place).view;
    const run = {
      filter: () => { if (listPlace) { filter.focus(); filter.select(); } },
      down: () => { if (!listPlace || !list.length) return; st.cursor = Math.min(list.length - 1, st.cursor + 1); moved(list); },
      up: () => { if (!listPlace || !list.length) return; st.cursor = Math.max(0, st.cursor - 1); moved(list); },
      open: () => { if (listPlace && list[st.cursor]) open({ mode: "item", name: list[st.cursor].name }); },
      close: () => {
        if (document.activeElement === filter && filter.value) { filter.value = ""; st.query = ""; drawRows(); return; }
        if (st.panel) { close(); return; }
        if (document.activeElement === filter) filter.blur();
      },
      copy: () => it && copy(it, mainField(it), mainField(it) === "value" ? "value" : mainField(it)),
      "copy-username": () => it && it.fields.includes("username") && copy(it, "username"),
      "copy-code": () => it && it.fields.includes("totp") && copy(it, "totp", "one-time code"),
      edit: () => it && open({ mode: "edit", name: it.name }),
      new: () => open({ mode: "add", kind: placeOf(st.place).kind }),
      favorite: () => { if (it) { st.fav = favorites.toggle(it.name); drawRail(); drawChips(); drawRows(); if (st.panel?.mode === "item") drawPanel(); } },
      lock: () => { if (vc.current()) lockNow(); },
      help,
    }[a];
    if (!run) return;
    if (a !== "close" || st.panel || document.activeElement === filter) e.preventDefault();
    run();
  }
  function moved(list) {
    drawRows();
    const row = /** @type {HTMLElement|null} */ (rowsBox.querySelector(".vt-row.cursor"));
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
    // With the pane open, the pane follows the cursor, as in a mail client.
    if (st.panel?.mode === "item" && list[st.cursor]) open({ mode: "item", name: list[st.cursor].name }, false);
  }
  document.addEventListener("keydown", onKey);
  ctx.cleanup(() => document.removeEventListener("keydown", onKey));

  /** What the view hands its parts. */
  const app = {
    ctx, st, get host() { return st.host; }, vc, load, open, close, goPlace, copy, href,
    onPane: fn => paneOff.push(fn), leavePane, drawPanel, drawRail, drawRows,
    modules, favorite: name => { st.fav = favorites.toggle(name); drawRail(); drawChips(); drawRows(); drawPanel(); },
    share: items => shareSheet(app, items), offboard: () => offboardSheet(app),
  };

  drawAll();
  await load();
}

function lastWord(t) {
  if (!t) return "Never";
  const t0 = startOfToday();
  if (t >= t0) return clock(t);
  if (t >= t0 - 86_400_000) return "Yesterday";
  const d = new Date(t);
  return `${d.getDate()} ${d.toLocaleDateString(undefined, { month: "short" })}`;
}

/** The words a person sees before proving presence: the item and the destination, never a value. */
export function summaryFor(tool, input = {}, host = "this box") {
  const n = input.name ? `“${input.name}”` : "";
  const f = input.field === "totp" ? "one-time code" : input.field || "value";
  switch (tool) {
    case "vault.session.open": return "Unlock the Vault in this browser";
    case "vault.copy": return `Copy the ${f} of ${n} to the clipboard for 90 seconds`;
    case "vault.reveal": return `Show the ${f} of ${n} on this screen for 30 seconds`;
    case "vault.totp": return `Show the one-time code for ${n}`;
    case "vault.update": return `${input.kind ? "Save" : "Change"} ${n}${input.generate ? `, with a new ${input.generate.field} made on ${host}` : ""}`;
    case "vault.put": return `Save ${n}`;
    case "vault.delete": return `Delete ${n}`;
    case "vault.grant": return `Let ${input.module} use ${n}`;
    case "vault.approve": return "Approve what an agent asked for";
    case "vault.pass.create": return `Share ${(input.items || []).map(x => `“${x}”`).join(", ")} with ${input.holder}, ${input.mode || "relayed"}`;
    case "vault.offboard": return `Offboard ${input.person}: end every pass they hold`;
    case "vault.breach.check": return "Send the first 5 characters of each password's SHA-1 to api.pwnedpasswords.com";
    default: return tool;
  }
}
