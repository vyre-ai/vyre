// The Chat screen's one list: chats, group chats, agents and teammates as rows, with a search, the project chips and the + menu. It draws what convo-model.js shapes and calls nothing itself;
// the screen owns the data and what a tap does.

import { View } from "react-native";
import { Avatar } from "../components/Avatar";
import { markRef } from "../marks/useMark";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { IconButton } from "../components/Button";
import { Icon } from "../components/Icon";
import { Menu, type MenuItem } from "../components/Menu";
import { Row } from "../components/Row";
import { Text } from "../components/Text";
import { convoChips, convoKindWord, type Convo } from "./convo-model.js";

export type { Convo };

/** The mark in front of a row: a person or an agent has a face, a chat a bubble, a group the people icon. */
function Lead({ c }: { c: Convo }) {
  if (c.kind === "agent") return <Avatar of={markRef("agent", c.title, c.agent)} size={40} />;
  if (c.kind === "person") return <Avatar of={markRef("person", c.title, c.person)} size={40} />;
  return <Icon name={c.kind === "group" ? "users" : "chat"} size={24} tone="text-2" />;
}

export function ConversationList({ items, query, onQuery, project, onProject, onOpen, add, whenOf, menuOf }: {
  items: readonly Convo[]; query: string; onQuery: (q: string) => void; project: string; onProject: (id: string) => void;
  onOpen: (c: Convo) => void;
  /** The + menu: New chat, New group chat, New agent. */
  add: MenuItem[];
  /** The short "when" at a row's end ("6m"); the screen formats it with the time library. */
  whenOf: (c: Convo) => string;
  /** A row's own menu, when it has one. */
  menuOf?: (c: Convo) => MenuItem[];
}) {
  const chips = convoChips(items);
  return (
    <View className="gap-s3">
      <View className="flex-row items-end gap-s2">
        <View className="min-w-0 flex-1"><Field name="Search chats, agents and teammates" value={query} onChangeText={onQuery} placeholder="Search" onKey={(k) => { if (k === "Escape") onQuery(""); }} /></View>
        <Menu align="end" trigger={<IconButton icon="plus" label="New" kind="secondary" />} items={add} />
      </View>
      {chips.length > 2 ? (
        <View accessibilityLabel="Filter by project" className="flex-row flex-wrap gap-s1">
          {chips.map((k) => <Chip key={k.id} selected={project === k.id} onPress={() => onProject(k.id)}>{k.label}</Chip>)}
        </View>
      ) : null}
      <View>
        {items.map((c) => {
          const when = whenOf(c);
          return (
            <Row key={c.id} lead={<Lead c={c} />} title={c.title} sub={[convoKindWord(c.kind), c.sub].filter(Boolean).join(" · ")}
              state={c.asks > 0 ? "Needs you" : c.unread > 0 ? `${c.unread} new` : undefined}
              end={<>{when ? <Text size="caption" tone="label">{when}</Text> : null}{menuOf && c.chat ? <Menu align="end" trigger={<IconButton icon="more" label={`More for ${c.title}`} kind="ghost" />} items={menuOf(c)} /> : null}</>}
              onPress={c.open ? () => onOpen(c) : undefined}
              accessibilityLabel={`${convoKindWord(c.kind)}: ${c.title}${c.open ? "" : ", you are not in this chat"}`} />
          );
        })}
      </View>
    </View>
  );
}
