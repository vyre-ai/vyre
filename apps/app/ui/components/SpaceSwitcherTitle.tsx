import { Pressable, View } from "react-native";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { Menu } from "./Menu";
import { Text } from "./Text";
import { spaceRef } from "../marks/useMark";

export type SwitcherSpace = { id: string; name: string };

/**
 * The large-title row's space switcher (ui-review Global 7): a 28 space emblem, the space's name in the headline role (17 semibold on a phone,
 * 15 on desktop) and a chevron-down. No border, no fill, no letter. "All spaces" shows the first spaces' emblems overlapped. Opens a menu to switch.
 */
export function SpaceSwitcherTitle({ spaces, space, onSpace, allId = "all" }: { spaces: SwitcherSpace[]; space: string; onSpace: (id: string) => void; allId?: string }) {
  const cur = spaces.find((s) => s.id === space) ?? spaces[0];
  const all = cur.id === allId;
  const real = spaces.filter((s) => s.id !== allId);
  return (
    <Menu
      trigger={
        <Pressable accessibilityRole="button" accessibilityLabel={`Space: ${cur.name}. Switch space`} className="min-h-touch flex-row items-center gap-s2 self-start">
          {all ? (
            <View className="flex-row">{real.slice(0, 2).map((s, i) => <View key={s.id} style={{ marginLeft: i ? -8 : 0 }}><Avatar of={spaceRef(s.name, s.id)} size={28} /></View>)}</View>
          ) : <Avatar of={spaceRef(cur.name, cur.id)} size={28} />}
          <Text strong size="headline" numberOfLines={1} className="min-w-0 flex-shrink">{cur.name}</Text>
          <Icon name="chevron-down" size={16} tone="label" />
        </Pressable>
      }
      items={spaces.map((s) => ({ label: s.id === space ? `${s.name} (showing)` : s.name, onPress: () => onSpace(s.id) }))}
    />
  );
}
