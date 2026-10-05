// Glass's Files tab: the folders of an agent's computer (or of the box), with preview, download, upload, new folder, rename or move, and trash. Every write says what happened in plain words.
// Bytes move on the box's own routes with a one-time ticket (transfer.ts); everything else is a tool call.
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Text, showToast } from "@vyre/ui";
import { glass } from "./source-real";
import { NO_PREVIEW, crumbs, errText, foldersFor, join, leaf, parent, rootLabel, size, stamp, uploadedLine, type Entry, type Preview } from "./model";
import { imageUrl, openFile, pickFiles, putBytes, saveFile, type Upload } from "./transfer";

const say = (e: unknown) => errText(e as { code?: string; message?: string });
type Move = { file: File; rel: string };

export default function FilesTab({ target, name }: { target: string; name: string }) {
  const root = rootLabel(target, name);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [problem, setProblem] = useState("");
  const [sel, setSel] = useState<Entry | null>(null);
  const [prev, setPrev] = useState<Preview | "loading" | "error" | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [renaming, setRenaming] = useState<{ from: string; to: string; kind: string } | null>(null);
  const [newDir, setNewDir] = useState<string | null>(null);
  const [trashing, setTrashing] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<{ id: number; name: string; note: string; err: boolean; overwrite?: { file: File; dir: string } }[]>([]);
  const live = useRef<Upload[]>([]);
  const seq = useRef(0);
  const tid = useRef(0);

  const load = useCallback((p: string, keep = false) => {
    const n = ++seq.current;
    glass.list(target, p).then((r) => {
      if (n !== seq.current) return;
      setProblem(""); setPath(r.path); setEntries(r.entries);
      if (!keep) setSel(null);
    }).catch((e) => { if (n === seq.current) { setProblem(say(e)); setEntries([]); } });
  }, [target]);
  useEffect(() => { load(""); return () => { live.current.forEach((u) => u.abort()); }; }, [load]);

  const full = sel ? join(path, sel.name) : "";
  useEffect(() => {
    if (!sel) { setPrev(null); return; }
    let on = true;
    setPrev("loading");
    glass.preview(target, join(path, sel.name)).then((r) => { if (on) setPrev(r.preview.kind === "image" ? { kind: "image", path: r.preview.path } : r.preview); }).catch(() => { if (on) setPrev("error"); });
    return () => { on = false; };
  }, [sel?.name, path, target]);

  const open = (e: Entry) => { if (e.kind === "dir") { setSel(null); load(join(path, e.name)); } else setSel(e); };
  const ok = (text: string) => setMsg({ tone: "ok", text });
  const bad = (text: string) => setMsg({ tone: "err", text });

  const uploadOne = async (file: File, dir: string, overwrite = false): Promise<boolean> => {
    const id = ++tid.current;
    const set = (note: string, err = false, extra: object = {}) => setTransfers((t) => t.map((x) => (x.id === id ? { ...x, note, err, ...extra } : x)));
    setTransfers((t) => [{ id, name: join(dir, file.name) || file.name, note: "waiting", err: false }, ...t]);
    let ticket: string;
    try { ticket = await glass.uploadTicket(target, dir, file.name, file.size, overwrite); }
    catch (e) { const c = (e as { code?: string }).code; set(say(e), true, c === "exists" ? { overwrite: { file, dir } } : {}); return false; }
    const u = putBytes(ticket, file, (sent, total) => set(`${size(sent)} of ${size(total)}`));
    live.current.push(u);
    try { await u.done; set(`${size(file.size)}, done`); return true; }
    catch (e) { set((e as { code?: string }).code === "aborted" ? "cancelled" : say(e), true); return false; }
    finally { live.current = live.current.filter((x) => x !== u); }
  };
  const uploadAll = async (list: Move[], into: string) => {
    for (const d of foldersFor(into, list.map((x) => x.rel))) await glass.mkdir(target, d).catch((e) => { if ((e as { code?: string }).code !== "exists") bad(`Could not create the folder ${d}: ${say(e)}`); });
    const done: Move[] = [];
    for (const m of list) if (await uploadOne(m.file, join(into, parent(m.rel)))) done.push(m);
    if (done.length) ok(uploadedLine(done.map((m) => m.file.name), done.reduce((n, m) => n + m.file.size, 0), into, root));
    if (into === path) load(path, true);
  };

  if (entries === null) return <LoadingState rows={4} />;
  const parts = crumbs(path);
  const dirs = entries.filter((e) => e.kind === "dir").length;
  return (
    <View className="gap-s3 pt-s2">
      <View className="flex-row flex-wrap items-center gap-s1">
        {parts.length ? <Button kind="ghost" size="sm" label={root} onPress={() => load("")} /> : <Text strong size="secondary">{root}</Text>}
        {parts.map((c, i) => (<View key={c.to} className="flex-row items-center gap-s1"><Text tone="faint">/</Text>{i === parts.length - 1 ? <Text strong size="secondary">{c.label}</Text> : <Button kind="ghost" size="sm" label={c.label} onPress={() => load(c.to)} />}</View>))}
        <View className="flex-1" />
        <Button kind="ghost" size="sm" icon="plus" label="New folder" onPress={() => setNewDir("")} />
        <Button size="sm" label="Upload" onPress={() => { void pickFiles().then((fs) => { if (fs.length) void uploadAll(fs.map((file) => ({ file, rel: file.name })), path); }); }} />
      </View>
      {msg ? <Banner tone={msg.tone === "err" ? "warn" : undefined}><View className="flex-row items-center gap-s2"><Text className="min-w-0 flex-1">{msg.text}</Text><Button kind="ghost" size="sm" label="Dismiss" onPress={() => setMsg(null)} /></View></Banner> : null}
      {newDir !== null ? (
        <View className="gap-s2">
          <Field label="Folder name" value={newDir} onChangeText={setNewDir} />
          <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Create" onPress={() => { const n = newDir.trim(); if (!n) return; glass.mkdir(target, join(path, n)).then(() => { ok(`Made the folder ${n}.`); setNewDir(null); load(path, true); }).catch((e) => bad(say(e))); }} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setNewDir(null)} /></View>
        </View>
      ) : null}
      {problem ? <ErrorState title="Glass could not list this folder" reason={problem} retry={() => load(path)} /> : (
        <Card flush>
          {path ? <Row dense title="Up one folder" chevron onPress={() => { setSel(null); load(parent(path)); }} /> : null}
          {entries.length ? entries.map((e, i) => (
            <View key={e.name}>{i || path ? <Divider /> : null}
              <Row dense selected={sel?.name === e.name} title={e.name} sub={[e.kind === "dir" ? "Folder" : e.kind === "link" ? "Link" : size(e.size), stamp(e.mtime)].filter(Boolean).join(", ")} chevron={e.kind === "dir"} onPress={() => open(e)} />
            </View>
          )) : <EmptyState title={path ? "This folder is empty" : "Nothing here yet"} body="Use Upload to add files here." />}
        </Card>
      )}
      {!problem ? <Text size="caption" tone="label">{`${dirs} folders, ${entries.length - dirs} files. Choose a file to preview it.`}</Text> : null}
      {sel || path ? (
        <Card>
          <View className="gap-s2">
            <Text strong>{sel ? sel.name : leaf(path)}</Text>
            {sel ? <Text size="secondary" tone="label">{[size(sel.size), sel.mtime ? `modified ${stamp(sel.mtime)}` : ""].filter(Boolean).join(", ")}</Text> : null}
            <View className="flex-row flex-wrap gap-s2">
              {sel ? <Button size="sm" label="Download" onPress={() => { glass.download(target, full).then((t) => { if (saveFile(t.path, t.name || sel.name)) ok(`Downloading ${t.name || sel.name}.`); else bad("That download is not on your server."); }).catch((e) => bad(`Download did not start: ${say(e)}`)); }} /> : null}
              <Button kind="ghost" size="sm" label="Rename or move" onPress={() => { const f = sel ? full : path; setRenaming({ from: f, to: f, kind: sel ? "file" : "folder" }); }} />
              <Button kind="holdText" size="sm" label="Trash" onPress={() => setTrashing(sel ? full : path)} />
            </View>
            {renaming ? (
              <View className="gap-s2">
                <Field label={`Rename or move this ${renaming.kind}`} value={renaming.to} onChangeText={(to) => setRenaming({ ...renaming, to })} help="Change the name, or the path to move it." />
                <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Save" onPress={() => {
                  const to = renaming.to.trim().replace(/^\/+/, "");
                  if (!to || to === renaming.from) { setRenaming(null); return; }
                  glass.move(target, renaming.from, to).then(() => { ok(`Moved to ${to}.`); setRenaming(null); const was = renaming.from === path; setSel(null); load(was ? parent(path) : path); }).catch((e) => bad(say(e)));
                }} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setRenaming(null)} /></View>
              </View>
            ) : null}
            {trashing ? (
              <View className="gap-s2">
                <Text size="secondary">{`Move ${leaf(trashing)} to the trash?`}</Text>
                <View className="flex-row gap-s2"><Button size="sm" label="Trash" onPress={() => { const t = trashing; glass.trash(target, t).then(() => { ok(`Moved ${leaf(t)} to the trash.`); setTrashing(null); const was = t === path; setSel(null); load(was ? parent(path) : path); }).catch((e) => bad(say(e))); }} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setTrashing(null)} /></View>
              </View>
            ) : null}
            {sel ? <PreviewView prev={prev} sel={sel} onPdf={() => { glass.preview(target, full).then((r) => { if (!openFile(r.path)) bad("Could not open the PDF."); }).catch((e) => bad(`Could not open the PDF: ${say(e)}`)); }} /> : null}
          </View>
        </Card>
      ) : null}
      {transfers.length ? (
        <View className="gap-s1">
          <Text size="caption" strong tone="label">Uploads</Text>
          {transfers.map((t) => (
            <View key={t.id} className="flex-row items-center gap-s2">
              <Text size="secondary" className="min-w-0 flex-1" numberOfLines={1}>{t.name}</Text>
              <Text size="caption" tone={t.err ? "err" : "faint"}>{t.note}</Text>
              {t.overwrite ? <Button kind="ghost" size="sm" label="Replace" onPress={() => { const o = t.overwrite!; setTransfers((x) => x.filter((y) => y.id !== t.id)); void uploadOne(o.file, o.dir, true).then((v) => { if (v) { ok(`Replaced ${o.file.name}.`); load(path, true); } }); }} /> : null}
              <Button kind="ghost" size="sm" label="Dismiss" onPress={() => setTransfers((x) => x.filter((y) => y.id !== t.id))} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function PreviewView({ prev, sel, onPdf }: { prev: Preview | "loading" | "error" | null; sel: Entry; onPdf: () => void }) {
  if (prev === "loading") return <Text size="secondary" tone="faint">Loading a preview.</Text>;
  if (prev === "error") return <Text size="secondary" tone="muted">No preview for this file.</Text>;
  if (!prev) return null;
  if (prev.kind === "text") return <View className="gap-s1"><Text mono size="caption" selectable>{prev.text}</Text>{prev.truncated ? <Text size="caption" tone="faint">Showing the start of the file. Download it for the rest.</Text> : null}</View>;
  if (prev.kind === "image") { const u = imageUrl(prev.path); return u ? <Image source={{ uri: u }} accessibilityLabel={`Preview of ${sel.name}`} style={{ width: "100%", height: 280 }} resizeMode="contain" /> : <Text tone="muted">{NO_PREVIEW}</Text>; }
  if (prev.kind === "pdf") return <View className="self-start"><Button size="sm" label="Open the PDF in a new tab" onPress={onPdf} /></View>;
  return <Text size="secondary" tone="muted">{NO_PREVIEW}</Text>;
}
