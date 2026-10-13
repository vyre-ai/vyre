import { useState } from "react";
import { View } from "react-native";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { Text } from "../components/Text";
import { TimelineItem } from "../components/TimelineItem";
import { TIMELINE_KINDS, timelineOf } from "./logic.js";

export type Activity = { id: string; kind: "note" | "email" | "call" | "change"; at: number; when: string; actor: string; what: string; why?: string };

/** One timeline of a record: notes, emails, calls and field changes together, newest first, one chip row to narrow it, and a note box on top. */
export function ActivityFeed({ items, onNote }: { items: Activity[]; onNote: (text: string) => void }) {
  const [kind, setKind] = useState("all");
  const [text, setText] = useState("");
  const shown = timelineOf(items, kind);
  return (
    <Card title="Activity" className="gap-s3">
      <View className="gap-s2">
        <Field name="Add a note" value={text} onChangeText={setText} placeholder="Add a note for the team" multiline lines={2} />
        <View className="flex-row"><Button kind="secondary" size="sm" icon="plus" label="Add note" disabled={!text.trim()} onPress={() => { onNote(text.trim()); setText(""); }} /></View>
      </View>
      <View className="flex-row flex-wrap gap-s2">{TIMELINE_KINDS.map(([k, l]) => <Chip key={k} selected={kind === k} onPress={() => setKind(k)}>{l}</Chip>)}</View>
      {shown.length ? shown.map((i) => <TimelineItem key={i.id} actor={i.actor} what={i.what} at={i.when} why={i.why} />) : <Text tone="label">Nothing of this kind yet.</Text>}
    </Card>
  );
}
