import { Fragment } from "react";
import { Platform, View } from "react-native";
import * as P from "@rn-primitives/dropdown-menu";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { Icon } from "./Icon";
import { elevation } from "../lib/elevation";
import { useUiTheme } from "../theme";
import { px } from "../lib/measure";

export type MenuItem = {
  label: string; onPress: () => void; danger?: boolean; /** Marks the choice that is on (a filter applied, the sort in use) with a check. */ selected?: boolean;
  /** Drawn before the label: a Space's tile, a face or an icon. */ lead?: React.ReactNode;
  /** A hairline above this item, to start a new group of choices. */ divider?: boolean;
  /** When two items may share a label (two Spaces with one name). */ id?: string;
  /** Shown at the right, muted ("Cmd 1"). */ shortcut?: string;
  /** A second muted line under the label. Absent on an ordinary row, so that row is drawn as it always was. */ note?: string;
  /** A small menu beside the row. The row itself still presses. Used when a Space is not answering, so Remove sits beside the words. */ menu?: MenuItem[];
  /** Choices that open beside this one: the item becomes a row with a chevron and nothing happens on its own press. */ sub?: MenuItem[];
};

/** One choice, or a row that opens a submenu: the same height, padding and gaps for both. */
function Choice({ i, map, color, scheme }: { i: MenuItem; map: any; color: any; scheme: "dark" | "paper" }) {
  const rowStyle = { minHeight: px(map, "--control-sm"), flexDirection: "row" as const, alignItems: "center" as const, gap: px(map, "--s-3"), borderRadius: px(map, "--r-row"), paddingHorizontal: px(map, "--s-3") };
  // A note or a beside-menu is only a Space that is not answering. An ordinary row, including one that opens a submenu, is drawn below exactly as before.
  if (i.note || (i.menu && i.menu.length)) {
    const body = (
      <>
        {i.lead ?? null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text tone={i.danger ? "err" : "default"} numberOfLines={1}>{i.label}</Text>
          {i.note ? <Text size="caption" tone="faint" numberOfLines={1}>{i.note}</Text> : null}
        </View>
        {i.shortcut ? <Text size="caption" tone="faint">{i.shortcut}</Text> : null}
        {i.selected ? <Icon name="check" size={16} tone="text" /> : null}
      </>
    );
    if (!i.menu || !i.menu.length) return <P.Item onPress={i.onPress} style={rowStyle}>{body}</P.Item>;
    return (
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <P.Item onPress={i.onPress} style={{ ...rowStyle, flex: 1 }}>{body}</P.Item>
        <P.Sub>
          <P.SubTrigger accessibilityLabel={i.menu[0]?.label ?? "More"} style={{ minHeight: rowStyle.minHeight, alignItems: "center", justifyContent: "center", paddingHorizontal: px(map, "--s-2") }}>
            <Icon name="more" size={16} tone="label" />
          </P.SubTrigger>
          <P.Portal>
            <P.SubContent style={{ ...elevation(scheme, 2), zIndex: 1001, minWidth: px(map, "--s-12") * 4, borderRadius: px(map, "--r-card"), borderWidth: 1, borderColor: color["edge-strong"], backgroundColor: color["surface-3"], padding: px(map, "--s-1") }}>
              {i.menu.map((c) => <Choice key={c.id ?? c.label} i={c} map={map} color={color} scheme={scheme} />)}
            </P.SubContent>
          </P.Portal>
        </P.Sub>
      </View>
    );
  }
  // The theme's colour as a style, never a class: the menu is portalled outside the themed view, where a class only has the custom properties on <html>.
  const inner = (
    <>
      {i.lead ?? null}
      <Text tone={i.danger ? "err" : "default"} style={{ flex: 1 }} numberOfLines={1}>{i.label}</Text>
      {i.shortcut ? <Text size="caption" tone="faint">{i.shortcut}</Text> : null}
      {i.selected ? <Icon name="check" size={16} tone="text" /> : null}
    </>
  );
  if (!i.sub || !i.sub.length) return <P.Item onPress={i.onPress} style={rowStyle}>{inner}</P.Item>;
  return (
    <P.Sub>
      <P.SubTrigger style={rowStyle}>
        {i.lead ?? null}
        <Text style={{ flex: 1 }} numberOfLines={1}>{i.label}</Text>
        <View style={{ transform: [{ rotate: "-90deg" }] }}><Icon name="chevron-down" size={16} tone="label" /></View>
      </P.SubTrigger>
      <P.Portal>
        <P.SubContent style={{ ...elevation(scheme, 2), zIndex: 1001, minWidth: px(map, "--s-12") * 4, borderRadius: px(map, "--r-card"), borderWidth: 1, borderColor: color["edge-strong"], backgroundColor: color["surface-3"], padding: px(map, "--s-1") }}>
          {i.sub.map((c) => <Choice key={c.id ?? c.label} i={c} map={map} color={color} scheme={scheme} />)}
        </P.SubContent>
      </P.Portal>
    </P.Sub>
  );
}

/** Anchored choices. `trigger` is any pressable element, passed as the anchor. */
export function Menu({ trigger, items, align, header, side }: { trigger: React.ReactNode; items: MenuItem[]; /** A block above the choices that is not a choice (a name and a space). */ header?: React.ReactNode; /** Which side of the trigger it opens on (default: below, flipping when there is no room). */ side?: "top" | "bottom"; /** Which edge of the trigger the menu lines up with (default: centred). A trigger at the left of a card uses "start" so the menu stays inside it; the menu flips above when there is no room below. */ align?: "start" | "center" | "end" }) {
  const { resolved, color, map } = useUiTheme();
  const content = (
    // Portalled to the document's end, kept 8 off the window's edges, and above every pane (Radix lifts its wrapper to the content's zIndex): a trigger in the folded rail opens it whole, over the page.
    <P.Content align={align} side={side} sideOffset={4} avoidCollisions insets={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ ...elevation(resolved.scheme, 2), zIndex: 1000, minWidth: px(map, "--s-12") * 4, borderRadius: px(map, "--r-card"), borderWidth: 1, borderColor: color["edge-strong"], backgroundColor: color["surface-3"], padding: px(map, "--s-1") }}>
      {header}
      {items.map((i) => (
        <Fragment key={i.id ?? i.label}>
          {i.divider ? <View style={{ height: 1, backgroundColor: color.edge, marginVertical: px(map, "--s-1") }} /> : null}
          <Choice i={i} map={map} color={color} scheme={resolved.scheme} />
        </Fragment>
      ))}
    </P.Content>
  );
  return (
    <P.Root>
      <P.Trigger asChild>{trigger as any}</P.Trigger>
      <P.Portal>
        {/* Radix's Portal slots onto ONE child (asChild): two siblings throw "failed to slot onto its children" and blank the page on the web. The web needs no Overlay (Radix dismisses on an outside press); the phone's portal does. */}
        {Platform.OS === "web" ? content : (
          <>
            <P.Overlay style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
            {content}
          </>
        )}
      </P.Portal>
    </P.Root>
  );
}
