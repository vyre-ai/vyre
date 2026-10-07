import { Pressable, View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { elevation } from "../lib/elevation";
import { Icon, type IconName } from "./Icon";
import { useUiTheme } from "../theme";

/**
 * The one segmented control (ui-review Global 8): 36 high (40 on a phone, 32 when it is icons only), a pill, the chosen segment on surface-3 with level-1 elevation, the others
 * text only on a quiet track. 2 to 5 choices; wraps on narrow screens, never scrolls. `fill` stretches it to the full width with equal segments (a phone's scope control);
 * `icons` names an icon per choice and `iconsOnly` shows only the icons (List, Board, Calendar on a phone), the label staying as the accessible name.
 */
export function Segmented<T extends string>({ options, value, onChange, label, fill, icons, iconsOnly }: { options: [T, string][]; value?: T; onChange?: (v: T) => void; label?: string; fill?: boolean; icons?: Partial<Record<T, IconName>>; iconsOnly?: boolean }) {
  const { phone, resolved } = useUiTheme();
  const h = iconsOnly ? 32 : phone ? 40 : 36;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ minHeight: h, padding: 2 }} className={cn("max-w-full flex-row gap-s1 bg-hover", fill ? "self-stretch rounded-full" : "flex-wrap self-start rounded-card")}>
      {options.map(([v, l]) => (
        <Pressable key={v} accessibilityRole="radio" accessibilityLabel={l} accessibilityState={{ selected: v === value }} onPress={() => onChange?.(v)}
          style={[{ height: h - 4 }, v === value ? elevation(resolved.scheme, 1) : null]}
          className={cn("flex-row items-center justify-center gap-s2 rounded-full", iconsOnly ? "px-s3" : "px-s4", fill && "grow", v === value ? "bg-surface-3" : "bg-transparent")}>
          {icons?.[v] ? <Icon name={icons[v] as IconName} size={16} tone={v === value ? "text" : "text-2"} /> : null}
          {iconsOnly && icons?.[v] ? null : <Text medium numberOfLines={1} style={{ fontSize: 15, lineHeight: 20 }} tone={v === value ? "default" : "muted"}>{l}</Text>}
        </Pressable>
      ))}
    </View>
  );
}
