import { Pressable, View } from "react-native";
import { useUiTheme } from "../theme";
import { Text } from "./Text";
import { Icon, type IconName } from "./Icon";

/**
 * A state the person set that differs from the default (who answers, where it runs, a file, a picked record), as a quiet chip that can be taken off. 28 high (44 hit area on a phone),
 * the x at its right removes it. Without `onRemove` it is a plain readout; with `onPress` the whole chip opens its picker.
 */
export function ChipToken({ label, icon, leading, tone = "plain", onPress, onRemove, removeLabel }: { label: string; icon?: IconName; leading?: React.ReactNode; tone?: "plain" | "accent" | "warn" | "err"; onPress?: () => void; onRemove?: () => void; removeLabel?: string }) {
  const { color, phone } = useUiTheme();
  const bg = tone === "accent" ? color["accent-wash"] : tone === "warn" ? color["warn-wash"] : tone === "err" ? color["err-wash"] : color.hover;
  const ink = tone === "accent" ? "accent" : tone === "warn" ? "warn" : tone === "err" ? "err" : "muted";
  const body = (
    <View style={{ minHeight: 28, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 8, paddingRight: onRemove ? 2 : 8, borderRadius: 14, backgroundColor: bg }}>
      {leading}
      {icon ? <Icon name={icon} size={14} tone={ink} /> : null}
      <Text size="caption" medium tone={ink} numberOfLines={1} style={{ maxWidth: 220 }}>{label}</Text>
      {onRemove ? (
        <Pressable accessibilityRole="button" accessibilityLabel={removeLabel ?? `Remove ${label}`} hitSlop={phone ? 8 : 4} onPress={onRemove} style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 12 }}>
          <Icon name="x" size={12} tone={ink} />
        </Pressable>
      ) : null}
    </View>
  );
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ alignSelf: "flex-start", minHeight: phone ? 44 : 28, justifyContent: "center" }}>{body}</Pressable> : <View style={{ alignSelf: "flex-start" }}>{body}</View>;
}
