import { Platform, Pressable, StyleSheet, type ViewStyle } from "react-native";
import { useTheme, type Palette } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { focusData, Spinner, transition } from "./Button";
import { Icon, type IconName } from "./Icon";
import { useDesk, useReducedMotion } from "./pointer";

/** Squares of 28, 32 and 44 (tokens.control). */
export type IconButtonSize = "xs" | "sm" | "touch";

type Props = {
  icon: IconName;
  /** The only name it has: sentence case, verb first ("Send", "Copy code", "One more teammate"). */
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** Default: 32 on the desktop shape, 44 everywhere else. */
  size?: IconButtonSize;
  /** Filled round: a circle on the `hover` fill, ink `text` (phone "New agent", the composer's Stop). */
  round?: boolean;
  /** The surface's one primary, only when nothing else there is (the composer's Send with text). */
  primary?: boolean;
  /** A toggle: true or false is on or off, announced as pressed; leave it out for a plain button. */
  pressed?: boolean;
  onPress?: () => void;
  /** Only Send has one (hold to queue for after the turn); never a menu. */
  onLongPress?: () => void;
  delayLongPress?: number;
  disabled?: boolean;
  /** The spinner takes the icon's place; the size never changes. */
  busy?: boolean;
  testID?: string;
};

const SIZE = { xs: tokens.control.xs, sm: tokens.control.sm, touch: tokens.control.touch } as const;
const RADIUS = { xs: tokens.radius.button, sm: tokens.radius.button, touch: tokens.radius.buttonTouch } as const;
const web = Platform.OS === "web";

function look(p: Props, c: Palette, s: { disabled: boolean; hot: boolean }): { fill: string; ink: string } {
  const none = "transparent";
  if (s.disabled) return { fill: none, ink: c.label };
  if (p.primary) return { fill: s.hot ? c.primaryHover : c.primaryBg, ink: c.primaryInk };
  if (p.round) return { fill: s.hot ? c.rule : c.hover, ink: c.text };
  if (p.pressed) return { fill: c.hover, ink: c.text };
  return { fill: s.hot ? c.hover : none, ink: s.hot ? c.text : c.text2 };
}

/**
 * A borderless square with one 16 icon (the icon-button spec), for actions frequent enough that a
 * word is noise. Never a visible label and never a destructive action (that is the hold Button).
 * On the phone a 28 or 32 drawing still takes a 44 hit area.
 */
export function IconButton(p: Props) {
  const { color, scheme } = useTheme();
  const desk = useDesk();
  const reduced = useReducedMotion();
  const size = p.size ?? (desk ? "sm" : "touch");
  const side = SIZE[size];
  const busy = !!p.busy;
  const disabled = !!p.disabled || busy;
  const slop = desk ? 0 : Math.max(0, (tokens.control.touch - side) / 2);
  const toggle = p.pressed !== undefined;

  const a11y: Record<string, unknown> = {
    accessibilityRole: "button",
    accessibilityLabel: p.accessibilityLabel,
    accessibilityHint: p.accessibilityHint,
    accessibilityState: { disabled, busy, ...(toggle ? { checked: p.pressed } : null) },
  };
  if (web) {
    a11y["aria-busy"] = busy || undefined;
    if (toggle) a11y["aria-pressed"] = p.pressed;
    Object.assign(a11y, focusData(scheme));
  }

  return (
    <Pressable
      {...a11y}
      testID={p.testID}
      disabled={disabled}
      onPress={p.onPress}
      onLongPress={p.onLongPress}
      delayLongPress={p.delayLongPress}
      hitSlop={slop || undefined}
      style={(st) => {
        const hot = !disabled && (st.pressed || !!(st as { hovered?: boolean }).hovered);
        const l = look(p, color, { disabled: !!p.disabled, hot });
        return [
          styles.box,
          { width: side, height: side, borderRadius: p.round ? tokens.radius.full : RADIUS[size], backgroundColor: l.fill },
          web ? (transition(reduced) as ViewStyle) : null,
        ];
      }}
    >
      {(st) => {
        const hot = !disabled && (st.pressed || !!(st as { hovered?: boolean }).hovered);
        const l = look(p, color, { disabled: !!p.disabled, hot });
        return busy ? <Spinner track={p.primary ? color.primaryHover : color.ruleStrong} arc={l.ink} still={reduced} /> : <Icon name={p.icon} color={l.ink} />;
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center" },
});
