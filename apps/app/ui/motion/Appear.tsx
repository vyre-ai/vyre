import { useEffect, type ReactNode } from "react";
import { type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import { SPRING, motion } from "./tokens";
import { entrance, staggerDelay } from "./logic.js";
import { useReducedMotion } from "./useReducedMotion";

const SHADOW_ROOM = 16;

/**
 * An item that appears: it fades in (an effects spring on opacity) and rises into place with a spatial spring, `index` steps after the first
 * (tokens.v2.motion.stagger: 24 ms a step, none past the 8th). Reduced motion: it only fades, at once. `show` false takes it out with a short fade;
 * the children stay mounted until the fade ends, so a removed item leaves, it does not vanish.
 */
export function Appear({ children, index = 0, show = true, style }: { children: ReactNode; index?: number; show?: boolean; style?: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  const e = entrance(reduced);
  const o = useSharedValue(0);
  const y = useSharedValue(e.dy);
  const s = useSharedValue(e.scale);
  useEffect(() => {
    const d = reduced ? 0 : staggerDelay(motion, index);
    if (show) {
      o.value = withDelay(d, reduced ? withTiming(1, { duration: motion.duration.state }) : withSpring(1, SPRING["effects.default"]));
      // Reduced motion sets the value directly: withDelay needs an animation, and a plain number there throws on native (Reanimated 4).
      if (reduced) { y.value = 0; s.value = 1; } else {
        y.value = withDelay(d, withSpring(0, SPRING["spatial.default"]));
        s.value = withDelay(d, withSpring(1, SPRING["spatial.default"]));
      }
    } else {
      o.value = withTiming(0, { duration: motion.duration.state });
      y.value = reduced ? 0 : withSpring(e.dy, SPRING["spatial.fast"]);
      s.value = reduced ? 1 : withSpring(e.scale, SPRING["spatial.fast"]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, reduced, index]);
  const anim = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ translateY: y.value }, { scale: s.value }] }));
  // The card inside casts a shadow past its own box; an animated view is its own layer, clipped to its bounds, so the shadow showed as a square band at the
  // rounded corners (captures 37164502912, 37169304766). The padding gives the shadow room and the equal negative margin keeps the layout where it was.
  return <Animated.View style={[{ padding: SHADOW_ROOM, margin: -SHADOW_ROOM }, style, anim]} pointerEvents={show ? "box-none" : "none"}>{children}</Animated.View>;
}

/** Wrap a list's items: each child is an Appear at its own index. */
export function Stagger({ children, style }: { children: ReactNode[] | ReactNode; style?: StyleProp<ViewStyle> }) {
  const kids = Array.isArray(children) ? children : [children];
  return <>{kids.map((c, i) => <Appear key={(c as any)?.key ?? i} index={i} style={style}>{c}</Appear>)}</>;
}
