import { View } from "react-native";
import { Avatar, type AvatarRef } from "./Avatar";
import { Button } from "./Button";
import { Divider } from "./Card";
import { Menu } from "./Menu";
import { Row } from "./Row";
import { Text } from "./Text";

export type Level = "use" | "edit";
export const LEVEL_WORDS: Record<Level, string> = { use: "Can use", edit: "Can edit" };

/**
 * Who has something, and at which level: Can use or Can edit, the same two words as flows and agents. Each row changes its level or removes the person from a menu; "Add" lists the people
 * and assistants not yet on it. `of` turns an id into the mark to draw. Sharing is a grant on the item; nothing here shows the value. See docs/design/system/components/access-list.md.
 */
export function AccessList({ rows, candidates, of, onChange, onRemove, onAdd, empty = "Only you." }: {
  rows: { who: string; level: Level }[]; candidates: string[]; of: (who: string) => AvatarRef;
  onChange: (who: string, level: Level) => void; onRemove: (who: string) => void; onAdd: (who: string, level: Level) => void; empty?: string;
}) {
  const left = candidates.filter((c) => !rows.some((r) => r.who === c));
  return (
    <View className="gap-s2">
      {rows.length ? rows.map((r, i) => (
        <View key={r.who}>
          {i ? <Divider inset={60} /> : null}
          <Row dense lead={<Avatar of={of(r.who)} size={32} />} title={r.who} sub={LEVEL_WORDS[r.level]}
            end={<Menu trigger={<Button kind="ghost" size="sm" label={LEVEL_WORDS[r.level]} />} items={[
              { label: LEVEL_WORDS.use, selected: r.level === "use", onPress: () => onChange(r.who, "use") },
              { label: LEVEL_WORDS.edit, selected: r.level === "edit", onPress: () => onChange(r.who, "edit") },
              { label: "Remove", danger: true, onPress: () => onRemove(r.who) },
            ]} />} />
        </View>
      )) : <Text tone="muted">{empty}</Text>}
      {left.length ? (
        <View className="self-start">
          <Menu trigger={<Button kind="ghost" size="sm" icon="plus" label="Add a person or assistant" />}
            items={left.flatMap((c) => (["use", "edit"] as Level[]).map((l) => ({ label: `${c}: ${LEVEL_WORDS[l]}`, onPress: () => onAdd(c, l) })))} />
        </View>
      ) : null}
    </View>
  );
}
