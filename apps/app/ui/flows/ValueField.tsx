import { View } from "react-native";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { Menu } from "../components/Menu";
import type { Draft, Options } from "./logic.js";
import { valueSources } from "./logic.js";

/**
 * A one-line input that takes a typed value or a value from before this step. "Insert" lists what is there to use (what started the Flow, what earlier steps made); a value in braces, like {email}, is read
 * when the step runs. Used by every field of a step, so a value never has to be typed twice.
 */
export function ValueField({ label, name, value, onChange, placeholder, help, draft, stepId, options, multiline, lines }: {
  label?: string; name?: string; value: string; onChange: (v: string) => void; placeholder?: string; help?: string; draft: Draft; stepId: string; options: Options; multiline?: boolean; lines?: number;
}) {
  const sources = valueSources(draft, stepId, options);
  return (
    <View className="gap-s1">
      <Field label={label} name={name} value={value} onChangeText={onChange} placeholder={placeholder} help={help} multiline={multiline} lines={lines} />
      {sources.length ? (
        <View className="flex-row">
          <Menu align="start" trigger={<Button kind="ghost" size="sm" icon="mention" label="Insert a value" />} items={sources.map(([token, words]) => ({ label: words, onPress: () => onChange(`${value}${value && !/\s$/.test(value) ? " " : ""}${token}`) }))} />
        </View>
      ) : null}
    </View>
  );
}
