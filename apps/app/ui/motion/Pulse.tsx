import { useEffect, type ReactNode } from "react";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { motion } from "./tokens";
import { useReducedMotion } from "./useReducedMotion";

/** Content that is busy: it breathes in place (opacity, one slow cycle). It replaces a spinner. Reduced motion: held at a lower opacity, still. */
export function Pulse({ active, children }: { active: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  const o = useSharedValue(1);
  useEffect(() => {
    if (!active) { o.value = withTiming(1, { duration: motion.duration.state }); return; }
    if (reduced) { o.value = 0.55; return; }
    o.value = withRepeat(withTiming(0.45, { duration: motion.duration.nod * 1.5, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [active, reduced, o]);
  const anim = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ flexDirection: "row", alignItems: "center", gap: 8 }, anim]}>{children}</Animated.View>;
}
