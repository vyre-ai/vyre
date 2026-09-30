// @ts-check
// The artifact card and its viewer (docs/design/system/components/artifact-card.md): something an
// agent made that lives on the box, versioned. Three parts here:
//   - the chat card (artifactCard): a 56 px row, kind glyph, title, "kind · vN · made by <agent> ·
//     <time>", Open and Share. Drawn for a tool block's `render: { kind: "artifact", ... }` and
//     for the session event thread.artifact { thread, artifact, version, kind, title } through
//     artifactFromEvent().
//   - the viewer (artifactView, openArtifact, artifactScreen): a version bar, the content, and a
//     Changes view that is diff.md's own unified diff between two versions. A side panel on a
//     desktop, a full-screen sheet on a phone, a plain screen at /a/<id>.
//   - the route (artifactHref, parseArtifactRoute).
//
// Content comes from the artifacts tools, named once in TOOLS. Their module may not be on a box
// yet, so a missing tool ends in a plain line, never an error code. Documents and reports are drawn
// natively by lib/markdown.js (no styling from the artifact); every other kind is shown by the
// artifacts render route inside the sandboxed frame in artifact-frame.js.

import { h, put, isPhone } from "../../js/dom.js";
import { attempt, queued } from "../../js/api.js";
import { icon } from "../../js/icons.js";
import { since } from "../../js/fmt.js";
import { openSheet } from "../../js/sheet.js";
import { renderMarkdown } from "../lib/markdown.js";
import { renderUnified } from "../lib/diff.js";
import { ensureCss, shell, chip, problemText } from "./kit.js";
import { artifactFrame } from "./artifact-frame.js";

/** Every artifacts tool the viewer calls, and the render route, in one place. */
export const TOOLS = { get: "artifacts.get", versions: "artifacts.versions", share: "artifacts.share" };
/** Where the box serves an artifact version's rendered page (opaque origin, its own CSP). @param {string} id @param {number} v */
export const renderSrc = (id, v) => `/artifacts/${encodeURIComponent(id)}/v${v}/render`;

/** Kinds drawn natively as Markdown; everything else goes to the frame. */
const TEXT_KINDS = new Set(["doc", "report", "markdown", "note"]);
/** Kinds that may widen the panel to half the window (layout.md's named exception). */
const WIDE_KINDS = new Set(["page", "deck"]);
const GLYPH = { doc: "file", report: "lines", page: "watch", dashboard: "planner", diagram: "branch", deck: "laptop", app: "terminal" };
const ID = /^[A-Za-z0-9][\w.-]{0,79}$/;
const NOT_YET = "This box can't show artifacts yet.";

// ---- the route ----------------------------------------------------------------------------

/** The address of an artifact's full-screen page, at a version when given. @param {string} id @param {number|null} [version] */
export const artifactHref = (id, version) => `/a/${encodeURIComponent(id)}` + (Number.isInteger(version) && /** @type {number} */ (version) > 0 ? `?v=${version}` : "");

/**
 * /a/<id> (and ?v=<n>) as { id, version }, or null for any other address. Ids are the safe
 * subset only, so a crafted path never reaches a tool call.
 * @param {string} pathname @param {string} [search]
 * @returns {{ id: string, version: number|null }|null}
 */
export function parseArtifactRoute(pathname, search = "") {
  const parts = String(pathname || "").replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "a") return null;
  let id;
  try { id = decodeURIComponent(parts[1]); } catch { return null; }
  if (!ID.test(id) || id.includes("..")) return null;
  const v = new URLSearchParams(search).get("v");
  const n = v == null ? null : /^\d{1,6}$/.test(v) ? Number(v) : NaN;
  return { id, version: n && n > 0 ? n : null };
}

// ---- the payload --------------------------------------------------------------------------

/** The render payload for a thread.artifact event; null when it names no artifact. @param {any} p */
export function artifactFromEvent(p) {
  if (!p || typeof p !== "object" || !p.artifact) return null;
  return { kind: "artifact", id: String(p.artifact), thread: p.thread ?? null, version: p.version ?? null, type: p.kind ?? "", title: p.title ?? "", agent: p.agent ?? null, at: p.at ?? p.ts ?? null };
}

/** One shape for a render payload or an event-made payload. (`kind` on a render payload is "artifact"; the artifact's own kind is `type`.) @param {any} d */
function norm(d) {
  const v = Number(d?.version);
  const at = typeof d?.at === "string" ? Date.parse(d.at) : Number(d?.at);
  return {
    id: String(d?.id ?? d?.artifact ?? ""), title: String(d?.title || "Untitled"),
    type: String(d?.type ?? d?.artifact_kind ?? (d?.kind && d.kind !== "artifact" ? d.kind : "") ?? "").toLowerCase(),
    version: Number.isInteger(v) && v > 0 ? v : null, agent: typeof d?.agent === "string" ? d.agent : d?.agent?.name ?? null,
    at: Number.isFinite(at) && at > 0 ? at : null, days: Number.isFinite(Number(d?.public_days)) && d?.public_days != null ? Number(d.public_days) : null,
  };
}

// ---- the chat card ------------------------------------------------------------------------

/**
 * @param {any} data @param {any} [ctx] { agent, phone, sheet, panelHost }
 * @returns {HTMLElement & { update: (d: any) => void }}
 */
export function artifactCard(data, ctx = {}) {
  ensureCss("artifact");
  const el = shell("cv-artifact", "Artifact");
  el.update = (/** @type {any} */ d) => {
    data = d;
    const a = norm(d);
    const by = a.agent || (typeof ctx.agent === "string" ? ctx.agent : ctx.agent?.name);
    const meta = [a.type, a.version ? `v${a.version}` : "", by ? `made by ${by}` : "", a.at ? `${since(a.at)} ago` : ""].filter(Boolean).join(" · ");
    put(el,
      h("span", { class: "cv-art-ico", "aria-hidden": "true" }, icon(GLYPH[a.type] || "file", 18)),
      h("div", { class: "cv-art-text" },
        h("div", { class: "cv-art-title ellipsis" }, a.title),
        h("div", { class: "cv-art-meta ellipsis" }, meta, a.days != null ? [" ", chip("neutral", `Public · ${a.days} days`)] : null)),
      h("div", { class: "cv-art-actions" },
        h("button", { class: "btn btn-sm", type: "button", "aria-label": `Open ${a.title}`, onclick: () => openArtifact(data, ctx) }, "Open"),
        h("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-label": `Share ${a.title}`, onclick: () => shareArtifact(data, ctx) }, "Share")));
  };
  el.update(data);
  return el;
}

// ---- the viewer ---------------------------------------------------------------------------

/** Versions as a sorted list of { version, at }, from whatever shape the tool answers. @param {any} r */
function versionList(r) {
  const raw = Array.isArray(r) ? r : Array.isArray(r?.versions) ? r.versions : [];
  const seen = new Map();
  for (const x of raw) {
    const v = Number(typeof x === "object" ? x?.version ?? x?.n ?? x?.v : x);
    if (Number.isInteger(v) && v > 0) seen.set(v, { version: v, at: typeof x === "object" ? x?.at ?? null : null });
  }
  return [...seen.values()].sort((a, b) => a.version - b.version);
}

/** A tool's own error in plain words: missing tool, or the problem line. @param {any} e */
const failure = e => (e?.missing || e?.code === "no_such_tool") ? NOT_YET : problemText(e);

/**
 * The viewer's parts: `bar` (version pills, Changes, Share) and `el` (the content). The caller
 * places both: a panel puts the bar on top, a phone sheet at the bottom.
 * @param {any} data @param {any} [ctx]
 * @param {{ phone?: boolean, onMeta?: (m: { title: string, type: string, version: number }) => void }} [o]
 * @returns {{ el: HTMLElement, bar: HTMLElement, dispose: () => void, title: () => string, type: () => string }}
 */
export function artifactView(data, ctx = {}, o = {}) {
  ensureCss("artifact");
  const a = norm(data);
  const phone = o.phone ?? ctx.phone ?? isPhone();
  const S = { versions: /** @type {{ version: number, at: any }[]} */ ([]), version: a.version, diff: false, seq: 0, dead: false, title: a.title, type: a.type,
    busy: false, guard: /** @type {any} */ (null) };

  const pills = h("div", { class: "cv-art-pills", role: "radiogroup", "aria-label": "Versions" });
  const changes = h("button", { class: "btn btn-ghost btn-sm cv-art-changes", type: "button", "aria-pressed": "false", onclick: () => toggleDiff() }, "Changes");
  const share = h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => shareArtifact({ ...data, title: S.title, id: a.id }, ctx) }, "Share");
  const bar = h("div", { class: "cv-art-bar" + (phone ? " cv-art-bar-phone" : ""), role: "toolbar", "aria-label": "Artifact" }, pills, changes, share);
  const body = h("div", { class: "cv-art-body" });
  const el = h("div", { class: "cv-art-view", tabindex: "-1", onkeydown: (/** @type {KeyboardEvent} */ e) => {
    if ((e.key === "s" || e.key === "S") && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|TEXTAREA)$/.test(String(/** @type {any} */ (e.target)?.tagName))) { e.preventDefault(); share.click(); }
  } }, body);

  function drawPills() {
    put(pills, S.versions.map(v => h("button", { class: "cv-art-pill", type: "button", role: "radio", "aria-checked": String(v.version === S.version), tabindex: v.version === S.version ? "0" : "-1",
      "data-v": String(v.version), onclick: () => pick(v.version),
      onkeydown: (/** @type {KeyboardEvent} */ e) => {
        const i = S.versions.findIndex(x => x.version === S.version);
        const j = e.key === "ArrowLeft" ? i - 1 : e.key === "ArrowRight" ? i + 1 : -1;
        if (j < 0 || j >= S.versions.length) return;
        e.preventDefault(); pick(S.versions[j].version).then(() => /** @type {any} */ (pills.querySelector(`[data-v="${S.version}"]`))?.focus?.());
      } }, `v${v.version}`)));
    changes.setAttribute("aria-pressed", String(S.diff));
    if (S.busy) changes.setAttribute("aria-busy", "true"); else changes.removeAttribute("aria-busy");
  }

  /** Skeleton in the shape of the kind: text lines for text, a blank canvas for the rest. */
  const skeleton = () => h("div", { class: "cv-art-skel", "aria-busy": "true", "aria-label": "Loading" }, TEXT_KINDS.has(S.type) || !S.type ? [0, 1, 2, 3].map(() => h("span", { class: "cv-art-skel-line" })) : null);
  const say = (/** @type {string} */ t, /** @type {boolean} */ bad) => put(body, h("p", { class: "cv-art-note", role: bad ? "alert" : "status" }, t));

  /** The text of one version, or an error line. */
  async function text(/** @type {number} */ v) {
    const r = await attempt(TOOLS.get, { artifact: a.id, version: v });
    if (r.error) return { error: failure(r.error) };
    const d = /** @type {any} */ (r.data);
    const t = typeof d === "string" ? d : d?.content ?? d?.text ?? "";
    return { text: String(t), type: String(d?.type ?? d?.kind ?? "").toLowerCase(), title: d?.title };
  }

  async function show() {
    const seq = ++S.seq;
    const v = S.version;
    if (v == null) return say("This artifact has no versions yet.");
    S.guard?.stop?.(); S.guard = null;
    if (!S.diff) put(body, skeleton());
    const cur = await text(v);
    if (S.dead || seq !== S.seq) return;
    if (cur.error) { S.busy = false; drawPills(); return say(cur.error, true); }
    if (cur.type) S.type = cur.type;
    if (cur.title) S.title = String(cur.title);
    o.onMeta?.({ title: S.title, type: S.type, version: v });
    if (S.diff) {
      const prev = [...S.versions].reverse().find(x => x.version < v);
      const before = prev ? await text(prev.version) : null;
      if (S.dead || seq !== S.seq) return;
      S.busy = false; drawPills();
      if (!prev) return say("This is the first version, so there is nothing to compare it with.");
      if (before?.error) return say(before.error, true);
      return put(body, h("div", { class: "cv-art-changes-view", "aria-label": `Changes from v${prev.version} to v${v}` }, renderUnified(before?.text || "", cur.text)));
    }
    if (TEXT_KINDS.has(S.type)) return put(body, h("div", { class: "cv-art-md md" }, renderMarkdown(cur.text)));
    const frame = artifactFrame({ src: renderSrc(a.id, v), title: S.title, onBlank: () => {} });
    S.guard = frame.guard;
    // Drawn by the Deck, outside the frame: whatever the page shows inside its border, even a look-alike of
    // Vyre, sits under this line (reviewer-2 M2: the frame's content is always untrusted and labelled).
    const by = a.agent || (typeof ctx.agent === "string" ? ctx.agent : ctx.agent?.name);
    put(body, h("p", { class: "cv-art-origin" }, by ? `Made by ${by}. ` : "Made by an agent. ", "It runs on its own and is not part of Vyre."), frame);
  }

  /** @param {number} v */
  async function pick(v) { if (v === S.version && !S.diff) return; S.version = v; if (S.diff) S.busy = true; drawPills(); await show(); }
  async function toggleDiff() { S.diff = !S.diff; S.busy = S.diff; drawPills(); await show(); }

  (async () => {
    put(body, skeleton());
    const r = await attempt(TOOLS.versions, { artifact: a.id });
    if (S.dead) return;
    if (r.error && (/** @type {any} */ (r.error).missing || /** @type {any} */ (r.error).code === "no_such_tool")) return say(NOT_YET, true);
    S.versions = r.error ? [] : versionList(r.data);
    if (!S.versions.length && a.version) S.versions = [{ version: a.version, at: null }];
    if (S.version == null || !S.versions.some(x => x.version === S.version)) S.version = S.versions.length ? S.versions[S.versions.length - 1].version : S.version;
    drawPills();
    await show();
  })();

  return { el, bar, title: () => S.title, type: () => S.type, dispose: () => { S.dead = true; S.guard?.stop?.(); } };
}

/** The one open side panel, if any. @type {{ close: () => void }|null} */
let openPanel = null;

/**
 * Open an artifact: a side panel beside chat on a desktop (340 wide, half the window for a page
 * or deck when the person widens it), a full-screen sheet on a phone. `ctx.panelHost` mounts the
 * panel somewhere other than the page body; `ctx.sheet` replaces openSheet (for tests).
 * @param {any} data @param {any} [ctx]
 * @returns {{ close: () => void, el?: HTMLElement }}
 */
export function openArtifact(data, ctx = {}) {
  ensureCss("artifact");
  const a = norm(data);
  const phone = ctx.phone ?? isPhone();
  if (phone) {
    /** @type {ReturnType<typeof artifactView>|null} */ let view = null;
    const s = (ctx.sheet || openSheet)({ title: a.title, onClose: () => view?.dispose(), build(body, _close, parts) {
      view = artifactView(data, ctx, { phone: true });
      body.classList.add("cv-art-sheet-body");
      body.append(view.el);
      parts.actions.append(view.bar);
    } });
    return { close: s.close, el: s.el };
  }
  openPanel?.close();
  const view = artifactView(data, ctx, { phone: false, onMeta: m => { put(titleEl, m.title); panel.setAttribute("aria-label", m.title); if (WIDE_KINDS.has(m.type)) widen.hidden = false; } });
  const titleEl = h("h2", { class: "cv-art-panel-title ellipsis" }, a.title);
  const widen = h("button", { class: "btn btn-ghost btn-sm", type: "button", hidden: !WIDE_KINDS.has(a.type), "aria-pressed": "false", onclick: () => {
    const on = !panel.classList.contains("cv-art-wide");
    panel.classList.toggle("cv-art-wide", on);
    widen.setAttribute("aria-pressed", String(on));
    put(widen, on ? "Narrow" : "Widen");
  } }, "Widen");
  const closeBtn = h("button", { class: "ibtn", type: "button", "aria-label": "Close", onclick: () => close() }, icon("close", 16));
  const panel = h("aside", { class: "cv-art-panel", role: "dialog", "aria-label": a.title, onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } } },
    h("div", { class: "cv-art-panel-head" }, titleEl, widen, closeBtn), view.bar, view.el);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    view.dispose();
    panel.remove();
    if (openPanel === handle) openPanel = null;
  }
  const handle = { close, el: panel };
  openPanel = handle;
  (ctx.panelHost || document.body).append(panel);
  view.el.focus?.();
  return handle;
}

/**
 * The full-screen page for /a/<id>: the same viewer, title on top, bar under it.
 * @param {string} id @param {number|null} [version] @param {any} [ctx]
 * @returns {HTMLElement & { dispose: () => void }}
 */
export function artifactScreen(id, version = null, ctx = {}) {
  ensureCss("artifact");
  const titleEl = h("h1", { class: "cv-art-panel-title ellipsis" }, "Artifact");
  const view = artifactView({ id, version }, ctx, { phone: ctx.phone ?? isPhone(), onMeta: m => { put(titleEl, m.title); } });
  const el = /** @type {any} */ (h("main", { class: "cv-art-screen", "aria-label": "Artifact" }, h("div", { class: "cv-art-panel-head" }, titleEl), view.bar, view.el));
  el.dispose = view.dispose;
  return el;
}

// ---- sharing ------------------------------------------------------------------------------

/**
 * The share sheet: one plain choice, a link. Runs at once, because the person tapped it (an agent
 * sharing alone is held by the Gate, not here). The secret scan is not a guarantee, so it says so.
 * @param {any} data @param {any} [ctx]
 */
export function shareArtifact(data, ctx = {}) {
  const a = norm(data);
  return (ctx.sheet || openSheet)({ title: `Share ${a.title}`, build(body, close, parts) {
    const out = h("div", { class: "cv-art-share-out", role: "status" });
    const go = h("button", { class: "btn btn-primary", type: "button", onclick: async () => {
      go.setAttribute("aria-busy", "true");
      const r = await queued(TOOLS.share, { artifact: a.id, ...(a.version ? { version: a.version } : {}) });
      go.removeAttribute("aria-busy");
      if (r.error) return put(out, h("p", { class: "cv-art-note", role: "alert" }, failure(r.error)));
      const d = /** @type {any} */ (r.data);
      const url = typeof d === "string" ? d : d?.url ?? d?.link ?? "";
      put(out, url ? h("p", { class: "cv-art-link" }, String(url)) : h("p", { class: "cv-art-note" }, "The link is ready."));
    } }, "Create a link");
    body.append(
      h("p", { class: "cv-art-share-copy" }, "Anyone with the link can read this. It stays private until you make one."),
      h("p", { class: "cv-art-share-copy" }, "Vyre scans for keys and passwords before it shares, and it catches the obvious ones. Read it once yourself first."),
      out);
    parts.actions.append(go, h("button", { class: "btn btn-ghost", type: "button", onclick: close }, "Not now"));
  } });
}
