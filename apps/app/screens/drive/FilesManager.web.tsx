// Files on the web: a real file manager. A folder tree on the left (react-arborist: Space, Shared, Linked, On your server, On your computer), the open folder in the middle as a list or a grid
// (@tanstack/react-table for the columns, @tanstack/react-virtual for the rows), breadcrumbs and a search above it, multi-select with a bulk bar, and a detail panel on the right. Every read
// and write is an existing files.* tool (files-real.ts); what a source cannot do is not offered (files-model.ts abilities). The detail panel's preview is a slot: native-mount's FileViewer
// takes it over; until then small text files show as text. Narrow screens keep the Drive screen with its tabs.
import { openFind } from "../find/FindHost";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, Field, IconTile, ListHeader, LoadingState, Row, Segmented, Sheet, Text, listRows, showToast, type FilterChip, FileViewer, useVirtualRows, Icon, IconButton } from "@vyre/ui";
import { Frame } from "../places/Frame";
import RealDrive from "./RealDrive";
import { SharedLinks } from "./SharedLinks";
import { Breadcrumb } from "./Breadcrumb";
import { driveSource, linkedFileSource } from "./file-source";
import { MenuRow } from "../../ui/blocks/RowMenu";
import { type Place, rootLabel, abilities, bulkActions, crumbsFor, moveFocus, nextSort, parentPlace, parsePlace, prune, selectAll, selectOnly, selectRange, selectToggle, sortRows, type FileRow, type Selection, type Sort } from "./files-model.ts";
import { folderNames, linkedNames, loader } from "./files-real";
import { agentPlace, detailLines, quickLook } from "./files-places.js";
import { SitePage } from "./SitePage";
import { startThread } from "./new-thread";
import { ComputerPage } from "./ComputerPage";
import { canDrop, carriesFiles, dropTarget, dropWords, plan, progressLine } from "./drop-model.js";
import { Thumb } from "./Thumb";
import { warm } from "./preload";
import { FileContextMenu } from "./FileContextMenu";
import { actOn, boxSelect, copyName, editCalls, fileMenu } from "./file-menu-model.js";
import { DRAG_TYPE, carriesRows, dragWords, movedLine, plan as movePlan, takesMoves } from "./move-model.js";
import { FolderPicker } from "./FolderPicker";
import { create as createSite } from "../sites/real";
import { BLANK, build as buildSite, publishRefusal } from "../sites/real-model";
import { useFilesNav } from "./files-nav";
import { tool } from "../../src/real/box";
import { driveTool, linked, spaceRead, spaceRestore, spaceUpload, spaceVersions, statusReal, linkCreate } from "./real";
import { bytesOf, sizeWord, textOf } from "./real-model";
import { driveRefusal } from "./real-model";
import { linkedRefusal, type LinkedVersion } from "./linked-model";
import { dayOf, newFolderName, spaceDriveRefusal, toBase64, MAX_UPLOAD, type Version } from "./space-model";

const say = (e: unknown) => { const x = e as { code?: string }; const m = e instanceof Error ? e.message : ""; return x.code === "conflict" || x.code === "unsupported" ? linkedRefusal(x.code, m) : spaceDriveRefusal(x.code, m) || driveRefusal(x.code, m); };
const ROW_H = 40;
type FolderOf = { place: string; root: string; path: string; link?: string };
const ICON: Record<string, string> = { folder: "folder", pdf: "file", doc: "file", sheet: "file", image: "file", video: "file", audio: "file", archive: "file", text: "file", file: "file" };
const KIND_WORD: Record<string, string> = { folder: "Folder", pdf: "PDF", doc: "Document", sheet: "Spreadsheet", image: "Image", video: "Video", audio: "Audio", archive: "Archive", text: "Text", file: "File" };
/** What the shared list header filters on: a file as a record with a name and a kind. */
const FILE_DEF = { name: "file", fields: [{ name: "name", label: "Name", kind: "text" }, { name: "kind", label: "Kind", kind: "text" }] };
const when = (t: number) => (t ? dayOf(t) : "");

export default function FilesManager() {
  const { width } = useWindowDimensions();
  if (width < 760) return <RealDrive />;
  return <Manager wide={width >= 1180} />;
}

function Manager({ wide }: { wide: boolean }) {
  const router = useRouter();
  const { place, folders, status, tick, go: setPlace, loadRoots, setKids, invalidate } = useFilesNav();
  // /u/files?agent=engineer (an agent's "Open in Vyre Files"): open that agent's own folder, the same place as Agents > Engineer in the sidebar.
  const { agent } = useLocalSearchParams<{ agent?: string }>();
  useEffect(() => {
    if (!agent) return;
    let live = true;
    tool<{ agents?: { name: string; path: string }[] }>("files.places", {}).then((r) => { const at = agentPlace(r?.agents, String(agent)); if (live && at) setPlace(at); }).catch(() => {});
    return () => { live = false; };
  }, [agent, setPlace]);
  const [rows, setRows] = useState<FileRow[] | null>(null);
  const [err, setErr] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });
  const [q, setQ] = useState("");
  const [chips, setChips] = useState<FilterChip[]>([]);
  const [view, setView] = useState<"list" | "grid">("grid");
  const [sel, setSel] = useState<Selection>({ set: new Set(), anchor: null });
  const [focus, setFocus] = useState(-1);
  const [dialog, setDialog] = useState<{ kind: "move" | "delete" | "rename"; rows: FileRow[] } | null>(null);
  const [look, setLook] = useState<{ open: string | null }>({ open: null });
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; keys: string[] } | null>(null);
  const [box, setBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const rowEls = useRef<Record<string, HTMLElement | null>>({});
  // the search box looks in this folder (the default) or in all the files of the Space
  const [publishing, setPublishing] = useState<{ row: FileRow; name: string } | null>(null);
  const [scopeAll, setScopeAll] = useState(false);
  // a new folder: null while closed, else the name being typed; the folder is selected once the listing has it
  const [newName, setNewName] = useState<string | null>(null);
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null);
  const selectAfter = useRef<string | null>(null);
  const [found, setFound] = useState<FileRow[] | null>(null);

  // the roots (linked folders and box shares) and the open place are shared with the sidebar tree (files-nav.ts)
  useEffect(loadRoots, [loadRoots]);

  const parsed = parsePlace(place);
  const root = parsed?.root ?? "space";
  const ability = abilities(root);

  // the open folder
  const load = useCallback((p: string) => {
    const pp = parsePlace(p);
    setErr(""); setRows(null);
    if (p === "recent") { loader.recent().then(setRows).catch((e) => { setErr(say(e)); setRows([]); }); return; }
    if (!pp) { setRows([]); return; }
    if (pp.root === "linked" && !pp.link) { setRows(folders.map((f) => ({ key: `linked:${f.id}`, place: `linked:${f.id}`, root: "linked" as const, name: f.name, dir: true, kind: "folder" as const, size: 0, modified: f.at, link: f.id, path: "" }))); return; }
    if (pp.root === "box" && !pp.share) { setRows((status?.shares ?? []).map((s) => ({ key: `box:${s.name}`, place: `box:${s.name}`, root: "box" as const, name: s.name, dir: true, kind: "folder" as const, size: 0, modified: 0, share: s.name, path: "" }))); return; }
    loader.rows(p).then((r) => { setRows(r); setKids(p, r.filter((x) => x.dir).map((x) => ({ id: x.place, label: x.name, root: x.root, kids: [] }))); }).catch((e) => { setErr(say(e)); setRows([]); });
  }, [folders, status]);
  useEffect(() => { load(place); setSel({ set: new Set(), anchor: null }); setFocus(-1); }, [place, load, tick]);
  useEffect(() => { setQ(""); setChips([]); }, [place]);

  const go = setPlace;

  useEffect(() => {
    if (!scopeAll || q.trim().length < 2) { setFound(null); return; }
    let live = true;
    const t = setTimeout(() => { loader.searchAll(q).then((r) => { if (live) setFound(r); }).catch(() => { if (live) setFound([]); }); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [scopeAll, q]);
  const shown = useMemo(() => {
    if (found) return found;
    const recs = (rows ?? []).map((row) => ({ row, data: { name: row.name, kind: KIND_WORD[row.kind] }, created_at: row.modified ? new Date(row.modified).toISOString() : undefined }));
    return sortRows((listRows(FILE_DEF, recs, chips, q) as typeof recs).map((x) => x.row), sort.key, sort.dir);
  }, [rows, q, chips, sort, found]);
  const keys = useMemo(() => shown.map((r) => r.key), [shown]);
  useEffect(() => { setSel((s) => prune(s, keys)); }, [keys]);
  const picked = shown.filter((r) => sel.set.has(r.key));
  const one = picked.length === 1 && !picked[0].dir ? picked[0] : null;

  const open = (r: FileRow) => { if (r.dir) go(r.place); else { setSel(selectOnly(r.key)); setLook((l) => quickLook(l, { type: "open", key: r.key }, shown, null)); } };
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && /^(input|textarea)$/i.test(t.tagName)) return;
    // Quick Look: Space on the selected file opens it (Space or Esc closes), the arrows move through the files while it is open
    if (look.open) {
      if (e.key === " " || e.key === "Escape") { e.preventDefault(); setLook(quickLook(look, { type: "close" }, shown, one?.key ?? null)); return; }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); setLook(quickLook(look, { type: "step", by: 1 }, shown, null)); return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); setLook(quickLook(look, { type: "step", by: -1 }, shown, null)); return; }
    }
    if (e.key === " " && one) { e.preventDefault(); setLook(quickLook(look, { type: "space" }, shown, one.key)); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const i = moveFocus(focus, shown.length, e.key);
      setFocus(i);
      if (i >= 0) setSel(e.shiftKey ? selectRange(sel, keys, keys[i]) : selectOnly(keys[i]));
    } else if (e.key === "Enter" && focus >= 0) { e.preventDefault(); open(shown[focus]); }
    else if (e.key === " " && focus >= 0) { e.preventDefault(); setSel(selectToggle(sel, keys[focus])); }
    else if ((e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setSel(selectAll(keys)); }
    else if (e.key === "Backspace" || (e.key === "ArrowLeft" && (e.metaKey || e.altKey))) { const up = parentPlace(place); if (up) { e.preventDefault(); go(up); } }
    else if (e.key === "Escape") setSel({ set: new Set(), anchor: null });
  };
  const click = (r: FileRow, i: number, e: React.MouseEvent) => {
    setFocus(i);
    setSel(e.shiftKey ? selectRange(sel, keys, r.key) : e.metaKey || e.ctrlKey ? selectToggle(sel, r.key) : selectOnly(r.key));
  };

  /** A right-click: the menu at the pointer, acting on the whole selection when the row is in it, else on that row. */
  const rightClick = (r: FileRow, i: number, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const a = actOn(sel.set, r.key);
    if (a.reselect) { setSel(selectOnly(r.key)); setFocus(i); }
    setMenu({ at: { x: e.clientX, y: e.clientY }, keys: a.keys });
  };
  const menuRows = menu ? shown.filter((r) => menu.keys.includes(r.key)) : [];
  const doAction = (id: string, rs: FileRow[]) => {
    const r0 = rs[0];
    if (id === "open") open(r0);
    else if (id === "look") setLook((l) => quickLook(l, { type: "open", key: r0.key }, shown, null));
    else if (id === "ask") {
      const fs = rs.filter((x) => !x.dir);
      const chips = fs.flatMap((x) => (x.root === "space" ? [{ kind: "space", id: x.path, name: x.name }] : x.root === "linked" && x.link ? [{ kind: "linked", id: `${x.link}:${x.path}`, name: x.name }] : []));
      void startThread(router, "assistant", fs.map((x) => `#${x.name}`).join(" ") + " ", fs.length === 1 ? `About ${fs[0].name}` : `About ${fs.length} files`, chips.length ? chips : undefined);
    }
    else if (id === "share") linkCreate(undefined, r0.path).then(() => showToast("Link made. It is under Shared.")).catch((e) => showToast(say(e)));
    else if (id === "download") rs.filter((x) => !x.dir).forEach((x) => download(x).catch((e) => showToast(say(e))));
    else if (id === "versions") setSel(selectOnly(r0.key));
    else if (id === "move" || id === "rename" || id === "delete") setDialog({ kind: id, rows: rs });
    else if (id === "duplicate") {
      const taken = new Set((rows ?? []).map((x) => x.name));
      const name = copyName(r0.name, taken), dest = `${r0.path.includes("/") ? r0.path.slice(0, r0.path.lastIndexOf("/") + 1) : ""}${name}`;
      spaceRead(undefined, r0.path).then((f) => spaceUpload(undefined, dest, f.base64)).then(() => { showToast(`Made ${name}.`); load(place); }).catch((e) => showToast(say(e)));
    }
  };
  // a box dragged on empty space selects the rows it touches
  const startBox = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[role=row],[data-tile],button,input,a")) return;
    const x1 = e.clientX, y1 = e.clientY; let moved = false;
    const move = (m: MouseEvent) => {
      if (!moved && Math.abs(m.clientX - x1) + Math.abs(m.clientY - y1) < 6) return;
      moved = true;
      const b = { x1, y1, x2: m.clientX, y2: m.clientY }; setBox(b);
      const rects: Record<string, { left: number; top: number; right: number; bottom: number }> = {};
      for (const [k, el] of Object.entries(rowEls.current)) if (el) { const q = el.getBoundingClientRect(); rects[k] = { left: q.left, top: q.top, right: q.right, bottom: q.bottom }; }
      const hit = boxSelect(b, rects).filter((k) => keys.includes(k));
      setSel({ set: new Set(hit), anchor: hit[0] ?? null });
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); setBox(null); if (!moved) setSel({ set: new Set(), anchor: null }); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  };

  const scroller = useRef<HTMLDivElement>(null);
  const virt = useVirtualRows({ count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 8 });

  const crumbs = parsed ? crumbsFor(parsed, { linked: linkedNames, space: folderNames }) : [];
  // The bar is for several at once; one row has its "..." and the detail panel, and a bar that appears on the first click would push the rows down before the second click of a double click.
  const bar = picked.length > 1 ? bulkActions(root, picked.length) : [];   // (the right-click menu offers the same and more)
  /** The "..." of a row: only what its source really does. */
  const menuFor = (r: FileRow) => {
    const a = abilities(r.root);
    const items: { label: string; onPress: () => void; danger?: boolean }[] = [{ label: r.dir ? "Open" : "Details", onPress: () => { setSel(selectOnly(r.key)); if (r.dir) go(r.place); } }];
    if (!r.dir && a.download && (r.root === "space" || r.root === "linked")) items.push({ label: "Download", onPress: () => { download(r).catch((e) => showToast(say(e))); } });
    if (!r.dir && a.share && r.root === "space") items.push({ label: "Share a link", onPress: () => { linkCreate(undefined, r.path).then(() => showToast("Link made. It is under Shared.")).catch((e) => showToast(say(e))); } });
    if (r.dir && r.root === "space") items.push({ label: "Publish as a site", onPress: () => setPublishing({ row: r, name: r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) }) });
    if (!r.dir && r.root === "box" && r.share) items.push({ label: "Send to another computer", onPress: () => { tool<{ devices?: { id: string; name: string; ready?: boolean }[] }>("files.drop.targets", {}).then((t) => { const d = (t?.devices ?? []).find((x) => x.ready); if (!d) { showToast("No other computer is set up to receive. Turn receiving on there first."); return; } return tool("files.deliver", { path: r.path, device: d.id }).then(() => showToast(`Sent to ${d.name}. It arrives when that computer is on.`)); }).catch((e) => showToast(say(e))); } });
    if (a.edit && r.root === "linked") items.push({ label: "Rename", onPress: () => setDialog({ kind: "rename", rows: [r] }) });
    if (a.move) items.push({ label: "Move", onPress: () => setDialog({ kind: "move", rows: [r] }) });
    if (a.remove && r.root === "linked") items.push({ label: "Delete", danger: true, onPress: () => setDialog({ kind: "delete", rows: [r] }) });
    return items;
  };
  const runBulk = (id: string) => {
    if (id === "download") picked.filter((r) => !r.dir).forEach((r) => download(r).catch((e) => showToast(say(e))));
    else if (id === "move" || id === "delete") setDialog({ kind: id, rows: picked });
    else if (id === "share" && one) linkCreate(undefined, one.path).then(() => showToast("Link made. It is under Shared.")).catch((e) => showToast(say(e)));
  };

  // upload: the picker and a drop onto the open folder (the Space and linked folders take files)
  const [dropping, setDropping] = useState(false);
  // the folder row the pointer is over during a drag of files (a drop onto it uploads into it)
  const [overRow, setOverRow] = useState<string | null>(null);
  const uploadTo = async (target: Place, files: File[], known?: FileRow[] | null) => {
    if (!files.length) return;
    const { go: sendable, skipped } = plan(files, MAX_UPLOAD);
    for (const x of skipped) showToast(x.why === "too_large" ? spaceDriveRefusal("too_large", "") : `${x.name} is a folder, not a file. Open it and drop its files instead.`);
    const base = target.path ? `${target.path}/` : "";
    const byName = new Map(sendable.map((f) => [f.name, files.find((g) => g.name === f.name)!]));
    let done = 0;
    for (const f of sendable) {
      const file = byName.get(f.name)!;
      showToast(progressLine(done, sendable.length, f.name));
      try {
        const b64 = toBase64(new Uint8Array(await file.arrayBuffer()));
        if (target.root === "space") await spaceUpload(undefined, `${base}${f.name}`, b64, known?.find((x) => !x.dir && x.name === f.name)?.ver);
        else if (target.root === "linked" && target.link) await linked.write(target.link, `${base}${f.name}`, b64);
        done++;
      } catch (e) { showToast(say(e)); }
    }
    if (done) { showToast(done === 1 ? "Uploaded." : `Uploaded ${done} files.`); load(place); }
  };
  const upload = (files: File[]) => (parsed && ability.upload ? uploadTo(parsed, files, rows) : Promise.resolve());
  /** The folder a drag over the page would land in: the folder row under the pointer, else the open folder. */
  const targetNow = () => {
    const over = overRow ? shown.find((r) => r.key === overRow) : null;
    const asFolder = (p: FolderOf) => ({ place: p.place, root: p.root, path: p.path, ...(p.link ? { link: p.link } : {}) });
    return dropTarget(parsed ? asFolder({ place, root: parsed.root, path: parsed.path, link: parsed.link }) : null, over ? { ...asFolder(over), dir: over.dir } : null);
  };
  const pickUpload = () => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true;
    input.onchange = () => { void upload(Array.from(input.files ?? [])); };
    input.click();
  };
  const canOpenFolder = !!parsed && (parsed.root === "space" || (parsed.root === "linked" && !!parsed.link));
  /** A new folder is made in the Space's Drive (the box keeps a folder as the path its files share, so it holds an empty one with a hidden file). */
  const canMakeFolder = !!parsed && parsed.root === "space" && ability.upload;
  const makeFolder = async () => {
    if (!parsed || newName === null) return;
    const v = newFolderName(newName, (rows ?? []).map((x) => x.name));
    if ("error" in v) { showToast(v.error); return; }
    try {
      await driveTool("files.drive.space.mkdir", { ...(parsed.path ? { parent: parsed.path } : {}), name: v.name });
      selectAfter.current = v.name; setNewName(null); invalidate();
    } catch (e) { showToast(say(e)); }
  };
  useEffect(() => {
    const want = selectAfter.current;
    if (!want || !rows) return;
    const hit = rows.find((x) => x.dir && x.name === want);
    if (hit) { selectAfter.current = null; setSel(selectOnly(hit.key)); setFocus(rows.indexOf(hit)); }
  }, [rows]);

  const uploadButton = ability.upload && canOpenFolder ? <Button kind="primary" size="sm" icon="upload" label="Upload" onPress={pickUpload} /> : null;
  const folderButton = canMakeFolder ? <Button kind="secondary" size="sm" icon="plus" label="New folder" onPress={() => setNewName("")} /> : null;
  // With the detail panel open the middle is narrower, so Kind (which the panel shows) steps aside and the rest keep their widths.
  const showDetail = !!one && (one.root === "space" || one.root === "linked" || one.root === "box");
  const GRID_COLS = showDetail ? "minmax(140px, 1fr) 104px 72px 36px" : "minmax(240px, 1fr) 120px 140px 80px 36px";
  // Moving by dragging: a file or folder (or the whole selection) dropped on a folder row, a folder tile or a crumb of the path moves into it (the same move the "Move to..." picker makes).
  const [dragRows, setDragRows] = useState<FileRow[] | null>(null);
  const [moveOver, setMoveOver] = useState<string | null>(null);
  const moveInto = async (dest: { root: string; path: string; link?: string }, name: string, carried: FileRow[]) => {
    const d = { root: dest.root, path: dest.path, ...(dest.link ? { link: dest.link } : {}) };
    const { go: goes, said } = movePlan(carried, d);
    if (!goes.length) { if (said) showToast(said); return; }
    const done: NonNullable<ReturnType<typeof editCalls>>[] = [];
    try { for (const r of goes) { const c = editCalls("move", { root: r.root, path: r.path, name: r.name, link: r.link }, d.path); if (!c) throw new Error("A box share is read-only."); await driveTool(c.call.tool, c.call.input); done.push(c); } }
    catch (e) { showToast(say(e)); }
    if (done.length) {
      const undos = done.map((x) => x.undo).filter((u): u is NonNullable<typeof u> => Boolean(u));
      invalidate();
      showToast(movedLine(done.length, name, carried.length - goes.length), undos.length ? { label: "Undo", run: () => { void Promise.all(undos.map((u) => driveTool(u.tool, u.input))).then(() => { showToast("Put back."); invalidate(); }).catch((e) => showToast(say(e))); } } : undefined);
    }
  };
  /** The drag handlers of one row or tile: it can be picked up (if its source moves), and a folder takes what is dropped on it. */
  const dragProps = (r: FileRow) => ({
    draggable: takesMoves(r),
    onDragStart: (e: React.DragEvent) => {
      if (!takesMoves(r)) return;
      const carried = (sel.set.has(r.key) ? picked : [r]).filter(takesMoves);
      if (!sel.set.has(r.key)) setSel(selectOnly(r.key));
      setDragRows(carried);
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(carried.map((x) => x.key)));
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => { setDragRows(null); setMoveOver(null); },
    onDragOver: (e: React.DragEvent) => {
      if (carriesRows(e.dataTransfer)) {
        if (r.dir && takesMoves(r) && dragRows && !dragRows.some((x) => x.key === r.key)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; setMoveOver(r.key); }
        return;
      }
      setOverRow(r.dir ? r.key : null);
    },
    onDragLeave: () => { setMoveOver((k) => (k === r.key ? null : k)); },
    onDrop: (e: React.DragEvent) => {
      if (!carriesRows(e.dataTransfer)) return;
      e.preventDefault(); e.stopPropagation();
      const carried = dragRows; setDragRows(null); setMoveOver(null);
      if (carried && r.dir && takesMoves(r)) void moveInto({ root: r.root, path: r.path, link: r.link }, r.name, carried);
    },
  });
  /** The drop handlers of a crumb of the path: dropping on it moves into that folder. */
  const crumbDrop = (key: string, name: string) => {
    const p = parsePlace(key);
    const ok = !!p && takesMoves({ root: p.root, link: p.link });
    return {
      onDragOver: (e: React.DragEvent) => { if (ok && dragRows && carriesRows(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setMoveOver(`crumb:${key}`); } },
      onDragLeave: () => { setMoveOver((k) => (k === `crumb:${key}` ? null : k)); },
      onDrop: (e: React.DragEvent) => {
        if (!ok || !carriesRows(e.dataTransfer)) return;
        e.preventDefault(); const carried = dragRows; setDragRows(null); setMoveOver(null);
        if (carried && p) void moveInto({ root: p.root, path: p.path, link: p.link }, name, carried);
      },
    };
  };
  const overName = moveOver ? (moveOver.startsWith("crumb:") ? crumbs.find((c) => c.place === moveOver.slice(6))?.name : shown.find((x) => x.key === moveOver)?.name) : undefined;
  const row = (r: FileRow, i: number, style?: React.CSSProperties) => {
    const on = sel.set.has(r.key);
    // The row's own grid is the child of MenuRow's wrapper (a column View), so every cell sits on the one line.
    return (
      <div key={r.key} style={style}>
        <MenuRow items={menuFor(r)}>{(menu) => (
          <div role="row" aria-selected={on} onClick={(e) => click(r, i, e)} onDoubleClick={() => open(r)} {...dragProps(r)} onContextMenu={(e) => rightClick(r, i, e)} ref={(el) => { rowEls.current[r.key] = el; }}
            style={{ display: "grid", gridTemplateColumns: GRID_COLS, alignItems: "center", columnGap: 12, height: ROW_H, boxSizing: "border-box", padding: "0 12px", cursor: "pointer", background: on || moveOver === r.key ? "var(--surface-3)" : "transparent", opacity: dragRows?.some((x) => x.key === r.key) ? 0.5 : 1, outline: moveOver === r.key ? "2px solid var(--edge-strong)" : i === focus ? "1px solid var(--edge-strong)" : "none", outlineOffset: -1 }}>
            <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}><Icon name={ICON[r.kind] as never} tone="text-2" size={18} /><div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Text strong={r.dir} numberOfLines={1}>{r.name}</Text></div></div>
            {showDetail ? null : <div style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><Text size="caption" tone="muted" numberOfLines={1}>{KIND_WORD[r.kind]}</Text></div>}
            <div style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden" }}><Text size="caption" tone="muted" numberOfLines={1}>{when(r.modified)}</Text></div>
            <div style={{ minWidth: 0, textAlign: "right", whiteSpace: "nowrap" }}><Text size="caption" tone="muted">{r.dir ? "" : sizeWord(r.size)}</Text></div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>{menu}</div>
          </div>
        )}</MenuRow>
      </div>
    );
  };
  const head = (id: Sort["key"], label: string, right?: boolean) => (
    <div onClick={() => setSort(nextSort(sort, id))} style={{ cursor: "pointer", userSelect: "none", textAlign: right ? "right" : "left", minWidth: 0 }}>
      <Text size="caption" strong tone="label">{label}{sort.key === id ? (sort.dir === "asc" ? "  \u25B2" : "  \u25BC") : ""}</Text>
    </div>
  );
  const BIG = 200;
  const emptyState = (
    <View className="gap-s3">
    <Card flush><EmptyState title={q || chips.length ? "Nothing matches" : "This folder is empty"} body={q || chips.length ? "Nothing in this folder fits the search." : ability.upload ? "Add a file, or drop one here." : "Nothing is here, or everything in it is kept away from you."}
      action={!q && !chips.length && uploadButton ? { label: "Upload", onPress: pickUpload } : undefined} /></Card>
    {!q && !chips.length && folderButton ? <View className="flex-row">{folderButton}</View> : null}
    </View>
  );

  const main = place.startsWith("site:") ? <SitePage name={place.slice(5)} onBack={() => go("space")} />
    : root === "shared" ? <View className="gap-s3"><SharedLinks refresh={0} /></View>
    : root === "computer" ? <ComputerPage status={status} reload={loadRoots} />
    : err ? <Card flush><ErrorState title="This folder did not open" reason={err} retry={() => load(place)} /></Card>
    : rows === null ? <LoadingState rows={4} />
    : !shown.length ? emptyState
    : view === "grid" ? (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))", gap: 14 }}>
        {shown.map((r, i) => (
          <div key={r.key} data-tile onClick={(e) => click(r, i, e)} onDoubleClick={() => open(r)} {...dragProps(r)} onContextMenu={(e) => rightClick(r, i, e)} ref={(el) => { rowEls.current[r.key] = el; }} style={{ cursor: "pointer", borderRadius: 14, padding: "20px 12px 12px", textAlign: "center", border: "1px solid var(--edge)", opacity: dragRows?.some((x) => x.key === r.key) ? 0.5 : 1, outline: moveOver === r.key ? "2px solid var(--edge-strong)" : "none", background: sel.set.has(r.key) || moveOver === r.key ? "var(--surface-3)" : "var(--surface-2)" }}>
            <div style={{ display: "flex", justifyContent: "center", height: 56, alignItems: "center" }}><Thumb row={r} fallback={ICON[r.kind]} /></div>
            <div style={{ marginTop: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Text size="caption" strong>{r.name}</Text></div>
            <Text size="caption" tone="faint">{r.dir ? when(r.modified) : [sizeWord(r.size), when(r.modified)].filter(Boolean).join(", ")}</Text>
          </div>
        ))}
      </div>
    ) : (
      <Card flush>
        <div role="row" style={{ display: "grid", gridTemplateColumns: GRID_COLS, columnGap: 12, padding: "10px 12px 8px" }}>
          {head("name", "Name")}{showDetail ? null : head("kind", "Kind")}{head("modified", "Modified")}{head("size", "Size", true)}<div />
        </div>
        <Divider />
        {shown.length > BIG ? (
          <div ref={scroller} style={{ height: 480, overflow: "auto" }}>
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {virt.getVirtualItems().map((v) => row(shown[v.index], v.index, { position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` }))}
            </div>
          </div>
        ) : <div>{shown.map((r, i) => row(r, i))}</div>}
      </Card>
    );

  return (
    <Frame title="Files">
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }} onKeyDown={onKey} tabIndex={0}>
        <div style={{ flex: 1, minWidth: 0 }} onDragOver={(e) => { if (carriesFiles(e.dataTransfer) && targetNow()) { e.preventDefault(); setDropping(true); } }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setDropping(false); setOverRow(null); } }}
          onDrop={(e) => { if (!carriesFiles(e.dataTransfer)) return; const t = targetNow(); setDropping(false); setOverRow(null); if (t) { e.preventDefault(); void uploadTo(t as unknown as Place, Array.from(e.dataTransfer.files), t.place === place ? rows : null); } }}>
          <View className="gap-s3">
            <View className="flex-row items-center gap-s3">
              <View className="min-w-0 flex-1"><Breadcrumb crumbs={crumbs.map((c) => ({ name: c.name, key: c.place }))} onPress={go} wrap={(key, node) => <div {...crumbDrop(key, crumbs.find((c) => c.place === key)?.name ?? "")} style={{ borderRadius: 6, padding: "0 2px", outline: moveOver === `crumb:${key}` ? "2px solid var(--edge-strong)" : "none", background: moveOver === `crumb:${key}` ? "var(--surface-3)" : "transparent" }}>{node}</div>} /></View>
              <View className="flex-row items-center gap-s2">
                {uploadButton}
                {folderButton}
                <IconButton icon="list" label="Show as a list" kind={view === "list" ? "secondary" : "ghost"} onPress={() => setView("list")} />
                <IconButton icon="grid" label="Show as a grid" kind={view === "grid" ? "secondary" : "ghost"} onPress={() => setView("grid")} />
              </View>
            </View>
            {root === "space" || place === "recent" ? <View className="flex-row"><Segmented label="Search in" value={scopeAll ? "all" : "here"} onChange={(v: string) => setScopeAll(v === "all")} options={[["here", "This folder"], ["all", "All files"]]} /></View> : null}
            {newName !== null ? (
              <div onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void makeFolder(); } else if (e.key === "Escape") { e.stopPropagation(); setNewName(null); } }}>
                <Card><View className="gap-s2">
                  <Field label="Folder name" value={newName} onChangeText={setNewName} placeholder="New folder" autoFocus onSubmit={() => { void makeFolder(); }} />
                  <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Make folder" onPress={() => { void makeFolder(); }} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setNewName(null)} /></View>
                </View></Card>
              </div>
            ) : null}
            <ListHeader onSearch={() => openFind("files")} noun={(rows?.length ?? 0) === 1 ? "item" : "items"} shown={shown.length} total={rows?.length ?? 0} query={q} onQuery={setQ} chips={chips} onChips={setChips} def={FILE_DEF} ctx={{}} title={null} />
            {bar.length ? (
              <Card><View className="flex-row flex-wrap items-center gap-s2"><Text strong>{picked.length} selected</Text>{bar.map((a) => <Button key={a.id} kind={a.id === "delete" ? "holdText" : "ghost"} size="sm" label={a.label} onPress={() => runBulk(a.id)} />)}<Button kind="ghost" size="sm" label="Clear" onPress={() => setSel({ set: new Set(), anchor: null })} /></View></Card>
            ) : null}
            <div onMouseDown={startBox} onContextMenu={(e) => { if (canMakeFolder && !(e.target as HTMLElement).closest("[role=row],[data-tile]")) { e.preventDefault(); setBgMenu({ x: e.clientX, y: e.clientY }); } }} style={{ position: "relative", minHeight: 240, outline: dropping ? "2px solid var(--edge-strong)" : "none", outlineOffset: 4, borderRadius: 14, background: dropping ? "var(--surface-2)" : "transparent", transition: "background 120ms" }}>
              {moveOver && dragRows && overName ? <div style={{ position: "absolute", top: 8, left: 0, right: 0, display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 2 }}><div style={{ padding: "6px 14px", borderRadius: 999, background: "var(--surface-3)", border: "1px solid var(--edge)" }}><Text size="caption" strong>{dragWords(dragRows, overName)}</Text></div></div> : null}
              {dropping ? <div style={{ position: "absolute", top: 8, left: 0, right: 0, display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 2 }}><div style={{ padding: "6px 14px", borderRadius: 999, background: "var(--surface-3)", border: "1px solid var(--edge)" }}><Text size="caption" strong>{dropWords(targetNow(), (f) => (f.place === place ? crumbs[crumbs.length - 1]?.name ?? "this folder" : rows?.find((r) => r.key === overRow)?.name ?? f.path))}</Text></div></div> : null}
              {main}
            </div>
          </View>
        </div>
        {showDetail ? <div style={{ width: 320, flex: "none", maxHeight: 640, overflow: "auto" }}><Detail row={one} ability={ability} onChanged={() => load(place)} /></div> : null}
      </div>
      <Sheet open={publishing !== null} onClose={() => setPublishing(null)} title="Publish this folder as a site">
        {publishing ? (
          <View className="gap-s3">
            <Text tone="muted">{`Builds a draft from ${publishing.row.name}. Nothing is public until you publish it from the site's page.`}</Text>
            <Field label="Site name" value={publishing.name} onChangeText={(name: string) => setPublishing({ ...publishing, name })} placeholder="spring-landing" />
            <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Make the draft" onPress={() => {
              const b = buildSite({ ...BLANK, name: publishing.name, kind: "drive", ref: publishing.row.path });
              if ("error" in b) { showToast(b.error); return; }
              createSite(b.input).then(() => { showToast("Draft made."); setPublishing(null); invalidate(); go(`site:${b.input.name}`); }).catch((e) => showToast(publishRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "")));
            }} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setPublishing(null)} /></View>
          </View>
        ) : null}
      </Sheet>
      {bgMenu ? <FileContextMenu groups={[[{ id: "newfolder", label: "New folder" }]]} at={bgMenu} onPick={() => setNewName("")} onClose={() => setBgMenu(null)} /> : null}
      {menu ? <FileContextMenu groups={fileMenu(menuRows)} at={menu.at} onPick={(id) => doAction(id, menuRows)} onClose={() => setMenu(null)} /> : null}
      {box ? <div style={{ position: "fixed", left: Math.min(box.x1, box.x2), top: Math.min(box.y1, box.y2), width: Math.abs(box.x2 - box.x1), height: Math.abs(box.y2 - box.y1), border: "1px solid var(--edge-strong)", background: "var(--surface-3)", opacity: 0.5, pointerEvents: "none", zIndex: 50, borderRadius: 4 }} /> : null}
      <QuickLookSheet row={shown.find((r) => r.key === look.open) ?? null} shown={shown} onClose={() => setLook({ open: null })} />
      <MoveDelete dialog={dialog} onClose={() => setDialog(null)} onDone={(line, undos) => { setDialog(null); invalidate(); showToast(line, undos.length ? { label: "Undo", run: () => { void Promise.all(undos.map((u) => driveTool(u.tool, u.input))).then(() => { showToast("Put back."); invalidate(); }).catch((e) => showToast(say(e))); } } : undefined); }} />
    </Frame>
  );
}

async function bytesFor(r: FileRow): Promise<string> {
  if (r.root === "space") return (await spaceRead(undefined, r.path)).base64;
  if (r.root === "linked" && r.link) return (await linked.read(r.link, r.path)).base64;
  throw Object.assign(new Error("There is no whole-file download for this source yet."), { code: "unsupported" });
}
async function download(r: FileRow) {
  const b64 = await bytesFor(r);
  const bin = Uint8Array.from(bytesOf(b64));
  const url = URL.createObjectURL(new Blob([bin]));
  const a = document.createElement("a");
  a.href = url; a.download = r.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The right panel: the shared FileViewer for a file in the Space or a linked folder (any kind, versions, Show changes, Download, Edit for text), and for the Space the older versions to put back. */
function Detail({ row, ability, onChanged }: { row: FileRow | null; ability: ReturnType<typeof abilities>; onChanged: () => void }) {
  const [versions, setVersions] = useState<{ id: string; line: string; restorable: boolean; ver?: number }[] | null>(null);
  useEffect(() => {
    setVersions(null);
    if (!row || row.root !== "space" || !ability.versions) return;
    let live = true;
    spaceVersions(undefined, row.path).then((v: Version[]) => live && setVersions([...v].reverse().slice(0, 6).map((x, k) => ({ id: String(x.ver), line: `v${x.ver}${k === 0 ? " (current)" : ""}, ${when(x.at)}`, restorable: k > 0, ver: x.ver })))).catch(() => live && setVersions([]));
    return () => { live = false; };
  }, [row?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const router = useRouter();
  if (!row) return <Card><EmptyState title="Select a file" body="Its preview, versions and details show here." /></Card>;
  const source = row.root === "space" ? driveSource(row.path) : row.root === "linked" && row.link ? linkedFileSource(row.link, row.path) : null;
  const a = abilities(row.root);
  const lines = detailLines(row, { where: row.root === "space" ? (row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : "All files") : rootLabel(row.root), when, versions: versions ? versions.length : undefined });
  return (
    <View className="gap-s3">
      <Card>
        <View className="flex-row flex-wrap items-center gap-s2">
          {!row.dir ? <Button kind="primary" size="sm" label="Ask about this" onPress={() => { void startThread(router, "assistant", `#${row.name} `, `About ${row.name}`, row.root === "space" ? [{ kind: "space", id: row.path, name: row.name }] : row.root === "linked" && row.link ? [{ kind: "linked", id: `${row.link}:${row.path}`, name: row.name }] : undefined); }} /> : null}
          {!row.dir && a.share && row.root === "space" ? <Button kind="ghost" size="sm" icon="share" label="Share" onPress={() => { linkCreate(undefined, row.path).then(() => showToast("Link made. It is under Shared.")).catch((e) => showToast(say(e))); }} /> : null}
          {!row.dir && a.download && (row.root === "space" || row.root === "linked") ? <Button kind="ghost" size="sm" icon="download" label="Download" onPress={() => { download(row).catch((e) => showToast(say(e))); }} /> : null}
        </View>
        {lines.map((l) => <View key={l.k} className="flex-row gap-s2"><View style={{ width: 96 }}><Text size="caption" tone="label">{l.k}</Text></View><View className="min-w-0 flex-1"><Text size="caption">{l.v}</Text></View></View>)}
      </Card>
      {source ? <FileViewer key={row.key} name={row.path} source={source} onSaved={onChanged} /> : (
        <Card><View className="gap-s2"><Text strong numberOfLines={2}>{row.name}</Text><Text size="caption" tone="muted">{[KIND_WORD[row.kind], sizeWord(row.size), when(row.modified)].filter(Boolean).join(", ")}</Text><Text tone="muted" size="caption">Files on your server open as text from the older Files tabs on a phone; there is no preview here yet.</Text></View></Card>
      )}
      {versions && versions.length > 1 ? (
        <Card flush>{versions.map((v, k) => <View key={v.id}>{k ? <Divider /> : null}<Row dense title={v.line} end={v.restorable && v.ver ? <Button size="sm" kind="ghost" label="Put back" onPress={() => spaceRestore(undefined, row.path, v.ver!).then((r) => { showToast(`Version ${v.ver} is back as version ${r.version}.`); onChanged(); }).catch((e) => showToast(say(e)))} /> : undefined} /></View>)}</Card>
      ) : null}
    </View>
  );
}

/** Move (linked folders) and delete (linked folders): the person says where, or says yes. */
function MoveDelete({ dialog, onClose, onDone }: { dialog: { kind: "move" | "delete" | "rename"; rows: FileRow[] } | null; onClose: () => void; onDone: (line: string, undos: { tool: string; input: Record<string, unknown> }[]) => void }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setTo(dialog?.kind === "rename" ? dialog.rows[0].name : ""); setErr(""); }, [dialog]);
  if (!dialog) return <Sheet open={false} onClose={onClose} title="" children={null} />;
  const run = () => {
    setBusy(true); setErr("");
    let rowsToRun = dialog.rows;
    if (dialog.kind === "move") {
      const first = dialog.rows[0], where = movePlan(dialog.rows, { root: first.root, path: to.trim().replace(/^\/+|\/+$/g, ""), ...(first.link ? { link: first.link } : {}) });
      if (!where.go.length) { setErr(where.said); setBusy(false); return; }
      rowsToRun = dialog.rows.filter((r) => where.go.includes(r));
    }
    const plans = rowsToRun.map((r) => ({ r, c: editCalls(dialog.kind, { root: r.root, path: r.path, name: r.name, link: r.link }, to) }));
    if (plans.some((x) => !x.c)) { setErr("A box share is read-only, so it cannot be moved, renamed or deleted from here."); setBusy(false); return; }
    // one at a time: a refusal stops the rest, and what already moved is named in the toast with its undo
    (async () => {
      const done: NonNullable<ReturnType<typeof editCalls>>[] = [];
      try { for (const p of plans) { await driveTool(p.c!.call.tool, p.c!.call.input); done.push(p.c!); } }
      finally {
        const undos = done.map((d) => d.undo).filter((u): u is NonNullable<typeof u> => Boolean(u));
        if (done.length) onDone(dialog.kind === "move" ? movedLine(done.length, to.trim().replace(/^\/+|\/+$/g, "").split("/").pop() || "the top", dialog.rows.length - rowsToRun.length) : `${dialog.kind === "delete" ? "Deleted" : "Renamed"} ${done.length === 1 ? "1 item" : `${done.length} items`}.`, undos);
      }
    })().catch((e) => setErr(say(e))).finally(() => setBusy(false));
  };
  const n = dialog.rows.length;
  return (
    <Sheet open onClose={onClose} title={dialog.kind === "rename" ? "Rename" : dialog.kind === "move" ? `Move ${n} ${n === 1 ? "item" : "items"}` : `Delete ${n} ${n === 1 ? "item" : "items"}`}>
      <View className="gap-s3">
        {dialog.kind === "rename" ? <Field label="New name" value={to} onChangeText={setTo} />
          : dialog.kind === "move"
          ? (takesMoves(dialog.rows[0])
            ? <FolderPicker root={dialog.rows[0].root === "linked" ? "linked" : "space"} link={dialog.rows[0].link} moving={dialog.rows} value={to} onChange={setTo} />
            : <Text>A box share is read-only, so it cannot be moved from here.</Text>)
          : <Text>{dialog.rows.some((r) => r.root === "space") ? "Deleted files stay in the Drive as a version: Version history brings one back. Folders delete the files inside them." : "It is deleted at the source, which keeps it in its own trash where it has one. Nothing else changes."}</Text>}
        {err ? <Banner tone="warn"><Text>{err}</Text></Banner> : null}
        <View className="flex-row gap-s2"><Button kind="primary" size="sm" label={busy ? "Working" : dialog.kind === "rename" ? "Rename" : dialog.kind === "move" ? "Move" : "Delete"} onPress={busy ? () => {} : run} /><Button kind="ghost" size="sm" label="Cancel" onPress={onClose} /></View>
      </View>
    </Sheet>
  );
}

/** The full-size look at one file (Space or a double click): a card with the file's icon, name, kind and size shows first and stays, so the sheet is never blank while the shared FileViewer reads and draws it (image, PDF,
 *  video, audio, text, code, markdown, documents and sheets; anything else is a card with Download). The neighbours of the open file are read in the background so the arrow keys open the next one at once. */
function QuickLookSheet({ row, shown, onClose }: { row: FileRow | null; shown: FileRow[]; onClose: () => void }) {
  useEffect(() => {
    if (!row) return;
    const files = shown.filter((r) => !r.dir && r.root === "space");
    const i = files.findIndex((r) => r.key === row.key);
    for (const n of [files[i + 1], files[i - 1], files[i + 2]]) if (n) warm(n.path, n.size);
  }, [row?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!row) return <Sheet open={false} onClose={onClose} title="" children={null} />;
  const source = row.root === "space" ? driveSource(row.path) : row.root === "linked" && row.link ? linkedFileSource(row.link, row.path) : null;
  return (
    <Sheet open onClose={onClose} title={row.name}>
      <View className="gap-s3">
        <View className="flex-row items-center gap-s3">
          <Icon name={ICON[row.kind] as never} tone="text-2" size={28 as never} />
          <View className="min-w-0 flex-1"><Text strong numberOfLines={1}>{row.name}</Text><Text size="caption" tone="muted">{[KIND_WORD[row.kind], sizeWord(row.size), when(row.modified)].filter(Boolean).join(", ")}</Text></View>
          {source && (row.root === "space" || row.root === "linked") ? <Button kind="ghost" size="sm" icon="download" label="Download" onPress={() => { download(row).catch((e) => showToast(say(e))); }} /> : null}
        </View>
        {source ? <FileViewer key={row.key} name={row.path} source={source} /> : <Card><Text tone="muted">There is no preview for this source yet.</Text></Card>}
      </View>
    </Sheet>
  );
}
