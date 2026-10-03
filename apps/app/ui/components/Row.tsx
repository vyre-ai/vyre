import { Pressable, View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";

/** The one list row: a leading mark, a title, a secondary line, an end. Lists, menus, search results and phone tables all use it. */
export function Row({ lead, title, sub, end, onPress, selected, className, accessibilityLabel }: {
  lead?: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; end?: React.ReactNode; onPress?: () => void; selected?: boolean; className?: string; accessibilityLabel?: string;
}) {
  const body = (
    <>
      {lead ? <View className="flex-none flex-row items-center">{lead}</View> : null}
      <View className="min-w-0 flex-1">
        {typeof title === "string" ? <Text strong numberOfLines={1}>{title}</Text> : title}
        {sub ? (typeof sub === "string" ? <Text size="caption" tone="label" numberOfLines={1}>{sub}</Text> : sub) : null}
      </View>
      {end ? <View className="flex-none flex-row items-center gap-s2">{end}</View> : null}
    </>
  );
  const cls = cn("min-h-row w-full flex-row items-center gap-s3 rounded-row px-s3 py-s2", selected && "bg-selected", className);
  if (!onPress) return <View className={cls}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ selected }} onPress={onPress} className={cls}
      style={({ pressed, hovered }: any) => (pressed ? { backgroundColor: "var(--press)" } : hovered && !selected ? { backgroundColor: "var(--hover)" } : undefined)}>
      {body}
    </Pressable>
  );
}
