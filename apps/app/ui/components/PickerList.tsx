import { useEffect, useRef } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useUiTheme } from "../theme";
import { Text } from "./Text";
import { Icon } from "./Icon";
import { scrollTopFor } from "../lib/picker-model.js";

export type PickerItem = {
  key: string;
  label: string;
  /** One quiet line under or beside the label. */
  sub?: string;
  /** A face, a provider mark or an icon, 24 wide. */
  leading?: React.ReactNode;
  /** A mark at the right (a sealed chip, a percent). */
  trailing?: React.ReactNode;
  /** On or off (a toggle row) with a check; undefined is a plain row. */
  checked?: boolean;
  /** A key hint at the right ("Alt 1"). */
  hint?: string;
  /** Rows with the same group sit under one small label. */
  group?: string;
};

/** The id of row `i` in list `id`: the box's aria-activedescendant names it. */
export const optionId = (id: string, i: number) => `${id}-opt-${i}`;

/**
 * The one picker list: the composer's / @ # lists, the + menu and the Answering list. The box that owns the keyboard keeps the focus (a combobox); this list only draws the rows,
 * marks the active one, and scrolls it into view. Roles: listbox and option, `aria-selected` on the active row. A footer line names the keys. Under 720 the rows are 48 high.
 */
export function PickerList({ id, label, items, active, onActive, onPick, header, crumbs, onCrumb, footer, empty = "Nothing matches", maxRows = 6 }: {
  id: string; label: string; items: readonly PickerItem[]; active: number; onActive?: (i: number) => void; onPick: (i: number) => void;
  header?: string; footer?: string; empty?: string; maxRows?: number;
  /** A nested list's way down so far ("Tag", "Records", "Clients"): drawn as the header, the last one in full strength; pressing an earlier one goes back to it (`onCrumb(index)`). */
  crumbs?: readonly string[]; onCrumb?: (i: number) => void;
}) {
  const { color, phone } = useUiTheme();
  const rowH = phone ? 48 : 40;
  const view = useRef<ScrollView>(null);
  const top = useRef(0);
  const viewH = Math.min(items.length, maxRows) * rowH;
  useEffect(() => {
    const next = scrollTopFor(active, rowH, top.current, viewH);
    if (next !== top.current) { top.current = next; view.current?.scrollTo({ y: next, animated: false }); }
  }, [active, rowH, viewH]);
  const web = Platform.OS === "web";
  return (
    <View style={{ backgroundColor: color["surface-3"], borderWidth: 1, borderColor: color["edge-strong"], borderRadius: 14, overflow: "hidden" }}>
      {crumbs && crumbs.length ? (
        <View accessibilityLabel={`In ${crumbs.join(", ")}`} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 }}>
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <View key={`${i}-${c}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                {i ? <Icon name="chev-r" size={12} tone="label" /> : null}
                <Pressable accessibilityRole="button" accessibilityLabel={last ? c : `Back to ${c}`} disabled={last} onPress={() => onCrumb?.(i)} {...(web ? ({ onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() } as object) : {})}>
                  <Text size="caption" tone={last ? "default" : "label"} medium={last}>{c}</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : header ? <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 }}><Text size="caption" tone="label" medium>{header}</Text></View> : null}
      {items.length === 0 ? <View style={{ minHeight: rowH, justifyContent: "center", paddingHorizontal: 12 }}><Text size="caption" tone="label">{empty}</Text></View> : (
        <ScrollView
          ref={view}
          style={{ maxHeight: maxRows * rowH, padding: 4 }}
          onScroll={(e) => { top.current = e.nativeEvent.contentOffset.y; }}
          scrollEventThrottle={32}
          keyboardShouldPersistTaps="always"
          {...(web ? ({ role: "listbox", id, "aria-label": label } as object) : { accessibilityLabel: label })}
        >
          {items.map((it, i) => {
            const on = i === active;
            const rowProps = web ? ({ role: "option", id: optionId(id, i), "aria-selected": on } as object) : {};
            return (
              <View key={it.key}>
                {it.group && it.group !== items[i - 1]?.group ? <View style={{ paddingHorizontal: 8, paddingTop: i ? 8 : 2, paddingBottom: 2 }}><Text size="caption" tone="label">{it.group}</Text></View> : null}
                <Pressable
                  {...rowProps}
                  accessibilityRole={web ? undefined : "button"}
                  accessibilityLabel={it.label}
                  accessibilityState={{ selected: on, ...(it.checked != null ? { checked: it.checked } : {}) }}
                  onHoverIn={() => onActive?.(i)}
                  onPress={() => onPick(i)}
                  // The box keeps the focus: a press on a row must not take it away.
                  {...(web ? ({ onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() } as object) : {})}
                  style={{ minHeight: rowH, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, borderRadius: 10, backgroundColor: on ? color.hover : "transparent" }}
                >
                  {it.leading ? <View style={{ width: 24, alignItems: "center" }}>{it.leading}</View> : null}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text strong numberOfLines={1}>{it.label}</Text>
                    {it.sub ? <Text size="caption" tone="label" numberOfLines={1}>{it.sub}</Text> : null}
                  </View>
                  {it.trailing}
                  {it.hint ? <Text size="caption" tone="label">{it.hint}</Text> : null}
                  {it.checked != null ? <View style={{ width: 20, alignItems: "center" }}>{it.checked ? <Icon name="check" size={16} tone="text" /> : null}</View> : null}
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      )}
      {footer ? <View style={{ paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: color.edge }}><Text size="caption" tone="label">{footer}</Text></View> : null}
    </View>
  );
}
