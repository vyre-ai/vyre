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
};

/** Anchored choices. `trigger` is any pressable element, passed as the anchor. */
export function Menu({ trigger, items, align, header, side }: { trigger: React.ReactNode; items: MenuItem[]; /** A block above the choices that is not a choice (a name and a space). */ header?: React.ReactNode; /** Which side of the trigger it opens on (default: below, flipping when there is no room). */ side?: "top" | "bottom"; /** Which edge of the trigger the menu lines up with (default: centred). A trigger at the left of a card uses "start" so the menu stays inside it; the menu flips above when there is no room below. */ align?: "start" | "center" | "end" }) {
  const { resolved, color, map } = useUiTheme();
  const content = (
    <P.Content align={align} side={side} sideOffset={4} avoidCollisions style={{ ...elevation(resolved.scheme, 2), minWidth: px(map, "--s-12") * 4, borderRadius: px(map, "--r-card"), borderWidth: 1, borderColor: color["edge-strong"], backgroundColor: color["surface-3"], padding: px(map, "--s-1") }}>
      {header}
      {items.map((i) => (
        <Fragment key={i.id ?? i.label}>
          {i.divider ? <View style={{ height: 1, backgroundColor: color.edge, marginVertical: px(map, "--s-1") }} /> : null}
          <P.Item onPress={i.onPress} style={{ minHeight: px(map, "--control-sm"), flexDirection: "row", alignItems: "center", gap: px(map, "--s-3"), borderRadius: px(map, "--r-row"), paddingHorizontal: px(map, "--s-3") }}>
            {i.lead ?? null}
            <Text tone={i.danger ? "err" : "default"} className="flex-1" numberOfLines={1}>{i.label}</Text>
            {i.selected ? <Icon name="check" size={16} tone="text" /> : null}
          </P.Item>
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
