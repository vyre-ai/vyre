// The Instructions and Context editors of a folder: an agent's or a project's. One component over a FolderApi, so every folder reads and writes the same way.
import { Component, Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Button, Card, Divider, ErrorState, Field, IconButton, LoadingState, Row, Sheet, Text, showToast } from "@vyre/ui";
import { PlainDocsEditor } from "./PlainDocs";
import { Sec } from "../places/Frame";
import { pickFile } from "../vault/pick-file";
import { KEPT_NOTE, READ_ONLY_NOTE, filesPath, itemLine, type DocFile, type DocsApi, type FolderApi, type Item } from "./model.ts";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const reload = useCallback(() => { setErr(""); fn().then(setData).catch((e) => setErr(say(e, "That did not load."))); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(reload, [reload]);
  return { data, err, reload };
}

/**
 * An agent's or a project's AGENTS.md and CLAUDE.md. On the shared Markdown viewer and editor (DocsViewer), loaded lazily so the PDF and Office renderers are not part of the page's start; if the viewer
 * cannot load (or is not in this build), the plain editor (PlainDocs) takes its place. The one switch is USE_VIEWER.
 */
const USE_VIEWER = true;
const Viewer = lazy(() => import("./DocsViewer"));

class Fallback extends Component<{ api: DocsApi; who: string; title?: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <PlainDocsEditor api={this.props.api} who={this.props.who} title={this.props.title} /> : this.props.children; }
}

export function DocsEditor({ api, who, title }: { api: DocsApi; who: string; title?: string }) {
  if (!USE_VIEWER) return <PlainDocsEditor api={api} who={who} title={title} />;
  return (
    <Fallback api={api} who={who} title={title}>
      <Suspense fallback={<LoadingState rows={4} />}><Viewer api={api} who={who} title={title} /></Suspense>
    </Fallback>
  );
}

/** The files, notes and references to Vyre Files kept as context. */
export function ContextEditor({ api, who, title = "Context" }: { api: FolderApi; who: string; title?: string }) {
  const q = useLoad(() => api.context(), [api.id]);
  const [adding, setAdding] = useState<"note" | "link" | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const edit = api.canEdit !== false;
  const close = () => { setAdding(null); setName(""); setBody(""); setProblem(""); };
  const upload = async () => {
    setBusy(true);
    try { const f = await pickFile(""); if (!f) return; await api.addFile(f.name, f.base64); showToast(`${f.name} added.`); q.reload(); } catch (e) { showToast(say(e)); } finally { setBusy(false); }
  };
  const submit = () => {
    setProblem("");
    const go = adding === "note" ? api.addNote(name, body) : api.addLink(name, filesPath(body));
    go.then(() => { close(); q.reload(); showToast(adding === "note" ? "Note added." : "Reference added."); }).catch((e) => setProblem(say(e)));
  };
  if (q.err) return <Card flush><ErrorState title="Context did not load" reason={q.err} retry={q.reload} /></Card>;
  if (!q.data) return <LoadingState rows={3} />;
  const items: Item[] = q.data;
  return (
    <>
      <Sec title={title}>
        {items.length ? (
          <Card flush>
            {items.map((i, k) => {
              const l = itemLine(i);
              return <View key={i.name}>{k ? <Divider /> : null}<Row title={l.title} sub={l.sub} end={edit ? <IconButton icon="trash" label={`Remove ${l.title}`} onPress={() => api.remove(i.name).then(q.reload).catch((e) => showToast(say(e)))} /> : undefined} /></View>;
            })}
          </Card>
        ) : <Card><Text tone="muted">{`Nothing kept for ${who} yet. Add files, notes, or a place in Files that every chat here should be able to find.`}</Text></Card>}
        {edit ? (
          <View className="flex-row flex-wrap gap-s2">
            <Button size="sm" label="Add a file" disabled={busy} onPress={upload} />
            <Button size="sm" kind="secondary" label="Add a note" onPress={() => setAdding("note")} />
            <Button size="sm" kind="secondary" label="Link a place in Files" onPress={() => setAdding("link")} />
          </View>
        ) : <Text size="caption" tone="label">{READ_ONLY_NOTE}</Text>}
      </Sec>
      <Sheet open={adding !== null} onClose={close} title={adding === "note" ? "Add a note" : "Link a place in Files"}>
        <View className="gap-s2">
          <Field name="Name" value={name} onChangeText={setName} placeholder={adding === "note" ? "Style guide" : "Intake form"} />
          <Field name={adding === "note" ? "Note" : "Place in Files"} value={body} onChangeText={setBody} multiline={adding === "note"} lines={adding === "note" ? 6 : 1} placeholder={adding === "note" ? "What should be remembered?" : "Clients/Rivera/intake.pdf"} help={adding === "link" ? "A link holds the place, not a copy. Whoever reads it opens it through Files, with their own access." : undefined} />
          {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
          <View className="flex-row"><Button size="sm" label="Add" disabled={!name.trim() || !body.trim()} onPress={submit} /></View>
        </View>
      </Sheet>
    </>
  );
}
