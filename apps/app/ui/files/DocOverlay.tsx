// A document in a large overlay (about 92% of the screen on a wide one, the whole screen on a phone): what Edit on an agent's or a project's Instructions opens, and what a row in a project's Files opens.
// A text or markdown file is written in the shared markdown editor and saved as you go (about 1.5 s after typing stops, and again on close); a file the viewer only draws (a PDF, a sheet, a picture) is the
// shared FileViewer, read only. Undo and redo are kept here (Cmd or Ctrl+Z, Shift+Cmd+Z), so the toolbar's formatting buttons are undone too.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Platform, View, useWindowDimensions } from "react-native";
import * as P from "@rn-primitives/dialog";
import { Button } from "../components/Button";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
import { FileViewer } from "./FileViewer";
import { MarkdownEditor } from "./MarkdownDoc";
import { canEdit, viewerKind, type ViewKind } from "./kinds.js";
import { textOfBytes } from "./viewer-model.js";
import { nextSaveDelay, pushHistory, redoOf, undoOf, type History } from "./autosave.js";
import type { FileSource } from "./source";

export type DocOverlayProps = {
  open: boolean;
  onClose: () => void;
  /** The heading: "Instructions", or a file's name. */
  title: string;
  /** Shown small under the title: the file name (AGENTS.md), or the folder a file is in. */
  name: string;
  /** The file's real name when `name` is a folder line; the viewer picks how to draw it from this. */
  fileName?: string;
  source: FileSource;
  kind?: ViewKind;
  readOnly?: boolean;
  /** Saves make a version each: keep them at least this far apart (ms), and flush on close. 0 saves at each pause. */
  spacing?: number;
  onOpenInFiles?: () => void;
  onSaved?: () => void;
};

type Status = "idle" | "dirty" | "saving" | "saved" | "failed";

export function DocOverlay(p: DocOverlayProps) {
  const { width, height } = useWindowDimensions();
  const { color } = useUiTheme();
  const phone = width < 640;
  const kind: ViewKind = p.kind ?? viewerKind(p.fileName ?? p.name);
  const writable = canEdit(kind) && !p.readOnly && !!p.source.save;
  const box = phone ? { width, height } : { width: Math.round(width * 0.92), height: Math.round(height * 0.92) };
  const card = (
    <View accessibilityRole="none" style={{ ...box, backgroundColor: color["surface-3"], borderRadius: phone ? 0 : 14, borderWidth: phone ? 0 : 1, borderColor: color["edge-strong"], overflow: "hidden" }}>
      {writable ? <Writer {...p} kind={kind} /> : <ReadOnly {...p} kind={kind} />}
    </View>
  );
  // On the web the same dialog primitive the Sheet uses (it lifts over the app and keeps focus inside); on a device a Modal.
  if (Platform.OS === "web") {
    return (
      <P.Root open={p.open} onOpenChange={(o) => { if (!o) p.onClose(); }}>
        <P.Portal>
          <P.Overlay style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.scrim }} />
          <View pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
            <P.Content>{card}</P.Content>
          </View>
        </P.Portal>
      </P.Root>
    );
  }
  return (
    <Modal visible={p.open} transparent animationType="fade" onRequestClose={p.onClose}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: color.scrim }}>{card}</View>
    </Modal>
  );
}

function Bar({ p, status, undo, redo, canUndo, canRedo, retry, close }: { p: DocOverlayProps; status?: Status; undo?: () => void; redo?: () => void; canUndo?: boolean; canRedo?: boolean; retry?: () => void; close: () => void }) {
  const said = status === "saving" ? "Saving..." : status === "saved" ? "Saved" : status === "dirty" ? "Not saved yet" : status === "failed" ? "Not saved" : "";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text strong numberOfLines={1}>{p.title}</Text>
        <Text size="caption" tone="label" numberOfLines={1}>{p.name}</Text>
      </View>
      {said ? <Text size="caption" tone={status === "failed" ? "warn" : "label"}>{said}</Text> : null}
      {status === "failed" && retry ? <Button size="sm" kind="secondary" label="Retry" onPress={retry} /> : null}
      {undo ? <Button size="sm" kind="ghost" icon="undo" label="Undo" disabled={!canUndo} onPress={undo} /> : null}
      {redo ? <Button size="sm" kind="ghost" label="Redo" disabled={!canRedo} onPress={redo} /> : null}
      {p.onOpenInFiles ? <Button size="sm" kind="ghost" label="Open in Files" onPress={p.onOpenInFiles} /> : null}
      <Button size="sm" kind="secondary" label="Close" onPress={close} />
    </View>
  );
}

function ReadOnly(p: DocOverlayProps & { kind: ViewKind }) {
  return (
    <View style={{ flex: 1 }}>
      <Bar p={p} close={p.onClose} />
      <View style={{ flex: 1, minHeight: 0 }}><FileViewer bare name={p.fileName ?? p.name} source={p.source} kind={p.kind} readOnly onOpenInFiles={undefined} /></View>
    </View>
  );
}

function Writer(p: DocOverlayProps & { kind: ViewKind }) {
  const [value, setValue] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [hist, setHist] = useState<History>({ past: [], future: [], at: 0 });
  const [why, setWhy] = useState("");
  const saved = useRef("");
  const latest = useRef("");
  const head = useRef<number | undefined>(undefined);
  const lastSave = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const failed = useRef(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const b = await p.source.load();
        const t = b.text !== undefined ? b.text : b.bytes ? textOfBytes(b.bytes) : "";
        const vs = await p.source.versions?.().catch(() => []);
        if (!live) return;
        head.current = vs && vs.length ? vs[vs.length - 1].ver : undefined;
        saved.current = t; latest.current = t; setValue(t);
      } catch (e) { if (live) setWhy(e instanceof Error && e.message ? e.message : "The file did not load."); }
    })();
    return () => { live = false; };
  }, [p.source]);

  const save = useCallback(async (): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (busy.current) return false;
    if (latest.current === saved.current) { if (!failed.current) return true; }
    busy.current = true; setStatus("saving");
    const text = latest.current;
    try {
      const r = (await p.source.save?.(text, head.current)) || {};
      if (typeof (r as { version?: number }).version === "number") head.current = (r as { version: number }).version;
      saved.current = text; lastSave.current = Date.now(); failed.current = false;
      setStatus(latest.current === text ? "saved" : "dirty"); p.onSaved?.();
      busy.current = false;
      if (latest.current !== text) schedule();
      return true;
    } catch { busy.current = false; failed.current = true; setStatus("failed"); return false; }
  }, [p.source]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveRef = useRef(save); saveRef.current = save;
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void saveRef.current(); }, nextSaveDelay(Date.now(), lastSave.current, p.spacing ?? 0));
  }, [p.spacing]);

  const change = (t: string) => {
    setHist((h) => pushHistory(h, latest.current, Date.now()));
    latest.current = t; setValue(t); setStatus("dirty"); schedule();
  };
  const undo = () => setHist((h) => { const r = undoOf(h, latest.current); if (r.text === null) return h; latest.current = r.text; setValue(r.text); setStatus("dirty"); schedule(); return r.hist; });
  const redo = () => setHist((h) => { const r = redoOf(h, latest.current); if (r.text === null) return h; latest.current = r.text; setValue(r.text); setStatus("dirty"); schedule(); return r.hist; });
  const undoRef = useRef(undo); undoRef.current = undo;
  const redoRef = useRef(redo); redoRef.current = redo;

  // closing writes what is unsaved first; if the write fails the overlay stays, with the text and a Retry
  const close = useCallback(async () => { if (await saveRef.current()) p.onClose(); }, [p.onClose]); // eslint-disable-line react-hooks/exhaustive-deps
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
      if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) redoRef.current(); else undoRef.current(); }
      else if (mod && k === "y") { e.preventDefault(); redoRef.current(); }
      else if (mod && k === "s") { e.preventDefault(); void saveRef.current(); }
      else if (e.key === "Escape") { e.preventDefault(); void closeRef.current(); }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, []);

  const pad = useMemo(() => ({ flex: 1, minHeight: 0, width: "100%" as const, maxWidth: 860, alignSelf: "center" as const }), []);
  return (
    <View style={{ flex: 1 }}>
      <Bar p={p} status={status} undo={undo} redo={redo} canUndo={hist.past.length > 0} canRedo={hist.future.length > 0} retry={() => void save()} close={() => void close()} />
      {value === null ? <View style={{ padding: 24 }}><Text tone="muted">{why || "Loading..."}</Text></View> : <View style={pad}><MarkdownEditor value={value} onChange={change} onSave={() => void save()} /></View>}
    </View>
  );
}
