// The Instructions and Context editors of a folder: an agent's or a project's. One component over a FolderApi, so every folder reads and writes the same way.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Divider, ErrorState, Field, IconButton, LoadingState, Row, Segmented, Sheet, Text, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { pickFile } from "../vault/pick-file";
import { KEPT_NOTE, READ_ONLY_NOTE, filesPath, itemLine, type DocFile, type FolderApi, type Item } from "./model.ts";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const reload = useCallback(() => { setErr(""); fn().then(setData).catch((e) => setErr(say(e, "That did not load."))); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(reload, [reload]);
  return { data, err, reload };
}

/** AGENTS.md and CLAUDE.md, edited in place. With `kept`, one text is shown and saved to both. */
export function DocsEditor({ api, who, title = "Instructions" }: { api: FolderApi; who: string; title?: string }) {
  const q = useLoad(() => api.docs(), [api.id]);
  const [file, setFile] = useState<DocFile>("AGENTS.md");
  const [text, setText] = useState<Record<DocFile, string>>({ "AGENTS.md": "", "CLAUDE.md": "" });
  const [saved, setSaved] = useState<Record<DocFile, string>>({ "AGENTS.md": "", "CLAUDE.md": "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) { setText(q.data); setSaved(q.data); } }, [q.data]);
  const edit = api.canEdit !== false;
  const shown: DocFile = api.kept ? "AGENTS.md" : file;
  const dirty = text[shown] !== saved[shown];
  const save = () => {
    setBusy(true);
    api.saveDoc(shown, text[shown]).then(() => { const both = api.kept ? { "AGENTS.md": text[shown], "CLAUDE.md": text[shown] } : { ...saved, [shown]: text[shown] }; setSaved(both); setText(both); showToast("Saved. It applies from the next chat."); }).catch((e) => showToast(say(e))).finally(() => setBusy(false));
  };
  if (q.err) return <Card flush><ErrorState title="Instructions did not load" reason={q.err} retry={q.reload} /></Card>;
  if (!q.data) return <LoadingState rows={4} />;
  return (
    <Sec title={title}>
      {api.kept ? null : <Segmented label="Instruction file" value={file} onChange={setFile} options={[["AGENTS.md", "AGENTS.md"], ["CLAUDE.md", "CLAUDE.md"]] as [DocFile, string][]} />}
      <Card className="gap-s2">
        <Text size="caption" tone="label">{api.kept ? KEPT_NOTE : shown === "AGENTS.md" ? `Who ${who} is and how it works.` : "Extra notes for Claude, kept apart."}</Text>
        {edit ? null : <Text size="caption" tone="label">{READ_ONLY_NOTE}</Text>}
        <Field name={`${who}'s ${shown}`} value={text[shown]} onChangeText={(v) => edit && setText((t) => ({ ...t, [shown]: v }))} multiline lines={12} placeholder="Write what every chat here should know before it starts." />
        {edit ? (
          <View className="flex-row items-center gap-s2">
            <Button size="sm" label="Save" disabled={busy || !dirty} onPress={save} />
            {dirty ? <Button size="sm" kind="ghost" label="Revert" onPress={() => setText((t) => ({ ...t, [shown]: saved[shown] }))} /> : <Text size="caption" tone="label">Saved</Text>}
          </View>
        ) : null}
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
