import { Pressable, View } from "react-native";
import { SpaceTile } from "./SpaceTile";
import { Icon } from "./Icon";
import { Menu, type MenuItem } from "./Menu";
import { Text } from "./Text";
import { SpaceTag } from "./SpaceTag";
import { switcherActions, switcherRows } from "../shell/switcher-model.js";

export type SwitcherSpace = { id: string; name: string; tag?: string; basic?: boolean };

/**
 * The Space switcher's choices, shared by the sidebar's top and the phone's title row: each Space with its tile and a check on the one showing, then making or joining a Space, inviting people to the
 * one showing and its settings. `onOpen` opens a route; without it only the Spaces are listed (the gallery, first run).
 */
export function spaceMenuItems(spaces: SwitcherSpace[], space: string, onSpace: (id: string) => void, onOpen?: (href: string) => void, allId = "all"): MenuItem[] {
  const rows: MenuItem[] = switcherRows(spaces, space, allId).map((r) => ({
    id: r.id, label: r.name, selected: r.on, onPress: () => onSpace(r.id),
    lead: r.all ? <View style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}><Icon name="space" tone="text-2" size={16} /></View> : <SpaceTile space={{ id: r.id, name: r.name }} size={20} />,
  }));
  if (!onOpen) return rows;
  const cur = spaces.find((s) => s.id === space);
  const ICON = { create: "plus", join: "link", invite: "users", settings: "settings" } as const;
  const acts: MenuItem[] = switcherActions(cur, allId).map((a, i) => ({ id: `act:${a.id}`, label: a.label, divider: i === 0, onPress: () => onOpen(a.href), lead: <View style={{ width: 20, alignItems: "center" }}><Icon name={ICON[a.id]} tone="label" size={16} /></View> }));
  return [...rows, ...acts];
}

/**
 * The large-title row's space switcher (ui-review Global 7): a 28 space emblem, the space's name in the headline role (17 semibold on a phone,
 * 15 on desktop) and a chevron-down. No border, no fill, no letter. "All spaces" shows the first spaces' emblems overlapped. Opens the switcher.
 */
export function SpaceSwitcherTitle({ spaces, space, onSpace, onOpen, allId = "all", compact }: { spaces: SwitcherSpace[]; space: string; onSpace: (id: string) => void; /** Opens a route (Make or Join a Space, Invite people, Space settings). */ onOpen?: (href: string) => void; allId?: string; /** One quiet line: the emblem, the name and the chevron, no place tag. */ compact?: boolean }) {
  const cur = spaces.find((s) => s.id === space) ?? spaces[0];
  const all = cur.id === allId;
  const real = spaces.filter((s) => s.id !== allId);
  return (
    <Menu
      align="start"
      trigger={
        <Pressable accessibilityRole="button" accessibilityLabel={`Space: ${cur.name}. Switch space`} className="min-h-touch flex-row items-center gap-s2 self-start">
          {all ? (
            <View className="flex-row">{real.slice(0, 2).map((s, i) => <View key={s.id} style={{ marginLeft: i ? -8 : 0 }}><SpaceTile space={s} size={28} /></View>)}</View>
          ) : <SpaceTile space={cur} size={28} />}
          <Text strong size="headline" numberOfLines={1} className="min-w-0 flex-shrink">{cur.name}</Text>
          {!all && !compact && cur.tag ? <SpaceTag text={cur.tag} /> : null}
          <Icon name="chevron-down" size={16} tone="label" />
        </Pressable>
      }
      items={spaceMenuItems(spaces, space, onSpace, onOpen, allId)}
    />
  );
}
