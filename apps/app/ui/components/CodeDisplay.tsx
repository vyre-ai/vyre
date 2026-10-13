import { useState } from "react";
import { Platform, View } from "react-native";
import { Button } from "./Button";
import { Text } from "./Text";

/**
 * A code the person reads or copies: the label above, the code in the mono face at the title size, a Copy button, and one line under it (how long it lasts, who to keep it from).
 * The pairing code of "Add your phone" and the space code are this (otp.md): groups joined by a hyphen, never wrapping, selectable.
 */
export function CodeDisplay({ label, code, note, onCopy }: { label?: string; code: string; note?: string; onCopy?: (code: string) => void }) {
  const [said, setSaid] = useState(false);
  const copy = () => {
    if (onCopy) onCopy(code);
    else if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) void navigator.clipboard.writeText(code);
    setSaid(true);
    setTimeout(() => setSaid(false), 1500);
  };
  return (
    <View className="gap-s2 rounded-card border border-edge bg-surface-3 p-s4" accessible accessibilityLabel={`${label ?? "Code"}: ${code.split("").join(" ")}`}>
      {label ? <Text size="caption" strong tone="label">{label}</Text> : null}
      <View className="flex-row flex-wrap items-center gap-s3">
        <Text mono strong selectable size="title" numberOfLines={1} className="min-w-0 flex-shrink">{code}</Text>
        <Button kind="secondary" size="sm" icon={said ? "check" : "copy"} label={said ? "Copied" : "Copy"} onPress={copy} />
      </View>
      {note ? <Text size="caption" tone="muted">{note}</Text> : null}
    </View>
  );
}
