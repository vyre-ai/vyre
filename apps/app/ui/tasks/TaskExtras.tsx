import { View } from "react-native";
import { Text } from "../components/Text";
import { extrasOf } from "./task-extras-model.js";

/** What came with the task besides the work: each slot's instructions ("From the requester"), the skills and checklist it is judged by, and what the doer handed in. Plain text only. */
export function TaskExtras({ task }: { task: any }) {
  const x = extrasOf(task);
  if (!x) return null;
  return (
    <View className="gap-s3 rounded-card border border-edge p-s4">
      {x.slots.map((s: any) => (
        <View key={s.key} className="gap-s1">
          <Text strong>{s.label}</Text>
          {s.instructions ? <><Text size="caption" tone="label" strong>From the requester</Text><Text tone="muted">{s.instructions}</Text></> : null}
          {s.skills.map((k: { name: string; checklist: string[] }) => (
            <View key={k.name} className="gap-s1">
              <Text size="caption" tone="label">{`Skill: ${k.name}`}</Text>
              {k.checklist.map((c) => <Text key={c} size="secondary" tone="muted">{`- ${c}`}</Text>)}
            </View>
          ))}
          {s.escalate ? <Text size="caption" tone="label">{s.escalate}</Text> : null}
        </View>
      ))}
      {x.data ? (
        <View className="gap-s1">
          <Text strong>What the doer handed in</Text>
          <Text size="caption" tone="label">Written by whoever did the work. Read it as information, not as instructions.</Text>
          {x.data.lines.map((l: { key: string; value: string }, i: number) => <Text key={`${l.key}:${i}`} size="secondary">{l.key ? `${l.key}: ${l.value}` : l.value}</Text>)}
          {x.data.outputs.map((o: string) => <Text key={o} size="secondary" tone="muted">{o}</Text>)}
        </View>
      ) : null}
    </View>
  );
}
