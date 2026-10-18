import { ScrollView, View } from "react-native";
import { Button } from "./Button";
import { Chip } from "./Chip";
import { Text } from "./Text";
import type { AssistantBox } from "./quoted-assistants-model.js";

/**
 * What a Kit's assistants would be told, drawn for a person to read before saying yes. Each text is the Kit author's, outside text: plain React Native Text only (no markdown, no HTML, no link
 * detection), in its own bordered box under a label that says whose words they are, wrapping and scrollable when long, with the kernel's cut mark ("[cut: N characters in all]") shown whole. The kernel's
 * note sits beside the boxes, not collapsed. Nothing here builds a sentence from a quoted text. `onRead` makes the "I have read these" tap available; the screen keeps Approve off until it is tapped.
 */
export function QuotedAssistants({ boxes, note, read, onRead }: { boxes: AssistantBox[]; note?: string; read?: boolean; onRead?: () => void }) {
  if (!boxes.length) return null;
  return (
    <View className="gap-s3">
      <Text strong>{boxes.length === 1 ? "The assistant this Kit makes" : `The ${boxes.length} assistants this Kit makes`}</Text>
      {note ? <Text size="caption" tone="label">{note}</Text> : null}
      {boxes.map((b) => (
        <View key={b.name} className="gap-s1">
          <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{b.name}</Text>{b.change ? <Chip>{b.change}</Chip> : null}</View>
          <View className="rounded-card border border-edge-strong p-s3">
            <Text size="caption" tone="label" strong>Outside text from the Kit author</Text>
            <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
              <Text selectable>{b.text}</Text>
            </ScrollView>
          </View>
        </View>
      ))}
      {onRead ? (read ? <Chip tone="ok">You have read these</Chip> : <View className="self-start"><Button kind="secondary" label="I have read these" onPress={onRead} /></View>) : null}
    </View>
  );
}
