import { useRef, useState } from "react";
import { Animated, Easing, Platform, View } from "react-native";
import { Text } from "./Text";
import { Icon, type IconName } from "./Icon";
import { useUiTheme, type UiCtx } from "../theme";
import { PressableScale } from "../motion/PressableScale";
import { Pulse } from "../motion/Pulse";
import { haptic } from "../motion/haptics";
import { tokens } from "../../src/theme/tokens";

/** The button box as plain style objects from the theme's colours and numbers: NativeWind class names on the animated Pressable are dropped on a phone
 *  (Mark done and Fix had no fill, their inverse ink vanished on the card), so nothing that must be right on native is a class. */
const px = (ctx: UiCtx, name: string) => Number.parseFloat(String(ctx.map[name]));
/** The room a control needs around it to reach a 44 point touch target (48 dp on Android): hitSlop is the difference, split over both sides. */
const slop = (height: number) => { const want = Platform.OS === "android" ? 48 : 44; return height < want ? Math.ceil((want - height) / 2) : undefined; };
function boxFor(ctx: UiCtx, kind: string, size: string, phone: boolean) {
  const c = ctx.color;
  const fill = kind === "primary" ? c.primary : kind === "danger" || kind === "hold" ? c["err-wash"] : kind === "secondary" && phone ? c["surface-3"] : "transparent";
  const edge = kind === "secondary" && !phone ? c["edge-strong"] : "transparent";
  const height = size === "lg" ? px(ctx, "--s-12") : size === "md" ? px(ctx, "--control") : px(ctx, "--control-sm");
  const pad = size === "lg" ? px(ctx, "--s-5") : size === "md" ? px(ctx, "--s-4") : px(ctx, "--s-3");
  return { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: px(ctx, "--s-2"), borderRadius: px(ctx, "--r-button"), borderWidth: 1, borderColor: edge, backgroundColor: fill, height, paddingHorizontal: pad, overflow: "hidden" } as const;
}
const boxes = new WeakMap<UiCtx, Map<string, object>>();
function box(ctx: UiCtx, kind: string, size: string, phone: boolean) {
  let m = boxes.get(ctx);
  if (!m) boxes.set(ctx, (m = new Map()));
  const k = `${kind}|${size}|${phone}`;
  let v = m.get(k);
  if (!v) m.set(k, (v = boxFor(ctx, kind, size, phone)));
  return v;
}
/** The few layout classes callers pass to a Button, read as style. */
function layoutOf(className?: string) {
  const out: Record<string, any> = {};
  for (const c of (className ?? "").split(/\s+/)) {
    if (c === "self-stretch") out.alignSelf = "stretch";
    else if (c === "self-start") out.alignSelf = "flex-start";
    else if (c === "flex-1") out.flex = 1;
    else if (c === "w-full") out.width = "100%";
  }
  return out;
}

/** The button label: 15 medium (ui-review Global 6), on every platform. */
const LABEL = { fontSize: 15, lineHeight: 20 } as const;

const ink: Record<string, string> = { primary: "inverse", secondary: "default", ghost: "muted", danger: "err", hold: "err", holdText: "err" };

export type ButtonProps = {
  label?: string;
  kind?: "primary" | "secondary" | "ghost" | "danger" | "hold" | "holdText";
  /** "lg" is the 48 high full-width primary of a page (Invite someone, Ask @Engineer); md is 44 on a phone; sm is 36. */
  size?: "lg" | "md" | "sm";
  icon?: IconName;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  /** The accessible name when there is no label. */
  accessibilityLabel?: string;
  className?: string;
};

/** Button: one primary per surface. "hold" carries the count of what goes and fires after a held press (tokens.v2.motion.hold). What it is not given (the handlers, aria props and ref a Menu trigger receives from Radix) goes on to the pressable, so a Button can be a Menu trigger. */
export function Button({ label, kind = "secondary", size = "md", icon, onPress, disabled, loading, accessibilityLabel, className, ...slot }: ButtonProps) {
  const ctx = useUiTheme();
  const { color, phone } = ctx;
  const hold = kind === "hold" || kind === "holdText";
  const fill = useRef(new Animated.Value(0)).current;
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
    Animated.timing(fill, { toValue: 0, duration: 160, useNativeDriver: false }).start();
  };
  const start = () => {
    if (disabled || loading || timer.current) return;
    setHolding(true);
    Animated.timing(fill, { toValue: 1, duration: tokens.v2.motion.hold, easing: Easing.linear, useNativeDriver: false }).start();
    timer.current = setTimeout(() => { timer.current = null; setHolding(false); fill.setValue(0); haptic.warn(); onPress?.(); }, tokens.v2.motion.hold);
  };
  return (
    <PressableScale
      {...(slot as object)}
      depth={hold ? 1 : 0.97}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={hold ? "Hold to confirm" : undefined}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      disabled={disabled || loading}
      // A small button is 36 tall on a phone; the target stays 44.
      hitSlop={phone ? slop(px(ctx, size === "lg" ? "--s-12" : size === "md" ? "--control" : "--control-sm")) : undefined}
      onPress={hold ? undefined : onPress}
      onPressIn={hold ? start : undefined}
      onPressOut={hold ? stop : undefined}
      style={[box(ctx, kind, size, phone), disabled ? { opacity: 0.45 } : null, layoutOf(className)] as any}
      pressedStyle={hold ? undefined : { opacity: 0.85 }}
      hoverStyle={{ opacity: 0.92 }}
    >
      {hold ? (
        <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: color["err-wash"], width: fill.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }} />
      ) : null}
      <Pulse active={!!loading}>
        {icon ? <Icon name={icon} tone={kind === "primary" ? "primary-ink" : kind === "danger" || hold ? "err" : "text"} /> : null}
        {label !== undefined ? <Text medium style={size === "sm" ? undefined : LABEL} size={size === "sm" ? "secondary" : "body"} tone={ink[kind] as any}>{label}</Text> : null}
      </Pulse>
    </PressableScale>
  );
}

/** A square button for an icon. Always named. 36 (control) or 44 (touch). Like Button, it hands what it is not given (the handlers, aria props and ref a Menu trigger receives) to the pressable. */
export function IconButton({ icon, label, onPress, kind = "ghost", touch, ...slot }: { icon: IconName; label: string; onPress?: () => void; kind?: "ghost" | "secondary" | "primary"; touch?: boolean }) {
  const ctx = useUiTheme();
  const side = px(ctx, touch ? "--touch" : "--control");
  const c = ctx.color;
  const look = { alignItems: "center", justifyContent: "center", borderRadius: px(ctx, "--r-button"), borderWidth: 1, width: side, height: side, borderColor: kind === "secondary" ? c["edge-strong"] : "transparent", backgroundColor: kind === "primary" ? c.primary : kind === "secondary" ? c["surface-3"] : "transparent" } as const;
  return (
    <PressableScale
      {...(slot as object)}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={slop(side)}
      onPress={onPress}
      // @ts-expect-error web-only prop: the tooltip
      title={label}
      style={look}
      pressedStyle={{ opacity: 0.8 }}
      hoverStyle={{ opacity: 0.9 }}
    >
      <Icon name={icon} size={20} tone={kind === "primary" ? "primary-ink" : "text-2"} />
    </PressableScale>
  );
}
