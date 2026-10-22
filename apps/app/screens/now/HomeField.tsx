import { useState } from "react";
import { TextInput, View } from "react-native";
import { IconButton, useUiTheme } from "@vyre/ui";
import type { IconName } from "../../src/ui/icons.generated";
import { facesFor } from "../../src/theme/fonts";
import { cn } from "../../ui/lib/cn";

/** One line, with its icon button inside the field on the right. Enter and the icon do the same thing. */
export function HomeField({ value, onChangeText, placeholder, name, icon, action, busy, busyLabel, onSubmit }: {
  value: string; onChangeText: (v: string) => void; placeholder: string; /** Accessible name of the field. */ name: string;
  icon: IconName; /** Accessible name of the icon. */ action: string; busy?: boolean; busyLabel?: string; onSubmit: () => void;
}) {
  const [focus, setFocus] = useState(false);
  const { color, resolved, phone } = useUiTheme();
  const face = facesFor(resolved.font).regular;
  const quiet = !value.trim() || busy;
  return (
    <View className={cn("min-w-0 flex-row items-center rounded-field border bg-surface-3 pl-s3", focus ? "border-primary" : "border-edge")}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.label}
        accessibilityLabel={name}
        autoCapitalize="none"
        editable={!busy}
        onSubmitEditing={onSubmit}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={[face, { outlineStyle: "none" } as any]}
        className="h-control min-w-0 flex-1 text-body text-text"
      />
      <View style={quiet ? { opacity: 0.45 } : undefined}>
        <IconButton icon={icon} label={busy ? (busyLabel ?? action) : action} onPress={onSubmit} touch={phone} />
      </View>
    </View>
  );
}
