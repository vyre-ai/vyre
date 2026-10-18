// The Chat list, as the sidebar draws it and as a phone's Chat page: a search with one filter control and the + menu above, then one calm row per conversation. A row is a face (an agent's blob, a
// person's circle, a stack for a group), a name, one line of preview, the time and at most one dot (unread, or waiting on you). The row's own menu shows on hover, on focus, or from a long press.
// It draws what convo-model.js shapes and calls nothing itself; the screen owns the data and what a tap does.

import { useState } from "react";
import { Pressable, View } from "react-native";
import { Avatar, AvatarStack } from "../components/Avatar";
import { markRef } from "../marks/useMark";
import { Field } from "../components/Field";
import { Button, IconButton } from "../components/Button";
import { Menu, type MenuItem } from "../components/Menu";
import { Icon } from "../components/Icon";
import { Row } from "../components/Row";
import { RAIL } from "../shell/rail-tokens.js";
import { Sheet } from "../components/Sheet";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
import { convoChips, type Convo } from "./convo-model.js";

export type { Convo };

/** The face in front of a row, in a 32 box. */
function Face({ c }: { c: Convo }) {
  if (c.kind === "agent") return <Avatar of={markRef("agent", c.title, c.agent, c.look || undefined)} size={32} />;
  if (c.kind === "person") return <Avatar of={markRef("person", c.title, c.person)} size={32} />;
  if (c.kind === "group") return <AvatarStack of={c.names.map((n) => markRef("person", n))} size={24} max={2} />;
  const lone = c.names[0];
  return <Avatar of={markRef(lone ? "agent" : "project", lone ?? c.title, lone)} size={32} />;
}

/** A chat row: 56 high, a 32 face, 12 between, the name at 14/20 medium with the time at its right, the preview at 13/18 muted with the dot at its right. The fill is inset 8 from the edges and the content pads 8 more, so the face sits on the 16 gutter. */
function ConvoRow({ c, selected, when, menu, onOpen }: { c: Convo; selected?: boolean; when: string; menu?: MenuItem[]; onOpen: () => void }) {
  const { color } = useUiTheme();
  const [sheet, setSheet] = useState(false);
  const ease = { transitionProperty: "background-color", transitionDuration: `${RAIL.easeMs}ms` };
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`${c.title}${c.sub ? `, ${c.sub}` : ""}${c.dot === "ask" ? ", waiting on you" : c.dot === "unread" ? ", unread" : ""}${c.open ? "" : ", you are not in this chat"}`}
        accessibilityState={{ selected: Boolean(selected), disabled: !c.open }} onPress={c.open ? onOpen : undefined} onLongPress={menu && menu.length ? () => setSheet(true) : undefined}
        style={({ hovered, focused }: any) => [{ flexDirection: "row", alignItems: "center", gap: RAIL.iconGap, height: RAIL.chatRowH, marginHorizontal: RAIL.rowInset, paddingHorizontal: RAIL.gutter - RAIL.rowInset, borderRadius: RAIL.rowRadius, opacity: c.open ? 1 : 0.5,
          backgroundColor: selected ? color.selected : hovered || focused ? color.hover : "transparent",
          ...(focused ? { outlineStyle: "solid", outlineWidth: 2, outlineColor: color.primary, outlineOffset: -2 } : {}), ...ease } as any]}>
        {({ hovered, focused }: any) => (
          <>
            <View style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}><Face c={c} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 20 }}>
                <Text medium numberOfLines={1} style={{ flex: 1, fontSize: RAIL.labelSize, lineHeight: RAIL.labelLine }}>{c.title}</Text>
                {hovered || focused ? (menu && menu.length && c.chat ? <Menu align="end" trigger={<Pressable accessibilityRole="button" accessibilityLabel={`More for ${c.title}`} style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}><Icon name="more" size={RAIL.iconSize} tone="label" /></Pressable>} items={menu} /> : null)
                  : when ? <Text tone="label" style={{ fontSize: RAIL.sectionLabelSize, lineHeight: 16 }}>{when}</Text> : null}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: RAIL.subLine }}>
                <Text tone="label" numberOfLines={1} style={{ flex: 1, fontSize: RAIL.subSize, lineHeight: RAIL.subLine }}>{c.sub}</Text>
                {c.dot ? <View accessibilityElementsHidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.dot === "ask" ? color.primary : color.label }} /> : null}
              </View>
            </View>
          </>
        )}
      </Pressable>
      {menu && menu.length ? (
        <Sheet open={sheet} onClose={() => setSheet(false)} title={c.title}>
          {menu.map((m) => <Row key={m.label} title={m.label} onPress={() => { setSheet(false); m.onPress(); }} />)}
        </Sheet>
      ) : null}
    </>
  );
}

/** The header row of the Chat list: whatever leads it (the sidebar's back button), the search, one filter control and the + menu. */
export function ConversationHeader({ lead, all, query, onQuery, onSearch, project, onProject, tags, tag, onTag, extraFilters, add }: {
  /** Put first in the row (the sidebar's back button). */ lead?: React.ReactNode;
  /** Every row, so the filter menu lists each project once. */ all: readonly Convo[];
  query: string; onQuery: (q: string) => void; /** The one search bar is the main one: given, the row shows a Search button that opens it on chats, in place of a box of its own. */ onSearch?: () => void; project: string; onProject: (id: string) => void;
  tags?: readonly string[]; tag?: string; onTag?: (t: string) => void;
  /** More choices at the end of the filter menu (the flow chats). */ extraFilters?: MenuItem[];
  /** The + menu: New chat, New group chat, New agent, New email. */ add: MenuItem[];
}) {
  const chips = convoChips(all);
  const filters: MenuItem[] = [
    ...chips.map((k) => ({ label: k.label, selected: project === k.id, onPress: () => onProject(k.id) })),
    ...(tags ?? []).map((t) => ({ label: `#${t}`, selected: tag === t, onPress: () => onTag?.(tag === t ? "" : t) })),
    ...(extraFilters ?? []),
  ];
  const narrowed = project !== "all" || Boolean(tag);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {lead}
      <View style={{ flex: 1, minWidth: 0 }}>
        {onSearch ? <Button kind="ghost" icon="search" label="Search chats" onPress={onSearch} /> : <Field name="Search chats, agents and teammates" value={query} onChangeText={onQuery} placeholder="Search" onKey={(k) => { if (k === "Escape") onQuery(""); }} />}
      </View>
      <Menu align="end" trigger={<IconButton icon="filter" label={narrowed ? "Filter, on" : "Filter"} kind={narrowed ? "secondary" : "ghost"} />} items={filters} />
      <Menu align="end" trigger={<IconButton icon="plus" label="New" kind="ghost" />} items={add} />
    </View>
  );
}

/** The rows of the Chat list. */
export function ConversationList({ items, onOpen, whenOf, menuOf, currentChat }: {
  /** The rows to draw (already filtered). */ items: readonly Convo[];
  onOpen: (c: Convo) => void;
  /** The short "when" at a row's end ("6m"); the screen formats it with the time library. */ whenOf: (c: Convo) => string;
  /** A row's own menu. */ menuOf?: (c: Convo) => MenuItem[];
  /** The chat that is open now, marked in the list. */ currentChat?: string;
}) {
  return (
    <View style={{ gap: RAIL.rowGap }}>
      {items.map((c) => <ConvoRow key={c.id} c={c} selected={Boolean(c.chat) && c.chat === currentChat} when={whenOf(c)} menu={menuOf?.(c)} onOpen={() => onOpen(c)} />)}
    </View>
  );
}
