import { useEffect, useState } from "react";
import { View } from "react-native";
import { Card, Chip, Row, Text } from "@vyre/ui";
import { recordsApi, type NoteRow } from "./records-api";
import { ShareControl } from "./ShareControl";

const WORDS: Record<string, string> = { private: "Only me", record: "Whoever can see the record", space: "Everyone in the Space" };
const first = (s?: string) => String(s ?? "").split("\n")[0].slice(0, 120);

/** Notes for one scope: Mine, Shared with me, or the Space. A note is the planner's, so the box cuts the list to what the person may read (planner.list); a writer changes who can read their own note in place. */
export function NotesList({ scope }: { scope: "mine" | "shared" | "space" }) {
  const [rows, setRows] = useState<NoteRow[] | null>(null);
  const [problem, setProblem] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setRows(null); setProblem("");
    void recordsApi.notes(scope).then((r) => { if (!live) return; if (r.error) { setRows([]); setProblem(r.error.message || ""); } else setRows(r.data?.items ?? []); });
    return () => { live = false; };
  }, [scope, n]);
  if (rows === null) return <Text tone="label">Loading</Text>;
  return (
    <Card>
      {rows.length ? rows.map((x) => (
        <View key={x.id} className="gap-s2 pb-s3">
          <Row title={x.title || first(x.body) || "Note"} sub={x.title ? first(x.body) : undefined} end={<Chip>{WORDS[x.visibility ?? "private"] ?? String(x.visibility)}</Chip>} />
          {scope === "mine" ? <ShareControl urn={x.id} type="note" value={x.visibility ?? "private"} record={x.record} onDone={() => setN((c) => c + 1)} /> : null}
        </View>
      )) : <Text tone="label">{problem || (scope === "mine" ? "You have not written a note yet." : scope === "shared" ? "Nothing has been shared with you." : "No note is shared with the whole Space yet.")}</Text>}
    </Card>
  );
}
