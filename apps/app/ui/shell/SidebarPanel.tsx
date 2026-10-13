import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Text } from "../components/Text";
import { Icon, type IconName } from "../components/Icon";
import { Field } from "../components/Field";
import { Tip } from "../components/Tip";
import { Pressable } from "react-native";
import { useUiTheme } from "../theme";
import { SidebarRow } from "./SidebarRow";
import { RAIL } from "./rail-tokens.js";
import { filterItems, groupItems } from "./sidebar-stack.js";

export type PanelItem = { id: string; label: string; href: string; icon?: IconName; group?: string; /** A mark (a project emblem) in place of the icon. */ lead?: React.ReactNode };
/** What a place shows in the sidebar once you are inside it: its list, with Back to the main sidebar. `before` and `after` are slots (the Records pinned views, "All record types", "New view"). */
export type PanelDef = {
  id: string; title: string; icon: IconName; onBack: () => void; items: PanelItem[]; currentHref?: string; search?: string;
  before?: React.ReactNode; after?: React.ReactNode; empty?: string;
};

/**
 * The panel a place's sidebar becomes: Back and the place's name, an optional search, the slots and the list grouped by a field with the current item marked. Folded, it is Back, the place's
 * icon and one icon per item, each named by a tip.
 */
export function SidebarPanel({ panel, folded, onOpen }: { panel: PanelDef; folded?: boolean; onOpen: (href: string) => void }) {
  const { color } = useUiTheme();
  const [q, setQ] = useState("");
  const shown = filterItems(panel.items, q);
  const back = (
    <Pressable accessibilityRole="button" accessibilityLabel={`Back to the main sidebar`} onPress={panel.onBack} style={({ hovered }: any) => [{ minHeight: folded ? RAIL.foldedRow : RAIL.rowH, borderRadius: RAIL.rowRadius, paddingHorizontal: folded ? 0 : RAIL.rowPadX, flexDirection: "row", alignItems: "center", justifyContent: folded ? "center" : "flex-start", gap: 12, backgroundColor: hovered ? "var(--hover)" : "transparent" }]}>
      <Icon name="chevron-left" tone="text-2" size={RAIL.iconSize} />
      {folded ? null : <Text medium style={{ fontSize: RAIL.labelSize, lineHeight: RAIL.labelLine, color: color["text-2"] }}>{panel.title}</Text>}
    </Pressable>
  );
  if (folded) {
    return (
      <View style={{ gap: RAIL.rowGap }}>
        <Tip label="Back to the main sidebar" hint="Esc">{back}</Tip>
        <View style={{ minHeight: RAIL.foldedRow, alignItems: "center", justifyContent: "center" }}><Icon name={panel.icon} tone="text" size={RAIL.iconSize} /></View>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: RAIL.rowGap }}>
          {panel.items.map((it) => <SidebarRow key={it.id} folded label={it.label} icon={it.icon ?? panel.icon} on={it.href === panel.currentHref} onPress={() => onOpen(it.href)} />)}
        </ScrollView>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, gap: RAIL.rowGap, minHeight: 0 }}>
      {back}
      {panel.search ? <View style={{ paddingVertical: 4 }}><Field name={panel.search} value={q} onChangeText={setQ} placeholder={panel.search} /></View> : null}
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: RAIL.sectionGap / 2 }}>
        {panel.before}
        {groupItems(shown).map((g) => (
          <View key={g.label} style={{ gap: RAIL.rowGap }} role="group" accessibilityLabel={g.label || panel.title}>
            {g.label ? <Text size="caption" medium tone="label" style={{ paddingHorizontal: RAIL.rowPadX, paddingBottom: 4, fontSize: RAIL.sectionLabelSize }} numberOfLines={1}>{g.label}</Text> : null}
            {g.items.map((it) => <SidebarRow key={it.id} label={it.label} icon={it.icon ?? panel.icon} lead={it.lead} on={it.href === panel.currentHref} onPress={() => onOpen(it.href)} />)}
          </View>
        ))}
        {!shown.length && panel.empty ? <Text tone="label" size="secondary" style={{ paddingHorizontal: RAIL.rowPadX }}>{q ? "Nothing matches." : panel.empty}</Text> : null}
        {panel.after}
      </ScrollView>
    </View>
  );
}
