// The Chat list, as the sidebar draws it and as a phone's Chat page: a search with one filter control and the + menu above, then one calm row per conversation. A row is a face (an agent's blob, a
// person's circle, a stack for a group), a name, one line of preview, the time and at most one dot (unread, or waiting on you). The row's own menu shows on hover, on focus, or from a long press.
// It draws what convo-model.js shapes and calls nothing itself; the screen owns the data and what a tap does.

import { useState } from "react";
import { Pressable, View } from "react-native";
import { Avatar, AvatarStack } from "../components/Avatar";
import { markRef } from "../marks/useMark";
import { Field } from "../components/Field";
import { IconButton } from "../components/Button";
import { Menu, type MenuItem } from "../components/Menu";
import { Row } from "../components/Row";
import { Sheet } from "../components/Sheet";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
import { convoChips, type Convo } from "./convo-model.js";

export type { Convo };

/** The face in front of a row. */
function Face({ c }: { c: Convo }) {
  if (c.kind === "agent") return <Avatar of={markRef("agent", c.title, c.agent)} size={40} />;
  if (c.kind === "person") return <Avatar of={markRef("person", c.title, c.person)} size={40} />;
  if (c.kind === "group") return <AvatarStack of={c.names.map((n) => markRef("person", n))} size={28} max={2} />;
  const lone = c.names[0];
  return <Avatar of={markRef(lone ? "agent" : "project", lone ?? c.title, lone)} size={40} />;
}

function ConvoRow({ c, selected, when, menu, onOpen }: { c: Convo; selected?: boolean; when: string; menu?: MenuItem[]; onOpen: () => void }) {
  const { color } = useUiTheme();
  const [sheet, setSheet] = useState(false);
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`${c.title}${c.sub ? `, ${c.sub}` : ""}${c.dot === "ask" ? ", waiting on you" : c.dot === "unread" ? ", unread" : ""}${c.open ? "" : ", you are not in this chat"}`}
        accessibilityState={{ selected: Boolean(selected), disabled: !c.open }} onPress={c.open ? onOpen : undefined} onLongPress={menu && menu.length ? () => setSheet(true) : undefined}
        style={({ hovered, focused }: any) => [{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, opacity: c.open ? 1 : 0.5,
          backgroundColor: selected ? color.selected : hovered || focused ? color.hover : "transparent" }]}>
        {({ hovered, focused }: any) => (
          <>
            <View style={{ width: 44, alignItems: "center" }}><Face c={c} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text medium={Boolean(c.dot) || Boolean(selected)} numberOfLines={1}>{c.title}</Text>
              {c.sub ? <Text size="secondary" tone="label" numberOfLines={1}>{c.sub}</Text> : null}
            </View>
            <View style={{ alignItems: "flex-end", justifyContent: "center", gap: 6, minWidth: 28 }}>
              {hovered || focused ? (menu && menu.length && c.chat ? <Menu align="end" trigger={<IconButton icon="more" label={`More for ${c.title}`} kind="ghost" />} items={menu} /> : null)
                : <>
                  {when ? <Text size="caption" tone="label">{when}</Text> : null}
                  {c.dot ? <View accessibilityElementsHidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.dot === "ask" ? color.primary : color.label }} /> : null}
                </>}
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

export function ConversationList({ items, all, query, onQuery, project, onProject, tags, tag, onTag, extraFilters, onOpen, add, whenOf, menuOf, currentChat }: {
  /** The rows to draw (already filtered). */ items: readonly Convo[];
  /** Every row, so the filter menu lists each project once. */ all: readonly Convo[];
  query: string; onQuery: (q: string) => void; project: string; onProject: (id: string) => void;
  /** The tags a chat can be filtered by, and the one on. */ tags?: readonly string[]; tag?: string; onTag?: (t: string) => void;
  /** More choices at the end of the filter menu (the flow chats). */ extraFilters?: MenuItem[];
  onOpen: (c: Convo) => void;
  /** The + menu: New chat, New group chat, New agent, New email. */ add: MenuItem[];
  /** The short "when" at a row's end ("6m"); the screen formats it with the time library. */ whenOf: (c: Convo) => string;
  /** A row's own menu. */ menuOf?: (c: Convo) => MenuItem[];
  /** The chat that is open now, marked in the list. */ currentChat?: string;
}) {
  const chips = convoChips(all);
  const filters: MenuItem[] = [
    ...chips.map((k) => ({ label: k.label, selected: project === k.id, onPress: () => onProject(k.id) })),
    ...(tags ?? []).map((t) => ({ label: `#${t}`, selected: tag === t, onPress: () => onTag?.(tag === t ? "" : t) })),
    ...(extraFilters ?? []),
  ];
  const narrowed = project !== "all" || Boolean(tag);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <View style={{ flex: 1, minWidth: 0 }}><Field name="Search chats, agents and teammates" value={query} onChangeText={onQuery} placeholder="Search" onKey={(k) => { if (k === "Escape") onQuery(""); }} /></View>
        <Menu align="end" trigger={<IconButton icon="filter" label={narrowed ? "Filter, on" : "Filter"} kind={narrowed ? "secondary" : "ghost"} />} items={filters} />
        <Menu align="end" trigger={<IconButton icon="plus" label="New" kind="ghost" />} items={add} />
      </View>
      <View style={{ gap: 2 }}>
        {items.map((c) => <ConvoRow key={c.id} c={c} selected={Boolean(c.chat) && c.chat === currentChat} when={whenOf(c)} menu={menuOf?.(c)} onOpen={() => onOpen(c)} />)}
      </View>
    </View>
  );
}
