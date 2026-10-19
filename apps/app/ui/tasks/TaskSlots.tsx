import { View } from "react-native";
import { Chip } from "../components/Chip";
import { Text } from "../components/Text";
import { reviewWords, slotsOf, stateStrip, stateWord } from "./slots-model.js";

/**
 * A task's slots and where it stands (DESIGN-tasks-v2.md): the strip of states with the current one marked, who is Assigned and, when they are set, the Reviewer and the Approver (an unset
 * slot is not drawn: nothing waits on it), and what the review said: the checklist with each item ticked or not, the reviewer's type (an agent's ticks are marked), and the note.
 */
export function TaskSlots({ task, nameOf }: { task: any; nameOf: (kind: string, id: string) => string }) {
  const strip = stateStrip(task.state);
  const at = strip.indexOf(task.state);
  const review = reviewWords(task, nameOf);
  return (
    <View className="gap-s3">
      <View className="flex-row flex-wrap gap-s1">
        {strip.map((s, i) => <Chip key={s} tone={i === at ? "accent" : "plain"}>{stateWord(s)}</Chip>)}
      </View>
      <View className="gap-s2">
        {slotsOf(task, nameOf).map((s) => (
          <View key={s.key} className="flex-row items-center gap-s3">
            <Text size="caption" tone="label" className="w-[80px]">{s.label}</Text>
            <Text>{s.who}</Text>
          </View>
        ))}
      </View>
      {review.skipped ? <Text size="caption" tone="label">{review.skipped}</Text> : null}
      {review.line ? (
        <View className="gap-s1 rounded-card border border-edge p-s3">
          <Text strong>{review.line}</Text>
          {review.items.map((x: { skill: string; item: string; ok: boolean }) => <Text key={`${x.skill}:${x.item}`} size="secondary" tone={x.ok ? "default" : "err"}>{`${x.ok ? "✓" : "✗"} ${x.item}`}</Text>)}
          {review.note ? <Text size="secondary" tone="muted">{review.note}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
