import { createContext, useContext, useEffect, useState } from "react";
import { View, type DimensionValue } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming, type SharedValue } from "react-native-reanimated";
import { useUiTheme } from "../theme";
import { cn } from "../lib/cn";
import { motion } from "./tokens";
import { skeletonPlan } from "./logic.js";
import { useReducedMotion } from "./useReducedMotion";

/** One shine for a whole list (UX-36): every Skeleton under a SkeletonRows reads this one value, so the bars brighten together instead of each running its own loop. */
const Shine = createContext<SharedValue<number> | null>(null);

/** The shine's own loop: a phase from 0 to 1 over the plan's period, still under reduced motion. */
function useShinePhase() {
  const reduced = useReducedMotion();
  const plan = skeletonPlan(motion, reduced);
  const x = useSharedValue(0);
  useEffect(() => {
    if (!plan.shimmer) { x.value = 0; return; }
    x.value = withRepeat(withTiming(1, { duration: plan.period, easing: Easing.inOut(Easing.ease) }), -1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.shimmer, plan.period]);
  return { x, shimmer: plan.shimmer };
}

/** A block that stands in for content that is loading: the shape of what will be there, with a slow shine across it (the token text colour at low strength, not white). Reduced motion: still. */
export function Skeleton({ width = "100%", height = 16, rounded = "rounded-row", className }: { width?: DimensionValue; height?: number; rounded?: string; className?: string }) {
  const { color } = useUiTheme();
  const shared = useContext(Shine);
  const own = useShinePhase();
  const x = shared ?? own.x;
  const shimmer = shared ? true : own.shimmer;
  const shine = useAnimatedStyle(() => ({ opacity: shimmer ? 0.08 * Math.sin(Math.PI * x.value) : 0 }));
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden style={{ width, height }} className={cn("overflow-hidden bg-hover", rounded, className)}>
      <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: color.text }, shine]} />
    </View>
  );
}

/** Keeps a skeleton up for at least `ms` once it has shown (motion.md 3.6: 240 ms), so a load that ends just after the skeleton appears does not flash it. Pass the real loading flag; draw the skeleton while this returns true. */
export function useSkeletonHold(loading: boolean, ms = 240) {
  const [held, setHeld] = useState(loading);
  useEffect(() => {
    if (loading) { setHeld(true); return; }
    const t = setTimeout(() => setHeld(false), ms);
    return () => clearTimeout(t);
  }, [loading, ms]);
  return loading || held;
}

/** True once `ms` have passed since mount: a fast load never flashes a skeleton (motion.md 3.6, show late at 150 ms; the space is kept so nothing shifts). */
function useAfter(ms: number) {
  const [late, setLate] = useState(false);
  useEffect(() => { const t = setTimeout(() => setLate(true), ms); return () => clearTimeout(t); }, [ms]);
  return late;
}

/** What a list looks like while it loads: `rows` rows of a mark and two lines. */
export function SkeletonRows({ rows = 4, card = true }: { rows?: number; card?: boolean }) {
  const late = useAfter(150);
  const { x } = useShinePhase();
  const body = (
    <View className="gap-s3">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} className="min-h-row flex-row items-center gap-s3 px-s3 py-s2">
          <Skeleton width={32} height={32} rounded="rounded-full" />
          <View className="min-w-0 flex-1 gap-s2"><Skeleton width={i % 2 ? "55%" : "70%"} height={14} /><Skeleton width="40%" height={12} /></View>
        </View>
      ))}
    </View>
  );
  return (
    <Shine.Provider value={x}>
      <View accessibilityRole="progressbar" accessibilityLabel="Loading" accessibilityState={{ busy: true }} style={{ opacity: late ? 1 : 0 }}>
        {card ? <View className="rounded-card border border-edge bg-surface-2 py-s2">{body}</View> : body}
      </View>
    </Shine.Provider>
  );
}

/** A page while it loads: a title block, then a few rows. */
export function SkeletonPage({ rows = 4 }: { rows?: number }) {
  return (
    <View className="gap-s4">
      <View className="gap-s2"><Skeleton width="45%" height={28} /><Skeleton width="30%" height={14} /></View>
      <SkeletonRows rows={rows} />
    </View>
  );
}
