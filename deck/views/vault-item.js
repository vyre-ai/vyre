// @ts-check
// The item pane (board: DeckVault's aside, 400px on Carbon; a full-screen sheet on a phone).
//
// Every field is twelve dots whatever its length. Copy asks vyred to write the clipboard and gets
// back only when it clears. Reveal, when vyred allows it, puts the value in one text node and
// takes it out again after 30 seconds, when the window loses focus, when the tab hides, and when
// the pane changes. A TOTP code is shown only while the Vault is unlocked.

import { h, put } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { clock, startOfToday } from "../js/fmt.js";
import { icon, tile, DOTS, everySecond, errText, toast } from "../vault/ui.js";
import { pickUsage, whoWord, USES, expiryWord } from "../vault/model.js";

const REVEAL_MS = 30_000;
const ORDER = { login: ["username", "password"], card: ["name", "number", "expiry", "cvc"], "api-key": ["value"], secret: ["value"], note: ["text"] };
const LABEL = { username: "Username", password: "Password", number: "Number", expiry: "Expiry", cvc: "Security code", name: "Cardholder", value: "Value", text: "Note", public: "Public key", private: "Private key" };
const ACTION = { release: "used it", inject: "ran a command with it", relay: "made a relayed call", fill: "filled it", totp: "made a code", copy: "copied it", reveal: "showed it", add: "added it", change: "changed it" };

/**
 * @param {any} app @param {HTMLElement} panel @param {string} name @param {boolean} focus
 */
export function itemPane(app, panel, name, focus) {
  const { st, vc, ctx } = app;
  const it = st.items.find(i => i.name === name);
  const top = h("div", { class: "vt-ptop" },
    h("button", { type: "button", class: "btn btn-ghost vt-back", onclick: app.close }, icon("back", 14), "Vault"),
    h("span", { class: "lbl" }, it ? it.kindLabel : "Item"),
    h("button", { type: "button", class: "ibtn vt-closex", "aria-label": "Close panel", onclick: app.close }, icon("close", 13)));
  const h2 = h("h2", { class: "vt-ptitle", tabindex: "-1", id: "vt-panel-h" }, name);
  panel.setAttribute("aria-labelledby", "vt-panel-h");
  if (!it) {
    put(panel, top, h2, h("div", { class: "empty" }, st.listErr ? errText(st.listErr) : `There is no item called ${name}.`));
    return;
  }

  // ---- fields ----
  const order = ORDER[it.kind] || [];
  const names = [...order.filter(f => it.fields.includes(f)), ...it.fields.filter(f => !order.includes(f) && f !== "totp")];
  const canReveal = st.caps.reveal && vc.has("vault.reveal");
  const canCopy = vc.has("vault.copy");
  /** @type {(() => void) | null} */ let conceal = null;
  const hideNow = () => { if (conceal) conceal(); };
  const onBlur = () => hideNow();
  const onHide = () => { if (document.visibilityState !== "visible") hideNow(); };
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onHide);
  app.onPane(() => { hideNow(); window.removeEventListener("blur", onBlur); document.removeEventListener("visibilitychange", onHide); });
  ctx.cleanup(hideNow);

  const fieldRow = f => {
    const val = h("span", { class: "vt-val", "aria-label": `${LABEL[f] || f}, hidden` }, DOTS);
    const revealBtn = canReveal ? h("button", { type: "button", class: "ibtn vt-fbtn", "aria-label": `Reveal ${LABEL[f] || f}`, "aria-pressed": "false", onclick: async () => {
      if (conceal) { const was = val.dataset.shown === "1"; hideNow(); if (was) return; }
      const r = await vc.call("vault.reveal", { name: it.name, field: f });
      if (!ctx.alive() || !val.isConnected) return;
      if (r.error) { toast({ text: r.error.code === "presence_refused" || r.error.code === "cancelled" ? "Not shown." : errText({ ...r.error, tool: "vault.reveal" }) }); return; }
      if (typeof r.data?.value !== "string") return;
      // One text node, no copy kept in a variable past this line.
      put(val, document.createTextNode(r.data.value));
      r.data.value = "";
      val.dataset.shown = "1";
      val.classList.add("shown");
      val.setAttribute("aria-label", `${LABEL[f] || f}, shown for 30 seconds`);
      revealBtn?.setAttribute("aria-pressed", "true");
      const t = window.setTimeout(hideNow, REVEAL_MS);
      conceal = () => { clearTimeout(t); put(val, DOTS); delete val.dataset.shown; val.classList.remove("shown"); val.setAttribute("aria-label", `${LABEL[f] || f}, hidden`); revealBtn?.setAttribute("aria-pressed", "false"); conceal = null; };
    } }, icon("eye", 14)) : null;
    return h("div", { class: "vt-frow" },
      h("span", { class: "lbl vt-flabel" }, LABEL[f] || f),
      val,
      h("span", { class: "vt-facts" }, revealBtn,
        h("button", { type: "button", class: "ibtn vt-fbtn", "aria-label": `Copy ${LABEL[f] || f}`, title: canCopy ? `Copy ${LABEL[f] || f}` : "Your server cannot copy yet", disabled: !canCopy,
          onclick: () => app.copy(it, f, (LABEL[f] || f).toLowerCase()) }, icon("copy", 14))));
  };

  // ---- TOTP: a 20px ring, and the code only while unlocked ----
  let totpRow = null;
  if (it.fields.includes("totp")) {
    const R = 8, C = 2 * Math.PI * R;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    for (const [k, v] of Object.entries({ width: "20", height: "20", viewBox: "0 0 20 20", "aria-hidden": "true", class: "vt-ring" })) svg.setAttribute(k, v);
    const track = document.createElementNS(ns, "circle"), arc = document.createElementNS(ns, "circle");
    for (const c of [track, arc]) for (const [k, v] of Object.entries({ cx: "10", cy: "10", r: String(R), fill: "none", "stroke-width": "2" })) c.setAttribute(k, v);
    track.setAttribute("class", "vt-ring-track"); arc.setAttribute("class", "vt-ring-arc");
    arc.setAttribute("stroke-dasharray", String(C)); arc.setAttribute("transform", "rotate(-90 10 10)");
    svg.append(track, arc);
    const code = h("span", { class: "vt-code" });
    const secs = h("span", { class: "vt-secs" });
    let shown = "", period = -1, fetching = false;
    const show = async () => {
      if (!vc.current() || !vc.has("vault.totp")) {
        shown = "";
        put(code, h("span", { class: "vt-code-lock" }, !vc.has("vault.session.open") ? "Codes show here once the Deck can unlock" : "Unlock to see the code"));
        return;
      }
      if (fetching) return;
      fetching = true;
      const r = await vc.call("vault.totp", { name: it.name });
      fetching = false;
      if (!ctx.alive() || !code.isConnected) return;
      if (r.error) { put(code, h("span", { class: "vt-code-lock" }, r.error.code === "denied" ? "Your server does not give codes to the Deck yet" : errText(r.error))); return; }
      const c = String(r.data?.code || "");
      shown = c.length === 6 ? c.slice(0, 3) + " " + c.slice(3) : c;
      put(code, shown);
    };
    app.onPane(everySecond(now => {
      const left = 30 - Math.floor(now / 1000) % 30;
      arc.setAttribute("stroke-dashoffset", String(C * (1 - left / 30)));
      put(secs, `${left}s`);
      const p = Math.floor(now / 30_000);
      if (p !== period) { period = p; show(); }
    }));
    app.onPane(vc.watch(() => { period = -1; }));
    totpRow = h("div", { class: "vt-frow vt-totp" },
      h("span", { class: "lbl vt-flabel" }, "Code"),
      h("span", { class: "vt-val vt-totp-val" }, svg, code, h("span", { class: "vt-secs-w" }, secs)),
      h("span", { class: "vt-facts" }, h("button", { type: "button", class: "ibtn vt-fbtn", "aria-label": "Copy one-time code", disabled: !canCopy,
        title: canCopy ? "Copy the code" : "Your server cannot copy yet", onclick: () => app.copy(it, "totp", "one-time code") }, icon("copy", 14))));
  }

  const set = it.updated ? `Set ${day(it.updated)}${it.set_by ? ` by ${it.set_by}` : ""}` : "";
  const sealed = h("div", { class: "vt-sealed" },
    h("div", { class: "vt-sealed-top" }, icon("lock", 14), h("span", { class: "vt-sealed-l" }, "Sealed"), set ? h("span", { class: "vt-set" }, set) : null),
    h("div", { class: "vt-fields" }, names.map(fieldRow), totpRow),
    h("p", { class: "vt-sealed-p" }, canReveal
      ? `Values stay sealed on ${app.host}. Copy puts one on the clipboard for 90 seconds; Reveal shows it here for 30.`
      : `Values stay sealed on ${app.host}. Copy puts one on the clipboard for 90 seconds without it entering this page.`),
    it.rotate ? h("p", { class: "vt-hint" }, "Marked to rotate: a sealed copy left your server. Replace the value to clear it.") : null);

  // ---- head actions ----
  const favOn = st.fav.has(it.name);
  const acts = h("div", { class: "vt-pacts" },
    // An API credential is never read back, so it cannot be edited: its key is replaced, and everything else about it stays.
    it.kind === "api-credential"
      ? h("button", { type: "button", class: "btn btn-sm", onclick: () => app.open({ mode: "replace", name: it.name }) }, icon("edit", 13), "Replace the key")
      : h("button", { type: "button", class: "btn btn-sm", onclick: () => app.open({ mode: "edit", name: it.name }) }, icon("edit", 13), "Edit"),
    h("button", { type: "button", class: "btn btn-sm", onclick: () => app.share([it.name]) }, icon("pass", 13), "Share"),
    h("button", { type: "button", class: "ibtn", "aria-pressed": favOn ? "true" : "false", "aria-label": favOn ? "Remove from favorites" : "Add to favorites", onclick: () => app.favorite(it.name) }, icon(favOn ? "starOn" : "star", 15)));

  // ---- held by ----
  const heldStatus = h("p", { class: "vt-hint", role: "status" });
  const picker = h("div", { class: "vt-picker", hidden: true });
  const addHolder = h("button", { type: "button", class: "btn btn-ghost vt-add", "aria-expanded": "false", onclick: async () => {
    const on = picker.hidden;
    picker.hidden = !on;
    addHolder.setAttribute("aria-expanded", String(on));
    if (!on) return;
    put(picker, h("div", { class: "vt-hint" }, "Loading modules"));
    const mods = (await app.modules()).filter(m => m.state === "running" && !["vault", "presence"].includes(m.name) && !it.holders.some(g => g.module === m.name));
    if (!ctx.alive()) return;
    put(picker, mods.length ? [h("div", { class: "lbl" }, "Let a module use it"), mods.map(m => h("button", { type: "button", class: "vt-pick", onclick: async () => {
      const r = await vc.call("vault.grant", { name: it.name, module: m.name });
      if (!ctx.alive()) return;
      picker.hidden = true;
      put(heldStatus, r.error ? errText({ ...r.error, tool: "vault.grant" }) : r.data?.grant?.status === "pending" ? `Asked. ${m.name} can use it once you approve.` : `${m.name} can use it now.`);
      if (!r.error) app.load();
    } }, tile(m.name), h("span", null, m.name)))] : h("div", { class: "vt-hint" }, "No other module is running."));
  } }, icon("plus", 12), "Add");
  const passHolders = st.passes.filter(p => p.direction === "to" && p.items.includes(it.name));
  const holders = [
    ...it.holders.filter(g => !g.pass).map(g => h("li", { class: "vt-hrow" }, tile(g.agent || g.module), h("span", { class: "vt-hname" }, g.agent || g.module),
      g.watcher ? h("span", { class: "vt-sub ellipsis" }, `watcher ${g.watcher}`) : g.scope ? h("span", { class: "vt-sub ellipsis" }, g.scope) : null,
      h("button", { type: "button", class: "ibtn vt-x", "aria-label": `Take it away from ${g.agent || g.module}`, onclick: async () => {
        const r = await vc.call("vault.revoke", { name: it.name, module: g.module || "agents", ...(g.watcher ? { watcher: g.watcher } : {}) });
        if (!ctx.alive()) return;
        put(heldStatus, r.error ? errText(r.error) : `${g.agent || g.module} can no longer use it.`);
        if (!r.error) app.load();
      } }, icon("close", 11)))),
    ...passHolders.map(p => h("li", { class: "vt-hrow" }, h("span", { class: "vt-hicon" }, icon("pass", 16)), h("span", { class: "mono vt-addr" }, p.holder),
      h("span", { class: "vt-sub" }, `by pass, ${p.state === "waiting" ? "waiting" : p.mode}`), h("span", { class: "vt-sub vt-hexp" }, expiryWord(p.expires)))),
  ];

  // ---- used today, and history ----
  const used = h("ul", { class: "vt-used-list", role: "list" }, h("li", { class: "vt-urow vt-hint" }, "Loading"));
  const history = vc.has("vault.history") ? h("section", { class: "vt-history" }) : null;

  put(panel, top, h2,
    it.description ? h("p", { class: "vt-desc" }, it.description) : null,
    it.hosts.length ? h("p", { class: "vt-hosts mono" }, it.hosts.map(x => x.replace(/^https:\/\//, "")).join("  ")) : null,
    acts, sealed,
    h("div", { class: "vt-shead" }, h("h3", { class: "lbl" }, "Held by"), addHolder),
    picker,
    holders.length ? h("ul", { class: "vt-hlist", role: "list" }, holders) : h("p", { class: "vt-none" }, "Nobody holds it. No agent can use it until you add one."),
    heldStatus,
    h("div", { class: "vt-shead" }, h("h3", { class: "lbl" }, "Used today")),
    used,
    history,
    h("div", { style: { flexGrow: "1" } }),
    h("p", { class: "vt-foot" }, st.onTailnet ? "Only your tailnet can open this page." : "Only this machine can open this page."));
  if (focus) h2.focus({ preventScroll: true });
  drawUsage(app, used, it.name);
  if (history) drawHistory(app, history, it.name);
}

async function drawUsage(app, el, name) {
  // vault.audit is the item's use and grant trail (there is no vault.usage; asking for it was a 404).
  const r = await attempt("vault.audit", { name, limit: 100 });
  if (!app.ctx.alive() || !el.isConnected) return;
  if (r.error) { put(el, h("li", { class: "vt-urow vt-hint" }, errText(r.error))); return; }
  const t0 = startOfToday();
  const rows = pickUsage(r.data).filter(u => u.at >= t0 && (!u.action || USES.includes(u.action) || u.agent || u.pass)).sort((a, b) => b.at - a.at).slice(0, 8);
  if (!rows.length) { put(el, h("li", { class: "vt-urow vt-hint" }, "Nobody used it today.")); return; }
  put(el, rows.map(u => {
    const byPass = Boolean(u.pass) || u.who.startsWith("pass:");
    const who = u.agent || u.pass || whoWord(u.who);
    return h("li", { class: "vt-urow" },
      byPass ? h("span", { class: "vt-hicon" }, icon("pass", 16)) : tile(who, 20),
      h("span", { class: "vt-utext" }, `${who} ${ACTION[u.action] || u.action}`, u.project ? h("span", { class: "faint" }, ` for ${u.project}`) : null,
        u.pass ? h("span", { class: "faint" }, ` relayed by ${u.relayed_by || app.host}`) : null),
      h("span", { class: "vt-ut" }, clock(u.at)));
  }));
}

async function drawHistory(app, el, name) {
  const r = await app.vc.call("vault.history", { name });
  if (!app.ctx.alive() || !el.isConnected) return;
  if (r.error) { el.remove(); return; }
  const versions = (Array.isArray(r.data?.versions) ? r.data.versions : []).filter(v => v && typeof v.at === "number");
  const pw = (Array.isArray(r.data?.passwords) ? r.data.passwords : []).filter(v => v && typeof v.at === "number");
  if (!versions.length && !pw.length) { el.remove(); return; }
  put(el,
    h("div", { class: "vt-shead" }, h("h3", { class: "lbl" }, "History")),
    h("ul", { class: "vt-used-list", role: "list" }, versions.slice(0, 6).map(v => h("li", { class: "vt-urow" },
      h("span", { class: "vt-ver mono" }, `v${Number(v.ver) || "?"}`),
      h("span", { class: "vt-utext" }, Array.isArray(v.fields) && v.fields.length ? `Changed ${v.fields.filter(x => typeof x === "string").join(", ")}` : Number(v.ver) === 1 ? "Added" : "Changed",
        typeof v.by === "string" && v.by ? h("span", { class: "faint" }, ` · ${whoWord(v.by)}`) : null),
      h("span", { class: "vt-ut" }, day(v.at))))),
    pw.length ? h("p", { class: "vt-hint vt-pwhist" }, `${pw.length} earlier password${pw.length === 1 ? "" : "s"}, the last replaced ${day(Math.max(...pw.map(p => p.at)))}. Kept sealed, never shown.`) : null);
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function day(t) { const d = new Date(t); return `${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : ""}`; }
