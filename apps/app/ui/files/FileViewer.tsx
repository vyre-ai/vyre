// The file viewer: one component that shows any file the way it should look. A markdown file is a rendered document (and the editor for instructions: Edit, Cmd+S, an unsaved-changes guard), code and text have
// line numbers and colours, JSON is a tree, images zoom, PDFs page, and what nothing here draws gets a card with Download. The chrome is the same for all of them: the name, which version, who changed it,
// Show changes, Open in Files, Download, Tag in chat, Edit. Reading is the caller's `source`; saving is the caller's `source.save` (a new version of a Drive file, or an agent's or project's instructions).
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import PdfDom from "./PdfDom";
import DocxDom from "./DocxDom";
import SheetDom from "./SheetDom";
import { Banner } from "../components/Banner";
import { Button, IconButton } from "../components/Button";
import { Icon } from "../components/Icon";
import { Menu } from "../components/Menu";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
import { MarkdownEditor, MarkdownView } from "./MarkdownDoc";
import { CodeLines, DiffView, ImageZoom, JsonTree, OtherCard } from "./parts";
import { canEdit, extOf, isTextKind, languageOf, LIMITS, mimeFor, viewerKind, type ViewKind } from "./kinds.js";
import { lineDiff, diffStats } from "./diff.js";
import { base64Of, bytesOfText, changedBy, editState, looksBinary, saveWords, textOfBytes } from "./viewer-model.js";
import type { FileBody, FileSource, FileVersion } from "./source";

export type FileViewerProps = {
  name: string;
  source: FileSource;
  /** Treat the file as this kind whatever its name says (an agent's instructions are markdown). */
  kind?: ViewKind;
  /** Open straight into the editor. */
  startEditing?: boolean;
  readOnly?: boolean;
  onClose?: () => void;
  onOpenInFiles?: () => void;
  onDownload?: () => void;
  onTagInChat?: () => void;
  onSaved?: (r: { version?: number; conflict?: boolean }) => void;
  /** A person's or agent's id as a name, for "Changed by". */
  nameOf?: (id: string) => string;
  /** Without the header (the caller has its own, like an instructions page). */
  bare?: boolean;
};

const ago = (at?: number | string) => {
  const t = typeof at === "string" ? Date.parse(at) : at;
  if (!t || Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

function download(name: string, bytes: ArrayLike<number>, mime: string) {
  if (Platform.OS !== "web" || typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes as ArrayLike<number>) as BlobPart], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = name.split("/").pop() || "file"; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function FileViewer(p: FileViewerProps) {
  const { color, resolved } = useUiTheme();
  const kind: ViewKind = p.kind ?? viewerKind(p.name);
  const [version, setVersion] = useState<number | undefined>();
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [body, setBody] = useState<FileBody | null>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [why, setWhy] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState("");
  const [changes, setChanges] = useState(false);
  const [before, setBefore] = useState<string | null>(null);
  const [asking, setAsking] = useState<null | (() => void)>(null);
  const started = useRef(false);

  const head = versions.length ? versions[versions.length - 1].ver : undefined;
  const shown = version ?? head;
  const atHead = version === undefined || version === head;
  const dirty = editing && editState(text, draft).dirty;

  const load = useCallback(async (v?: number) => {
    setState("loading"); setWhy("");
    try {
      const b = await p.source.load(v);
      const size = b.bytes?.length ?? b.text?.length ?? 0;
      if (LIMITS[kind] && size > LIMITS[kind]) { setBody(b); setState("failed"); setWhy("This file is too big to show here. Download it to open it."); return; }
      const asText = isTextKind(kind) || kind === "html";
      let t = "";
      if (asText) {
        if (b.text !== undefined) t = b.text;
        else if (b.bytes) { if (isTextKind(kind) && looksBinary(b.bytes)) { setBody(b); setState("failed"); setWhy("This is not a text file, so it is not shown. Download it to open it."); return; } t = textOfBytes(b.bytes); }
      }
      setBody(b); setText(t); setDraft(t); setState("ready");
    } catch (e) {
      const x = e as { code?: string; message?: string };
      setState("failed"); setWhy(x.code === "too_large" ? "This file is too big to show here. Download it to open it." : x.code === "not_found" ? "This file is not in your Drive." : x.message || "The file did not load.");
    }
  }, [p.source, kind]);

  useEffect(() => { void load(version); }, [load, version]);
  useEffect(() => { void p.source.versions?.().then(setVersions).catch(() => setVersions([])); }, [p.source]);
  useEffect(() => { if (p.startEditing && !started.current && state === "ready" && canEdit(kind) && !p.readOnly && p.source.save) { started.current = true; setEditing(true); } }, [p.startEditing, state, kind, p.readOnly, p.source]);

  // Show changes: the version before the one on screen.
  useEffect(() => {
    if (!changes || shown === undefined) { setBefore(null); return; }
    const i = versions.findIndex((v) => v.ver === shown);
    const prev = i > 0 ? versions[i - 1].ver : undefined;
    if (prev === undefined) { setBefore(""); return; }
    let live = true;
    void p.source.load(prev).then((b) => { if (live) setBefore(b.text ?? (b.bytes ? textOfBytes(b.bytes) : "")); }).catch(() => { if (live) setBefore(null); });
    return () => { live = false; };
  }, [changes, shown, versions, p.source]);

  const ask = (go: () => void) => { if (dirty) setAsking(() => go); else go(); };
  const save = useCallback(async () => {
    if (!p.source.save || saving || !editState(text, draft).canSave) return;
    setSaving(true); setSaid(""); setWhy("");
    try {
      const r = (await p.source.save(draft, head)) || {};
      setText(draft); setSaid(saveWords(r)); p.onSaved?.(r);
      void p.source.versions?.().then((vs) => { setVersions(vs); setVersion(undefined); });
    } catch (e) { setWhy((e as Error).message || "That did not save. What you typed is still here."); }
    finally { setSaving(false); }
  }, [p, saving, text, draft, head]);

  // Cmd or Ctrl S saves; E edits when nothing is being typed; Esc leaves the editor. A page with unsaved text asks before it unloads.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const key = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement | null)?.tagName ?? "");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && editing) { e.preventDefault(); void save(); }
      else if (e.key === "Escape" && editing) { e.preventDefault(); ask(() => { setEditing(false); setDraft(text); }); }
      else if (e.key.toLowerCase() === "e" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !editing && state === "ready" && canEditHere) { e.preventDefault(); setEditing(true); }
    };
    const leave = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    document.addEventListener("keydown", key);
    window.addEventListener("beforeunload", leave);
    return () => { document.removeEventListener("keydown", key); window.removeEventListener("beforeunload", leave); };
  });

  const canEditHere = canEdit(kind) && !p.readOnly && !!p.source.save && atHead;
  const sub = [shown !== undefined ? `Version ${shown}` : "", (() => { const v = versions.find((x) => x.ver === shown); return v ? [changedBy(v, p.nameOf), ago(v.at)].filter(Boolean).join(", ") : ""; })()].filter(Boolean).join(" · ");
  const ops = useMemo(() => (before === null ? [] : lineDiff(before, text)), [before, text]);
  const stats = diffStats(ops);
  const mime = body?.mime || mimeFor(p.name, kind);
  const doDownload = p.onDownload ?? (body?.bytes ? () => download(p.name, body.bytes!, mime) : undefined);

  const uri = (() => {
    if (!body || (kind !== "image" && kind !== "audio" && kind !== "video")) return "";
    const b64 = body.base64 ?? (body.bytes ? base64Of(body.bytes) : "");
    return b64 ? `data:${mime};base64,${b64}` : "";
  })();

  const content = (() => {
    if (state === "loading") return <View style={{ padding: 24 }}><Text tone="muted">Opening</Text></View>;
    if (state === "failed") return <OtherCard name={p.name} size={body?.bytes?.length} note={why} onDownload={doDownload} />;
    if (changes && isTextKind(kind)) return before === null ? <View style={{ padding: 24 }}><Text tone="muted">Looking at the version before</Text></View> : <DiffView ops={ops} />;
    switch (kind) {
      case "markdown": return editing ? <MarkdownEditor value={draft} onChange={setDraft} onSave={save} /> : <MarkdownView text={text} />;
      case "code": case "text":
        return editing
          ? <TextInput multiline value={draft} onChangeText={setDraft} autoCapitalize="none" autoCorrect={false} accessibilityLabel="File text" style={{ flex: 1, padding: 16, color: color.text, fontFamily: Platform.select({ web: "ui-monospace, Menlo, monospace", default: "Courier" }), fontSize: 13, lineHeight: 20, textAlignVertical: "top" }} />
          : <CodeLines text={text} lang={kind === "text" ? "" : languageOf(p.name)} />;
      case "json": return <JsonTree text={text} />;
      case "image": return uri ? <ImageZoom uri={uri} /> : <OtherCard name={p.name} note="The picture did not load." onDownload={doDownload} />;
      case "pdf": return body?.base64 || body?.bytes ? <PdfDom base64={body.base64 ?? base64Of(body.bytes!)} dom={{ style: { flex: 1, width: "100%", height: "100%" } }} /> : null;
      case "html":
        return Platform.OS === "web"
          ? <View style={{ flex: 1 }}><Banner icon="shield">Shown without scripts, the way the file is written.</Banner>{createFrame(text)}</View>
          : <OtherCard name={p.name} note="Open this page in Vyre on a computer to see it." onDownload={doDownload} />;
      case "audio": case "video":
        return Platform.OS === "web" && uri ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}>{createMedia(kind, uri)}</View> : <OtherCard name={p.name} note="Play this on a computer, or download it." onDownload={doDownload} />;
      case "docx": return body?.base64 || body?.bytes ? <DocxDom base64={body.base64 ?? base64Of(body.bytes!)} dom={{ style: { flex: 1, width: "100%", height: "100%" } }} /> : null;
      case "sheet": {
        const ext = extOf(p.name);
        if (ext === "xls") return <OtherCard name={p.name} size={body?.bytes?.length} note="Older .xls spreadsheets cannot be shown here. Download it, or save it as .xlsx." onDownload={doDownload} />;
        return body?.base64 || body?.bytes ? <SheetDom base64={body.base64 ?? base64Of(body.bytes!)} kind={ext === "xlsx" ? "xlsx" : ext === "tsv" ? "tsv" : "csv"} dark={resolved.scheme === "dark"} dom={{ style: { flex: 1, width: "100%", height: "100%" } }} /> : null;
      }
      default: return <OtherCard name={p.name} size={body?.bytes?.length} onDownload={doDownload} />;
    }
  })();

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: color.surface }}>
      {p.bare && (canEditHere || editing) ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8, paddingHorizontal: 12, minHeight: 44, borderBottomWidth: 1, borderBottomColor: color.edge }}>
          {editing ? <><Button size="sm" kind="ghost" label="Cancel" onPress={() => ask(() => { setEditing(false); setDraft(text); })} /><Button size="sm" kind="primary" label={saving ? "Saving" : "Save"} disabled={!dirty || saving} onPress={save} /></> : <Button size="sm" kind="secondary" icon="edit" label="Edit" onPress={() => setEditing(true)} />}
        </View>
      ) : null}
      {p.bare ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, minHeight: 52, borderBottomWidth: 1, borderBottomColor: color.edge }}>
          <Icon name="file" />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text strong numberOfLines={1}>{p.name.split("/").pop()}</Text>
            {sub ? <Text size="caption" tone="label" numberOfLines={1}>{sub}</Text> : null}
          </View>
          {versions.length > 1 ? (
            <Menu trigger={<Button size="sm" kind="ghost" icon="history" label={shown !== undefined ? `v${shown}` : "Versions"} />} items={[...versions].reverse().map((v) => ({ label: `Version ${v.ver}${v.ver === head ? " (latest)" : ""} · ${[changedBy(v, p.nameOf).replace("Changed by ", ""), ago(v.at)].filter(Boolean).join(", ")}`, selected: v.ver === shown, onPress: () => ask(() => { setEditing(false); setVersion(v.ver === head ? undefined : v.ver); }) }))} />
          ) : null}
          {versions.length > 1 && isTextKind(kind) ? <Button size="sm" kind={changes ? "secondary" : "ghost"} label={changes ? `Hide changes (+${stats.add} −${stats.del})` : "Show changes"} onPress={() => setChanges(!changes)} /> : null}
          {canEditHere && !editing ? <Button size="sm" kind="secondary" icon="edit" label="Edit" onPress={() => setEditing(true)} /> : null}
          {editing ? <><Button size="sm" kind="ghost" label="Cancel" onPress={() => ask(() => { setEditing(false); setDraft(text); })} /><Button size="sm" kind="primary" label={saving ? "Saving" : "Save"} disabled={!dirty || saving} onPress={save} /></> : null}
          {p.onTagInChat ? <IconButton icon="mention" label="Tag in chat" onPress={p.onTagInChat} /> : null}
          {p.onOpenInFiles ? <IconButton icon="drive" label="Open in Files" onPress={p.onOpenInFiles} /> : null}
          {doDownload ? <IconButton icon="download" label="Download" onPress={doDownload} /> : null}
          {p.onClose ? <IconButton icon="x" label="Close" onPress={() => ask(() => p.onClose?.())} /> : null}
        </View>
      )}
      {asking ? (
        <Banner tone="warn">
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Text style={{ flex: 1 }}>You have changes that are not saved.</Text>
            <Button size="sm" kind="ghost" label="Keep editing" onPress={() => setAsking(null)} />
            <Button size="sm" kind="danger" label="Discard" onPress={() => { const go = asking; setAsking(null); setDraft(text); go(); }} />
          </View>
        </Banner>
      ) : null}
      {said ? <Banner>{said}</Banner> : null}
      {why && state !== "failed" ? <Banner tone="err">{why}</Banner> : null}
      {version !== undefined && !atHead && !p.bare ? <Banner icon="history"><Text>This is an older version. Edit works on the latest.</Text></Banner> : null}
      <View style={{ flex: 1, minHeight: 0 }}>{content}</View>
    </View>
  );
}

/** A sandboxed page: no scripts, no forms, no same-origin, so the file cannot reach the app. */
function createFrame(html: string) {
  if (typeof document === "undefined") return null;
  return createElement("iframe", { sandbox: "", srcDoc: html, title: "Page", style: { flex: 1, border: 0, width: "100%", height: "100%", background: "#fff" } });
}
function createMedia(kind: "audio" | "video", src: string) {
  return createElement(kind, { src, controls: true, style: { maxWidth: "100%", maxHeight: "100%" } });
}

export { bytesOfText };
