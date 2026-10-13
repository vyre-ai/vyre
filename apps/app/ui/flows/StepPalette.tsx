import { useState } from "react";
import { View } from "react-native";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { IconTile } from "../components/IconTile";
import { Row } from "../components/Row";
import { Text } from "../components/Text";
import { searchChoices } from "./logic.js";

/**
 * What a step can be, in groups (Logic, Records, Calculate, Send, AI, Work) with a search box. Typing narrows the list and Enter picks the first one; every row is focusable, so Tab and Enter work
 * without the mouse. A choice the engine cannot do yet is shown and marked Coming.
 */
export function StepPalette({ onPick, onCancel }: { onPick: (kind: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState("");
  const groups = searchChoices(q);
  const first = groups[0]?.items[0];
  return (
    <Card flush>
      <View className="gap-s2 px-s4 pt-s3 pb-s2">
        <Text strong>What should happen next?</Text>
        <Field name="Search steps" value={q} onChangeText={setQ} placeholder="Search: if, wait, email, formula, find..." onSubmit={() => { if (first && !("soon" in first && first.soon)) onPick(first.kind); }} />
      </View>
      {groups.length ? groups.map((g) => (
        <View key={g.name}>
          <View className="px-s4 pt-s2 pb-s1"><Text size="caption" strong tone="label">{g.name}</Text></View>
          {g.items.map((c) => (
            <Row key={c.kind} dense lead={<IconTile name={c.icon as any} />} title={c.label} sub={c.hint} end={"soon" in c && c.soon ? <Chip tone="accent">Coming</Chip> : undefined} onPress={"soon" in c && c.soon ? undefined : () => onPick(c.kind)} />
          ))}
        </View>
      )) : <View className="px-s4 pb-s3"><Text tone="muted">{`Nothing matches "${q}". Try if, wait, email, formula or find.`}</Text></View>}
      <View className="px-s4 py-s2"><Button kind="ghost" size="sm" label="Cancel" onPress={onCancel} /></View>
    </Card>
  );
}
