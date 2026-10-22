import { useState } from "react";
import { Pressable } from "react-native";
import { Icon, type IconName } from "../components/Icon";
import { px } from "../lib/measure";
import { useUiTheme } from "../theme";

/**
 * A small icon button for a row: quiet until the row is hovered or the button itself has keyboard focus, so a copy control stays easy to reach and easy to see once it has focus.
 * On a phone it is always visible and 44 tall, because that is the touch target.
 */
export function QuietIcon({ icon, label, onPress, visible = false }: { icon: IconName; label: string; onPress: () => void; /** Drawn at full strength even before hover (the header's copy control). */ visible?: boolean }) {
  const { phone, map } = useUiTheme();
  const [focused, setFocused] = useState(false);
  const side = phone ? px(map, "--touch") : 24;
  const show = visible || focused || phone;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={(e) => { (e as { stopPropagation?: () => void }).stopPropagation?.(); onPress(); }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      pointerEvents={show ? "auto" : "none"}
      style={{ width: side, height: side, alignItems: "center", justifyContent: "center", opacity: show ? 1 : 0 }}
    >
      <Icon name={icon} size={14} tone="label" />
    </Pressable>
  );
}
