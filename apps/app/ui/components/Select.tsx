import { Pressable, View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { Menu } from "./Menu";
import { Icon } from "./Icon";

/** One choice from a list, in a menu. Looks like Field; the options are [value, label]. "None" is the caller's option when a blank is allowed. */
export function Select({ value, options, onChange, placeholder = "Choose", label, disabled, className }: {
  value: string; options: [string, string][]; onChange: (v: string) => void; placeholder?: string; label?: string; disabled?: boolean; className?: string;
}) {
  const current = options.find(([v]) => v === value);
  return (
    <View className={cn("min-w-0 gap-s1", disabled && "opacity-60", className)}>
      {label ? <Text size="caption" strong tone="label">{label}</Text> : null}
      <Menu
        trigger={(
          <Pressable disabled={disabled} accessibilityRole="button" accessibilityLabel={label ? `${label}: ${current?.[1] ?? placeholder}` : current?.[1] ?? placeholder}
            className="h-control w-full min-w-0 flex-row items-center gap-s2 rounded-field border border-edge bg-surface-3 px-s3"
            style={({ hovered }: any) => (hovered ? { borderColor: "var(--edge-strong)" } : undefined)}>
            <Text numberOfLines={1} tone={current ? "default" : "label"} className="min-w-0 flex-1">{current?.[1] ?? placeholder}</Text>
            <Icon name="chevron-down" size={16} tone="label" />
          </Pressable>
        )}
        items={options.map(([v, l]) => ({ label: l, onPress: () => onChange(v) }))}
      />
    </View>
  );
}
