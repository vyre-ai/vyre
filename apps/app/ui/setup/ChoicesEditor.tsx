import { useState } from "react";
import { View } from "react-native";
import { Button, IconButton } from "../components/Button";
import { Card, Divider } from "../components/Card";
import { Field } from "../components/Field";
import { Text } from "../components/Text";
import { addChoice, moveChoice, removeChoice } from "./logic.js";

/** The options of a choice field: type one and add it, rename in place, move up or down, remove. No two alike. */
export function ChoicesEditor({ options, onChange, error }: { options: string[]; onChange: (o: string[]) => void; error?: string }) {
  const [next, setNext] = useState("");
  const add = () => { const n = addChoice(options, next); if (n !== options) { onChange(n); setNext(""); } };
  return (
    <View className="gap-s2">
      {options.length ? (
        <Card flush>
          {options.map((o, i) => (
            <View key={i}>
              {i ? <Divider /> : null}
              <View className="flex-row items-center gap-s1 py-s1 pl-s3 pr-s1">
                <View className="min-w-0 flex-1"><Field name={`Option ${i + 1}`} value={o} onChangeText={(v) => onChange(options.map((x, k) => (k === i ? v : x)))} /></View>
                <IconButton icon="chevron-up" label={`Move ${o} up`} onPress={() => onChange(moveChoice(options, i, -1))} />
                <IconButton icon="chevron-down" label={`Move ${o} down`} onPress={() => onChange(moveChoice(options, i, 1))} />
                <IconButton icon="trash" label={`Remove ${o}`} onPress={() => onChange(removeChoice(options, i))} />
              </View>
            </View>
          ))}
        </Card>
      ) : null}
      <View className="flex-row items-end gap-s2">
        <View className="min-w-0 flex-1"><Field label="Add an option" value={next} onChangeText={setNext} placeholder="For example Real estate" /></View>
        <Button kind="secondary" icon="plus" label="Add" disabled={!next.trim()} onPress={add} />
      </View>
      {error ? <Text size="caption" tone="err">{error}</Text> : <Text size="caption" tone="label">The order here is the order people see. Press Add to keep one.</Text>}
    </View>
  );
}
