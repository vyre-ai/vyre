import { useState } from "react";
import { Platform, Pressable, ScrollView, View, type ViewStyle } from "react-native";
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
import { elevation } from "../lib/elevation";
import { SpaceTile } from "../components/SpaceTile";
import { lookOf, type ShellLook, type ShellLookName } from "./looks-ts";
import { allItems, currentItem, isTopLevel, phoneSplit, type NavItem as PureItem } from "./nav.js";

export type NavItem = Omit<PureItem, "icon"> & { icon: IconName };
export type NavGroup = { name: string; items: NavItem[] };
/** The places the shell draws: main, then each named group, then More, then the bottom. Groups are the ones a person named in the sidebar editor (screens/shell/sidebar). */
export type NavDef = { items: NavItem[]; more: NavItem[]; bottom: NavItem[]; groups?: NavGroup[] };
export type ShellSpace = { id: string; name: string; sub: string; /** A personal space with no server: Records, flows and the planner need a server (screens/shell/basic.js). */ /** The space's own logo (an image the person uploaded); without one the tile is a monogram of its initials. */ logo?: string | null; basic?: boolean; /** The space's home time zone (an IANA name), when it has one; times that belong to the space also show in it. */ zone?: string };
export type ShellProps = NavDef & {
  /** The path now showing (usePathname). */
  current: string;
  onNavigate: (href: string) => void;
  spaces: ShellSpace[];
  space: string;
  onSpace: (id: string) => void;
  user: { name: string; sub?: string };
  /** The sidebar and space-identity look (ui/shell/looks.js). Default: the default look. */
  look?: ShellLookName;
  children: React.ReactNode;
};

function SpaceSwitcher({ spaces, space, onSpace }: Pick<ShellProps, "spaces" | "space" | "onSpace"> & { compact?: boolean }) {
  return <SpaceSwitcherTitle spaces={spaces} space={space} onSpace={onSpace} />;
}

/** The count on Now: the one badge the shell shows. */
function CountBadge({ n, ink }: { n: number; ink?: string }) {
  const { color } = useUiTheme();
  return (
    <View className="min-w-s5 items-center rounded-full px-s2" style={{ backgroundColor: ink ? "transparent" : color["accent-wash"], borderWidth: ink ? 1 : 0, borderColor: ink }}>
      <Text size="caption" medium tone="accent" style={ink ? { color: ink } : undefined}>{String(n)}</Text>
    </View>
  );
}

const WEIGHT = { regular: {}, medium: { medium: true }, strong: { strong: true } } as const;

/**
 * A rail row, drawn from the look: its height, icon (alone, or in a chip), label weight and the current place (a wash, a solid fill or a pill).
 * The current row is never marked by colour alone: its fill, weight and aria-selected say it.
 */
function RailItem({ it, on, onPress, look }: { it: NavItem; on: boolean; onPress: () => void; look: ShellLook }) {
  const { color } = useUiTheme();
  const solid = on && look.active === "fill";
  const ink = solid ? "primary-ink" : on ? "text" : "text-2";
  const fill = solid ? color.primary : on ? color["surface-3"] : undefined;
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={it.label} accessibilityState={{ selected: on }} onPress={onPress}
      style={({ hovered }: any) => [{ minHeight: look.rowH, borderRadius: look.rowRadius, paddingHorizontal: look.rowPadX, flexDirection: "row", alignItems: "center", gap: look.iconChip ? 12 : 12, backgroundColor: fill }, hovered && !on ? { backgroundColor: "var(--hover)" } : null]}>
      {look.iconChip ? (
        <View style={{ width: look.iconChip, height: look.iconChip, borderRadius: Math.round(look.iconChip * 0.3), alignItems: "center", justifyContent: "center", backgroundColor: solid ? "transparent" : color["surface-3"] }}>
          <Icon name={it.icon} tone={ink} size={look.iconSize} />
        </View>
      ) : <Icon name={it.icon} tone={ink} size={look.iconSize} />}
      <Text {...WEIGHT[on && look.labelWeight === "regular" ? "medium" : look.labelWeight]} style={{ fontSize: look.labelSize, lineHeight: look.labelLine, color: color[solid ? "primary-ink" : on ? "text" : "text-2"] }} className="flex-1" numberOfLines={1}>{it.label}</Text>
      {it.id === "now" && it.badge ? <CountBadge n={it.badge} ink={solid ? color["primary-ink"] : undefined} /> : null}
    </Pressable>
  );
}

/** The space at the top of the rail: a plain mark and name, a card with its subtitle, or a soft bar. The mark is the space's logo or its monogram. */
function RailSwitcher({ p, look }: { p: Omit<ShellProps, "look">; look: ShellLook }) {
  const { color } = useUiTheme();
  const cur = p.spaces.find((s) => s.id === p.space) ?? p.spaces[0];
  const all = cur.id === "all";
  const card = look.switcher === "card", bar = look.switcher === "bar";
  const box = card ? { borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"], borderRadius: 16, padding: 8 } : bar ? { backgroundColor: color["surface-2"], borderRadius: 999, paddingVertical: 6, paddingLeft: 6, paddingRight: 14 } : { paddingVertical: 4, paddingHorizontal: 4 };
  return (
    <Menu
      trigger={
        <Pressable accessibilityRole="button" accessibilityLabel={`Space: ${cur.name}. Switch space`} style={[{ flexDirection: "row", alignItems: "center", gap: 12 }, box]}>
          {all ? <View style={{ width: look.tile, height: look.tile, borderRadius: look.tileShape === "round" ? look.tile : Math.round(look.tile * 0.28), backgroundColor: color["surface-3"], alignItems: "center", justifyContent: "center" }}><Icon name="space" tone="text-2" size={look.iconSize} /></View> : <SpaceTile space={cur} size={look.tile as 32} shape={look.tileShape} />}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text strong style={{ fontSize: 15, lineHeight: 20 }} numberOfLines={1}>{cur.name}</Text>
            {card && cur.sub ? <Text size="caption" tone="label" numberOfLines={1}>{cur.sub}</Text> : null}
          </View>
          <Icon name="chevron-down" size={16} tone="label" />
        </Pressable>
      }
      items={p.spaces.map((s) => ({ label: s.id === p.space ? `${s.name} (showing)` : s.name, onPress: () => p.onSpace(s.id) }))}
    />
  );
}

/** You, at the bottom: a face and your name, plain, as a card with a chevron, or as a soft bar. */
function RailPerson({ p, look }: { p: Omit<ShellProps, "look">; look: ShellLook }) {
  const { color } = useUiTheme();
  const card = look.person === "card", bar = look.person === "bar";
  const box = card ? { borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"], borderRadius: 16, padding: 8 } : bar ? { backgroundColor: color["surface-2"], borderRadius: 999, paddingVertical: 6, paddingLeft: 6, paddingRight: 14 } : { paddingVertical: 8, paddingHorizontal: 8 };
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: 12 }, box]}>
      <Avatar of={markRef("person", p.user.name)} size={look.personFace} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text strong style={{ fontSize: 14, lineHeight: 18 }} numberOfLines={1}>{p.user.name}</Text>
        {p.user.sub ? <Text size="caption" tone="label" style={{ fontSize: 12, lineHeight: 16 }} numberOfLines={1}>{p.user.sub}</Text> : null}
      </View>
      {card ? <Icon name="chevron" size={16} tone="label" /> : null}
    </View>
  );
}

function Rail(p: Omit<ShellProps, "look"> & { look: ShellLook }) {
  const { color, resolved } = useUiTheme();
  const look = p.look;
  const all = allItems(p) as NavItem[];
  const cur = currentItem(p.current, all)?.id;
  const go = (it: NavItem) => () => p.onNavigate(it.href);
  const item = (it: NavItem) => <RailItem key={it.id} it={it} on={cur === it.id} onPress={go(it)} look={look} />;
  const frame: ViewStyle = look.floating
    ? { margin: look.inset, borderRadius: look.railRadius, borderWidth: 1, borderColor: color.edge, ...(look.translucent ? glass(color["surface-1"], 0.72) : { backgroundColor: color["surface-1"] }), ...elevation(resolved.scheme === "paper" ? "paper" : "dark", 1) }
    : { borderRightWidth: 1, borderColor: color.edge, backgroundColor: color["surface-1"] };
  return (
    <View role="navigation" accessibilityLabel="Places" style={[{ width: look.rail, flexShrink: 0, flexGrow: 0, padding: look.inset, gap: look.sectionGap - 8 }, look.floating ? { margin: look.inset } : null, frame]}>
        <RailSwitcher p={p} look={look} />
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: look.sectionGap }} showsVerticalScrollIndicator={false}>
          <View style={{ gap: look.rowGap }}>
            {p.items.map(item)}
            {p.more.length ? <Menu
              trigger={
                <Pressable accessibilityRole="button" accessibilityLabel="More places" style={{ minHeight: look.rowH, borderRadius: look.rowRadius, paddingHorizontal: look.rowPadX, flexDirection: "row", alignItems: "center", gap: 12 }}>
                  {look.iconChip ? <View style={{ width: look.iconChip, height: look.iconChip, borderRadius: Math.round(look.iconChip * 0.3), alignItems: "center", justifyContent: "center", backgroundColor: color["surface-3"] }}><Icon name="more" tone="text-2" size={look.iconSize} /></View> : <Icon name="more" tone="text-2" size={look.iconSize} />}
                  <Text medium={look.labelWeight !== "regular"} style={{ fontSize: look.labelSize, lineHeight: look.labelLine, color: color["text-2"] }}>More</Text>
                </Pressable>
              }
              items={p.more.map((it) => ({ label: it.label, onPress: () => p.onNavigate(it.href) }))}
            /> : null}
          </View>
          {(p.groups ?? []).map((g) => (
            <View key={g.name} style={{ gap: look.rowGap }} role="group" accessibilityLabel={g.name}>
              <Text size="caption" medium tone="label" style={{ paddingHorizontal: look.rowPadX + (look.iconChip ? 0 : 0), paddingBottom: 4, ...(look.section === "caps" ? { textTransform: "uppercase", letterSpacing: 0.8, fontSize: 11, lineHeight: 14 } : null) }} numberOfLines={1}>{g.name}</Text>
              {g.items.map(item)}
            </View>
          ))}
        </ScrollView>
        <View style={{ gap: look.rowGap }}>
          {p.bottom.map(item)}
          <View style={{ height: 1, backgroundColor: color.edge, marginVertical: 8, opacity: look.person === "plain" ? 1 : 0 }} />
          <RailPerson p={p} look={look} />
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
  const { tabs, more: rest } = phoneSplit(p, 4) as { tabs: NavItem[]; more: (NavItem & { group?: string })[] };
  const all = allItems(p) as NavItem[];
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
            <Row key={it.id} lead={<Icon name={it.icon} tone="text-2" size={20} />} title={it.label} sub={it.group} selected={cur === it.id}
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
  const look = lookOf(p.look);
  return (
    <View className="flex-1 flex-row bg-bg">
      <Rail {...p} look={look} />
      <View className="min-w-0 flex-1">{p.children}</View>
    </View>
  );
}
