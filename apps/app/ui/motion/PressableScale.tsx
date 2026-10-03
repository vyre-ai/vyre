import { useState } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { cssInterop } from "nativewind";
import { SPRING } from "./tokens";
import { pressScale } from "./logic.js";
import { useReducedMotion } from "./useReducedMotion";

const APressable = Animated.createAnimatedComponent(Pressable);
cssInterop(APressable, { className: "style" });

export type PressableScaleProps = Omit<PressableProps, "style"> & {
  className?: string;
  /** How far it shrinks while pressed (default 0.97). Rows use a lighter 0.985. */
  depth?: number;
  /** Extra style while pressed (a background) and while hovered (web). */
  pressedStyle?: ViewStyle;
  hoverStyle?: ViewStyle;
  style?: StyleProp<ViewStyle>;
};

/**
 * A Pressable that springs down on press and back on release (the token springs, fast down and default up), on the UI thread. It is the one press
 * feedback for Button, IconButton, Row and the AskCard actions. Reduced motion keeps the pressed colour and drops the scale.
 */
export function PressableScale({ depth = 0.97, pressedStyle, hoverStyle, style, onPressIn, onPressOut, onHoverIn, onHoverOut, disabled, ...rest }: PressableScaleProps) {
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <APressable
      {...(rest as object)}
      disabled={disabled}
      onPressIn={(e: any) => { setPressed(true); scale.value = withSpring(pressScale(reduced, depth), SPRING["spatial.fast"]); onPressIn?.(e); }}
      onPressOut={(e: any) => { setPressed(false); scale.value = withSpring(1, SPRING["spatial.default"]); onPressOut?.(e); }}
      onHoverIn={(e: any) => { setHovered(true); onHoverIn?.(e); }}
      onHoverOut={(e: any) => { setHovered(false); onHoverOut?.(e); }}
      style={[style, hovered && !disabled ? hoverStyle : null, pressed && !disabled ? pressedStyle : null, anim] as any}
    />
  );
}
