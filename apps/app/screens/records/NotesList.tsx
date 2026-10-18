import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Chip, Field, Row, Sheet, Text, showToast } from "@vyre/ui";
import { recordsApi, type NoteRow } from "./records-api";
import { ShareControl } from "./ShareControl";
import { NoteSheet } from "./NoteSheet";

const WORDS: Record<string, string> = { private: "Only me", record: "Whoever can see the record", space: "Everyone in the Space" };
const first = (s?: string) => String(s ?? "").split("\n")[0].slice(0, 120);

/** Notes for one scope: Mine, Shared with me, or the Space. A note is the planner's, so the box cuts the list to what the person may read (planner.list); a writer changes who can read their own note in place. */
export function NotesList({ scope, me }: { scope: "mine" | "shared" | "space"; me?: string }) {
  const [rows, setRows] = useState<NoteRow[] | null>(null);
  const [problem, setProblem] = useState("");
  const [n, setN] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const r = await recordsApi.noteAdd(title.trim(), body.trim());
    setBusy(false);
    if (r.error) { showToast(r.error.message || "That did not save."); return; }
    setAdding(false); setTitle(""); setBody(""); setN((c) => c + 1);
  };
  useEffect(() => {
    let live = true;
    setRows(null); setProblem("");
    void recordsApi.notes(scope).then((r) => { if (!live) return; if (r.error) { setRows([]); setProblem(r.error.message || ""); } else setRows(r.data?.items ?? []); });
    return () => { live = false; };
  }, [scope, n]);
  if (rows === null) return <Text tone="label">Loading</Text>;
  return (
    <View className="gap-s3">
    <View className="flex-row"><Button kind="secondary" size="sm" icon="plus" label="New note" onPress={() => setAdding(true)} /></View>
    <Sheet open={adding} onClose={() => setAdding(false)} title="New note">
      <View className="gap-s3">
        <Field label="Title" value={title} onChangeText={setTitle} />
        <Field label="Note" value={body} onChangeText={setBody} multiline lines={5} />
        <View className="flex-row gap-s2">
          <Button kind="primary" label="Save" loading={busy} disabled={busy || !title.trim()} onPress={() => void add()} />
          <Button kind="ghost" label="Cancel" onPress={() => setAdding(false)} />
        </View>
      </View>
    </Sheet>
    <Card>
      {rows.length ? rows.map((x) => (
        <View key={x.id} className="gap-s2 pb-s3">
          <Row title={x.title || first(x.body) || "Note"} sub={x.title ? first(x.body) : undefined} onPress={() => setOpen(x.id)} end={<Chip>{WORDS[x.visibility ?? "private"] ?? String(x.visibility)}</Chip>} />
          {scope === "mine" ? <ShareControl urn={x.id} type="note" value={x.visibility ?? "private"} record={x.record} onDone={() => setN((c) => c + 1)} /> : null}
        </View>
      )) : <Text tone="label">{problem || (scope === "mine" ? "You have not written a note yet." : scope === "shared" ? "Nothing has been shared with you." : "No note is shared with the whole Space yet.")}</Text>}
    <NoteSheet id={open} me={me} onClose={() => setOpen(null)} onChanged={() => setN((c) => c + 1)} />
    </Card>
    </View>
  );
}
