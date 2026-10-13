// Files on the web: a real file manager. A folder tree on the left (react-arborist: Space, Shared, Linked, On your server, On your computer), the open folder in the middle as a list or a grid
// (@tanstack/react-table for the columns, @tanstack/react-virtual for the rows), breadcrumbs and a search above it, multi-select with a bulk bar, and a detail panel on the right. Every read
// and write is an existing files.* tool (files-real.ts); what a source cannot do is not offered (files-model.ts abilities). The detail panel's preview is a slot: native-mount's FileViewer
// takes it over; until then small text files show as text. Narrow screens keep the Drive screen with its tabs.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { Tree, type NodeRendererProps } from "react-arborist";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, Field, IconTile, ListHeader, LoadingState, Row, Segmented, Sheet, Text, listRows, showToast, type FilterChip } from "@vyre/ui";
import { Frame } from "../places/Frame";
import RealDrive from "./RealDrive";
import { SharedLinks } from "./SharedLinks";
import { Breadcrumb } from "./Breadcrumb";
import { MenuRow } from "../../ui/blocks/RowMenu";
import { abilities, bulkActions, crumbsFor, moveFocus, nextSort, parentPlace, parsePlace, prune, rootsOf, selectAll, selectOnly, selectRange, selectToggle, sortRows, type FileRow, type Selection, type Sort, type TreeNode } from "./files-model.ts";
import { linkedNames, loader } from "./files-real";
import { linked, spaceRead, spaceRestore, spaceVersions, statusReal, linkCreate } from "./real";
import { bytesOf, sizeWord, textOf, type Status } from "./real-model";
import { driveRefusal } from "./real-model";
import { linkedRefusal, type LinkedFolder, type LinkedVersion } from "./linked-model";
import { dayOf, spaceDriveRefusal, type Version } from "./space-model";

const say = (e: unknown) => { const x = e as { code?: string }; const m = e instanceof Error ? e.message : ""; return x.code === "conflict" || x.code === "unsupported" ? linkedRefusal(x.code, m) : spaceDriveRefusal(x.code, m) || driveRefusal(x.code, m); };
const ROW_H = 40, TREE_H = 560;
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
  const [place, setPlace] = useState("space");
  const [folders, setFolders] = useState<LinkedFolder[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [kids, setKids] = useState<Record<string, TreeNode[]>>({});
  const [rows, setRows] = useState<FileRow[] | null>(null);
  const [err, setErr] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });
  const [q, setQ] = useState("");
  const [chips, setChips] = useState<FilterChip[]>([]);
  const [view, setView] = useState<"list" | "grid">("list");
  const [sel, setSel] = useState<Selection>({ set: new Set(), anchor: null });
  const [focus, setFocus] = useState(-1);
  const [dialog, setDialog] = useState<{ kind: "move" | "delete" | "rename"; rows: FileRow[] } | null>(null);

  // the roots: linked folders and box shares
  const loadRoots = useCallback(() => {
    linked.list().then((fs) => { fs.forEach((f) => { linkedNames[f.id] = f.name; }); setFolders(fs); }).catch(() => setFolders([]));
    statusReal().then(setStatus).catch(() => setStatus(null));
  }, []);
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
    loader.rows(p).then((r) => { setRows(r); setKids((k) => ({ ...k, [p]: r.filter((x) => x.dir).map((x) => ({ id: x.place, label: x.name, root: x.root, kids: [] })) })); }).catch((e) => { setErr(say(e)); setRows([]); });
  }, [folders, status]);
  useEffect(() => { load(place); setSel({ set: new Set(), anchor: null }); setFocus(-1); }, [place, load]);

  const go = (p: string) => { setQ(""); setChips([]); setPlace(p); };

  const shown = useMemo(() => {
    const recs = (rows ?? []).map((row) => ({ row, data: { name: row.name, kind: KIND_WORD[row.kind] }, created_at: row.modified ? new Date(row.modified).toISOString() : undefined }));
    return sortRows((listRows(FILE_DEF, recs, chips, q) as typeof recs).map((x) => x.row), sort.key, sort.dir);
  }, [rows, q, chips, sort]);
  const keys = useMemo(() => shown.map((r) => r.key), [shown]);
  useEffect(() => { setSel((s) => prune(s, keys)); }, [keys]);
  const picked = shown.filter((r) => sel.set.has(r.key));
  const one = picked.length === 1 && !picked[0].dir ? picked[0] : null;

  // the tree
  const treeData = useMemo(() => {
    const roots = rootsOf({ linked: folders, shares: status?.shares ?? [] });
    const withKids = (n: TreeNode): TreeNode => {
      const loaded = kids[n.id];
      const own = n.kids;
      const list = loaded ?? own ?? (n.root === "space" || n.id.includes(":") ? [] : undefined);
      return list ? { ...n, kids: list.map(withKids) } : n;
    };
    return roots.map((r) => (r.id === "space" ? { ...r, kids: (kids.space ?? []).map(withKids) } : withKids(r)));
  }, [folders, status, kids]);
  const openNode = (id: string) => { if (!kids[id] && !["shared", "computer", "linked", "box"].includes(id)) loader.dirs(id).then((d) => setKids((k) => ({ ...k, [id]: d }))).catch(() => {}); };
  useEffect(() => { if (!kids.space) openNode("space"); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = ({ dragIds, parentId }: { dragIds: string[]; parentId: string | null }) => {
    const to = parentId ? parsePlace(parentId) : null;
    if (!to || to.root !== "linked" || !to.link) { showToast("Only linked folders move files."); return; }
    Promise.all(dragIds.map((id) => { const f = parsePlace(id); if (!f || f.root !== "linked" || f.link !== to.link) return Promise.reject(new Error("Files move within one linked folder.")); const name = f.path.split("/").pop()!; return linked.rename(to.link!, f.path, to.path ? `${to.path}/${name}` : name); }))
      .then(() => { showToast("Moved at the source."); load(place); setKids({}); }).catch((e) => showToast(say(e)));
  };

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

  // columns
  const columns = useMemo<ColumnDef<FileRow>[]>(() => [
    { id: "name", header: "Name", accessorKey: "name", cell: (c) => <Cell r={c.row.original} /> },
    { id: "kind", header: "Kind", accessorFn: (r) => KIND_WORD[r.kind], size: 110 },
    { id: "modified", header: "Modified", accessorFn: (r) => when(r.modified), size: 130 },
    { id: "size", header: "Size", accessorFn: (r) => (r.dir ? "" : sizeWord(r.size)), size: 90 },
  ], []);
  const table = useReactTable({ data: shown, columns, getCoreRowModel: getCoreRowModel(), getRowId: (r) => r.key });
  const scroller = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 8 });

  const crumbs = parsed ? crumbsFor(parsed, { linked: linkedNames }) : [];
  const bar = bulkActions(root, picked.length);
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

  const main = root === "shared" ? <View className="gap-s3"><SharedLinks refresh={0} /></View>
    : root === "computer" ? <Card>{status ? <View className="gap-s2"><Text strong>{status.enabled ? "Sharing to your computer is on" : "Sharing to your computer is off"}</Text>{status.why ? <Text tone="muted">{status.why}</Text> : null}{status.fix ? <Text tone="label">{status.fix}</Text> : null}</View> : <LoadingState rows={2} />}</Card>
    : err ? <Card flush><ErrorState title="This folder did not open" reason={err} retry={() => load(place)} /></Card>
    : rows === null ? <LoadingState rows={4} />
    : !shown.length ? <Card flush><EmptyState title={q ? "Nothing matches" : "Nothing here"} body={q ? "No name in this folder has all of those words." : "This folder is empty, or everything in it is kept away from you."} /></Card>
    : view === "grid" ? (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
        {shown.map((r, i) => (
          <div key={r.key} onClick={(e) => click(r, i, e)} onDoubleClick={() => open(r)} style={{ cursor: "pointer", borderRadius: 12, padding: 12, border: "1px solid var(--edge, rgba(128,128,128,.25))", outline: sel.set.has(r.key) ? "2px solid var(--accent, #6b5cff)" : "none" }}>
            <IconTile name={ICON[r.kind] as never}  />
            <div style={{ marginTop: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Text size="caption" strong>{r.name}</Text></div>
            <Text size="caption" tone="faint">{r.dir ? when(r.modified) : [sizeWord(r.size), when(r.modified)].filter(Boolean).join(", ")}</Text>
          </div>
        ))}
      </div>
    ) : (
      <Card flush>
        <div style={{ display: "flex", padding: "8px 16px" }}>
          {table.getHeaderGroups()[0].headers.map((h) => (
            <div key={h.id} onClick={() => setSort(nextSort(sort, h.id as Sort["key"]))} style={{ flex: h.id === "name" ? 1 : "none", width: h.id === "name" ? undefined : h.getSize(), cursor: "pointer", userSelect: "none" }}>
              <Text size="caption" strong tone="label">{flexRender(h.column.columnDef.header, h.getContext())}{sort.key === h.id ? (sort.dir === "asc" ? "  ▲" : "  ▼") : ""}</Text>
            </div>
          ))}
        </div>
        <Divider />
        <div ref={scroller} style={{ height: Math.min(shown.length * ROW_H, TREE_H - 60), overflow: "auto" }}>
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((v) => {
              const row = table.getRowModel().rows[v.index]; const r = row.original; const on = sel.set.has(r.key);
              return (
                <div key={row.id} onClick={(e) => click(r, v.index, e)} onDoubleClick={() => open(r)}
                  style={{ position: "absolute", top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${v.start}px)`, display: "flex", alignItems: "center", padding: "0 16px", cursor: "pointer", background: on ? "var(--surface-3, rgba(128,128,255,.14))" : "transparent", outline: v.index === focus ? "1px solid var(--accent, #6b5cff)" : "none" }}>
                  <MenuRow items={menuFor(r)}>{(menu) => (<>
                  {row.getVisibleCells().map((c) => (
                    <div key={c.id} style={{ flex: c.column.id === "name" ? 1 : "none", width: c.column.id === "name" ? undefined : c.column.getSize(), minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.column.id === "name" ? flexRender(c.column.columnDef.cell, c.getContext()) : <Text size="caption" tone="muted">{String(c.getValue() ?? "")}</Text>}
                    </div>
                  ))}
                  <div style={{ flex: "none", width: 36 }}>{menu}</div></>)}</MenuRow>
                </div>
              );
            })}
          </div>
        </div>
      </Card>
    );

  return (
    <Frame title="Files" sub="The space's files with their versions, linked folders, and your server's folders.">
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }} onKeyDown={onKey} tabIndex={0}>
        <div style={{ width: 252, flex: "none" }}>
          <Card flush>
            <Tree<TreeNode> data={treeData} childrenAccessor="kids" idAccessor="id" width={252} height={TREE_H} rowHeight={32} indent={14} openByDefault={false} selection={place}
              disableDrag={(n) => n.root !== "linked" || !n.id.includes(":")} disableDrop={(a) => !(a.parentNode?.data?.root === "linked" && a.parentNode.data.id.includes(":")) } disableEdit
              onSelect={(ns) => { if (ns[0]) go(ns[0].id); }} onToggle={(id) => openNode(id)} onMove={onMove}>
              {TreeRow}
            </Tree>
          </Card>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <View className="gap-s3">
            <ListHeader noun="items" shown={shown.length} total={rows?.length ?? 0} query={q} onQuery={setQ} chips={chips} onChips={setChips} def={FILE_DEF} ctx={{}}
              title={
                <Breadcrumb crumbs={crumbs.map((c) => ({ name: c.name, key: c.place }))} onPress={go} end={<Segmented<"list" | "grid"> value={view} onChange={setView} options={[["list", "List"], ["grid", "Grid"]]} />} />
              } />
            {bar.length ? (
              <Card><View className="flex-row flex-wrap items-center gap-s2"><Text strong>{picked.length} selected</Text>{bar.map((a) => <Button key={a.id} kind={a.id === "delete" ? "holdText" : "ghost"} size="sm" label={a.label} onPress={() => runBulk(a.id)} />)}<Button kind="ghost" size="sm" label="Clear" onPress={() => setSel({ set: new Set(), anchor: null })} /></View></Card>
            ) : null}
            {main}
          </View>
        </div>
        {wide || one ? (
          <div style={{ width: 320, flex: "none" }}>
            <Detail row={one} ability={ability} onChanged={() => load(place)} />
          </div>
        ) : null}
      </div>
      <MoveDelete dialog={dialog} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(place); setKids({}); }} />
    </Frame>
  );
}

function Cell({ r }: { r: FileRow }) {
  return <View className="flex-row items-center gap-s2"><IconTile name={ICON[r.kind] as never}  /><Text strong={r.dir} numberOfLines={1}>{r.name}</Text></View>;
}

function TreeRow({ node, style, dragHandle }: NodeRendererProps<TreeNode>) {
  return (
    <div style={{ ...style, display: "flex", alignItems: "center", gap: 6, paddingRight: 8, background: node.isSelected ? "var(--surface-3, rgba(128,128,255,.14))" : "transparent", borderRadius: 8, cursor: "pointer" }} ref={dragHandle}>
      <span onClick={(e) => { e.stopPropagation(); node.toggle(); }} style={{ width: 16, textAlign: "center", opacity: node.isLeaf ? 0 : 0.7 }}>{node.isOpen ? "▾" : "▸"}</span>
      <Text size="caption" numberOfLines={1}>{node.data.label}</Text>
    </div>
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

/** The right panel: what the file is, its preview (a slot for FileViewer), and its versions. */
function Detail({ row, ability, onChanged }: { row: FileRow | null; ability: ReturnType<typeof abilities>; onChanged: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [versions, setVersions] = useState<{ id: string; line: string; restorable: boolean; ver?: number }[] | null>(null);
  useEffect(() => {
    setText(null); setNote(""); setVersions(null);
    if (!row) return;
    let live = true;
    if (row.kind === "text" && row.size <= 262144 && (row.root === "space" || row.root === "linked")) bytesFor(row).then((b) => live && setText(textOf(bytesOf(b)))).catch((e) => live && setNote(say(e)));
    if (ability.versions && row.root === "space") spaceVersions(undefined, row.path).then((v: Version[]) => live && setVersions([...v].reverse().map((x, k) => ({ id: String(x.ver), line: `Version ${x.ver}${k === 0 ? ", current" : ""}, ${sizeWord(x.size)}, ${when(x.at)}`, restorable: k > 0, ver: x.ver })))).catch(() => live && setVersions([]));
    else if (ability.versions && row.root === "linked" && row.link) linked.versions(row.link, row.path).then((v: LinkedVersion[]) => live && setVersions([...v].reverse().map((x) => ({ id: x.rev, line: `${when(x.modified)}${x.by ? `, ${x.by}` : ""}`, restorable: false })))).catch(() => live && setVersions([]));
    return () => { live = false; };
  }, [row?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!row) return <Card><EmptyState title="Select a file" body="Its preview, versions and details show here." /></Card>;
  return (
    <Card>
      <View className="gap-s3">
        <View className="flex-row items-center gap-s2"><IconTile name={ICON[row.kind] as never} /><Text strong numberOfLines={2} className="flex-1">{row.name}</Text></View>
        <Text size="caption" tone="muted">{[KIND_WORD[row.kind], sizeWord(row.size), when(row.modified)].filter(Boolean).join(", ")}</Text>
        {/* The preview slot. ui/files/FileViewer (native-mount) replaces this block for every type. */}
        {text != null ? <Text mono size="caption" selectable numberOfLines={24}>{text}</Text> : <Text tone="muted" size="caption">{row.kind === "text" ? "" : "No preview here yet."}</Text>}
        {note ? <Banner tone="warn"><Text>{note}</Text></Banner> : null}
        {ability.download && (row.root === "space" || row.root === "linked") ? <View className="self-start"><Button kind="ghost" size="sm" label="Download" onPress={() => download(row).catch((e) => showToast(say(e)))} /></View> : null}
        {ability.versions ? (
          <>
            <Text size="caption" strong tone="label">Versions</Text>
            {versions === null ? <Text tone="muted">Loading.</Text> : versions.length === 0 ? <Text tone="muted">No versions listed.</Text> : (
              <Card flush>{versions.map((v, k) => <View key={v.id}>{k ? <Divider /> : null}<Row dense title={v.line} end={v.restorable && v.ver ? <Button size="sm" kind="ghost" label="Put back" onPress={() => spaceRestore(undefined, row.path, v.ver!).then((r) => { showToast(`Version ${v.ver} is back as version ${r.version}.`); onChanged(); }).catch((e) => showToast(say(e)))} /> : undefined} /></View>)}</Card>
            )}
          </>
        ) : null}
      </View>
    </Card>
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
