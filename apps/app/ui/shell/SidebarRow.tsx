import { Pressable, View } from "react-native";
import { Text } from "../components/Text";
import { Icon, type IconName } from "../components/Icon";
import { Tip } from "../components/Tip";
import { useUiTheme } from "../theme";
import { RAIL } from "./rail-tokens.js";

/**
 * One row of the sidebar, in the main list, a panel or a slot (the pinned views): an icon or a mark, a label, an optional count or trailing thing. The current row is a raised fill with
 * medium text. Folded, only the icon shows in a 40 square and the label is a tip; the row keeps its accessible name.
 */
export function SidebarRow({ label, icon, lead, on, onPress, badge, trailing, folded, hint, tone }: {
  label: string; icon?: IconName; /** A mark in place of the icon (a project emblem, a space tile). */ lead?: React.ReactNode; on?: boolean; onPress?: () => void; badge?: number; trailing?: React.ReactNode; folded?: boolean; hint?: string; tone?: "muted" | "label";
}) {
  const { color } = useUiTheme();
  const ink = on ? "text" : tone === "label" ? "label" : "text-2";
  const row = (
    <Pressable accessibilityRole="link" accessibilityLabel={label} accessibilityState={{ selected: Boolean(on) }} onPress={onPress}
      style={({ hovered }: any) => [{ minHeight: folded ? RAIL.foldedRow : RAIL.rowH, borderRadius: RAIL.rowRadius, paddingHorizontal: folded ? 0 : RAIL.rowPadX, flexDirection: "row", alignItems: "center", justifyContent: folded ? "center" : "flex-start", gap: 12, backgroundColor: on ? color["surface-3"] : hovered ? "var(--hover)" : "transparent" }]}>
      {lead ?? (icon ? <View><Icon name={icon} tone={ink} size={RAIL.iconSize} />{folded && badge ? <View style={{ position: "absolute", right: -3, top: -3, width: 8, height: 8, borderRadius: 4, backgroundColor: color.primary }} /> : null}</View> : null)}
      {folded ? null : <Text medium={Boolean(on)} style={{ fontSize: RAIL.labelSize, lineHeight: RAIL.labelLine, color: color[ink] }} numberOfLines={1} className="flex-1">{label}</Text>}
      {!folded && badge ? <View className="min-w-s5 items-center rounded-full px-s2" style={{ backgroundColor: color.selected }}><Text size="caption" medium tone="default">{String(badge)}</Text></View> : null}
      {!folded ? trailing : null}
    </Pressable>
  );
  return folded ? <Tip label={label} hint={hint}>{row}</Tip> : row;
}
