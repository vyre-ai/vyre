import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button } from "./Button";
import { Chip } from "./Chip";
import { Field } from "./Field";
import { Icon } from "./Icon";
import { IconButton } from "./Button";
import { Menu } from "./Menu";
import { Text } from "./Text";
import { addGroup, moveGroup, removeGroup, renameGroup, sectionsOf } from "./groups.js";
import type { Group } from "./groups.js";

export type { Group };

/**
 * Items in named groups, the one shape every list that needs sections uses (record-type fields, stage tasks, flows, pinned views, agents). An item says which group it is in by `group`;
 * none means the default section, shown first and without a header. Each header collapses its section; with `onChange` it also has a menu to rename, move up or down, or delete the group
 * (its items go to the default section, nothing is lost) and the list ends with "Add a group". Groups are presentation only, never a permission. See docs/design/system/components/grouped-list.md.
 */
export function GroupedList<T extends { group?: string }>({ groups, items, renderItems, onChange, itemNoun = "items", addLabel = "Add a group" }: {
  groups: Group[]; items: T[]; renderItems: (items: T[], group: string) => React.ReactNode; onChange?: (next: { groups: Group[]; items: T[] }) => void; itemNoun?: string; addLabel?: string;
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>(() => Object.fromEntries(groups.filter((g) => g.collapsed).map((g) => [g.name, true])));
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const emit = (n: { groups: Group[]; items?: T[] }) => onChange?.({ groups: n.groups, items: n.items ?? items });
  const sections = sectionsOf(groups, items);
  return (
    <View className="gap-s3">
      {sections.map((s) => {
        if (s.flat || !s.name) return <View key="_">{renderItems(s.items as T[], "")}</View>;
        const open = !closed[s.name];
        const i = groups.findIndex((g) => g.name === s.name);
        return (
          <View key={s.name} className="gap-s2">
            {renaming?.from === s.name ? (
              <View className="flex-row items-end gap-s2">
                <View className="min-w-0 flex-1"><Field label="Group name" value={renaming.to} onChangeText={(to) => setRenaming({ from: s.name, to })} /></View>
                <Button kind="primary" size="sm" label="Save" onPress={() => { const r = renameGroup(groups, items, s.name, renaming.to); emit(r); setClosed((c) => { const { [s.name]: was, ...rest } = c; return renaming.to.trim() && r.groups !== groups ? { ...rest, [renaming.to.trim()]: !!was } : c; }); setRenaming(null); }} />
                <Button kind="ghost" size="sm" label="Cancel" onPress={() => setRenaming(null)} />
              </View>
            ) : (
              <View className="flex-row items-center gap-s2">
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${s.name}, ${open ? "collapse" : "expand"}`} onPress={() => setClosed({ ...closed, [s.name]: open })} className="min-h-control min-w-0 flex-1 flex-row items-center gap-s2">
                  <Icon name={open ? "chevron-down" : "chev-r"} size={16} tone="label" />
                  <Text strong>{s.name}</Text>
                  <Chip className="self-center">{`${s.items.length}`}</Chip>
                </Pressable>
                {onChange ? (
                  <Menu trigger={<IconButton icon="more" label={`${s.name}, more`} />} items={[
                    { label: "Rename", onPress: () => setRenaming({ from: s.name, to: s.name }) },
                    ...(i > 0 ? [{ label: "Move up", onPress: () => emit({ groups: moveGroup(groups, s.name, -1) }) }] : []),
                    ...(i < groups.length - 1 ? [{ label: "Move down", onPress: () => emit({ groups: moveGroup(groups, s.name, 1) }) }] : []),
                    { label: `Delete group (${itemNoun} stay)`, onPress: () => emit(removeGroup(groups, items, s.name)) },
                  ]} />
                ) : null}
              </View>
            )}
            {open ? (s.items.length ? renderItems(s.items as T[], s.name) : <Text tone="label">{`No ${itemNoun} in this group.`}</Text>) : null}
          </View>
        );
      })}
      {onChange ? (
        adding !== null ? (
          <View className="flex-row items-end gap-s2">
            <View className="min-w-0 flex-1"><Field label="New group" value={adding} onChangeText={setAdding} placeholder="For example Client details" /></View>
            <Button kind="primary" size="sm" label="Add" disabled={!adding.trim() || groups.some((g) => g.name.toLowerCase() === adding.trim().toLowerCase())} onPress={() => { emit({ groups: addGroup(groups, adding) }); setAdding(null); }} />
            <Button kind="ghost" size="sm" label="Cancel" onPress={() => setAdding(null)} />
          </View>
        ) : <View className="flex-row"><Button kind="ghost" size="sm" icon="plus" label={addLabel} onPress={() => setAdding("")} /></View>
      ) : null}
    </View>
  );
}
