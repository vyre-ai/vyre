// The Instructions and Context editors of a folder: an agent's or a project's. One component over a FolderApi, so every folder reads and writes the same way.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Button, Card, Divider, ErrorState, Field, FileViewer, IconButton, LoadingState, Row, Segmented, Sheet, Text, showToast } from "@vyre/ui";
import type { FileSource } from "../../ui/files/source";
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
 * An agent's or a project's AGENTS.md and CLAUDE.md, shown and edited in the one Markdown viewer and editor Files uses (FileViewer): rendered by default, Edit to change it, Cmd+S, an unsaved-changes
 * guard. This is only the wiring: which file, how it loads and where it saves. With `kept`, CLAUDE.md is the same as AGENTS.md and one file is shown.
 */
export function DocsEditor({ api, who, title = "Instructions" }: { api: DocsApi; who: string; title?: string }) {
  const [file, setFile] = useState<DocFile>("AGENTS.md");
  const shown: DocFile = api.kept ? "AGENTS.md" : file;
  const source = useMemo<FileSource>(() => ({
    load: async () => ({ text: (await api.docs())[shown] ?? "" }),
    save: api.canEdit === false ? undefined : async (text) => { await api.saveDoc(shown, text); },
  }), [api.id, shown, api.canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sec title={title}>
      {api.kept ? null : <Segmented label="Instruction file" value={file} onChange={setFile} options={[["AGENTS.md", "AGENTS.md"], ["CLAUDE.md", "CLAUDE.md"]] as [DocFile, string][]} />}
      <Text size="caption" tone="label">{api.kept ? KEPT_NOTE : shown === "AGENTS.md" ? `Who ${who} is and how it works.` : "Extra notes for Claude, kept apart."}</Text>
      <Card flush>
        <FileViewer key={`${api.id}:${shown}`} name={shown} kind="markdown" bare readOnly={api.canEdit === false} source={source} onSaved={() => showToast("Saved. It applies from the next chat.")} />
      </Card>
    </Sec>
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
