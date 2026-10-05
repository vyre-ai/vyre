import { useMemo, useState } from "react";
import { View } from "react-native";
import { ActorMark, Field, Row, SectionLabel, Sheet, Text } from "@vyre/ui";
import { assignGroups, searchGroups, type Assignee } from "./model";

/**
 * The one Assign to picker (a sheet), for tasks, a record's owner field, projects, Flow steps and chats: people and assistants listed together,
 * the project's teammates first. The caller owns `open` and what choosing does.
 */
export function AssignPicker({ open, onClose, title = "Assign to", actors, onProject = [], exclude = [], onPick }: {
  open: boolean; onClose: () => void; title?: string; actors: Assignee[]; onProject?: string[]; exclude?: string[]; onPick: (a: Assignee) => void;
}) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => searchGroups(assignGroups(actors, onProject, exclude), q), [actors, onProject, exclude, q]);
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <View className="gap-s2">
        <Field name="Search" value={q} onChangeText={setQ} placeholder="Search" />
        {groups.length ? groups.map((g) => (
          <View key={g.title}>
            <SectionLabel>{g.title}</SectionLabel>
            {g.rows.map((a) => <Row key={a.id} lead={<ActorMark who={a as any} />} title={a.name} sub={a.role || (a.family === "person" ? "Person" : "Assistant")} onPress={() => { onPick(a); onClose(); }} />)}
          </View>
        )) : <Text tone="muted">Nobody matches that.</Text>}
      </View>
    </Sheet>
  );
}
