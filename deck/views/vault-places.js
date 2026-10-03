// @ts-check
// The Vault's pages that are not the item list: Watchtower, Passes (with what waits for you on
// top), Shared with you and Devices, and the share and offboard sheets.

import { h, put } from "../js/dom.js";
import { action } from "../js/empty-actions.js";
import { attempt } from "../js/api.js";
import { icon, kindIcon, tile, sheet, errText, toast, confirmButton, field } from "../vault/ui.js";
import { REASON, pickDevices, expiryWord } from "../vault/model.js";

// ---- Watchtower -------------------------------------------------------------------------------

/** @param {any} app @param {HTMLElement} body */
export async function watchtower(app, body) {
  const { st, ctx, vc } = app;
  put(body, h("div", { class: "empty" }, `Checking on ${app.host}.`));
  const r = await attempt("vault.health");
  if (!ctx.alive() || !body.isConnected) return;
  if (r.error) { put(body, h("div", { class: "empty" }, errText({ ...r.error, tool: "vault.health" }))); return; }
  st.health = r.data;
  app.drawRail();
  const items = Array.isArray(r.data?.items) ? r.data.items : [];
  const counts = r.data?.counts || {};
  const order = ["weak", "reused", "rotate", "old", "2fa-available", "unprotected"];
  const byName = new Map(st.items.map(i => [i.name, i]));
  const total = Number(r.data?.checked) || st.items.length;

  const summary = h("div", { class: "vt-wt-sum" },
    order.map(code => h("a", { href: `#wt-${code}`, class: "vt-wt-tile" + (counts[code] ? "" : " zero"),
      onclick: e => { e.preventDefault(); body.querySelector(`#wt-${code}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); } },
      h("span", { class: "vt-wt-n" }, String(counts[code] || 0)), h("span", { class: "lbl" }, REASON[code][0]))));

  const groups = order.filter(code => counts[code]).map(code => {
    const rows = items.filter(i => i.reasons.includes(code));
    const byGroup = code === "reused" ? groupBy(rows, i => i.group || "") : null;
    return h("section", { class: "vt-wt-g", id: `wt-${code}`, "aria-labelledby": `wt-${code}-h` },
      h("div", { class: "vt-shead" }, h("h2", { class: "lbl", id: `wt-${code}-h` }, `${REASON[code][0]} · ${rows.length}`)),
      h("p", { class: "vt-wt-why" }, REASON[code][1]),
      h("ul", { class: "vt-list", role: "list" }, (byGroup ? [...byGroup.values()].flat() : rows).map((i, n, all) => {
        const it = byName.get(i.name);
        const sameAs = byGroup ? (byGroup.get(i.group || "") || []).filter(x => x.name !== i.name).map(x => x.name) : [];
        const detail = code === "old" && it?.updated ? `Changed ${ago(it.updated)}`
          : code === "reused" ? `Same value as ${sameAs.join(", ")}`
          : code === "2fa-available" ? `${(it?.hosts[0] || "").replace(/^https?:\/\//, "")} offers codes`
          : it?.description || "";
        const fix = code === "2fa-available" ? "Add code" : code === "unprotected" ? null : "Replace";
        return h("li", { class: "vt-wt-row" + (byGroup && n > 0 && all[n - 1].group !== i.group ? " newgroup" : "") },
          h("span", { class: "vt-kicon" }, kindIcon(i.kind)),
          h("a", { class: "vt-wt-name link quiet", href: app.href("all", `?item=${encodeURIComponent(i.name)}`), onclick: e => { e.preventDefault(); app.goPlace("all"); app.open({ mode: "item", name: i.name }); } }, i.name),
          h("span", { class: "vt-wt-d ellipsis" }, detail),
          fix ? h("button", { type: "button", class: "btn btn-sm", onclick: () => { app.goPlace("all"); app.open({ mode: "edit", name: i.name }); } }, fix) : h("span"));
      })));
  });

  put(body,
    summary,
    items.length ? groups : h("div", { class: "empty" }, `Nothing to fix. ${total} item${total === 1 ? "" : "s"} checked on ${app.host}.`),
    breachBox(app));
}

function breachBox(app) {
  const { st, vc, ctx } = app;
  const out = h("div", { class: "vt-breach-out", role: "status" });
  const allowed = st.caps.breach === "ask" && vc.has("vault.breach.check");
  const run = h("button", { type: "button", class: "btn btn-primary", disabled: !allowed, onclick: async () => {
    run.setAttribute("disabled", "");
    put(out, h("p", { class: "vt-hint" }, "Asking api.pwnedpasswords.com."));
    const r = await vc.call("vault.breach.check", {});
    run.removeAttribute("disabled");
    if (!ctx.alive()) return;
    if (r.error) { put(out, h("p", { class: "vt-hint" }, r.error.code === "presence_refused" || r.error.code === "cancelled" ? "Not checked. Nothing was sent." : errText({ ...r.error, tool: "vault.breach.check" }))); return; }
    const hit = Array.isArray(r.data?.breached) ? r.data.breached.filter(n => typeof n === "string") : [];
    put(out, hit.length
      ? [h("p", { class: "small" }, `${hit.length} of ${r.data.checked} passwords appear in known breaches. Replace them.`),
         h("ul", { class: "vt-list", role: "list" }, hit.map(n => h("li", { class: "vt-wt-row" }, h("span", { class: "vt-kicon" }, icon("login")), h("span", { class: "vt-wt-name" }, n), h("span"),
           h("button", { type: "button", class: "btn btn-sm", onclick: () => { app.goPlace("all"); app.open({ mode: "edit", name: n }); } }, "Replace"))))]
      : h("p", { class: "small" }, `None of ${r.data?.checked ?? 0} passwords appear in known breaches.`));
  } }, "Check now");
  return h("section", { class: "vt-breach", "aria-labelledby": "vt-breach-h" },
    h("div", { class: "vt-breach-top" },
      h("div", { class: "vt-head-text" },
        h("h2", { class: "h3", id: "vt-breach-h" }, "Known breaches"),
        h("p", { class: "vt-lede" }, "A network call, and off unless you allow it. It sends the first 5 characters of each password's SHA-1 to api.pwnedpasswords.com, with padding, and compares the rest here. No password and no full hash leaves."),
        h("div", { class: "vt-callout mono" }, h("span", { class: "vt-chipx" }, app.host), h("span", { class: "faint" }, "sends"), h("span", { class: "vt-chipx" }, "5 hex chars"), icon("send", 12), h("span", { class: "vt-chipx" }, "api.pwnedpasswords.com"))),
      h("div", { style: { flexGrow: "1" } }), run),
    allowed ? null : h("p", { class: "vt-hint" }, st.caps.breach !== "ask" ? "Off. To allow it, set vault.breach to \"ask\" in config.json; every check still asks you first." : "Your server cannot check for breaches yet."),
    out);
}

// ---- Passes -------------------------------------------------------------------------------

/** @param {any} app @param {HTMLElement} body */
export function passesView(app, body) {
  const { st, vc, ctx } = app;
  const given = st.passes.filter(p => p.direction === "to");
  const heldFrom = st.passes.filter(p => p.direction === "from");
  const status = h("p", { class: "vt-hint", role: "status" });
  const waiting = st.pending.length ? h("section", { class: "vt-waiting held", "aria-labelledby": "vt-wait-h" },
    h("div", { class: "vt-wait-top" }, h("span", { class: "dot beacon" }), h("h2", { class: "lbl beacon", id: "vt-wait-h" }, `Waiting for you · ${st.pending.length}`)),
    h("ul", { class: "vt-list", role: "list" }, st.pending.map(x => h("li", { class: "vt-wait-row" },
      h("span", { class: "vt-wait-t" }, x.kind === "grant"
        ? [h("b", null, whoAsked(x.by)), ` asked to let ${x.module}${x.watcher ? `/${x.watcher}` : ""} use `, h("b", null, x.name)]
        : [h("b", null, whoAsked(x.by)), ` asked to share ${x.items.join(", ")} with `, h("span", { class: "mono" }, x.holder), `, ${x.mode}`]),
      h("span", { class: "vt-wait-acts" },
        h("button", { type: "button", class: "btn btn-sm", onclick: async () => {
          const r = await vc.call("vault.approve", { id: x.id });
          if (!ctx.alive()) return;
          put(status, r.error ? errText({ ...r.error, tool: "vault.approve" }) : "Approved.");
          if (!r.error) app.load();
        } }, "Approve"),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: async () => {
          const r = x.kind === "grant" ? await vc.call("vault.revoke", { name: x.name, module: x.module, ...(x.watcher ? { watcher: x.watcher } : {}) }) : await vc.call("vault.pass.revoke", { id: x.id });
          if (!ctx.alive()) return;
          put(status, r.error ? errText(r.error) : "Denied. Nothing was shared.");
          if (!r.error) app.load();
        } }, "Deny")))))) : null;

  const sel = given.find(p => p.state === "active") || given[0] || heldFrom[0];
  put(body,
    waiting, status,
    h("section", { class: "vt-passes", "aria-label": "Passes" },
      h("div", { class: "vt-phead" },
        h("div", { class: "vt-head-text" },
          h("p", { class: "vt-plede" }, "Their Vyre asks yours, yours makes the call:"),
          sel ? flow(app, sel) : null),
        h("div", { style: { flexGrow: "1" } }),
        h("div", { class: "vt-pacts2" },
          h("button", { type: "button", class: "btn btn-ghost", onclick: () => app.offboard() }, "Offboard a person"),
          h("button", { type: "button", class: "btn", onclick: () => app.share([]), disabled: !st.items.length }, icon("pass", 14), "New pass"))),
      st.passErr ? h("div", { class: "empty" }, errText(st.passErr))
        : !given.length && !heldFrom.length ? h("div", { class: "empty" }, "No passes. Nobody else's Vyre can use anything here.",
          st.items.length ? action("New pass", () => app.share([])) : null)
        : h("ul", { class: "vt-list", role: "list" }, [...given, ...heldFrom].map(p => passRow(app, p)))));
}

const whoAsked = by => (String(by).includes("agent:") ? String(by).split("agent:")[1] : String(by).startsWith("mcp") ? "Claude" : String(by) || "An agent");

function flow(app, p) {
  const itemHost = app.st.items.find(i => p.items.includes(i.name))?.hosts[0] || "";
  const service = p.service || (p.hosts[0] || itemHost).replace(/^https?:\/\//, "") || p.items[0] || "the service";
  const me = app.st.onTailnet ? location.hostname : app.host;
  const [asker, caller] = p.direction === "to" ? [p.holder, me] : [me, p.holder];
  const mine = caller === me;
  return h("div", { class: "vt-flow", role: "img", "aria-label": `${asker} asks ${caller}, which calls ${service}` },
    h("span", { class: "vt-chipx" + (mine ? "" : " on") }, mine ? null : icon("lock", 11), asker),
    h("span", { class: "faint" }, "asks"), icon("send", 12),
    h("span", { class: "vt-chipx" + (mine ? " on" : "") }, mine ? icon("lock", 11) : null, caller),
    h("span", { class: "faint" }, "calls"), icon("send", 12),
    h("span", { class: "vt-chipx" }, service));
}

function passRow(app, p) {
  const { vc, ctx } = app;
  const status = h("span", { class: "vt-pstatus", role: "status" });
  const act = p.direction === "from" ? "Remove" : p.state === "waiting" ? "Cancel" : "Revoke";
  const btn = confirmButton(act, p.mode === "sealed" && act === "Revoke" ? "Revoke, then rotate" : act === "Revoke" ? "Revoke now" : `${act} it`, "btn btn-ghost btn-sm vt-pbtn", async () => {
    const r = await vc.call("vault.pass.revoke", { id: p.id });
    if (!ctx.alive()) return;
    if (r.error) { put(status, errText(r.error)); return; }
    const rot = Array.isArray(r.data?.rotate) ? r.data.rotate.filter(n => typeof n === "string") : [];
    toast({ text: rot.length ? `Ended. Replace ${rot.join(", ")}: they kept a sealed copy.` : `Ended. ${p.holder} cannot use it any more.` });
    app.load();
  });
  return h("li", { class: "vt-pgrid vt-prow" },
    h("span", { class: "lbl" }, p.direction === "to" ? "To" : "From"),
    h("span", { class: "vt-pwho" }, h("span", { class: "mono vt-addr ellipsis" }, p.holder), p.person ? h("span", { class: "vt-sub ellipsis" }, p.person) : null),
    h("span", { class: "vt-pitem" }, h("span", { class: "ellipsis" }, p.items.join(", ")), p.scope ? h("span", { class: "vt-sub ellipsis" }, p.scope) : null),
    h("span", null, h("span", { class: "vt-mode" }, p.state === "waiting" ? "Waiting" : p.mode === "sealed" ? "Sealed" : "Relayed")),
    h("span", { class: "vt-exp" }, expiryWord(p.expires)),
    h("span", { class: "vt-pact" }, btn, status));
}

/** @param {any} app @param {HTMLElement} body */
export function sharedView(app, body) {
  const held = app.st.passes.filter(p => p.direction === "from");
  put(body, !held.length ? h("div", { class: "empty" }, "Nobody has shared anything with you. When someone does, paste their ticket with vyre vault pass accept.")
    : h("ul", { class: "vt-list", role: "list" }, held.map(p => passRow(app, p))),
    h("p", { class: "vt-hint vt-under" }, "Your agents use these with vault.relay. Their box adds the value; it never reaches yours."));
}

/** @param {any} app @param {HTMLElement} body */
export async function devicesView(app, body) {
  const { vc, ctx } = app;
  put(body, h("div", { class: "empty" }, "Loading devices."));
  const r = await attempt("vault.devices");
  if (!ctx.alive() || !body.isConnected) return;
  if (r.error) { put(body, h("div", { class: "empty" }, errText({ ...r.error, tool: "vault.devices" }))); return; }
  const list = pickDevices(r.data);
  put(body,
    !list.length ? h("div", { class: "empty" }, "No browser is paired for autofill. Pair one from the extension; vyre vault pair shows the code.")
      : h("ul", { class: "vt-list", role: "list" }, list.map(d => h("li", { class: "vt-dev" + (d.revoked ? " off" : "") },
        h("span", { class: "vt-kicon" }, icon("laptop")),
        h("span", { class: "vt-dev-n" }, h("span", null, d.name), h("span", { class: "vt-sub" }, d.revoked ? `Revoked ${ago(d.revoked)}` : `Paired ${ago(d.created)} · last seen ${ago(d.lastSeen)}`)),
        h("span", { class: "vt-sub" }, d.revoked ? "" : d.sessions ? `${d.sessions} open session${d.sessions === 1 ? "" : "s"}` : "Locked"),
        d.revoked ? h("span") : confirmButton("Revoke", "Revoke now", "btn btn-ghost btn-sm", async () => {
          const x = await vc.call("vault.device.revoke", { id: d.id });
          if (!ctx.alive()) return;
          toast({ text: x.error ? errText(x.error) : `${d.name} can no longer fill. Its sessions ended.` });
          devicesView(app, body);
        })))),
    h("p", { class: "vt-hint vt-under" }, "A paired browser fills only on pages whose origin matches an item, and only while unlocked."));
}

// ---- the share sheet ----------------------------------------------------------------------

/** @param {any} app @param {string[]} preset */
export function shareSheet(app, preset) {
  const { st, vc, ctx } = app;
  let mode = "relayed";
  const chosen = new Set(preset);
  const people = [...new Map(st.passes.map(p => [p.holder, p.person])).keys()].filter(Boolean);
  const status = h("p", { class: "vt-status", role: "status" });
  const whoIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input", id: "vt-s-who", autocomplete: "off", spellcheck: "false", placeholder: "dana", list: "vt-s-people" }));
  const cardIn = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input mono vt-cardin", id: "vt-s-card", rows: "2", spellcheck: "false", placeholder: "vyre-card:…" }));
  const noteIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input", id: "vt-s-note", autocomplete: "off", placeholder: "Read the Reports folder" }));
  const expSel = /** @type {HTMLSelectElement} */ (h("select", { class: "input", id: "vt-s-exp" }, [["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"], ["365d", "A year"]].map(([v, l]) => h("option", { value: v, selected: v === "30d" }, l))));
  const itemsBox = h("div", { class: "vt-checks" });
  const hostsBox = h("div", { class: "vt-checks" });
  const modeSeg = h("div", { class: "seg", role: "group", "aria-label": "How" });
  const modeNote = h("div", { class: "vt-mode-note" });
  const hostsField = h("div", { class: "vt-field" }, h("span", { class: "lbl" }, "Hosts it may call"), hostsBox);
  const offHosts = new Set();

  const live = st.items.filter(i => i.state === "live");
  const drawItems = () => put(itemsBox, [...live.filter(i => chosen.has(i.name)), ...live.filter(i => !chosen.has(i.name))].map(i => h("label", { class: "vt-check" },
    h("input", { type: "checkbox", checked: chosen.has(i.name), onchange: e => { if (e.target.checked) chosen.add(i.name); else chosen.delete(i.name); drawHosts(); drawMode(); } }),
    h("span", { class: "vt-kicon" }, kindIcon(i.kind)), h("span", { class: "ellipsis" }, i.name), h("span", { class: "vt-sub" }, i.kindLabel))));
  const drawHosts = () => {
    const hosts = [...new Set(st.items.filter(i => chosen.has(i.name)).flatMap(i => i.hosts))];
    put(hostsBox, hosts.length ? hosts.map(x => h("label", { class: "vt-check" }, h("input", { type: "checkbox", checked: !offHosts.has(x), onchange: e => { if (e.target.checked) offHosts.delete(x); else offHosts.add(x); } }), h("span", { class: "mono" }, x.replace(/^https:\/\//, ""))))
      : h("span", { class: "vt-hint" }, "The chosen items have no hosts, so they can only be shared sealed."));
  };
  const drawMode = () => {
    put(modeSeg, [["relayed", "Relayed"], ["sealed", "Sealed"]].map(([m, l]) => h("button", { type: "button", "aria-pressed": m === mode ? "true" : "false", onclick: () => { mode = m; drawMode(); } }, l)));
    const who = whoIn.value.trim() || "their Vyre";
    put(modeNote, mode === "relayed"
      ? [h("div", { class: "vt-flow", role: "img", "aria-label": `${who} asks ${app.host}, which makes the call` },
          h("span", { class: "vt-chipx" }, who), h("span", { class: "faint" }, "asks"), icon("send", 12),
          h("span", { class: "vt-chipx on" }, icon("lock", 11), app.host), h("span", { class: "faint" }, "calls"), icon("send", 12),
          h("span", { class: "vt-chipx" }, (st.items.filter(i => chosen.has(i.name)).flatMap(i => i.hosts).find(x => !offHosts.has(x)) || "the host").replace(/^https?:\/\//, ""))),
         h("p", { class: "vt-hint" }, `The value never leaves ${app.host}. Revoking ends it at once.`)]
      : h("p", { class: "vt-warn" }, h("b", null, "Revoking means rotating. "), "An encrypted copy goes to their Vyre and stays there. To take it back you must replace the value."));
    hostsField.hidden = mode !== "relayed";
  };
  whoIn.addEventListener("input", drawMode);
  drawItems(); drawHosts(); drawMode();

  const s = sheet({ label: "Share", title: preset.length === 1 ? `Share ${preset[0]}` : "New pass", wide: true, body: [
    h("form", { class: "vt-form vt-share", autocomplete: "off", onsubmit: async e => {
      e.preventDefault();
      const holder = whoIn.value.trim();
      if (!holder) { put(status, "Say who it is for."); return; }
      if (!chosen.size) { put(status, "Choose at least one item."); return; }
      const hosts = [...new Set(st.items.filter(i => chosen.has(i.name)).flatMap(i => i.hosts))];
      const narrowed = hosts.filter(x => !offHosts.has(x));
      const input = { holder, items: [...chosen], mode, expires: expSel.value,
        ...(cardIn.value.trim() ? { card: cardIn.value.trim() } : {}), ...(noteIn.value.trim() ? { note: noteIn.value.trim() } : {}),
        ...(mode === "relayed" && offHosts.size && narrowed.length ? { hosts: narrowed } : {}) };
      const r = await vc.call("vault.pass.create", input);
      if (!ctx.alive()) return;
      if (r.error) { put(status, r.error.code === "presence_refused" || r.error.code === "cancelled" ? "Not shared." : errText({ ...r.error, tool: "vault.pass.create" })); return; }
      const ticket = typeof r.data?.ticket === "string" ? r.data.ticket : "";
      put(s.el.querySelector(".vt-share"), ticket
        ? [h("p", { class: "small" }, `Made a pass for ${holder}. Send them this ticket; it names the items and holds no value${mode === "sealed" ? " they can open without their own key" : ""}.`),
           h("textarea", { class: "input mono vt-ticket", rows: "4", readonly: true, "aria-label": "Ticket" }, ticket),
           h("div", { class: "vt-form-acts" }, h("button", { type: "button", class: "btn", onclick: async () => { try { await navigator.clipboard.writeText(ticket); toast({ text: "Ticket copied." }); } catch { toast({ text: "Select the ticket and copy it." }); } } }, icon("copy", 13), "Copy ticket"),
             h("button", { type: "button", class: "btn btn-ghost", onclick: s.close }, "Done"))]
        : [h("p", { class: "small" }, r.data?.pass?.status === "pending" ? `Asked. The pass to ${holder} waits for approval.` : `Made a pass for ${holder}.`),
           h("div", { class: "vt-form-acts" }, h("button", { type: "button", class: "btn btn-ghost", onclick: s.close }, "Done"))]);
      app.load();
    } },
      h("div", { class: "vt-two" },
        field("To", whoIn, people.length ? `Known: ${people.join(", ")}` : "A name for the person."),
        field("Ends", expSel)),
      h("datalist", { id: "vt-s-people" }, people.map(p => h("option", { value: p }))),
      field("Their card", cardIn, "From their vyre vault card. Needed the first time; a changed card must be confirmed."),
      h("div", { class: "vt-field" }, h("span", { class: "lbl" }, "Items"), itemsBox),
      h("div", { class: "vt-field" }, h("span", { class: "lbl" }, "How"), modeSeg, modeNote),
      hostsField,
      field("Note", noteIn, "What they may do with it. They see this."),
      h("div", { class: "vt-form-acts" }, h("button", { type: "submit", class: "btn btn-primary" }, icon("pass", 14), "Share"), h("button", { type: "button", class: "btn btn-ghost", onclick: () => s.close() }, "Cancel")),
      status)] });
  return s;
}

/** @param {any} app */
export function offboardSheet(app) {
  const { st, vc, ctx } = app;
  const people = [...new Map(st.passes.filter(p => p.direction === "to").map(p => [p.holder, p.person])).entries()];
  const out = h("div", { class: "vt-off-out", role: "status" });
  const whoIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "input", id: "vt-o-who", autocomplete: "off", spellcheck: "false", placeholder: "theo" }));
  const go = confirmButton("Offboard", "Offboard now", "btn", async () => {
    const person = whoIn.value.trim();
    if (!person) { put(out, h("p", { class: "vt-hint" }, "Say who left.")); return; }
    const r = await vc.call("vault.offboard", { person });
    if (!ctx.alive()) return;
    if (r.error) { put(out, h("p", { class: "vt-hint" }, errText({ ...r.error, tool: "vault.offboard" }))); return; }
    const ended = Array.isArray(r.data?.revoked) ? r.data.revoked.length : 0;
    const rot = Array.isArray(r.data?.rotate) ? r.data.rotate.filter(n => typeof n === "string") : [];
    put(out,
      h("p", { class: "small" }, `${person} holds nothing here now. Ended ${ended} pass${ended === 1 ? "" : "es"}.`),
      rot.length ? [h("div", { class: "lbl" }, "Rotate these"),
        h("ul", { class: "vt-hlist", role: "list" }, rot.map(n => h("li", { class: "vt-hrow" }, h("span", { class: "vt-hicon" }, icon("key", 14)), h("span", null, n),
          h("button", { type: "button", class: "btn btn-sm vt-x", onclick: () => { s.close(); app.goPlace("all"); app.open({ mode: "edit", name: n }); } }, "Replace")))),
        h("p", { class: "vt-hint" }, "They had a sealed copy of each. Replace each value to finish.")]
        : h("p", { class: "vt-hint" }, "Nothing to rotate. Every pass they held was relayed."));
    app.load();
  });
  const s = sheet({ label: "Someone left", title: "Offboard a person", body: [h("div", { class: "vt-form" },
    h("p", { class: "vt-sheet-p" }, "Ends every pass a person holds, forgets their card, and lists what must be rotated. One action, and it cannot be undone."),
    field("Who left", whoIn),
    people.length ? h("div", { class: "vt-people" }, people.map(([a, n]) => h("button", { type: "button", class: "vt-pick", onclick: () => { whoIn.value = a; } }, tile(a), h("span", { class: "mono" }, a), n ? h("span", { class: "vt-sub" }, n) : null))) : null,
    h("div", { class: "vt-form-acts" }, go, h("button", { type: "button", class: "btn btn-ghost", onclick: () => s.close() }, "Cancel")),
    out)] });
}

// ---- helpers ------------------------------------------------------------------------------

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}
function ago(t) {
  if (!t) return "never";
  const d = Math.round((Date.now() - t) / 86400_000);
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 60) return `${d} days ago`;
  if (d < 730) return `${Math.round(d / 30)} months ago`;
  return `${Math.round(d / 365)} years ago`;
}
