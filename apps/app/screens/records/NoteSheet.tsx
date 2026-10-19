import { useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Field, Sheet, Text, showToast } from "@vyre/ui";
import { recordsApi } from "./records-api";
import { editInput, isMine, noteOf } from "./note-model.js";
import { ShareControl } from "./ShareControl";

/** One note, opened from the Notes tab (planner.get). Your own can be edited and shared in place (planner.update); one shared with you is read-only, and says so. */
export function NoteSheet({ id, me, onClose, onChanged }: { id: string | null; me?: string; onClose: () => void; onChanged: () => void }) {
  const [note, setNote] = useState<ReturnType<typeof noteOf>>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!id) return;
    let live = true;
    setNote(null); setProblem("");
    void recordsApi.noteGet(id).then((r) => {
      if (!live) return;
      const n = r.error ? null : noteOf(r.data);
      if (!n) { setProblem(r.error?.message || "That note is not here, or it is not yours to read."); return; }
      setNote(n); setTitle(n.title); setBody(n.body);
    });
    return () => { live = false; };
  }, [id]);
  const mine = note ? isMine(note, me) : false;
  const save = async () => {
    if (!note) return;
    const input = editInput(note, { title, body });
    if (!input) { onClose(); return; }
    setBusy(true);
    const r = await recordsApi.noteUpdate(input);
    setBusy(false);
    if (r.error) { setProblem(r.error.message || "That did not save."); return; }
    showToast("Saved.");
    onChanged(); onClose();
  };
  return (
    <Sheet open={!!id} onClose={onClose} title={note?.title || "Note"}>
      <View className="gap-s3">
        {problem ? <Banner tone="warn">{problem}</Banner> : null}
        {note ? (
          mine ? (
            <>
              <Field label="Title" value={title} onChangeText={setTitle} />
              <Field label="Note" value={body} onChangeText={setBody} multiline lines={6} />
              <ShareControl urn={note.id} type="note" value={note.visibility} record={note.record} onDone={onChanged} />
              <View className="flex-row gap-s2">
                <Button kind="primary" label="Save" loading={busy} disabled={busy} onPress={() => void save()} />
                <Button kind="ghost" label="Cancel" onPress={onClose} />
              </View>
            </>
          ) : (
            <>
              <Text>{note.body || "This note is empty."}</Text>
              <Text size="caption" tone="label">It was shared with you, so you can read it but not change it.</Text>
              <View className="flex-row"><Button kind="ghost" label="Close" onPress={onClose} /></View>
            </>
          )
        ) : problem ? null : <Text tone="label">Loading</Text>}
      </View>
    </Sheet>
  );
}
