import { View } from "react-native";
import { Card, IconButton, Text } from "@vyre/ui";
import type { Body } from "./model";
import { TaskForm } from "./TaskForm";

type Who = { id: string; name: string };

/** A task's full settings beside the board (below it on a phone): the same fields the editor has, one place for them. */
export function TaskPanel({ body, si, ti, onChange, onClose, people, agents }: { body: Body; si: number; ti: number; onChange: (b: Body) => void; onClose: () => void; people: Who[]; agents: Who[] }) {
  const t = (body.stages[si]?.tasks || [])[ti];
  if (!t) return null;
  return (
    <Card><View className="gap-s3 p-s3">
      <View className="flex-row items-center gap-s2">
        <View className="min-w-0 flex-1"><Text strong numberOfLines={1}>{t.title || "Untitled task"}</Text><Text size="caption" tone="label">{body.stages[si].name}</Text></View>
        <IconButton icon="x" label="Close the settings" onPress={onClose} />
      </View>
      <TaskForm body={body} si={si} ti={ti} onChange={onChange} people={people} agents={agents} />
    </View></Card>
  );
}
