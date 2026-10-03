import { useRef, useState } from "react";
import { Animated, Easing, Pressable, View, ActivityIndicator } from "react-native";
import { cva } from "class-variance-authority";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { Icon, type IconName } from "./Icon";
import { useUiTheme } from "../theme";
import { tokens } from "../../src/theme/tokens";

const button = cva("flex-row items-center justify-center gap-s2 rounded-button border overflow-hidden", {
  variants: {
    kind: {
      primary: "bg-primary border-transparent",
      secondary: "bg-surface-3 border-edge-strong",
      ghost: "bg-transparent border-transparent",
      danger: "bg-err-wash border-transparent",
      hold: "bg-err-wash border-transparent",
    },
    size: { md: "h-control px-s4", sm: "h-control-sm px-s3" },
    disabled: { true: "opacity-45", false: "" },
  },
  defaultVariants: { kind: "secondary", size: "md", disabled: false },
});

const ink: Record<string, string> = { primary: "inverse", secondary: "default", ghost: "muted", danger: "err", hold: "err" };

export type ButtonProps = {
  label?: string;
  kind?: "primary" | "secondary" | "ghost" | "danger" | "hold";
  size?: "md" | "sm";
  icon?: IconName;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  /** The accessible name when there is no label. */
  accessibilityLabel?: string;
  className?: string;
};

/** Button: one primary per surface. "hold" carries the count of what goes and fires after a held press (tokens.v2.motion.hold). */
export function Button({ label, kind = "secondary", size = "md", icon, onPress, disabled, loading, accessibilityLabel, className }: ButtonProps) {
  const { color } = useUiTheme();
  const hold = kind === "hold";
  const fill = useRef(new Animated.Value(0)).current;
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inkColor = kind === "primary" ? color["primary-ink"] : kind === "danger" || hold ? color.err : kind === "ghost" ? color["text-2"] : color.text;
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
    Animated.timing(fill, { toValue: 0, duration: 120, useNativeDriver: false }).start();
  };
  const start = () => {
    if (disabled || loading || timer.current) return;
    setHolding(true);
    Animated.timing(fill, { toValue: 1, duration: tokens.v2.motion.hold, easing: Easing.linear, useNativeDriver: false }).start();
    timer.current = setTimeout(() => { timer.current = null; setHolding(false); fill.setValue(0); onPress?.(); }, tokens.v2.motion.hold);
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={hold ? "Hold to confirm" : undefined}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      disabled={disabled || loading}
      onPress={hold ? undefined : onPress}
      onPressIn={hold ? start : undefined}
      onPressOut={hold ? stop : undefined}
      className={cn(button({ kind, size, disabled: !!disabled }), className)}
      style={({ pressed, hovered }: any) => (pressed && !hold ? { opacity: 0.85 } : hovered && !disabled ? { opacity: 0.92 } : undefined)}
    >
      {hold ? (
        <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: color["err-wash"], width: fill.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }} />
      ) : null}
      {loading ? <ActivityIndicator size="small" color={inkColor} /> : icon ? <Icon name={icon} tone={kind === "primary" ? "primary-ink" : kind === "danger" || hold ? "err" : "text"} /> : null}
      {label !== undefined ? (
        <Text strong size={size === "sm" ? "caption" : "body"} tone={ink[kind] as any} style={{ opacity: loading ? 0.75 : 1 }}>
          {label}
        </Text>
      ) : null}
      <View />
    </Pressable>
  );
}

/** A square button for an icon. Always named. 36 (control) or 44 (touch). */
export function IconButton({ icon, label, onPress, kind = "ghost", touch }: { icon: IconName; label: string; onPress?: () => void; kind?: "ghost" | "secondary" | "primary"; touch?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      // @ts-expect-error web-only prop: the tooltip
      title={label}
      className={cn("items-center justify-center rounded-button border", touch ? "h-touch w-touch" : "h-control w-control", kind === "primary" ? "bg-primary border-transparent" : kind === "secondary" ? "bg-surface-3 border-edge-strong" : "bg-transparent border-transparent")}
      style={({ pressed, hovered }: any) => (pressed ? { opacity: 0.8 } : hovered ? { opacity: 0.9 } : undefined)}
    >
      <Icon name={icon} size={20} tone={kind === "primary" ? "primary-ink" : "text-2"} />
    </Pressable>
  );
}
