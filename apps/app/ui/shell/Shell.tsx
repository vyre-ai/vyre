import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../lib/cn";
import { Text } from "../components/Text";
import { Icon, type IconName } from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { Chip } from "../components/Chip";
import { Menu } from "../components/Menu";
import { Row } from "../components/Row";
import { Sheet } from "../components/Sheet";
import { useUiTheme } from "../theme";
import { currentItem, phoneSplit, type NavItem as PureItem } from "./nav.js";

export type NavItem = Omit<PureItem, "icon"> & { icon: IconName };
export type NavDef = { items: NavItem[]; more: NavItem[]; bottom: NavItem[] };
export type ShellSpace = { id: string; name: string; sub: string };
export type ShellProps = NavDef & {
  /** The path now showing (usePathname). */
  current: string;
  onNavigate: (href: string) => void;
  spaces: ShellSpace[];
  space: string;
  onSpace: (id: string) => void;
  user: { name: string; sub?: string };
  children: React.ReactNode;
};

function SpaceSwitcher({ spaces, space, onSpace, compact }: Pick<ShellProps, "spaces" | "space" | "onSpace"> & { compact?: boolean }) {
  const cur = spaces.find((s) => s.id === space) ?? spaces[0];
  const all = cur.id === "all";
  return (
    <Menu
      trigger={
        <Pressable accessibilityRole="button" accessibilityLabel={`Space: ${cur.name}. Switch space`}
          className={cn("min-h-control flex-row items-center gap-s3 rounded-row border border-edge bg-surface-2 px-s3", compact ? "self-start" : "w-full")}>
          <Avatar name={cur.name} family="space" size="sm" tint={!all} />
          <Text strong numberOfLines={1} className={compact ? "" : "flex-1"}>{cur.name}</Text>
          <Icon name="more" tone="label" />
        </Pressable>
      }
      items={spaces.map((s) => ({ label: s.id === space ? `${s.name} (showing)` : s.name, onPress: () => onSpace(s.id) }))}
    />
  );
}

function RailItem({ it, on, onPress }: { it: NavItem; on: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={it.label} accessibilityState={{ selected: on }} onPress={onPress}
      className={cn("min-h-control flex-row items-center gap-s3 rounded-row px-s3", on && "bg-selected")}
      style={({ hovered }: any) => (hovered && !on ? { backgroundColor: "var(--hover)" } : undefined)}>
      <Icon name={it.icon} tone={on ? "text" : "text-2"} size={20} />
      <Text strong={on} tone={on ? "default" : "muted"} className="flex-1">{it.label}</Text>
      {it.badge ? <Chip tone="accent">{String(it.badge)}</Chip> : null}
    </Pressable>
  );
}

function Rail(p: ShellProps) {
  const all = [...p.items, ...p.more, ...p.bottom];
  const cur = currentItem(p.current, all)?.id;
  const go = (it: NavItem) => () => p.onNavigate(it.href);
  return (
    <View role="navigation" accessibilityLabel="Places" className="w-rail flex-none gap-s1 border-r border-edge bg-surface-1 p-s3">
      <Text size="title" strong className="px-s2 pb-s2">Vyre</Text>
      <SpaceSwitcher spaces={p.spaces} space={p.space} onSpace={p.onSpace} />
      <ScrollView className="mt-s2 flex-1" contentContainerClassName="gap-s1">
        {p.items.map((it) => <RailItem key={it.id} it={it} on={cur === it.id} onPress={go(it)} />)}
        <Menu
          trigger={
            <Pressable accessibilityRole="button" accessibilityLabel="More places" className="min-h-control flex-row items-center gap-s3 rounded-row px-s3">
              <Icon name="more" tone="text-2" size={20} /><Text tone="muted">More</Text>
            </Pressable>
          }
          items={p.more.map((it) => ({ label: it.label, onPress: () => p.onNavigate(it.href) }))}
        />
      </ScrollView>
      <View className="gap-s1">
        {p.bottom.map((it) => <RailItem key={it.id} it={it} on={cur === it.id} onPress={go(it)} />)}
        <View className="mt-s2 flex-row items-center gap-s3 border-t border-edge px-s2 pt-s3">
          <Avatar name={p.user.name} />
          <View className="min-w-0 flex-1"><Text strong numberOfLines={1}>{p.user.name}</Text>{p.user.sub ? <Text size="caption" tone="label" numberOfLines={1}>{p.user.sub}</Text> : null}</View>
        </View>
      </View>
    </View>
  );
}

function Tab({ it, on, onPress }: { it: NavItem | null; on: boolean; onPress: () => void }) {
  if (!it) return null;
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={it.label} accessibilityState={{ selected: on }} onPress={onPress} className="min-h-touch flex-1 items-center justify-center gap-s1 py-s1">
      <Icon name={it.icon} tone={on ? "text" : "label"} size={20} />
      <Text size="caption" strong={on} tone={on ? "default" : "label"}>{it.label}</Text>
    </Pressable>
  );
}

function PhoneShell(p: ShellProps) {
  const [more, setMore] = useState(false);
  const inset = useSafeAreaInsets();
  const { tabs, more: rest } = phoneSplit(p, 4) as { tabs: NavItem[]; more: NavItem[] };
  const all = [...p.items, ...p.more, ...p.bottom];
  const cur = currentItem(p.current, all)?.id;
  const inMore = rest.some((r) => r.id === cur);
  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: inset.top }}>
      <View className="flex-row items-center px-s4 py-s2">
        <SpaceSwitcher spaces={p.spaces} space={p.space} onSpace={p.onSpace} compact />
      </View>
      <View className="min-h-0 flex-1">{p.children}</View>
      <View role="navigation" accessibilityLabel="Places" className="flex-row border-t border-edge bg-surface-1 px-s2" style={{ paddingBottom: inset.bottom }}>
        {tabs.map((it) => <Tab key={it.id} it={it} on={cur === it.id} onPress={() => p.onNavigate(it.href)} />)}
        <Tab it={{ id: "more", label: "More", icon: "more", href: "" }} on={inMore || more} onPress={() => setMore(true)} />
      </View>
      <Sheet open={more} onClose={() => setMore(false)} title="More">
        <View>
          {rest.map((it) => (
            <Row key={it.id} lead={<Icon name={it.icon} tone="text-2" size={20} />} title={it.label} selected={cur === it.id}
              onPress={() => { setMore(false); p.onNavigate(it.href); }} />
          ))}
        </View>
      </Sheet>
    </View>
  );
}

/**
 * The frame of every place: a rail on a wide screen (the space switcher on top, places, then Settings and you), a tab bar with More on a phone.
 * It knows no routes: the caller gives a nav definition and an onNavigate. Switching space is the caller's, so it can apply that space's theme.
 */
export function Shell(p: ShellProps) {
  const { phone } = useUiTheme();
  if (phone) return <PhoneShell {...p} />;
  return (
    <View className="flex-1 flex-row bg-bg">
      <Rail {...p} />
      <View className="min-w-0 flex-1">{p.children}</View>
    </View>
  );
}
