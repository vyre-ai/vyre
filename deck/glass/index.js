// @ts-check
// Glass in the Deck (ADR 0005): an agent's computer or the box, with a Screen tab (watch, take
// over, sign in privately) and a Files tab. deck/views/glass.js loads this for /agents/:name/glass;
// :name "box" opens the box, which has files and no screen.
//
// Boards: GlassWatch, GlassTakeover, PhoneGlass. Below 600 px, or on a touch screen, the page
// lays out as PhoneGlass and this browser names itself phone:<id> to the box.

import { h, put, link } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { surfaceId, isPhone, errText, gicon } from "./util.js";
import { mountScreen } from "./watch.js";
import { mountFiles } from "./files.js";
import { healthDot } from "../js/health.js";

let styled = /** @type {Promise<void> | null} */ (null);
/** The Glass stylesheet, added once, before the first render. */
function style() {
  if (!styled) styled = new Promise(resolve => {
    const l = h("link", { rel: "stylesheet", href: new URL("./glass.css", import.meta.url).pathname });
    l.addEventListener("load", () => resolve());
    l.addEventListener("error", () => resolve());
    document.head.append(l);
  });
  return styled;
}

const STATE = { working: "working", idle: "idle", frozen: "resting", running: "running", starting: "starting", none: "no computer yet", stopped: "stopped" };

/** @param {any} ctx */
export default async function glass(ctx) {
  await style();
  if (!ctx.alive()) return;
  const raw = String(ctx.params.name || "");
  const box = raw === "box";
  const name = box ? "box" : raw;
  const target = box ? "box" : `computer:${name}`;
  const phone = isPhone();
  const surface = surfaceId();

  const t = await attempt("glass.targets");
  if (!ctx.alive()) return;
  const info = (t.data || []).find((/** @type {any} */ x) => x.target === target) || null;
  const hasScreen = !box && info?.screen !== false;
  const tabs = [
    ...(hasScreen ? [{ id: "screen", label: "Screen" }] : []),
    { id: "files", label: "Files" },
    ...(!box ? [{ id: "terminal", label: "Terminal", off: "Not in this version" }] : []),
  ];
  let tab = ctx.query.get("tab");
  if (!tabs.some(x => x.id === tab && !x.off)) tab = tabs[0].id;

  const title = box ? "The box" : `${name}'s computer`;
  const state = info ? (STATE[info.state] || info.state) : null;
  const sub = box ? "Files in the folders you chose for Glass. The box has no screen."
    : t.error ? errText(t.error) : !info ? `Glass does not know a computer for ${name}.` : null;
  const slot = h("div", { class: "gl-head-right" });
  const status = h("div", { class: "gl-phone-status" });
  const body = h("div", { class: "gl-body" });
  const seg = h("div", { class: "seg gl-tabs", role: "tablist", "aria-label": "Glass" });

  // How the box reaches this device, as a dot beside the title (asked on open, then once a minute while shown).
  const health = healthDot();
  ctx.cleanup(health.stop);

  const back = phone
    ? link(box ? "/now" : `/agents/${encodeURIComponent(name)}`, { class: "gl-back", "aria-label": box ? "Back to Now" : `Back to ${name}` },
      gicon("left", 22), h("span", null, box ? "Now" : "Back"))
    : null;

  put(ctx.root, h("div", { class: "gl" + (phone ? " gl-is-phone" : "") },
    phone
      ? h("header", { class: "gl-phead" }, back, h("div", { class: "gl-pname" }, h("span", { class: "mono" }, box ? "box" : name), health.el, h("span", { class: "gl-vr" }), status))
      : h("header", { class: "gl-head" },
        h("div", { class: "gl-title" },
          h("div", { class: "gl-title-row" }, h("h1", { class: "h3" }, title), state ? h("span", { class: "small faint" }, state) : null, health.el),
          sub ? h("div", { class: "small muted" }, sub) : h("div", { class: "small muted" }, "Only your tailnet can open this page. ",
            link(`/agents/${encodeURIComponent(name)}`, { class: "link quiet" }, `Back to ${name}`))),
        slot),
    seg,
    body));

  /** @type {{ unmount: () => void } | null} */ let current = null;
  function show(id) {
    tab = id;
    current?.unmount();
    current = null;
    put(seg, tabs.map(x => h("button", { type: "button", role: "tab", "aria-selected": String(x.id === tab), "aria-pressed": String(x.id === tab),
      disabled: !!x.off, title: x.off || undefined, onclick: () => { if (x.id !== tab) { show(x.id); remember(x.id); } } },
      x.label, x.off ? h("span", { class: "gl-tab-off" }, x.off) : null)));
    put(slot);
    put(status);
    body.className = "gl-body gl-body-" + id;
    if (id !== "screen") put(status, h("span", { class: "lbl" }, "Files"));
    if (id === "screen") current = mountScreen({ ctx, name, target, surface, info, phone, root: body, slot, status });
    else current = mountFiles({ ctx, root: body, target, name, phone });
  }
  /** The tab goes in the address (?tab=files), without a navigation. */
  function remember(id) {
    const u = new URL(location.href);
    if (id === tabs[0].id) u.searchParams.delete("tab"); else u.searchParams.set("tab", id);
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  }
  ctx.cleanup(() => { current?.unmount(); current = null; });
  show(tab);
}
