import { useEffect, useState } from "react";
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
import Animated, { SlideInLeft, SlideInRight } from "react-native-reanimated";
import { SpaceTile } from "../components/SpaceTile";
import { Tip } from "../components/Tip";
import { useReducedMotion } from "../motion/useReducedMotion";
import { SidebarRow } from "./SidebarRow";
import { SidebarPanel, type PanelDef } from "./SidebarPanel";
import { RAIL } from "./rail-tokens.js";
import { isToggleKey, railWidth } from "./rail-state.js";
import { useRail } from "./useRail";
import { allItems, currentItem, isTopLevel, phoneSplit, type NavItem as PureItem } from "./nav.js";

export type NavItem = Omit<PureItem, "icon"> & { icon: IconName };
export type NavGroup = { name: string; items: NavItem[] };
/** The places the shell draws: main, then each named group, then More, then the bottom. Groups are the ones a person named in the sidebar editor (screens/shell/sidebar). */
export type NavDef = { items: NavItem[]; more: NavItem[]; bottom: NavItem[]; groups?: NavGroup[] };
export type ShellSpace = { id: string; name: string; sub: string; /** The small tag that says where it lives: "Personal - Home", "Personal - Cloud" or the team space's name (placeTag). */ tag?: string; /** The space's own logo (an image the person uploaded); without one the tile is a monogram of its initials. */ logo?: string | null; /** A personal space with no server: Records, flows and the planner need a server (screens/shell/basic.js). */ basic?: boolean; /** The space's home time zone (an IANA name), when it has one; times that belong to the space also show in it. */ zone?: string };
export type ShellProps = NavDef & {
  /** The path now showing (usePathname). */
  current: string;
  onNavigate: (href: string) => void;
  spaces: ShellSpace[];
  space: string;
  onSpace: (id: string) => void;
  user: { name: string; sub?: string };
  /** What the sidebar becomes inside a place (its list with Back); null or absent is the main sidebar. Built by the caller from the path (ui/shell/sidebar-stack.js). */
  panel?: PanelDef | null;
  /** Force the rail folded or open (a picture, a test); without it the device's remembered state decides. */
  folded?: boolean;
  /** Opens search: the footer's search button. */
  onSearch?: () => void;
  children: React.ReactNode;
};

function SpaceSwitcher({ spaces, space, onSpace }: Pick<ShellProps, "spaces" | "space" | "onSpace"> & { compact?: boolean }) {
  return <SpaceSwitcherTitle spaces={spaces} space={space} onSpace={onSpace} />;
}

type RailProps = ShellProps;

/** The space at the top of the rail: its logo or monogram, its name and a chevron; folded, only the mark. The menu switches space. */
function RailSwitcher({ p, folded }: { p: RailProps; folded: boolean }) {
  const cur = p.spaces.find((s) => s.id === p.space) ?? p.spaces[0];
  const all = cur.id === "all";
  const { color } = useUiTheme();
  const mark = all
    ? <View style={{ width: RAIL.tile, height: RAIL.tile, borderRadius: Math.round(RAIL.tile * 0.28), backgroundColor: color["surface-3"], alignItems: "center", justifyContent: "center" }}><Icon name="space" tone="text-2" size={RAIL.iconSize} /></View>
    : <SpaceTile space={cur} size={RAIL.tile} />;
  return (
    <Menu
      trigger={
        <Pressable accessibilityRole="button" accessibilityLabel={`Space: ${cur.name}. Switch space`} style={({ hovered }: any) => [{ flexDirection: "row", alignItems: "center", gap: 12, padding: 4, borderRadius: RAIL.rowRadius + 2, justifyContent: folded ? "center" : "flex-start", backgroundColor: hovered ? "var(--hover)" : "transparent" }]}>
          {mark}
          {folded ? null : <><View style={{ flex: 1, minWidth: 0 }}><Text strong style={{ fontSize: 15, lineHeight: 20 }} numberOfLines={1}>{cur.name}</Text>{cur.sub ? <Text size="caption" tone="label" numberOfLines={1}>{cur.sub}</Text> : null}</View><Icon name="chevron-down" size={16} tone="label" /></>}
        </Pressable>
      }
      items={p.spaces.map((s) => ({ label: s.id === p.space ? `${s.name} (showing)` : s.name, onPress: () => p.onSpace(s.id) }))}
    />
  );
}

const caps = { textTransform: "uppercase", letterSpacing: 0.7, fontSize: RAIL.sectionLabelSize } as const;

/** The main sidebar: the places, then each named group (AI, Build) under a small label (folded: under a hairline). */
function MainNav({ p, folded }: { p: RailProps; folded: boolean }) {
  const { color } = useUiTheme();
  const all = allItems(p) as NavItem[];
  const cur = currentItem(p.current, all)?.id;
  const row = (it: NavItem) => <SidebarRow key={it.id} label={it.label} icon={it.icon} on={cur === it.id} badge={it.id === "now" ? it.badge : undefined} folded={folded} onPress={() => p.onNavigate(it.href)} />;
  return (
    <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: RAIL.sectionGap }}>
      <View style={{ gap: RAIL.rowGap }}>{p.items.map(row)}</View>
      {(p.groups ?? []).map((g) => (
        <View key={g.name} style={{ gap: RAIL.rowGap }} role="group" accessibilityLabel={g.name}>
          {folded ? <View style={{ height: 1, backgroundColor: color.edge, marginHorizontal: 8, marginBottom: 6 }} /> : <Text size="caption" medium tone="label" style={[{ paddingHorizontal: RAIL.rowPadX, paddingBottom: 4 }, caps]} numberOfLines={1}>{g.name}</Text>}
          {g.items.map(row)}
        </View>
      ))}
    </ScrollView>
  );
}

/** You at the foot of the rail. Expanded: the search button, your face, your name and address on one row. Folded: Expand, Search and your face stacked, search directly above the face. */
function RailFoot({ p, folded, toggle }: { p: RailProps; folded: boolean; toggle: () => void }) {
  const { color } = useUiTheme();
  const all = allItems(p) as NavItem[];
  const cur = currentItem(p.current, all)?.id;
  const search = (
    <Tip label="Search" hint="Cmd K" side={folded ? "right" : "top"}>
      <Pressable accessibilityRole="button" accessibilityLabel="Search" onPress={p.onSearch} style={({ hovered, focused }: any) => [{ width: RAIL.face, height: RAIL.face, borderRadius: RAIL.rowRadius, alignItems: "center", justifyContent: "center", backgroundColor: hovered || focused ? "var(--hover)" : "transparent" }]}>
        <Icon name="search" tone="text-2" size={RAIL.iconSize} />
      </Pressable>
    </Tip>
  );
  const face = <Avatar of={markRef("person", p.user.name)} size={RAIL.face} />;
  return (
    <View style={{ gap: RAIL.rowGap }}>
      {p.bottom.map((it) => <SidebarRow key={it.id} label={it.label} icon={it.icon} on={cur === it.id} folded={folded} onPress={() => p.onNavigate(it.href)} />)}
      <SidebarRow label={folded ? "Expand" : "Collapse"} icon={folded ? "chevron" : "chevron-left"} tone="label" folded={folded} hint="Cmd \\" onPress={toggle} />
      <View style={{ height: 1, backgroundColor: color.edge, marginVertical: 8 }} />
      {folded ? (
        <View style={{ alignItems: "center", gap: 8 }}>{search}{face}</View>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
          {search}{face}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text strong style={{ fontSize: 14, lineHeight: 18 }} numberOfLines={1}>{p.user.name}</Text>
            {p.user.sub ? <Text size="caption" tone="label" style={{ fontSize: 12, lineHeight: 16 }} numberOfLines={1}>{p.user.sub}</Text> : null}
          </View>
        </View>
      )}
    </View>
  );
}

function Rail(p: RailProps) {
  const { color } = useUiTheme();
  const reduced = useReducedMotion();
  const remembered = useRail();
  const folded = p.folded ?? remembered.collapsed, toggle = remembered.toggle;
  const panel = p.panel;
  // Cmd or Ctrl and a backslash folds the rail; Escape leaves a panel (not while a field has the keys).
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const on = (e: KeyboardEvent) => {
      if (isToggleKey(e)) { e.preventDefault(); toggle(); return; }
      const t = e.target as HTMLElement | null;
      if (e.key === "Escape" && panel && !(t && /^(INPUT|TEXTAREA)$/.test(t.tagName))) panel.onBack();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [toggle, panel]);
  const enter = reduced ? undefined : (panel ? SlideInRight : SlideInLeft).duration(RAIL.slideMs);
  return (
    <View role="navigation" accessibilityLabel="Places" style={{ width: railWidth(folded, RAIL.width), flexShrink: 0, flexGrow: 0, padding: folded ? 12 : RAIL.inset, gap: RAIL.sectionGap - 8, borderRightWidth: 1, borderColor: color.edge, backgroundColor: color.bg }}>
      <RailSwitcher p={p} folded={folded} />
      <Animated.View key={panel?.id ?? "main"} entering={enter} style={{ flex: 1, minHeight: 0 }}>
        {panel ? <SidebarPanel panel={panel} folded={folded} onOpen={p.onNavigate} /> : <MainNav p={p} folded={folded} />}
      </Animated.View>
      <RailFoot p={p} folded={folded} toggle={toggle} />
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
  return (
    <View className="flex-1 flex-row bg-bg">
      <Rail {...p} />
      <View className="min-w-0 flex-1">{p.children}</View>
    </View>
  );
}
