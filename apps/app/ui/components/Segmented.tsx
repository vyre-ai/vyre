import { Pressable, View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { elevation } from "../lib/elevation";
import { useUiTheme } from "../theme";

/**
 * The one segmented control (ui-review Global 8): 36 high (40 on a phone), a pill, the chosen segment on surface-3 with level-1 elevation, the others
 * text only on a quiet track. 2 to 5 choices; wraps on narrow screens, never scrolls.
 */
export function Segmented<T extends string>({ options, value, onChange, label }: { options: [T, string][]; value?: T; onChange?: (v: T) => void; label?: string }) {
  const { phone, resolved } = useUiTheme();
  const h = phone ? 40 : 36;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ minHeight: h, padding: 2 }} className="max-w-full flex-row flex-wrap self-start gap-s1 rounded-full bg-hover">
      {options.map(([v, l]) => (
        <Pressable key={v} accessibilityRole="radio" accessibilityState={{ selected: v === value }} onPress={() => onChange?.(v)}
          style={[{ height: h - 4 }, v === value ? elevation(resolved.scheme, 1) : null]}
          className={cn("items-center justify-center rounded-full px-s4", v === value ? "bg-surface-3" : "bg-transparent")}>
          <Text medium style={{ fontSize: 15, lineHeight: 20 }} tone={v === value ? "default" : "muted"}>{l}</Text>
        </Pressable>
      ))}
    </View>
  );
}
