// @ts-check
// Drive (the Files view): the folders this box shares as VyreDrive, browsed from a phone (/files, /files/:share,
// the folder in ?p=). A phone cannot mount a share, so this reads through files.drive.list and
// files.drive.read as an owner device (the box guards them like sharing itself). Reading only: a
// preview for a picture, text or PDF up to 8 MB, otherwise a download. Words and reads:
// js/drive-browse.js.
//
// Tools: files.drive.status (which shares), files.drive.list, files.drive.read. Any may be
// missing on an older box; the page then says so.

import { h, put, link, head, empty } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";
import { since } from "../js/fmt.js";
import { sizeWord, crumbs, child, previewKind, readFile, listAll, whyNot } from "../js/drive-browse.js";

const href = (/** @type {string} */ share, /** @type {string} */ p) => `/files/${encodeURIComponent(share)}${p ? `?p=${encodeURIComponent(p)}` : ""}`;

/** @param {any} ctx */
export default async function files(ctx) {
  const share = ctx.params.share ? decodeURIComponent(ctx.params.share) : "";
  const body = h("div", { class: "fl-col" });
  put(ctx.root, h("div", { class: "fl" }, body));
  put(body, head("Drive"), h("p", { class: "muted" }, "Loading..."));
  if (!share) return shares(ctx, body);
  return folder(ctx, body, share, ctx.query.get("p") || "");
}

/** @param {any} ctx @param {HTMLElement} body */
async function shares(ctx, body) {
  const r = await attempt("files.drive.status");
  if (!ctx.alive()) return;
  if (r.error) return put(body, head("Drive"), empty("Your box's folders are not reachable.", r.error));
  const list = (r.data?.shares || []).filter((/** @type {any} */ s) => s && s.shared);
  put(body, head("Drive"),
    list.length
      ? h("div", { class: "fl-list" }, list.map((/** @type {any} */ s) => link(href(s.name, ""), { class: "fl-row" }, icon("projects", 16), h("span", { class: "fl-name" }, s.name), icon("chevronright", 14))))
      : empty("No folder is shared yet. Share one from Settings on your Mac."));
}

/** @param {any} ctx @param {HTMLElement} body @param {string} share @param {string} dir */
async function folder(ctx, body, share, dir) {
  const trail = h("nav", { class: "fl-trail", "aria-label": "Folder" },
    crumbs(share, dir).map((c, i, all) => [link(href(share, c.path), { class: "fl-crumb", "aria-current": i === all.length - 1 ? "page" : false }, c.label), i < all.length - 1 ? h("span", { class: "faint" }, " / ") : null]));
  const r = await listAll(attempt, share, dir);
  if (!ctx.alive()) return;
  if ("error" in r) return put(body, head("Drive"), trail, empty(whyNot(r.error)));
  const rows = r.entries.map(e => {
    const p = child(dir, e.name);
    if (e.dir) return link(href(share, p), { class: "fl-row" }, icon("projects", 16), h("span", { class: "fl-name" }, e.name), icon("chevronright", 14));
    return h("button", { type: "button", class: "fl-row", onclick: () => open(ctx, share, p, e) },
      icon("file", 16), h("span", { class: "fl-name" }, e.name), h("span", { class: "fl-meta small faint" }, [sizeWord(e.size), e.mtime ? since(Date.parse(e.mtime)) : ""].filter(Boolean).join(", ")));
  });
  put(body, head("Drive"), trail, rows.length ? h("div", { class: "fl-list" }, rows) : empty("Nothing in this folder."));
}

/** One file: a preview when it is small and a known kind, else a download. @param {any} ctx @param {string} share @param {string} p @param {any} e */
async function open(ctx, share, p, e) {
  const view = h("div", { class: "fl-view", role: "dialog", "aria-label": e.name },
    h("div", { class: "fl-view-head" }, h("span", { class: "fl-name" }, e.name),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => view.remove() }, "Close")));
  const stage = h("div", { class: "fl-stage" }, h("p", { class: "muted" }, "Opening..."));
  view.append(stage);
  ctx.root.append(view);
  const kind = previewKind(e);
  const r = await readFile(attempt, share, p);
  if (!ctx.alive() || !view.isConnected) return;
  if ("error" in r) return put(stage, empty(whyNot(r.error)));
  if ("tooBig" in r) return put(stage, h("p", { class: "muted" }, `${e.name} is ${sizeWord(r.size)}, too big to open here. Open it on a computer.`));
  const blob = new Blob([/** @type {BlobPart} */ (r.bytes)], { type: r.mime || e.mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  ctx.cleanup(() => URL.revokeObjectURL(url));
  const save = h("a", { class: "btn btn-sm", href: url, download: e.name }, "Save");
  if (kind === "image") put(stage, h("img", { class: "fl-img", src: url, alt: e.name }), save);
  else if (kind === "text") put(stage, h("pre", { class: "fl-text" }, new TextDecoder().decode(r.bytes)), save);
  else if (kind === "pdf") put(stage, h("iframe", { class: "fl-pdf", src: url, title: e.name }), save);
  else put(stage, h("p", { class: "muted" }, `${sizeWord(r.size)}. This kind of file does not open here.`), save);
}
