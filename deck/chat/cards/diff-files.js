// @ts-check
// The multi-file diff (docs/design/system/components/diff.md, Multi-file variant): several files'
// diffs in one scroll, each behind its own file row (path, counts, a chevron). The first file is
// open on the desktop and none is on a phone; a file with a review comment opens too, when the
// caller passes it in `open`. Each file's state is its own, and "Expand all" / "Collapse all" set
// every file at once. A file over TOO_LARGE lines, or a binary one, says so inline and never
// blocks the rest. Comes in as a display card (render kind "diff") and as fileList(), the list
// builder pr-review.js embeds. Line drawing is lib/diff.js's, unchanged.

import { h, put, isPhone } from "../../js/dom.js";
import { icon } from "../../js/icons.js";
import { patchRows, renderRows, rowCounts, countsLabel } from "../lib/diff.js";
import { ensureCss, shell, head } from "./kit.js";

/** A file with more lines than this is not drawn: "This diff has 4,200 lines. Open it in Files." */
export const TOO_LARGE = 4000;

/**
 * A unified patch (GitHub's `patch`, or `git diff` text) as the hunks patchRows() takes. File
 * headers before the first hunk and "\ No newline" markers are dropped.
 * @param {string} text @returns {{ oldStart: number, newStart: number, lines: string[] }[]}
 */
export function parsePatch(text) {
  /** @type {{ oldStart: number, newStart: number, lines: string[] }[]} */
  const hunks = [];
  /** @type {any} */ let cur = null;
  for (const line of String(text ?? "").split("\n")) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) { cur = { oldStart: +m[1], newStart: +m[2], lines: [] }; hunks.push(cur); continue; }
    if (!cur || line[0] === "\\") continue;
    if (line[0] === "+" || line[0] === "-" || line[0] === " ") cur.lines.push(line);
    else if (line === "") cur.lines.push(" ");
  }
  // A patch text ends in a newline: that last empty line is not a context line.
  if (cur && cur.lines.length && /\n$/.test(String(text)) && cur.lines[cur.lines.length - 1] === " ") cur.lines.pop();
  return hunks;
}

/** The rows of one file, or null when it carries no hunks or patch. @param {any} f */
function rowsOf(f) {
  if (Array.isArray(f.hunks)) return patchRows(f.hunks);
  if (typeof f.patch === "string" && f.patch) { const hk = parsePatch(f.patch); return hk.length ? patchRows(hk) : null; }
  return null;
}
const isBinary = (/** @type {any} */ f) => f.binary === true || (typeof f.patch === "string" && /^Binary files /m.test(f.patch));

/** A file's counts: what the data says, else counted from its rows. @param {any} f @param {any[]|null} rows */
function countsOf(f, rows) {
  if (Number.isFinite(f.additions) || Number.isFinite(f.deletions)) return { added: f.additions || 0, removed: f.deletions || 0 };
  return rows ? rowCounts(rows) : { added: 0, removed: 0 };
}

/** The counts as the file row prints them: "new · +60", "deleted · −40", "+12 −4". @param {any} f @param {{ added: number, removed: number }} c */
export function fileMeta(f, c) {
  const n = countsLabel(c);
  if (f.status === "added" || f.status === "new") return `new · ${n}`;
  if (f.status === "deleted" || f.status === "removed") return `deleted · ${n}`;
  if (f.status === "renamed") return `renamed · ${n}`;
  return n;
}

/**
 * The file list: a bar (count, totals, Expand all / Collapse all) and one row per file.
 * @param {any[]} files [{ path, status?, additions?, deletions?, hunks|patch }]
 * @param {{ phone?: boolean, open?: Iterable<string>, onToggle?: (path: string, open: boolean) => void, openFile?: (f: any) => void }} [opts]
 *   open: paths to start open, beyond the first-file rule
 * @returns {HTMLElement & { update: (files: any[]) => void, isOpen: (path: string) => boolean, setOpen: (path: string, open: boolean) => void,
 *   setAll: (open: boolean) => void, paths: () => string[] }}
 */
export function fileList(files, opts = {}) {
  const phone = opts.phone ?? isPhone();
  const el = /** @type {any} */ (h("div", { class: "cv-dfl" }));
  const bar = h("div", { class: "cv-dfl-bar" });
  const list = h("div", { class: "cv-dfl-files", role: "list" });
  put(el, bar, list);
  /** @type {Map<string, boolean>} */ const openState = new Map();
  /** @type {Map<string, { wrap: HTMLElement, f: any, rows: any[]|null|undefined }>} */ const entries = new Map();
  const first = new Set(opts.open || []);
  let seeded = false;

  function drawFile(/** @type {string} */ path) {
    const e = /** @type {any} */ (entries.get(path));
    const f = e.f;
    const open0 = !!openState.get(path);
    const hasCounts = Number.isFinite(f.additions) || Number.isFinite(f.deletions);
    if (e.rows === undefined && (open0 || !hasCounts)) e.rows = isBinary(f) ? null : rowsOf(f);
    const rows = e.rows || null;
    const c = countsOf(f, rows);
    const open = !!openState.get(path);
    put(e.wrap,
      h("button", { class: "cv-df-row", type: "button", "aria-expanded": String(open), onclick: () => api.setOpen(path, !open) },
        h("span", { class: "cv-df-chev" + (open ? " open" : ""), "aria-hidden": "true" }, icon("chevron", 12)),
        h("span", { class: "cv-df-path", title: path }, path),
        h("span", { class: "cv-df-counts" }, fileMeta(f, c))),
      open ? body(f, rows) : null);
  }

  function body(/** @type {any} */ f, /** @type {any[]|null} */ rows) {
    if (isBinary(f)) return h("div", { class: "cv-df-note" }, "Binary file changed");
    if (!rows) return h("div", { class: "cv-df-note" }, "No line changes to show");
    const n = rows.filter(r => r.type !== "@").length;
    if (n > TOO_LARGE) return h("div", { class: "cv-df-note cv-df-big" },
      h("span", null, `This diff has ${n.toLocaleString("en-US")} lines. Open it in Files.`),
      opts.openFile ? h("button", { class: "btn btn-sm", type: "button", onclick: () => opts.openFile?.(f) }, "Open in Files") : null);
    return renderRows(rows, { cap: 0 });
  }

  function drawBar() {
    const paths = [...entries.keys()];
    if (!paths.length) { put(bar); return; }
    let added = 0, removed = 0;
    for (const p of paths) { const e = /** @type {any} */ (entries.get(p)); const c = countsOf(e.f, e.rows || null); added += c.added; removed += c.removed; }
    const allOpen = paths.every(p => openState.get(p));
    put(bar,
      h("span", { class: "cv-dfl-sum" }, `${paths.length} ${paths.length === 1 ? "file" : "files"}`, (added || removed) ? ` · ${countsLabel({ added, removed })}` : ""),
      h("span", { class: "cv-dfl-sp" }),
      paths.length > 1 ? h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "all", onclick: () => api.setAll(!allOpen) }, allOpen ? "Collapse all" : "Expand all") : null);
  }

  const api = {
    isOpen: (/** @type {string} */ p) => !!openState.get(p),
    paths: () => [...entries.keys()],
    setOpen(/** @type {string} */ p, /** @type {boolean} */ open) {
      if (!entries.has(p) || !!openState.get(p) === open) return;
      openState.set(p, open); drawFile(p); drawBar(); opts.onToggle?.(p, open);
    },
    setAll(/** @type {boolean} */ open) {
      const changed = [];
      for (const p of entries.keys()) if (!!openState.get(p) !== open) { openState.set(p, open); drawFile(p); changed.push(p); }
      drawBar(); for (const p of changed) opts.onToggle?.(p, open);
    },
    update(/** @type {any[]} */ next) {
      const fs = (Array.isArray(next) ? next : []).filter(f => f && typeof f.path === "string");
      const keep = new Set(fs.map(f => f.path));
      for (const p of [...entries.keys()]) if (!keep.has(p)) { entries.delete(p); openState.delete(p); }
      fs.forEach((f, i) => {
        const old = entries.get(f.path);
        if (old) { old.f = f; old.rows = undefined; }
        else {
          entries.set(f.path, { wrap: h("div", { class: "cv-df", role: "listitem" }), f, rows: undefined });
          openState.set(f.path, first.has(f.path) || (!seeded && !phone && i === 0));
        }
      });
      seeded = true;
      put(list, fs.map(f => /** @type {any} */ (entries.get(f.path)).wrap));
      for (const p of entries.keys()) drawFile(p);
      drawBar();
    },
  };
  Object.assign(el, api);
  api.update(files);
  return el;
}

/** Totals over a file list's counts. @param {any[]} files */
function totals(files) {
  let added = 0, removed = 0;
  for (const f of files || []) { const c = countsOf(f, Number.isFinite(f.additions) || Number.isFinite(f.deletions) ? null : rowsOf(f)); added += c.added; removed += c.removed; }
  return { added, removed };
}

/**
 * The display card for render {kind: "diff", title?, files: [...]}.
 * @param {any} data @param {{ phone?: boolean, open?: (href: string) => void }} [ctx]
 */
export function diffFiles(data, ctx = {}) {
  ensureCss("diff-files");
  const el = /** @type {any} */ (shell("cv-diff-files", "Changes"));
  const openFile = (/** @type {any} */ f) => ctx.open?.(f.href || `/files?path=${encodeURIComponent(f.path)}`);
  /** @type {any} */ let list = null;
  el.update = (/** @type {any} */ d) => {
    data = d || {};
    const files = Array.isArray(data.files) ? data.files : [];
    el.setAttribute("aria-label", data.title || "Changes");
    if (list) list.update(files);
    else list = fileList(files, { phone: ctx.phone, openFile });
    const t = totals(files);
    put(el, head({ icon: "lines", title: data.title || "Changes", meta: (t.added || t.removed) ? countsLabel(t) : null }),
      files.length ? list : h("div", { class: "cv-df-note" }, "No files changed"));
  };
  el.update(data);
  return el;
}
