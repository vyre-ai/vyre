// The plain Instructions editor (a text box and Save): the fallback DocsEditor uses if the shared file viewer is not available (see FolderDocs.tsx).
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, ErrorState, Field, LoadingState, Segmented, Text, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { KEPT_NOTE, READ_ONLY_NOTE, type DocFile, type DocsApi } from "./model.ts";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const reload = useCallback(() => { setErr(""); fn().then(setData).catch((e) => setErr(say(e, "That did not load."))); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(reload, [reload]);
  return { data, err, reload };
}

/** AGENTS.md and CLAUDE.md, edited in place. With `kept`, one text is shown and saved to both. */
export function PlainDocsEditor({ api, who, title = "Instructions" }: { api: DocsApi; who: string; title?: string }) {
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

