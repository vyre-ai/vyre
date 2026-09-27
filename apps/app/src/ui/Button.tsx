import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { useTheme, type Palette } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";
import { useDesk, useReducedMotion } from "./pointer";

/** The five buttons (docs/design/system/components/button.md), each with one job. */
export type ButtonKind = "primary" | "secondary" | "outline" | "ghost" | "hold";
/** @deprecated the old name; the same five. */
export type ButtonStyle = ButtonKind;
/** Heights 28, 32, 44 and 54 (tokens.control). */
export type ButtonSize = "xs" | "sm" | "touch" | "touchLg";

type Props = {
  /** Verb first, sentence case. A hold names the count or the thing ("Remove alex's Pixel 8"). */
  label: string;
  kind?: ButtonKind;
  /** Default: 32 on the desktop shape, 44 everywhere else. 54 for a sheet's stacked actions. */
  size?: ButtonSize;
  /** For a hold, this runs when the hold completes, never on a tap. */
  onPress?: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  disabled?: boolean;
  /** In progress: the width stays, a spinner takes the icon's place, the label turns to `busyLabel`. */
  busy?: boolean;
  /** The verb in -ing form: "Allowing", "Sending", "Deleting". */
  busyLabel?: string;
  /** A 16 leading icon. */
  icon?: ReactNode;
  /** The key that works while the row or card has focus ("A", "D", "⏎"); desktop only. */
  keyHint?: string;
  /** The same key for assistive tech (aria-keyshortcuts), when it differs from the hint ("Meta+Enter"). */
  keyShortcut?: string;
  /** 100% of the stack, not the content's width. */
  full?: boolean;
  accessibilityLabel?: string;
  testID?: string;
};

const HEIGHT = { xs: tokens.control.xs, sm: tokens.control.sm, touch: tokens.control.touch, touchLg: tokens.control.touchLg } as const;
// Padding per the button spec's size table (0 10 at 28, 0 12 at 32, 0 16 at 44 and 54).
const PAD = { xs: tokens.space[4] - tokens.space[1], sm: tokens.space[4], touch: tokens.space[5], touchLg: tokens.space[5] } as const;
const RADIUS = { xs: tokens.radius.button, sm: tokens.radius.button, touch: tokens.radius.buttonTouch, touchLg: tokens.radius.card } as const;
const SPINNER = 14;
const ICON = tokens.icon.sizes[1];
const HINT_MS = 2000;
const TURN_MS = 900;
const web = Platform.OS === "web";

type Look = { fill: string; border: string; ink: string; hint: string };

function look(kind: ButtonKind, c: Palette, s: { disabled: boolean; hot: boolean }): Look {
  const none = "transparent";
  if (s.disabled) {
    if (kind === "primary" || kind === "secondary") return { fill: c.hover, border: c.hover, ink: c.label, hint: c.label };
    return { fill: none, border: kind === "ghost" ? none : c.rule, ink: c.label, hint: c.label };
  }
  switch (kind) {
    case "primary":
      return { fill: s.hot ? c.primaryHover : c.primaryBg, border: s.hot ? c.primaryHover : c.primaryBg, ink: c.primaryInk, hint: c.primaryInk };
    case "secondary":
      return { fill: s.hot ? c.rule : c.hover, border: s.hot ? c.rule : c.hover, ink: c.text, hint: c.label };
    case "outline":
      return { fill: s.hot ? c.hover : none, border: c.ruleStrong, ink: c.text, hint: c.label };
    case "hold":
      return { fill: s.hot ? c.hover : none, border: c.text, ink: c.text, hint: c.label };
    default:
      return { fill: s.hot ? c.hover : none, border: none, ink: c.text, hint: c.label };
  }
}

/**
 * The app's one button. Primary is the one action on a surface; secondary a common second
 * choice; outline a real alternative; ghost Cancel, Deny, Discard, Details; hold is destructive:
 * press and hold for tokens.motion.hold (0.6 s) while a fill grows from the left, release early
 * and nothing happens. The safe choice is never primary, and a destructive action is never primary.
 */
export function Button(p: Props) {
  const { color, scheme } = useTheme();
  const desk = useDesk();
  const reduced = useReducedMotion();
  const kind = p.kind ?? "secondary";
  const size = p.size ?? (desk ? "sm" : "touch");
  const hold = kind === "hold";
  const busy = !!p.busy;
  const disabled = !!p.disabled || busy;

  // Busy keeps the resting width: the width measured before the change becomes the minimum.
  const width = useRef(0);
  const [lock, setLock] = useState<number | null>(null);
  useEffect(() => setLock(busy ? width.current || null : null), [busy]);

  const holdState = useHold(hold && !disabled ? p.onPress : undefined);
  const phone = size === "touch" || size === "touchLg";
  const text = phone ? type.readStrong : type.baseStrong;
  const showHint = !!p.keyHint && desk && !busy;
  const shortcut = p.keyShortcut ?? p.keyHint;

  const a11y: Record<string, unknown> = {
    accessibilityRole: "button",
    accessibilityLabel: p.accessibilityLabel ?? p.label,
    accessibilityState: { disabled, busy },
    accessibilityHint: hold ? `Hold for ${tokens.motion.hold / 1000} seconds` : undefined,
  };
  if (web) {
    a11y["aria-busy"] = busy || undefined;
    if (shortcut) a11y["aria-keyshortcuts"] = shortcut;
    Object.assign(a11y, focusData(scheme));
  }

  const button = (
    <Pressable
      {...a11y}
      testID={p.testID}
      disabled={disabled}
      onPress={hold ? undefined : p.onPress}
      onLongPress={hold ? undefined : p.onLongPress}
      delayLongPress={p.delayLongPress}
      onPressIn={hold ? holdState.start : undefined}
      onPressOut={hold ? holdState.stop : undefined}
      onLayout={(e: LayoutChangeEvent) => {
        if (!busy) width.current = e.nativeEvent.layout.width;
      }}
      style={(st) => {
        const hot = !disabled && (st.pressed || !!(st as { hovered?: boolean }).hovered);
        const l = look(kind, color, { disabled: !!p.disabled, hot });
        return [
          styles.box,
          { height: HEIGHT[size], paddingHorizontal: PAD[size], borderRadius: RADIUS[size], backgroundColor: l.fill, borderColor: l.border },
          p.full ? styles.full : null,
          lock ? { minWidth: lock } : null,
          web ? (transition(reduced) as ViewStyle) : null,
        ];
      }}
    >
      {(st) => {
        const hot = !disabled && (st.pressed || !!(st as { hovered?: boolean }).hovered);
        const l = look(kind, color, { disabled: !!p.disabled, hot });
        return (
          <>
            {hold ? <HoldFill progress={holdState.progress} color={color.hover} /> : null}
            {busy ? <Spinner track={kind === "primary" ? color.primaryHover : color.ruleStrong} arc={kind === "primary" ? color.primaryInk : color.text2} still={reduced} /> : p.icon ? <View style={styles.icon}>{p.icon}</View> : null}
            <Text numberOfLines={1} style={[text, { color: l.ink }]}>
              {busy ? (p.busyLabel ?? p.label) : p.label}
            </Text>
            {showHint ? (
              <Text accessibilityElementsHidden importantForAccessibility="no" style={[type.meta, { color: l.hint }]} {...(web ? { "aria-hidden": true } : null)}>
                {p.keyHint}
              </Text>
            ) : null}
          </>
        );
      }}
    </Pressable>
  );

  if (!hold) return button;
  // The line beside a hold: "hold 0.6 s" at rest, "Hold to delete" for 2 s after a quick tap.
  const verb = p.label.split(" ")[0].toLowerCase();
  return (
    <View style={[styles.holdRow, p.full ? styles.full : null]}>
      {button}
      {busy ? null : (
        <Text style={[type.meta, { color: color.label }]}>{holdState.tapped ? `Hold to ${verb}` : `hold ${tokens.motion.hold / 1000} s`}</Text>
      )}
    </View>
  );
}

/** Press and hold: the fill tracks the press linearly, fires at full, drains over motion.tap on an early release. */
function useHold(fire: (() => void) | undefined) {
  const progress = useRef(new Animated.Value(0)).current;
  const [tapped, setTapped] = useState(false);
  const state = useRef({ holding: false, at: 0, timer: 0 as ReturnType<typeof setTimeout> | 0 });
  useEffect(() => () => {
    if (state.current.timer) clearTimeout(state.current.timer);
  }, []);
  const start = () => {
    const s = state.current;
    if (!fire || s.holding) return;
    s.holding = true;
    s.at = Date.now();
    Animated.timing(progress, { toValue: 1, duration: tokens.motion.hold, easing: Easing.linear, useNativeDriver: false }).start(({ finished }) => {
      if (!finished || !s.holding) return;
      s.holding = false;
      progress.setValue(0);
      fire();
    });
  };
  const stop = () => {
    const s = state.current;
    if (!s.holding) return;
    s.holding = false;
    progress.stopAnimation();
    Animated.timing(progress, { toValue: 0, duration: tokens.motion.tap, easing: Easing.linear, useNativeDriver: false }).start();
    setTapped(true);
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => setTapped(false), HINT_MS);
  };
  return { progress, tapped, start, stop };
}

function HoldFill({ progress, color }: { progress: Animated.Value; color: string }) {
  const width = progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });
  return <Animated.View pointerEvents="none" style={[styles.fill, { width, backgroundColor: color }]} />;
}

/** The busy spinner: 14, a 1.5 track and a rotating arc; a static arc under reduced motion. */
export function Spinner({ track, arc, still }: { track: string; arc: string; still?: boolean }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (still) return;
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: TURN_MS, easing: Easing.linear, useNativeDriver: !web }));
    loop.start();
    return () => loop.stop();
  }, [still, turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[styles.spinner, { borderColor: track, borderTopColor: arc, transform: [{ rotate }] }]}
    />
  );
}

const ease = `cubic-bezier(${tokens.motion.ease.join(",")})`;
const transition = (reduced: boolean) =>
  reduced ? null : { transitionProperty: "background-color, border-color, color", transitionDuration: `${tokens.motion.tap}ms`, transitionTimingFunction: ease };

/** The keyboard focus ring (below) on any pressable, on the web; nothing on native. */
export function focusData(scheme: "dark" | "paper"): Record<string, unknown> {
  return web ? { dataSet: { vybtn: scheme } } : {};
}

// Focus: a 2 px focus outline, offset 2, from the keyboard only (:focus-visible), never removed.
if (web && typeof document !== "undefined" && !document.getElementById("vy-button-css")) {
  const css = document.createElement("style");
  css.id = "vy-button-css";
  css.textContent = (["dark", "paper"] as const)
    .map((s) => `[data-vybtn="${s}"]:focus-visible{outline:2px solid ${tokens.color[s].focus} !important;outline-offset:2px}`)
    .join("\n");
  document.head.appendChild(css);
}

const styles = StyleSheet.create({
  box: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.space[3],
    borderWidth: 1,
    overflow: "hidden",
  },
  full: { alignSelf: "stretch" },
  icon: { width: ICON, height: ICON, alignItems: "center", justifyContent: "center" },
  fill: { position: "absolute", left: 0, top: 0, bottom: 0 },
  spinner: { width: SPINNER, height: SPINNER, borderRadius: tokens.radius.full, borderWidth: tokens.icon.stroke },
  holdRow: { flexDirection: "row", alignItems: "center", gap: tokens.space[4] },
});
