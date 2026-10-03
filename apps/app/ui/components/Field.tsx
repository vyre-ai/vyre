import { useState } from "react";
import { TextInput, View, type KeyboardTypeOptions } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { faces } from "../../src/theme/fonts";
import { useUiTheme } from "../theme";

/** One-line input shell, label above. `kind` picks the keyboard and the mask; the value is always a string at this layer. */
export function Field({ label, value, onChangeText, placeholder, kind = "text", error, help, disabled, multiline, mono, className }: {
  label?: string; value: string; onChangeText?: (v: string) => void; placeholder?: string; kind?: "text" | "number" | "email" | "phone" | "password" | "url" | "date";
  error?: string; help?: string; disabled?: boolean; multiline?: boolean; mono?: boolean; className?: string;
}) {
  const [focus, setFocus] = useState(false);
  const { color } = useUiTheme();
  const kb: KeyboardTypeOptions = kind === "number" ? "decimal-pad" : kind === "email" ? "email-address" : kind === "phone" ? "phone-pad" : kind === "url" ? "url" : "default";
  const note = error || help;
  return (
    <View className={cn("min-w-0 gap-s1", disabled && "opacity-60", className)}>
      {label ? <Text size="caption" strong tone="label">{label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.label}
        editable={!disabled}
        multiline={multiline}
        keyboardType={kb}
        secureTextEntry={kind === "password"}
        autoCapitalize="none"
        accessibilityLabel={label ?? placeholder}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={[mono ? faces.mono : faces.regular, { outlineStyle: "none" } as any]}
        className={cn("w-full min-w-0 rounded-field border bg-surface-3 px-s3 text-body text-text", multiline ? "min-h-row py-s2" : "h-control", focus ? "border-accent" : error ? "border-err" : "border-edge")}
      />
      {note ? <Text size="caption" tone={error ? "err" : "label"}>{note}</Text> : null}
    </View>
  );
}
