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
import { useAppearance, useUiTheme } from "../theme";
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
import { ResizeHandle, useStoredWidth } from "./ResizeHandle";
import { ArrowNav } from "./ArrowNav";
import { SidebarLabel } from "./SidebarLabel";
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
  /** Lock the vault on this device (the account menu's Lock). */
  onLock?: () => void;
  /** The few latest chats, under the places: a short Recent list. Folded, it is not drawn. */
  recent?: { id: string; label: string; href: string }[];
  children: React.ReactNode;
};

function SpaceSwitcher({ spaces, space, onSpace, compact }: Pick<ShellProps, "spaces" | "space" | "onSpace"> & { compact?: boolean }) {
  return <SpaceSwitcherTitle spaces={spaces} space={space} onSpace={onSpace} compact={compact} />;
}

type RailProps = ShellProps;

/** The space at the top of the rail: a 24 mark, its name on one line and a chevron; folded, only the mark. The menu switches space. */
function RailSwitcher({ p, folded }: { p: RailProps; folded: boolean }) {
  const cur = p.spaces.find((s) => s.id === p.space) ?? p.spaces[0];
  const all = cur.id === "all";
  const { color } = useUiTheme();
  const mark = all
    ? <View style={{ width: RAIL.tile, height: RAIL.tile, borderRadius: Math.round(RAIL.tile * 0.28), backgroundColor: color["surface-3"], alignItems: "center", justifyContent: "center" }}><Icon name="space" tone="text-2" size={14} /></View>
    : <SpaceTile space={cur} size={RAIL.tile} />;
  return (
    <Menu
      align="start"
      trigger={
        <Pressable accessibilityRole="button" accessibilityLabel={`Space: ${cur.name}. Switch space`} style={({ hovered, focused }: any) => [{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: 4, marginLeft: -4, borderRadius: RAIL.rowRadius, justifyContent: folded ? "center" : "flex-start", backgroundColor: hovered || focused ? color.hover : "transparent", transitionProperty: "background-color", transitionDuration: `${RAIL.easeMs}ms` } as any]}>
          {mark}
          {folded ? null : <><Text medium style={{ fontSize: RAIL.labelSize, lineHeight: RAIL.labelLine, flexShrink: 1 }} numberOfLines={1}>{cur.name}</Text><Icon name="chevron-down" size={14} tone="label" /></>}
        </Pressable>
      }
      items={p.spaces.map((s) => ({ label: s.id === p.space ? `${s.name} (showing)` : s.name, onPress: () => p.onSpace(s.id) }))}
    />
  );
}

/** The main sidebar: Search, the places, then each named group (AI, Build) under a small label (folded: under a hairline). */
function MainNav({ p, folded }: { p: RailProps; folded: boolean }) {
  const { color } = useUiTheme();
  const all = allItems(p) as NavItem[];
  const cur = currentItem(p.current, all)?.id;
  const row = (it: NavItem) => <SidebarRow key={it.id} label={it.label} icon={it.icon} on={cur === it.id} badge={it.id === "now" ? it.badge : undefined} folded={folded} onPress={() => p.onNavigate(it.href)} />;
  return (
    <View style={{ flex: 1, gap: 8, minHeight: 0 }}>
      {folded ? null : (
        <Pressable accessibilityRole="button" accessibilityLabel="Search" onPress={p.onSearch} style={({ hovered, focused }: any) => [{ flexDirection: "row", alignItems: "center", gap: 8, height: RAIL.searchH, marginHorizontal: RAIL.gutter, paddingHorizontal: 12, borderRadius: RAIL.rowRadius, backgroundColor: hovered || focused ? color.hover : color["surface-3"], transitionProperty: "background-color", transitionDuration: `${RAIL.easeMs}ms` } as any]}>
          <Icon name="search" tone="label" size={RAIL.iconSize} />
          <Text tone="label" style={{ flex: 1, fontSize: RAIL.labelSize, lineHeight: RAIL.labelLine }}>Search</Text>
          <Text size="caption" tone="faint">Cmd K</Text>
        </Pressable>
      )}
      <ArrowNav>
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: RAIL.rowGap }}>
          {p.items.map(row)}
          {!folded && p.recent && p.recent.length > 0 ? (
            <View style={{ gap: RAIL.rowGap }} role="group" accessibilityLabel="Recent">
              <SidebarLabel>Recent</SidebarLabel>
              {p.recent.slice(0, 5).map((r) => <SidebarRow key={r.id} label={r.label} icon="chat" tone="label" on={p.current === r.href} onPress={() => p.onNavigate(r.href)} />)}
            </View>
          ) : null}
          {(p.groups ?? []).map((g) => (
            <View key={g.name} style={{ gap: RAIL.rowGap }} role="group" accessibilityLabel={g.name}>
              {folded ? <View style={{ height: 1, backgroundColor: color.edge, marginHorizontal: 8, marginVertical: 6 }} /> : <SidebarLabel>{g.name}</SidebarLabel>}
              {g.items.map(row)}
            </View>
          ))}
        </ScrollView>
      </ArrowNav>
      {p.bottom.length > 0 ? <View style={{ gap: RAIL.rowGap }}>{p.bottom.map(row)}</View> : null}
    </View>
  );
}

/**
 * You at the foot, as a profile row: your face, your name and a muted line (your name on the box, else the space), and a chevron. Pressing it opens a short menu above it: your profile and Assistant,
 * Appearance, the theme, the other spaces, Lock, Collapse and About. Folded, only the face shows and the name is its tip. No name yet reads "You". Every section's sidebar has this same foot.
 */
function RailFoot({ p, folded, toggle }: { p: RailProps; folded: boolean; toggle: () => void }) {
  const { color, resolved } = useUiTheme();
  const cur = p.spaces.find((s) => s.id === p.space) ?? p.spaces[0];
  const name = (p.user.name || "").trim() || "You";
  const sub = (p.user.sub || "").trim() || cur?.name || "";
  const others = p.spaces.filter((s) => s.id !== p.space && s.id !== "all").slice(0, 5);
  const items = [
    { label: "Your profile and Assistant", onPress: () => p.onNavigate("/u/settings/account") },
    { label: "Appearance", onPress: () => p.onNavigate("/u/appearance") },
    { label: resolved.scheme === "paper" ? "Use the dark theme" : "Use the light theme", onPress: () => useAppearance.getState().setPerson({ theme: resolved.scheme === "paper" ? "dark" : "paper" }) },
    ...others.map((s) => ({ label: `Switch to ${s.name}`, onPress: () => p.onSpace(s.id) })),
    ...(p.onLock ? [{ label: "Lock now", onPress: p.onLock }] : []),
    { label: folded ? "Expand sidebar" : "Collapse sidebar", onPress: toggle },
    { label: "Help and About", onPress: () => p.onNavigate("/u/about") },
  ];
  const header = (
    <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 2 }}>
      <Text medium numberOfLines={1}>{name}</Text>
      <Text size="caption" tone="label" numberOfLines={1}>{sub}</Text>
    </View>
  );
  const label = `${name}: profile, appearance, spaces, lock and the sidebar`;
  const face = <Avatar of={markRef("person", name)} size={RAIL.face} />;
  const trigger = folded ? (
    <Tip label={name}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} style={({ hovered, focused }: any) => [{ width: RAIL.foldedRow, height: RAIL.foldedRow, borderRadius: RAIL.rowRadius, alignItems: "center", justifyContent: "center", backgroundColor: hovered || focused ? color.hover : "transparent" } as any]}>{face}</Pressable>
    </Tip>
  ) : (
    <Pressable accessibilityRole="button" accessibilityLabel={label}
      style={({ hovered, focused }: any) => [{ minHeight: RAIL.navRowH + 8, marginHorizontal: RAIL.rowInset, borderRadius: RAIL.rowRadius, paddingHorizontal: RAIL.gutter - RAIL.rowInset, flexDirection: "row", alignItems: "center", gap: RAIL.iconGap, backgroundColor: hovered || focused ? color.hover : "transparent",
        ...(focused ? { outlineStyle: "solid", outlineWidth: 2, outlineColor: color.primary, outlineOffset: -2 } : {}), transitionProperty: "background-color", transitionDuration: `${RAIL.easeMs}ms` } as any]}>
      {face}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text medium numberOfLines={1} style={{ fontSize: RAIL.labelSize, lineHeight: 18 }}>{name}</Text>
        <Text tone="label" numberOfLines={1} style={{ fontSize: 12, lineHeight: 14 }}>{sub}</Text>
      </View>
      <Icon name="chevron-up" size={14} tone="faint" />
    </Pressable>
  );
  return (
    <View style={{ height: RAIL.footH, justifyContent: "center", alignItems: folded ? "center" : "stretch" }}>
      <Menu align="start" side="top" header={header} items={items} trigger={trigger} />
    </View>
  );
}

function Rail(p: RailProps) {
  const { color } = useUiTheme();
  const reduced = useReducedMotion();
  const remembered = useRail();
  const folded = p.folded ?? remembered.collapsed, toggle = remembered.toggle;
  // Folded, the rail is the main places: a drill's own list is a column of names, which icons alone cannot tell apart.
  const panel = folded ? null : p.panel;
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
  // The rail is resizable and is the same width in every section: one width kept per device. A double-click on the edge sets the default again.
  const w = useStoredWidth("rail", RAIL.width, RAIL.minWidth, RAIL.maxWidth);
  const enter = reduced ? undefined : (panel ? SlideInRight : SlideInLeft).duration(RAIL.slideMs);
  return (
    <View role="navigation" accessibilityLabel="Places" style={{ width: railWidth(folded, w.width), flexShrink: 0, flexGrow: 0, borderRightWidth: 1, borderColor: color.edge, backgroundColor: color.bg }}>
      {/* The top bar: the space switcher on the left, the section's + on the right. */}
      <View style={{ height: RAIL.topH, flexDirection: "row", alignItems: "center", justifyContent: folded ? "center" : "space-between", paddingHorizontal: folded ? 0 : RAIL.gutter }}>
        <RailSwitcher p={p} folded={folded} />
        {folded ? null : panel?.plus}
      </View>
      <Animated.View key={panel?.id ?? "main"} entering={enter} style={{ flex: 1, minHeight: 0 }}>
        {panel ? <SidebarPanel panel={panel} folded={folded} onOpen={p.onNavigate} /> : <MainNav p={p} folded={folded} />}
      </Animated.View>
      <RailFoot p={p} folded={folded} toggle={toggle} />
      {folded ? null : <ResizeHandle edge="right" label="Resize the sidebar" width={w.width} onChange={w.set} onReset={w.reset} min={RAIL.minWidth} max={RAIL.maxWidth} def={RAIL.width} />}
    </View>
  );
}

/** A tab: icon 24, label 11 medium. The current tab is the strong ink, icon and label together (violet is only for what needs you). */
function Tab({ it, on, onPress }: { it: NavItem | null; on: boolean; onPress: () => void }) {
  const { color } = useUiTheme();
  if (!it) return null;
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={it.label} accessibilityState={{ selected: on }} onPress={onPress} className="flex-1 items-center justify-center gap-s1" style={{ minHeight: 49 }}>
      {/* Android (Material 3): the current icon sits in a 64 x 32 selected pill. iOS tints the icon and label only. */}
      <View style={Platform.OS === "android" ? { width: 64, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: on ? color.selected : "transparent" } : null}>
        <Icon name={it.icon} tone={on ? "text" : "label"} size={24} />
      </View>
      <Text medium style={{ fontSize: 11, lineHeight: 13 }} tone={on ? "default" : "label"}>{it.label}</Text>
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
