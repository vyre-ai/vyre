import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { Text, useTypeStyle, useUiTheme } from "@vyre/ui";

/** A name you edit where it is: it reads as a title, and a change is kept when you press Enter or leave it (an empty name puts the old one back). No Save button, no card around it. */
export function InlineTitle({ value, label, busy, onCommit }: { value: string; label: string; busy?: boolean; onCommit: (next: string) => void }) {
  const { color } = useUiTheme();
  const style = useTypeStyle("title");
  const [text, setText] = useState(value);
  const [focus, setFocus] = useState(false);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const next = text.trim();
    if (!next) { setText(value); return; }
    if (next !== value) onCommit(next);
  };
  return (
    <View className="gap-s1">
      <Text size="caption" tone="label">{label}</Text>
      <TextInput
        value={text} onChangeText={setText} onBlur={() => { setFocus(false); commit(); }} onFocus={() => setFocus(true)} onSubmitEditing={commit}
        editable={!busy} accessibilityLabel={label} returnKeyType="done"
        style={[style, { color: color.text, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: focus ? color.primary : "transparent", opacity: busy ? 0.6 : 1 }] as any}
      />
    </View>
  );
}
