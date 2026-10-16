// Files on the web: a real file manager. A folder tree on the left (react-arborist: Space, Shared, Linked, On your server), the open folder in the middle as a list or a grid
// (@tanstack/react-table for the columns, @tanstack/react-virtual for the rows), breadcrumbs and a search above it, multi-select with a bulk bar, and a detail panel on the right. Every read
// and write is an existing files.* tool (files-real.ts); what a source cannot do is not offered (files-model.ts abilities). The detail panel's preview is a slot: native-mount's FileViewer
// takes it over; until then small text files show as text. Narrow screens keep the Drive screen with its tabs.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, Field, IconTile, ListHeader, LoadingState, Row, Segmented, Sheet, Text, listRows, showToast, type FilterChip, FileViewer, useVirtualRows, Icon, IconButton } from "@vyre/ui";
import { Frame } from "../places/Frame";
import RealDrive from "./RealDrive";
import { SharedLinks } from "./SharedLinks";
import { Breadcrumb } from "./Breadcrumb";
import { driveSource, linkedFileSource } from "./file-source";
import { MenuRow } from "../../ui/blocks/RowMenu";
import { abilities, bulkActions, crumbsFor, moveFocus, nextSort, parentPlace, parsePlace, prune, selectAll, selectOnly, selectRange, selectToggle, sortRows, type FileRow, type Selection, type Sort } from "./files-model.ts";
import { linkedNames, loader } from "./files-real";
import { useFilesNav } from "./files-nav";
import { linked, spaceRead, spaceRestore, spaceUpload, spaceVersions, statusReal, linkCreate } from "./real";
import { bytesOf, sizeWord, textOf } from "./real-model";
import { driveRefusal } from "./real-model";
import { linkedRefusal, type LinkedVersion } from "./linked-model";
import { dayOf, spaceDriveRefusal, toBase64, MAX_UPLOAD, type Version } from "./space-model";

const say = (e: unknown) => { const x = e as { code?: string }; const m = e instanceof Error ? e.message : ""; return x.code === "conflict" || x.code === "unsupported" ? linkedRefusal(x.code, m) : spaceDriveRefusal(x.code, m) || driveRefusal(x.code, m); };
const ROW_H = 40;
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
  const { place, folders, status, tick, go: setPlace, loadRoots, setKids, invalidate } = useFilesNav();
  const [rows, setRows] = useState<FileRow[] | null>(null);
  const [err, setErr] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });
  const [q, setQ] = useState("");
  const [chips, setChips] = useState<FilterChip[]>([]);
  const [view, setView] = useState<"list" | "grid">("list");
  const [sel, setSel] = useState<Selection>({ set: new Set(), anchor: null });
  const [focus, setFocus] = useState(-1);
  const [dialog, setDialog] = useState<{ kind: "move" | "delete" | "rename"; rows: FileRow[] } | null>(null);

  // the roots (linked folders and box shares) and the open place are shared with the sidebar tree (files-nav.ts)
  useEffect(loadRoots, [loadRoots]);

  const parsed = parsePlace(place);
  const root = parsed?.root ?? "space";
  const ability = abilities(root);

  // the open folder
  const load = useCallback((p: string) => {
    const pp = parsePlace(p);
    setErr(""); setRows(null);
    if (!pp) { setRows([]); return; }
    if (pp.root === "linked" && !pp.link) { setRows(folders.map((f) => ({ key: `linked:${f.id}`, place: `linked:${f.id}`, root: "linked" as const, name: f.name, dir: true, kind: "folder" as const, size: 0, modified: f.at, link: f.id, path: "" }))); return; }
    if (pp.root === "box" && !pp.share) { setRows((status?.shares ?? []).map((s) => ({ key: `box:${s.name}`, place: `box:${s.name}`, root: "box" as const, name: s.name, dir: true, kind: "folder" as const, size: 0, modified: 0, share: s.name, path: "" }))); return; }
    loader.rows(p).then((r) => { setRows(r); setKids(p, r.filter((x) => x.dir).map((x) => ({ id: x.place, label: x.name, root: x.root, kids: [] }))); }).catch((e) => { setErr(say(e)); setRows([]); });
  }, [folders, status]);
  useEffect(() => { load(place); setSel({ set: new Set(), anchor: null }); setFocus(-1); }, [place, load, tick]);
  useEffect(() => { setQ(""); setChips([]); }, [place]);

  const go = setPlace;

  const shown = useMemo(() => {
    const recs = (rows ?? []).map((row) => ({ row, data: { name: row.name, kind: KIND_WORD[row.kind] }, created_at: row.modified ? new Date(row.modified).toISOString() : undefined }));
    return sortRows((listRows(FILE_DEF, recs, chips, q) as typeof recs).map((x) => x.row), sort.key, sort.dir);
  }, [rows, q, chips, sort]);
  const keys = useMemo(() => shown.map((r) => r.key), [shown]);
  useEffect(() => { setSel((s) => prune(s, keys)); }, [keys]);
  const picked = shown.filter((r) => sel.set.has(r.key));
  const one = picked.length === 1 && !picked[0].dir ? picked[0] : null;

  const open = (r: FileRow) => { if (r.dir) go(r.place); else setSel(selectOnly(r.key)); };
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && /^(input|textarea)$/i.test(t.tagName)) return;
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

  const scroller = useRef<HTMLDivElement>(null);
  const virt = useVirtualRows({ count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 8 });

  const crumbs = parsed ? crumbsFor(parsed, { linked: linkedNames }) : [];
  // The bar is for several at once; one row has its "..." and the detail panel, and a bar that appears on the first click would push the rows down before the second click of a double click.
  const bar = picked.length > 1 ? bulkActions(root, picked.length) : [];
  /** The "..." of a row: only what its source really does. */
  const menuFor = (r: FileRow) => {
    const a = abilities(r.root);
    const items: { label: string; onPress: () => void; danger?: boolean }[] = [{ label: r.dir ? "Open" : "Details", onPress: () => { setSel(selectOnly(r.key)); if (r.dir) go(r.place); } }];
    if (!r.dir && a.download && (r.root === "space" || r.root === "linked")) items.push({ label: "Download", onPress: () => { download(r).catch((e) => showToast(say(e))); } });
    if (!r.dir && a.share && r.root === "space") items.push({ label: "Share a link", onPress: () => { linkCreate(undefined, r.path).then(() => showToast("Link made. It is under Shared.")).catch((e) => showToast(say(e))); } });
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
  const upload = async (files: File[]) => {
    if (!parsed || !ability.upload || !files.length) return;
    const base = parsed.path ? `${parsed.path}/` : "";
    let done = 0;
    for (const f of files) {
      if (f.size > MAX_UPLOAD) { showToast(spaceDriveRefusal("too_large", "")); continue; }
      try {
        const b64 = toBase64(new Uint8Array(await f.arrayBuffer()));
        if (parsed.root === "space") await spaceUpload(undefined, `${base}${f.name}`, b64, rows?.find((x) => !x.dir && x.name === f.name)?.ver);
        else if (parsed.root === "linked" && parsed.link) await linked.write(parsed.link, `${base}${f.name}`, b64);
        done++;
      } catch (e) { showToast(say(e)); }
    }
    if (done) { showToast(done === 1 ? "Uploaded." : `Uploaded ${done} files.`); load(place); }
  };
  const pickUpload = () => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true;
    input.onchange = () => { void upload(Array.from(input.files ?? [])); };
    input.click();
  };
  const canOpenFolder = !!parsed && (parsed.root === "space" || (parsed.root === "linked" && !!parsed.link));

  const uploadButton = ability.upload && canOpenFolder ? <Button kind="primary" size="sm" icon="upload" label="Upload" onPress={pickUpload} /> : null;
  // With the detail panel open the middle is narrower, so Kind (which the panel shows) steps aside and the rest keep their widths.
  const showDetail = !!one && (one.root === "space" || one.root === "linked" || one.root === "box");
  const GRID_COLS = showDetail ? "minmax(140px, 1fr) 104px 72px 36px" : "minmax(240px, 1fr) 120px 140px 80px 36px";
  const row = (r: FileRow, i: number, style?: React.CSSProperties) => {
    const on = sel.set.has(r.key);
    // The row's own grid is the child of MenuRow's wrapper (a column View), so every cell sits on the one line.
    return (
      <div key={r.key} style={style}>
        <MenuRow items={menuFor(r)}>{(menu) => (
          <div role="row" aria-selected={on} onClick={(e) => click(r, i, e)} onDoubleClick={() => open(r)}
            style={{ display: "grid", gridTemplateColumns: GRID_COLS, alignItems: "center", columnGap: 12, height: ROW_H, boxSizing: "border-box", padding: "0 12px", cursor: "pointer", background: on ? "var(--surface-3)" : "transparent", outline: i === focus ? "1px solid var(--edge-strong)" : "none", outlineOffset: -1 }}>
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
    <Card flush><EmptyState title={q || chips.length ? "Nothing matches" : "This folder is empty"} body={q || chips.length ? "Nothing in this folder fits the search." : ability.upload ? "Add a file, or drop one here." : "Nothing is here, or everything in it is kept away from you."}
      action={!q && !chips.length && uploadButton ? { label: "Upload", onPress: pickUpload } : undefined} /></Card>
  );

  const main = root === "shared" ? <View className="gap-s3"><SharedLinks refresh={0} /></View>
    : err ? <Card flush><ErrorState title="This folder did not open" reason={err} retry={() => load(place)} /></Card>
    : rows === null ? <LoadingState rows={4} />
    : !shown.length ? emptyState
    : view === "grid" ? (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))", gap: 14 }}>
        {shown.map((r, i) => (
          <div key={r.key} onClick={(e) => click(r, i, e)} onDoubleClick={() => open(r)} style={{ cursor: "pointer", borderRadius: 14, padding: "20px 12px 12px", textAlign: "center", border: "1px solid var(--edge)", background: sel.set.has(r.key) ? "var(--surface-3)" : "var(--surface-2)" }}>
            <div style={{ display: "flex", justifyContent: "center", height: 56, alignItems: "center" }}><Icon name={ICON[r.kind] as never} tone="text-2" size={44 as never} /></div>
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
        <div style={{ flex: 1, minWidth: 0 }} onDragOver={(e) => { if (ability.upload && canOpenFolder) { e.preventDefault(); setDropping(true); } }} onDragLeave={() => setDropping(false)}
          onDrop={(e) => { if (ability.upload && canOpenFolder) { e.preventDefault(); setDropping(false); void upload(Array.from(e.dataTransfer.files)); } }}>
          <View className="gap-s3">
            <View className="flex-row items-center gap-s3">
              <View className="min-w-0 flex-1"><Breadcrumb crumbs={crumbs.map((c) => ({ name: c.name, key: c.place }))} onPress={go} /></View>
              <View className="flex-row items-center gap-s2">
                {uploadButton}
                <IconButton icon="list" label="Show as a list" kind={view === "list" ? "secondary" : "ghost"} onPress={() => setView("list")} />
                <IconButton icon="grid" label="Show as a grid" kind={view === "grid" ? "secondary" : "ghost"} onPress={() => setView("grid")} />
              </View>
            </View>
            <ListHeader noun={(rows?.length ?? 0) === 1 ? "item" : "items"} shown={shown.length} total={rows?.length ?? 0} query={q} onQuery={setQ} chips={chips} onChips={setChips} def={FILE_DEF} ctx={{}} title={null} />
            {bar.length ? (
              <Card><View className="flex-row flex-wrap items-center gap-s2"><Text strong>{picked.length} selected</Text>{bar.map((a) => <Button key={a.id} kind={a.id === "delete" ? "holdText" : "ghost"} size="sm" label={a.label} onPress={() => runBulk(a.id)} />)}<Button kind="ghost" size="sm" label="Clear" onPress={() => setSel({ set: new Set(), anchor: null })} /></View></Card>
            ) : null}
            <div style={{ outline: dropping ? "2px dashed var(--edge-strong)" : "none", outlineOffset: 4, borderRadius: 14 }}>{main}</div>
          </View>
        </div>
        {showDetail ? <div style={{ width: 320, flex: "none", maxHeight: 640, overflow: "auto" }}><Detail row={one} ability={ability} onChanged={() => load(place)} /></div> : null}
      </div>
      <MoveDelete dialog={dialog} onClose={() => setDialog(null)} onDone={() => { setDialog(null); invalidate(); }} />
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
  if (!row) return <Card><EmptyState title="Select a file" body="Its preview, versions and details show here." /></Card>;
  const source = row.root === "space" ? driveSource(row.path) : row.root === "linked" && row.link ? linkedFileSource(row.link, row.path) : null;
  return (
    <View className="gap-s3">
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
function MoveDelete({ dialog, onClose, onDone }: { dialog: { kind: "move" | "delete" | "rename"; rows: FileRow[] } | null; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setTo(dialog?.kind === "rename" ? dialog.rows[0].name : ""); setErr(""); }, [dialog]);
  if (!dialog) return <Sheet open={false} onClose={onClose} title="" children={null} />;
  const run = () => {
    setBusy(true); setErr("");
    Promise.all(dialog.rows.map((r) => {
      if (r.root !== "linked" || !r.link) return Promise.reject(new Error("Only linked folders do that."));
      if (dialog.kind === "delete") return linked.remove(r.link, r.path);
      const dest = to.trim().replace(/^\/+|\/+$/g, "");
      if (dialog.kind === "rename") { const up = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/") + 1) : ""; return linked.rename(r.link, r.path, `${up}${dest}`); }
      return linked.rename(r.link, r.path, dest ? `${dest}/${r.name}` : r.name);
    })).then(onDone).catch((e) => setErr(say(e))).finally(() => setBusy(false));
  };
  const n = dialog.rows.length;
  return (
    <Sheet open onClose={onClose} title={dialog.kind === "rename" ? "Rename" : dialog.kind === "move" ? `Move ${n} ${n === 1 ? "item" : "items"}` : `Delete ${n} ${n === 1 ? "item" : "items"}`}>
      <View className="gap-s3">
        {dialog.kind === "rename" ? <Field label="New name" value={to} onChangeText={setTo} />
          : dialog.kind === "move"
          ? <Field label="Move into this folder" value={to} onChangeText={setTo} placeholder="Folder path inside the linked folder, empty for its top" />
          : <Text>It is deleted at the source, which keeps it in its own trash where it has one. Nothing else changes.</Text>}
        {err ? <Banner tone="warn"><Text>{err}</Text></Banner> : null}
        <View className="flex-row gap-s2"><Button kind="primary" size="sm" label={busy ? "Working" : dialog.kind === "rename" ? "Rename" : dialog.kind === "move" ? "Move" : "Delete"} onPress={busy ? () => {} : run} /><Button kind="ghost" size="sm" label="Cancel" onPress={onClose} /></View>
      </View>
    </Sheet>
  );
}
