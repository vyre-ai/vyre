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

/**
 * The Drive front page: this server's own project folders first (each opens straight into its folder, where a Generated folder holds
 * what models made), then the folders shared with the paired Macs. A server with a project and nothing shared is not empty.
 * @param {(tool: string, input?: any) => Promise<any>} call
 * @returns {Promise<{ nodes: any[] } | { error: any }>}
 */
export async function drawHome(call) {
  const [st, cand] = await Promise.all([call("files.drive.status"), call("files.drive.candidates")]);
  if (st.error && cand.error) return { error: st.error };
  const projects = ((cand.data && cand.data.candidates) || []).filter((/** @type {any} */ c) => c && c.kind === "project" && c.via);
  const shared = ((st.data && st.data.shares) || []).filter((/** @type {any} */ s) => s && s.shared);
  const row = (/** @type {string} */ to, /** @type {string} */ name, /** @type {string} */ note) =>
    link(to, { class: "fl-row" }, icon("projects", 16), h("span", { class: "fl-name" }, name), note ? h("span", { class: "fl-meta small faint" }, note) : null, icon("chevronright", 14));
  const nodes = [];
  if (projects.length) {
    nodes.push(h("h2", { class: "fl-sub" }, "Projects on your server"));
    nodes.push(h("div", { class: "fl-list" }, projects.map((/** @type {any} */ p) => row(href(p.via.share, p.via.rel), p.name || p.slug, ""))));
  }
  if (shared.length) {
    nodes.push(h("h2", { class: "fl-sub" }, "Shared with your Macs"));
    nodes.push(h("div", { class: "fl-list" }, shared.map((/** @type {any} */ s) => row(href(s.name, ""), s.name, ""))));
  }
  if (!nodes.length) {
    nodes.push(empty("No project is on your server yet."),
      h("p", { class: "muted" }, "Make a project and its folder shows here, with the images and video your models make. To share another folder with your Macs, choose it in Settings, then Drive."),
      link("/projects", { class: "btn btn-sm" }, "Make a project"));
  }
  return { nodes };
}

/** @param {any} ctx @param {HTMLElement} body */
async function shares(ctx, body) {
  const r = await drawHome(attempt);
  if (!ctx.alive()) return;
  if ("error" in r) return put(body, head("Drive"), empty("Your box's folders are not reachable.", r.error));
  put(body, head("Drive"), ...r.nodes);
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
  // The type is ours, from the kind we decided to show, never the box's string: a wrong mime must not render as HTML here.
  const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
  const type = kind === "image" ? (IMAGE.test(r.mime || e.mime || "") ? String(r.mime || e.mime) : "application/octet-stream")
    : kind === "pdf" ? "application/pdf" : kind === "text" ? "text/plain" : "application/octet-stream";
  const blob = new Blob([/** @type {BlobPart} */ (r.bytes)], { type });
  const url = URL.createObjectURL(blob);
  ctx.cleanup(() => URL.revokeObjectURL(url));
  const save = h("a", { class: "btn btn-sm", href: url, download: e.name }, "Save");
  if (kind === "image") put(stage, h("img", { class: "fl-img", src: url, alt: e.name }), save);
  else if (kind === "text") put(stage, h("pre", { class: "fl-text" }, new TextDecoder().decode(r.bytes)), save);
  else if (kind === "pdf") put(stage, h("iframe", { class: "fl-pdf", src: url, title: e.name }), save);
  else put(stage, h("p", { class: "muted" }, `${sizeWord(r.size)}. This kind of file does not open here.`), save);
}
