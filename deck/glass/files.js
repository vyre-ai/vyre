// @ts-check
// The file browser (ADR 0005 decision 4). One browser for every target: an agent's home
// (computer:<agent>) and the box's chosen folders (box). Listing, stat and text preview are
// tools; downloads and uploads get a one-time ticket from a tool and move their bytes on
// /v1/glass/raw and /v1/glass/put. Every write says what happened, in plain words.

import { h, put } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";
import { gicon, errText, size, stamp } from "./util.js";
import { upload as putBytes } from "./transfer.js";

const join = (...parts) => parts.filter(Boolean).join("/").replace(/\/+/g, "/");
const parent = p => p.split("/").slice(0, -1).join("/");
const leaf = p => p.split("/").pop() || "";

/**
 * @param {{ root: HTMLElement, target: string, name: string, phone: boolean, ctx: any }} o
 */
export function mountFiles(o) {
  const { target, name } = o;
  let dead = false;
  let path = "";
  const rootLabel = target === "box" ? "The box" : `${name}'s home`;
  /** @type {any[]} */ let entries = [];
  /** @type {any} */ let listErr = null;
  /** @type {any} */ let sel = null;
  let seq = 0;
  /** A download ticket fetched when the pointer reaches the Download button, so a drag can use it. */
  /** @type {{ for: string, path: string, name: string, at: number } | null} */ let ticket = null;

  const crumbs = h("nav", { class: "gl-crumbs", "aria-label": "Folder" });
  const status = h("div", { class: "gl-fstatus", role: "status", "aria-live": "polite" });
  const picker = /** @type {HTMLInputElement} */ (h("input", { type: "file", multiple: true, hidden: true, onchange: () => {
    const list = [...(picker.files || [])].map(f => ({ file: f, rel: f.name }));
    picker.value = "";
    if (list.length) uploadAll(list, path);
  } }));
  const newForm = h("form", { class: "gl-fnew", hidden: true });
  const table = h("div", { class: "gl-flist", role: "grid", "aria-label": "Files" });
  const pane = h("section", { class: "gl-fprev", "aria-label": "Preview" });
  const transfers = h("div", { class: "gl-ftransfers", "aria-label": "Uploads" });
  const drop = h("div", { class: "gl-drop", hidden: true }, h("div", { class: "gl-drop-card" }, gicon("upload", 20), h("span", null, "")));
  const wrap = h("div", { class: "gl-files" },
    h("div", { class: "gl-ftool" }, crumbs, h("div", { class: "gl-ftool-acts" },
      h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: showNew }, gicon("folder"), "New folder"),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => picker.click() }, gicon("upload"), "Upload"), picker)),
    newForm, status,
    h("div", { class: "gl-fmain" }, h("div", { class: "gl-flistwrap" }, table, drop), pane),
    transfers);
  put(o.root, wrap);

  // ---- messages ----------------------------------------------------------------------------
  /** @param {string} text @param {"ok"|"err"} [tone] */
  function say(text, tone = "ok") {
    put(status, text ? h("div", { class: "gl-msg" + (tone === "err" ? " gl-msg-err" : "") }, tone === "err" ? h("span", { class: "dot beacon" }) : icon("check", 14),
      h("span", null, text), h("button", { type: "button", class: "ibtn", "aria-label": "Dismiss", onclick: () => put(status) }, gicon("close", 12))) : null);
  }

  // ---- listing -----------------------------------------------------------------------------
  async function load(p = path, keepSel = false) {
    const n = ++seq;
    const r = await attempt("glass.files.list", { target, ...(p ? { path: p } : {}) });
    if (dead || n !== seq) return;
    if (r.error) { listErr = r.error; entries = []; }
    else {
      listErr = null;
      path = r.data.path || "";
      entries = [...(r.data.entries || [])].sort((a, b) => (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1) || a.name.localeCompare(b.name));
    }
    if (!keepSel || !entries.some(e => sel && e.name === sel.name)) sel = null;
    drawCrumbs(); drawList(); drawPane();
  }

  function drawCrumbs() {
    const parts = path ? path.split("/") : [];
    const btn = (label, to, last) => last ? h("span", { class: "gl-crumb", "aria-current": "page" }, label)
      : h("button", { type: "button", class: "gl-crumb link quiet", onclick: () => { path = to; sel = null; load(to); } }, label);
    put(crumbs, btn(rootLabel, "", !parts.length),
      parts.map((seg, i) => [h("span", { class: "gl-crumb-sep", "aria-hidden": "true" }, "/"), btn(seg, parts.slice(0, i + 1).join("/"), i === parts.length - 1)]));
  }

  function drawList() {
    if (listErr) { put(table, h("div", { class: "empty" }, "Glass could not list this folder.", h("span", { class: "code" }, errText(listErr)))); return; }
    const up = path ? h("div", { class: "gl-frow gl-frow-up", role: "row", tabindex: "0", onclick: () => open({ name: "..", kind: "dir" }),
      onkeydown: rowKey(() => open({ name: "..", kind: "dir" })) }, h("span", { class: "gl-fname" }, gicon("back"), h("span", null, "Up one folder")), h("span"), h("span")) : null;
    put(table,
      h("div", { class: "gl-frow gl-fhead", role: "row" }, h("span", { role: "columnheader" }, "Name"), h("span", { role: "columnheader", class: "gl-fnum" }, "Size"),
        h("span", { role: "columnheader", class: "gl-fnum" }, "Modified")),
      up,
      entries.length ? entries.map(e => h("div", { class: "gl-frow" + (sel && sel.name === e.name ? " on" : ""), role: "row", tabindex: "0",
        "aria-selected": sel && sel.name === e.name ? "true" : "false", onclick: () => open(e), onkeydown: rowKey(() => open(e)) },
        h("span", { class: "gl-fname" }, e.kind === "dir" ? gicon("folder") : e.kind === "link" ? gicon("link") : gicon("file"), h("span", { class: "ellipsis" }, e.name)),
        h("span", { class: "gl-fnum code" }, e.kind === "dir" ? "" : size(e.size)),
        h("span", { class: "gl-fnum code" }, stamp(e.mtime))))
        : h("div", { class: "empty gl-fempty" }, path ? "This folder is empty. Drop files here to upload them." : "Nothing here yet. Drop files here to upload them."));
  }

  const rowKey = fn => (/** @type {KeyboardEvent} */ e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } };

  function open(e) {
    if (e.name === "..") { path = parent(path); sel = null; load(path); return; }
    if (e.kind === "dir") { path = join(path, e.name); sel = null; ticket = null; load(path); return; }
    sel = e; ticket = null;
    drawList(); drawPane();
    if (o.phone) pane.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  // ---- preview pane ------------------------------------------------------------------------
  let paneSeq = 0;
  function drawPane() {
    const n = ++paneSeq;
    if (!sel) {
      pane.hidden = o.phone && !path;
      put(pane, h("div", { class: "gl-fprev-head" }, h("span", { class: "lbl" }, "Folder"),
        h("h3", { class: "h3 ellipsis" }, path ? leaf(path) : rootLabel)),
        h("p", { class: "small muted" }, `${entries.filter(e => e.kind === "dir").length} folders, ${entries.filter(e => e.kind !== "dir").length} files. Choose a file to preview it, or drop files anywhere in the list to upload them here.`),
        path ? h("div", { class: "gl-fprev-acts" }, renameBtn(path, "dir"), trashBtn(path, "dir")) : null,
        h("div", { class: "gl-fslot" }));
      return;
    }
    pane.hidden = false;
    const full = join(path, sel.name);
    const body = h("div", { class: "gl-fbody" }, h("div", { class: "small faint" }, "Loading a preview"));
    const dl = downloadLink(full, sel.name);
    put(pane,
      h("div", { class: "gl-fprev-head" }, h("span", { class: "lbl" }, "File"), h("h3", { class: "h3 gl-break" }, sel.name),
        h("div", { class: "code" }, [size(sel.size), sel.mtime ? `modified ${stamp(sel.mtime)}` : ""].filter(Boolean).join(" · "))),
      h("div", { class: "gl-fprev-acts" }, dl, renameBtn(full, "file"), trashBtn(full, "file")),
      h("div", { class: "gl-fslot" }),
      body);
    attempt("glass.files.preview", { target, path: full }).then(r => {
      if (dead || n !== paneSeq) return;
      if (r.error) { put(body, h("div", { class: "small muted" }, "No preview for this file. ", h("span", { class: "code" }, errText(r.error)))); return; }
      const p = r.data;
      if (p.kind === "text") put(body, h("pre", { class: "gl-pre" }, p.text || ""), p.truncated ? h("div", { class: "small faint" }, "Showing the start of the file. Download it for the rest.") : null);
      else if (p.kind === "image") put(body, h("img", { class: "gl-img", src: p.path, alt: `Preview of ${sel.name}` }));
      else if (p.kind === "pdf") put(body, h("button", { type: "button", class: "btn", onclick: () => openPdf(full) }, "Open the PDF in a new tab"));
      else put(body, h("div", { class: "small muted" }, "No preview for this kind of file. Download it to open it."));
    });
  }

  /** PDFs open in their own tab, from the box's raw route with its own strict headers. A ticket is
   * one use, so each open asks for a fresh one. */
  async function openPdf(full) {
    const w = window.open("about:blank", "_blank");
    const r = await attempt("glass.files.preview", { target, path: full });
    if (r.error || !r.data?.path) { w?.close(); say(`Could not open the PDF: ${errText(r.error)}`, "err"); return; }
    if (w) { w.opener = null; w.location.href = r.data.path; }
  }

  function downloadLink(full, fname) {
    const a = /** @type {HTMLAnchorElement} */ (h("a", { class: "btn btn-sm", href: "#", download: fname, draggable: "true" }, gicon("download"), "Download"));
    const fetchTicket = async () => {
      if (ticket && ticket.for === full && Date.now() - ticket.at < 45_000) return ticket;
      const r = await attempt("glass.files.download", { target, path: full });
      if (r.error) { say(`Download did not start: ${errText(r.error)}`, "err"); return null; }
      ticket = { for: full, path: r.data.path, name: r.data.name || fname, at: Date.now() };
      a.href = ticket.path;
      return ticket;
    };
    a.addEventListener("pointerenter", () => { if (!ticket || ticket.for !== full) fetchTicket(); });
    a.addEventListener("click", async e => {
      e.preventDefault();
      const t = await fetchTicket();
      if (!t) return;
      ticket = null;
      const go = /** @type {HTMLAnchorElement} */ (h("a", { href: t.path, download: t.name, hidden: true }));
      document.body.append(go); go.click(); go.remove();
      a.href = "#";
      say(`Downloading ${t.name}.`);
    });
    // Dragging the button to Finder saves the file (Chromium's DownloadURL); the ticket was fetched
    // when the pointer arrived, since dragstart cannot wait for the network.
    a.addEventListener("dragstart", e => {
      if (!ticket || ticket.for !== full || !e.dataTransfer) { e.preventDefault(); say("Hold on a moment and drag again: Glass is asking the box for the file.", "err"); fetchTicket(); return; }
      e.dataTransfer.setData("DownloadURL", `application/octet-stream:${ticket.name}:${location.origin}${ticket.path}`);
      e.dataTransfer.setData("text/uri-list", location.origin + ticket.path);
      e.dataTransfer.effectAllowed = "copy";
      ticket = null;
    });
    return a;
  }

  function slot() { return /** @type {HTMLElement} */ (pane.querySelector(".gl-fslot")); }

  function renameBtn(full, kind) {
    return h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => {
      const input = /** @type {HTMLInputElement} */ (h("input", { class: "input", value: full, "aria-label": "New name or path", spellcheck: "false" }));
      const f = h("form", { class: "gl-inline" },
        h("label", { class: "small muted" }, `Rename or move this ${kind === "dir" ? "folder" : "file"}. Change the name, or the path to move it.`),
        input,
        h("div", { class: "gl-inline-acts" },
          h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => put(slot()) }, "Cancel"),
          h("button", { type: "submit", class: "btn btn-primary btn-sm" }, "Save")));
      f.addEventListener("submit", async ev => {
        ev.preventDefault();
        const to = input.value.trim().replace(/^\/+/, "");
        if (!to || to === full) { put(slot()); return; }
        const r = await attempt("glass.files.move", { target, from: full, to });
        if (r.error) { say(`Could not move ${leaf(full)}: ${errText(r.error)}`, "err"); return; }
        say(parent(to) === parent(full) ? `Renamed ${leaf(full)} to ${leaf(to)}.` : `Moved ${leaf(full)} to ${parent(to) || rootLabel}.`);
        if (kind === "dir" && full === path) { path = to; }
        sel = null;
        load(path);
      });
      put(slot(), f);
      input.focus();
      input.setSelectionRange(full.length - leaf(full).length, full.length);
    } }, gicon("move"), "Rename");
  }

  function trashBtn(full, kind) {
    return h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => {
      put(slot(), h("div", { class: "gl-inline gl-inline-warn", role: "alertdialog", "aria-label": "Move to trash" },
        h("p", { class: "small" }, `Move ${leaf(full)} to the trash? ${kind === "dir" ? "Everything in it goes too. " : ""}It stays in the trash folder on ${target === "box" ? "the box" : `${name}'s computer`}, so you can take it back out.`),
        h("div", { class: "gl-inline-acts" },
          h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => put(slot()) }, "Cancel"),
          h("button", { type: "button", class: "btn btn-sm gl-danger", onclick: async () => {
            const r = await attempt("glass.files.trash", { target, path: full });
            if (r.error) { say(`Could not move ${leaf(full)} to the trash: ${errText(r.error)}`, "err"); return; }
            say(`Moved ${leaf(full)} to the trash${r.data?.to ? ` (${r.data.to})` : ""}.`);
            sel = null;
            if (kind === "dir" && full === path) path = parent(path);
            load(path);
          } }, gicon("trash"), "Move to trash"))));
    } }, gicon("trash"), "Trash");
  }

  // ---- new folder --------------------------------------------------------------------------
  function showNew() {
    const input = /** @type {HTMLInputElement} */ (h("input", { class: "input", placeholder: "Folder name", "aria-label": "New folder name", spellcheck: "false" }));
    put(newForm, h("span", { class: "small muted" }, `New folder in ${path || rootLabel}`), input,
      h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => { newForm.hidden = true; } }, "Cancel"),
      h("button", { type: "submit", class: "btn btn-primary btn-sm" }, "Create"));
    newForm.hidden = false;
    input.focus();
  }
  newForm.addEventListener("submit", async e => {
    e.preventDefault();
    const input = /** @type {HTMLInputElement} */ (newForm.querySelector("input"));
    const nm = input.value.trim();
    if (!nm) return;
    if (nm.includes("/") || nm === "." || nm === "..") { say("A folder name cannot contain a slash.", "err"); return; }
    const r = await attempt("glass.files.mkdir", { target, path: join(path, nm) });
    if (r.error) { say(`Could not create ${nm}: ${errText(r.error)}`, "err"); return; }
    newForm.hidden = true;
    say(`Created the folder ${nm}.`);
    load(path, true);
  });

  // ---- uploads -----------------------------------------------------------------------------
  /** @type {{ abort: () => void }[]} */ const live = [];

  /** @param {{ file: File, rel: string }[]} list rel is the path under the drop folder @param {string} into */
  async function uploadAll(list, into) {
    const made = new Set();
    let ok = 0, bytes = 0;
    for (const { file, rel } of list) {
      if (dead) return;
      const dir = join(into, parent(rel));
      // Folders dropped from Finder: make each one first (an existing folder is fine).
      const parts = parent(rel).split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const d = join(into, parts.slice(0, i).join("/"));
        if (made.has(d)) continue;
        made.add(d);
        const r = await attempt("glass.files.mkdir", { target, path: d });
        if (r.error && r.error.code !== "exists") say(`Could not create the folder ${d}: ${errText(r.error)}`, "err");
      }
      if (await uploadOne(file, dir)) { ok++; bytes += file.size; }
    }
    if (ok) say(`Uploaded ${ok === 1 ? list[0].file.name : `${ok} files`} (${size(bytes)}) to ${into || rootLabel}.`);
    if (!dead && into === path) load(path, true);
  }

  /** @param {File} file @param {string} dir @param {boolean} [overwrite] */
  async function uploadOne(file, dir, overwrite = false) {
    const fill = h("span", { style: { width: "0%" } });
    const note = h("span", { class: "code" }, "waiting");
    const actsEl = h("span", { class: "gl-tr-acts" });
    const row = h("div", { class: "gl-tr" }, h("span", { class: "ellipsis small" }, join(dir, file.name) || file.name), note, h("div", { class: "bar" }, fill), actsEl);
    transfers.prepend(row);
    const r = await attempt("glass.files.upload", { target, dir, name: file.name, size: file.size, ...(overwrite ? { overwrite: true } : {}) });
    if (r.error) {
      row.classList.add("gl-tr-err");
      put(note, errText(r.error));
      if (r.error.code === "exists") put(actsEl, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: async () => { row.remove(); if (await uploadOne(file, dir, true)) { say(`Replaced ${file.name}.`); load(path, true); } } }, "Replace"));
      put(actsEl, actsEl.firstChild, h("button", { type: "button", class: "ibtn", "aria-label": "Dismiss", onclick: () => row.remove() }, gicon("close", 12)));
      return false;
    }
    const t = putBytes(r.data.path, file, (sent, total) => {
      const pct = total ? Math.round((sent / total) * 100) : 0;
      fill.style.width = pct + "%";
      put(note, `${size(sent)} of ${size(total)}`);
    });
    live.push(t);
    put(actsEl, h("button", { type: "button", class: "ibtn", "aria-label": `Cancel uploading ${file.name}`, onclick: () => t.abort() }, gicon("close", 12)));
    try {
      await t.done;
      fill.style.width = "100%";
      put(note, `${size(file.size)}, done`);
      put(actsEl, h("button", { type: "button", class: "ibtn", "aria-label": "Dismiss", onclick: () => row.remove() }, gicon("close", 12)));
      return true;
    } catch (err) {
      row.classList.add("gl-tr-err");
      put(note, /** @type {any} */ (err).code === "aborted" ? "cancelled" : errText(err));
      put(actsEl, h("button", { type: "button", class: "ibtn", "aria-label": "Dismiss", onclick: () => row.remove() }, gicon("close", 12)));
      return false;
    } finally {
      live.splice(live.indexOf(t), 1);
    }
  }

  // Drop from Finder, folders included (webkitGetAsEntry).
  let depth = 0;
  const hasFiles = (/** @type {DragEvent} */ e) => [...(e.dataTransfer?.types || [])].includes("Files");
  wrap.addEventListener("dragenter", e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth++;
    put(/** @type {HTMLElement} */ (drop.querySelector("span")), `Drop to upload into ${path || rootLabel}`);
    drop.hidden = false;
  });
  wrap.addEventListener("dragover", e => { if (hasFiles(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; } });
  wrap.addEventListener("dragleave", e => { if (hasFiles(e) && --depth <= 0) { depth = 0; drop.hidden = true; } });
  wrap.addEventListener("drop", async e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; drop.hidden = true;
    const into = path;
    const items = [...(e.dataTransfer?.items || [])];
    const roots = items.map(i => /** @type {any} */ (i).webkitGetAsEntry?.()).filter(Boolean);
    /** @type {{ file: File, rel: string }[]} */ let list = [];
    if (roots.length) {
      for (const en of roots) list = list.concat(await walk(en, ""));
    } else {
      list = [...(e.dataTransfer?.files || [])].map(f => ({ file: f, rel: f.name }));
    }
    if (list.length) uploadAll(list, into);
  });

  /** @returns {Promise<{ file: File, rel: string }[]>} */
  async function walk(entry, prefix) {
    const rel = join(prefix, entry.name);
    if (entry.isFile) return [{ file: await new Promise((res, rej) => entry.file(res, rej)), rel }];
    if (!entry.isDirectory) return [];
    const reader = entry.createReader();
    /** @type {any[]} */ let all = [];
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      all = all.concat(batch);
    }
    let out = [];
    for (const en of all) out = out.concat(await walk(en, rel));
    return out;
  }

  // Someone else's writes to this folder show up without a reload.
  let evT = 0;
  for (const t of ["file.uploaded", "file.moved", "file.trashed", "file.created"]) o.ctx.on(t, (/** @type {any} */ e) => {
    if (dead || e.payload?.target !== target) return;
    clearTimeout(evT);
    evT = window.setTimeout(() => load(path, true), 200);
  });

  load("");
  return {
    unmount() { dead = true; clearTimeout(evT); for (const t of live.splice(0)) t.abort(); },
  };
}

