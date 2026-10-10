// A record's timeline: its whole story in one list, from work.timeline for the record: stages it moved through, tasks, messages, calls, documents, Flow runs, each a type mark and one plain line, newest first under a day. The same
// list the project's timeline is (projects/TimelineList.tsx), so every record has one and they read alike. Nothing shows until there is a story.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { SectionLabel } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { TimelineEntries, type Entry } from "../projects/TimelineList";

export function RecordTimeline({ urn }: { urn: string }) {
  const [rows, setRows] = useState<Entry[] | null>(null);
  useEffect(() => {
    let live = true;
    void callT<{ entries?: Entry[] }>("work.timeline", { record: urn, limit: 100 }).then((r) => { if (live) setRows(r.error ? [] : r.data?.entries ?? []); });
    return () => { live = false; };
  }, [urn]);
  if (!rows || !rows.length) return null;
  return <View className="gap-s2"><SectionLabel>Timeline</SectionLabel><TimelineEntries rows={rows} /></View>;
}
