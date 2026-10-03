import { useEffect } from "react";
import * as P from "@rn-primitives/switch";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { cn } from "../lib/cn";
import { SPRING, motion } from "../motion/tokens";
import { useReducedMotion } from "../motion/useReducedMotion";
import { haptic } from "../motion/haptics";
import { useUiTheme } from "../theme";

// Thumb travel: the track is s10 wide (40) and the thumb s4 (16) with s1 (4) either side; the move is 20.
const TRAVEL = 20;

/** On or off. Never used for a destructive action. The thumb springs across and a tick is felt on a phone. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange?: (on: boolean) => void; label: string; disabled?: boolean }) {
  const reduced = useReducedMotion();
  const { color } = useUiTheme();
  const x = useSharedValue(on ? TRAVEL : 0);
  useEffect(() => { x.value = reduced ? withTiming(on ? TRAVEL : 0, { duration: motion.duration.state }) : withSpring(on ? TRAVEL : 0, SPRING["spatial.fast"]); }, [on, reduced, x]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <P.Root checked={on} onCheckedChange={(v) => { haptic.selection(); (onChange ?? (() => {}))(v); }} disabled={disabled} accessibilityLabel={label}
      className={cn("h-s6 w-s10 flex-none justify-center rounded-full border", on ? "border-accent bg-accent" : "border-edge-strong bg-surface-3", disabled && "opacity-45")}>
      <P.Thumb asChild>
        <Animated.View style={[{ marginLeft: 4, width: 16, height: 16, borderRadius: 8, backgroundColor: on ? color["accent-ink"] : color["text-2"] }, thumb]} />
      </P.Thumb>
    </P.Root>
  );
}
