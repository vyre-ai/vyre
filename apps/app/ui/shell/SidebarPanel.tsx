import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Text } from "../components/Text";
import { Icon, type IconName } from "../components/Icon";
import { Tip } from "../components/Tip";
import { Pressable } from "react-native";
import { useUiTheme } from "../theme";
import { SidebarRow } from "./SidebarRow";
import { SidebarSearch } from "./SidebarSearch";
import { ArrowNav } from "./ArrowNav";
import { SidebarLabel } from "./SidebarLabel";
import { RAIL } from "./rail-tokens.js";
import { filterItems, groupItems } from "./sidebar-stack.js";

export type PanelItem = { id: string; label: string; href: string; icon?: IconName; group?: string; /** A mark (a project emblem) in place of the icon. */ lead?: React.ReactNode };
/** What a place shows in the sidebar once you are inside it: its list, with Back to the main sidebar. `before` and `after` are slots (the Records pinned views, "All record types", "New view"). */
export type PanelDef = {
  id: string; title: string; icon: IconName; onBack: () => void; items: PanelItem[]; currentHref?: string;
  /** The search's placeholder. Absent: no search. */ search?: string;
  /** A search the section owns (the Chat list's); else the panel keeps its own and filters its items by it. */ query?: string; onQuery?: (q: string) => void;
  /** A control inside the search's right end (a filter menu's button). */ filter?: React.ReactNode;
  /** Opens the main search with this section's scope. When given, the panel draws a Search button in place of a search box of its own: the one search bar is the main one. */ onSearch?: () => void;
  /** The section's + at the right of the top bar (a menu or a button). */ plus?: React.ReactNode;
  before?: React.ReactNode; after?: React.ReactNode; empty?: string;
};

/**
 * The panel a place's sidebar becomes: Back and the place's name, an optional search, the slots and the list grouped by a field with the current item marked. Folded, it is Back, the place's
 * icon and one icon per item, each named by a tip.
 */
export function SidebarPanel({ panel, folded, onOpen }: { panel: PanelDef; folded?: boolean; onOpen: (href: string) => void }) {
  const { color } = useUiTheme();
  const [own, setOwn] = useState("");
  const q = panel.onQuery ? panel.query ?? "" : own;
  const shown = panel.onQuery ? panel.items : filterItems(panel.items, q);
  if (folded) {
    return (
      <View style={{ gap: RAIL.rowGap }}>
        <Tip label="Back to the main sidebar" hint="Esc">
          <Pressable accessibilityRole="button" accessibilityLabel="Back to the main sidebar" onPress={panel.onBack} style={({ hovered }: any) => [{ minHeight: RAIL.foldedRow, borderRadius: RAIL.rowRadius, alignItems: "center", justifyContent: "center", backgroundColor: hovered ? color.hover : "transparent" }]}>
            <Icon name="chevron-left" tone="text-2" size={RAIL.iconSize} />
          </Pressable>
        </Tip>
        <View style={{ minHeight: RAIL.foldedRow, alignItems: "center", justifyContent: "center" }}><Icon name={panel.icon} tone="text" size={RAIL.iconSize} /></View>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: RAIL.rowGap }}>
          {panel.items.map((it) => <SidebarRow key={it.id} folded label={it.label} icon={it.icon ?? panel.icon} on={it.href === panel.currentHref} onPress={() => onOpen(it.href)} />)}
        </ScrollView>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, gap: 8, minHeight: 0 }}>
      {panel.onSearch ? <PanelSearchButton label={panel.search ?? "Search"} onPress={panel.onSearch} end={panel.filter} />
        : panel.search ? <SidebarSearch value={q} onChange={panel.onQuery ?? setOwn} placeholder={panel.search} end={panel.filter} /> : null}
      <ArrowNav>
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: RAIL.rowGap }}>
          {/* Back to the main sidebar is the first row, the same as any other place. */}
          <SidebarRow label="All places" icon="chevron-left" tone="label" onPress={panel.onBack} hint="Esc" />
          {panel.before}
          {groupItems(shown).map((g) => (
            <View key={g.label} style={{ gap: RAIL.rowGap }} role="group" accessibilityLabel={g.label || panel.title}>
              {g.label ? <SidebarLabel>{g.label}</SidebarLabel> : null}
              {g.items.map((it) => <SidebarRow key={it.id} label={it.label} icon={it.icon ?? panel.icon} lead={it.lead} on={it.href === panel.currentHref} onPress={() => onOpen(it.href)} />)}
            </View>
          ))}
          {!shown.length && panel.empty ? <Text tone="label" style={{ paddingHorizontal: RAIL.gutter, paddingTop: 8, fontSize: RAIL.labelSize }}>{q ? "Nothing matches." : panel.empty}</Text> : null}
          {panel.after}
        </ScrollView>
      </ArrowNav>
    </View>
  );
}

/** Where a panel's search box used to be: a button that opens the main search on this section's scope (Cmd K opens it on everything). */
function PanelSearchButton({ label, onPress, end }: { label: string; onPress: () => void; end?: React.ReactNode }) {
  const { color } = useUiTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginHorizontal: RAIL.gutter }}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ hovered, focused }: any) => [{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8, height: RAIL.searchH, paddingHorizontal: 12, borderRadius: RAIL.rowRadius, backgroundColor: hovered || focused ? color.hover : color["surface-2"] }]}>
        <Icon name="search" tone="label" size={RAIL.iconSize} />
        <Text tone="label" style={{ flex: 1, fontSize: RAIL.labelSize, lineHeight: RAIL.labelLine }} numberOfLines={1}>{label}</Text>
        <Text size="caption" tone="faint">Cmd K</Text>
      </Pressable>
      {end}
    </View>
  );
}
