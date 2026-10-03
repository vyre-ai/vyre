import { View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { PressableScale } from "../motion/PressableScale";
import { SwipeActions, type SwipeSet } from "../motion/SwipeActions";
import { useUiTheme } from "../theme";

/**
 * The one list row: a leading mark, a title, a secondary line, an end. Lists, menus, search results and phone tables all use it.
 * `swipe` adds swipe actions (a phone, or any native screen): right reveals the leading buttons, left the trailing ones. The same actions are in a
 * screen reader's action menu on the row, so no action is gesture-only.
 */
export function Row({ lead, title, sub, end, onPress, selected, className, accessibilityLabel, swipe }: {
  lead?: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; end?: React.ReactNode; onPress?: () => void; selected?: boolean; className?: string; accessibilityLabel?: string; swipe?: SwipeSet;
}) {
  const { phone } = useUiTheme();
  const body = (
    <>
      {lead ? <View className="flex-none flex-row items-center">{lead}</View> : null}
      <View className="min-w-0 flex-1">
        {typeof title === "string" ? <Text strong size="headline" numberOfLines={1}>{title}</Text> : title}
        {sub ? (typeof sub === "string" ? <Text size="secondary" tone="label" numberOfLines={1}>{sub}</Text> : sub) : null}
      </View>
      {end ? <View className="flex-none flex-row items-center gap-s2">{end}</View> : null}
    </>
  );
  const cls = cn("min-h-row w-full flex-row items-center gap-s3 rounded-row px-s3 py-s2", selected && "bg-selected", className);
  const all = [...(swipe?.leading ?? []), ...(swipe?.trailing ?? [])];
  const row = !onPress ? <View className={cls}>{body}</View> : (
    <PressableScale
      depth={0.985}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      accessibilityActions={all.map((a) => ({ name: a.id, label: a.label }))}
      onAccessibilityAction={(e) => all.find((a) => a.id === e.nativeEvent.actionName)?.onPress()}
      onPress={onPress}
      className={cls}
      pressedStyle={{ backgroundColor: "var(--press)" }}
      hoverStyle={selected ? undefined : { backgroundColor: "var(--hover)" }}
    >
      {body}
    </PressableScale>
  );
  return swipe ? <SwipeActions leading={swipe.leading} trailing={swipe.trailing} enabled={phone}>{row}</SwipeActions> : row;
}
