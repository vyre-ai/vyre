import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../lib/cn";
import { Text } from "../components/Text";
import { Icon, type IconName } from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { SpaceSwitcherTitle } from "../components/SpaceSwitcherTitle";
import { markRef, spaceRef } from "../marks/useMark";
import { Menu } from "../components/Menu";
import { Row } from "../components/Row";
import { Sheet } from "../components/Sheet";
import { useUiTheme } from "../theme";
import { glass } from "../lib/glass";
import { px } from "../lib/measure";
import { currentItem, isTopLevel, phoneSplit, type NavItem as PureItem } from "./nav.js";

export type NavItem = Omit<PureItem, "icon"> & { icon: IconName };
export type NavDef = { items: NavItem[]; more: NavItem[]; bottom: NavItem[] };
export type ShellSpace = { id: string; name: string; sub: string; /** A personal space with no server: Records, flows and the planner need a server (screens/shell/basic.js). */ basic?: boolean };
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

function SpaceSwitcher({ spaces, space, onSpace }: Pick<ShellProps, "spaces" | "space" | "onSpace"> & { compact?: boolean }) {
  return <SpaceSwitcherTitle spaces={spaces} space={space} onSpace={onSpace} />;
}

/** The count on Now: the one badge the shell shows. */
function CountBadge({ n }: { n: number }) {
  return (
    <View className="min-w-s5 items-center rounded-full bg-accent-wash px-s2">
      <Text size="caption" medium tone="accent">{String(n)}</Text>
    </View>
  );
}

/** A rail row: 40 high, icon 20, label 15 medium. The current place is a surface-3 fill (radius 10) with a 3 wide accent bar at the left edge. */
function RailItem({ it, on, onPress }: { it: NavItem; on: boolean; onPress: () => void }) {
  const { map } = useUiTheme();
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={it.label} accessibilityState={{ selected: on }} onPress={onPress}
      style={({ hovered }: any) => [{ minHeight: px(map, "--s-10") }, hovered && !on ? { backgroundColor: "var(--hover)" } : null]}
      className={cn("flex-row items-center gap-s3 rounded-row px-s3", on && "bg-surface-3")}>
      {on ? <View className="absolute rounded-full bg-accent" style={{ left: 0, top: 8, height: 24, width: 3 }} /> : null}
      <Icon name={it.icon} tone={on ? "text" : "text-2"} size={20} />
      <Text medium style={{ fontSize: 15, lineHeight: 20 }} tone={on ? "default" : "muted"} className="flex-1" numberOfLines={1}>{it.label}</Text>
      {it.id === "now" && it.badge ? <CountBadge n={it.badge} /> : null}
    </Pressable>
  );
}

function Rail(p: ShellProps) {
  const { map } = useUiTheme();
  const all = [...p.items, ...p.more, ...p.bottom];
  const cur = currentItem(p.current, all)?.id;
  const go = (it: NavItem) => () => p.onNavigate(it.href);
  return (
    <View role="navigation" accessibilityLabel="Places" className="w-rail flex-none gap-s1 border-r border-edge bg-surface-1 p-s3">
      <View className="px-s1 pb-s1"><SpaceSwitcher spaces={p.spaces} space={p.space} onSpace={p.onSpace} /></View>
      <ScrollView className="mt-s2 flex-1" contentContainerClassName="gap-s1">
        {p.items.map((it) => <RailItem key={it.id} it={it} on={cur === it.id} onPress={go(it)} />)}
        <Menu
          trigger={
            <Pressable accessibilityRole="button" accessibilityLabel="More places" style={{ minHeight: px(map, "--s-10") }} className="flex-row items-center gap-s3 rounded-row px-s3">
              <Icon name="more" tone="text-2" size={20} /><Text medium style={{ fontSize: 15, lineHeight: 20 }} tone="muted">More</Text>
            </Pressable>
          }
          items={p.more.map((it) => ({ label: it.label, onPress: () => p.onNavigate(it.href) }))}
        />
      </ScrollView>
      <View className="gap-s1">
        {p.bottom.map((it) => <RailItem key={it.id} it={it} on={cur === it.id} onPress={go(it)} />)}
        <View className="mt-s2 flex-row items-center gap-s3 border-t border-edge px-s2 pt-s3">
          <Avatar of={markRef("person", p.user.name)} size={32} />
          <View className="min-w-0 flex-1"><Text strong style={{ fontSize: 14, lineHeight: 18 }} numberOfLines={1}>{p.user.name}</Text>{p.user.sub ? <Text mono size="caption" tone="label" style={{ fontSize: 12, lineHeight: 16 }} numberOfLines={1}>{p.user.sub}</Text> : null}</View>
        </View>
      </View>
    </View>
  );
}

/** A tab: icon 24, label 11 medium. The current tab is the accent, icon and label together. */
function Tab({ it, on, onPress }: { it: NavItem | null; on: boolean; onPress: () => void }) {
  const { color } = useUiTheme();
  if (!it) return null;
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={it.label} accessibilityState={{ selected: on }} onPress={onPress} className="flex-1 items-center justify-center gap-s1" style={{ minHeight: 49 }}>
      {/* Android (Material 3): the current icon sits in a 64 x 32 accent-wash pill. iOS tints the icon and label only. */}
      <View style={Platform.OS === "android" ? { width: 64, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: on ? color["accent-wash"] : "transparent" } : null}>
        <Icon name={it.icon} tone={on ? "accent" : "label"} size={24} />
      </View>
      <Text medium style={{ fontSize: 11, lineHeight: 13 }} tone={on ? "accent" : "label"}>{it.label}</Text>
    </Pressable>
  );
}

function PhoneShell(p: ShellProps) {
  const [more, setMore] = useState(false);
  const inset = useSafeAreaInsets();
  const { color } = useUiTheme();
  const { tabs, more: rest } = phoneSplit(p, 4) as { tabs: NavItem[]; more: NavItem[] };
  const all = [...p.items, ...p.more, ...p.bottom];
  const cur = currentItem(p.current, all)?.id;
  const inMore = rest.some((r) => r.id === cur);
  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: inset.top + 8 }}>
      {/* The switcher shows on the tab bar's own places only; a page opened from More (Vault, Drive, Settings, Spaces) is pushed and has its own title row. */}
      {isTopLevel(p.current, all) && !inMore ? (
        <View className="flex-row items-center px-s4">
          <SpaceSwitcher spaces={p.spaces} space={p.space} onSpace={p.onSpace} compact />
        </View>
      ) : null}
      <View className="min-h-0 flex-1">{p.children}</View>
      <View role="navigation" accessibilityLabel="Places" className="flex-row border-t border-edge px-s2" style={[glass(color.bg), { paddingBottom: inset.bottom }]}>
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
