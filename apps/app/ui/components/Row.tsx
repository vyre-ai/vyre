/** @jsxImportSource react */
// Row opts out of NativeWind's JSX transform (the pragma): lists mount thousands of them, and class resolution at runtime was the cost chat measured
// (scroll.hard). Its layout is plain style objects from the theme's numbers, built once per theme. A `className` from the caller uses a wrapper View.
import { View } from "react-native";
import { Text } from "./Text";
import { Icon } from "./Icon";
import { PressableScale } from "../motion/PressableScale";
import { SwipeActions, type SwipeSet } from "../motion/SwipeActions";
import { useUiTheme, type UiCtx } from "../theme";

const DENSE_SUB = { fontSize: 14, lineHeight: 18 } as const;

/** The few class names callers pass to a Row (padding only: px-0, py-s3), read as style so the row stays class-free. */
function paddingOf(ctx: UiCtx, className?: string) {
  if (!className) return null;
  const out: Record<string, number> = {};
  for (const c of className.split(/\s+/)) {
    const m = /^p([xy])-(0|s\d+)$/.exec(c);
    if (m) out[m[1] === "x" ? "paddingHorizontal" : "paddingVertical"] = m[2] === "0" ? 0 : Number.parseFloat(String(ctx.map[`--${m[2].replace("s", "s-")}`]));
  }
  return out;
}

const px = (ctx: UiCtx, name: string) => Number.parseFloat(String(ctx.map[name]));
const memo = new WeakMap<UiCtx, Record<string, any>>();
/** The row's styles for this theme, built once: the box (dense or not, selected or not), the lead, the main column and the end. */
function stylesFor(ctx: UiCtx) {
  let m = memo.get(ctx);
  if (m) return m;
  const box = { width: "100%", flexDirection: "row", alignItems: "center", gap: px(ctx, "--s-3"), borderRadius: px(ctx, "--r-row"), paddingVertical: px(ctx, "--s-2") } as const;
  m = {
    box: { ...box, minHeight: px(ctx, "--row-h"), paddingHorizontal: px(ctx, "--s-3") },
    dense: { ...box, minHeight: 56, paddingHorizontal: px(ctx, "--s-4") },
    selected: { backgroundColor: ctx.color.selected },
    lead: { flexGrow: 0, flexShrink: 0, flexDirection: "row", alignItems: "center" },
    main: { minWidth: 0, flex: 1 },
    end: { flexGrow: 0, flexShrink: 0, flexDirection: "row", alignItems: "center", gap: px(ctx, "--s-2") },
    press: { backgroundColor: ctx.color.press },
    hover: { backgroundColor: ctx.color.hover },
  };
  memo.set(ctx, m);
  return m;
}

/**
 * The one list row: a leading mark, a title, a secondary line, an end. Lists, menus, search results and phone tables all use it.
 * `swipe` adds swipe actions (a phone, or any native screen): right reveals the leading buttons, left the trailing ones. The same actions are in a
 * screen reader's action menu on the row, so no action is gesture-only.
 */
export function Row({ lead, title, sub, end, onPress, selected, className, accessibilityLabel, swipe, dense, chevron, state }: {
  lead?: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; end?: React.ReactNode; onPress?: () => void; selected?: boolean; className?: string; accessibilityLabel?: string; swipe?: SwipeSet;
  /** The settings density (ui-review Settings 2 to 5): 56 high, title 16/22 medium, one 14/18 line under it. */ dense?: boolean;
  /** A 16 faint chevron at the end, after `state` (the state text, "2 devices", in the label colour). It says the row opens something. */ chevron?: boolean; state?: string;
}) {
  const ctx = useUiTheme();
  const { phone } = ctx;
  const st = stylesFor(ctx);
  const body = (
    <>
      {lead ? <View style={st.lead}>{lead}</View> : null}
      <View style={st.main}>
        {typeof title === "string" ? (dense ? <Text medium size="body" numberOfLines={1}>{title}</Text> : <Text strong size="headline" numberOfLines={1}>{title}</Text>) : title}
        {sub ? (typeof sub === "string" ? <Text size="secondary" tone="label" numberOfLines={1} style={dense ? DENSE_SUB : undefined}>{sub}</Text> : sub) : null}
      </View>
      {end || state || chevron ? (
        <View style={st.end}>
          {end}
          {state ? <Text size="secondary" tone="label" numberOfLines={1} style={dense ? DENSE_SUB : undefined}>{state}</Text> : null}
          {chevron ? <Icon name="chev-r" size={16} tone="faint" /> : null}
        </View>
      ) : null}
    </>
  );
  const boxStyle = [dense ? st.dense : st.box, selected ? st.selected : null, paddingOf(ctx, className)];
  const all = [...(swipe?.leading ?? []), ...(swipe?.trailing ?? [])];
  const row = !onPress ? <View style={boxStyle}>{body}</View> : (
    <PressableScale
      depth={0.985}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      accessibilityActions={all.map((a) => ({ name: a.id, label: a.label }))}
      onAccessibilityAction={(e) => all.find((a) => a.id === e.nativeEvent.actionName)?.onPress()}
      onPress={onPress}
      style={boxStyle}
      pressedStyle={st.press}
      hoverStyle={selected ? undefined : st.hover}
    >
      {body}
    </PressableScale>
  );
  return swipe ? <SwipeActions leading={swipe.leading} trailing={swipe.trailing} enabled={phone}>{row}</SwipeActions> : row;
}
