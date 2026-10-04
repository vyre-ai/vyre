import { useEffect } from "react";
import * as P from "@rn-primitives/switch";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { cn } from "../lib/cn";
import { SPRING, motion } from "../motion/tokens";
import { useReducedMotion } from "../motion/useReducedMotion";
import { haptic } from "../motion/haptics";
import { useUiTheme } from "../theme";

// The track is 44 x 26 (ui-review Flows 2); the thumb is 20 with 3 either side inside the 1 px edge, so the move is 16.
const TRAVEL = 16;

/** On or off. Never used for a destructive action. The thumb springs across and a tick is felt on a phone. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange?: (on: boolean) => void; label: string; disabled?: boolean }) {
  const reduced = useReducedMotion();
  const { color } = useUiTheme();
  // Style props, not className: @rn-primitives drops className on the web.
  const x = useSharedValue(on ? TRAVEL : 0);
  useEffect(() => { x.value = reduced ? withTiming(on ? TRAVEL : 0, { duration: motion.duration.state }) : withSpring(on ? TRAVEL : 0, SPRING["spatial.fast"]); }, [on, reduced, x]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <P.Root checked={on} onCheckedChange={(v) => { haptic.selection(); (onChange ?? (() => {}))(v); }} disabled={disabled} accessibilityLabel={label} hitSlop={{ top: 9, bottom: 9, left: 4, right: 4 }}
      style={{ height: 26, width: 44, flexShrink: 0, flexGrow: 0, justifyContent: "center", borderRadius: 999, borderWidth: 1, borderColor: on ? color.accent : color["edge-strong"], backgroundColor: on ? color.accent : color["surface-3"], opacity: disabled ? 0.45 : 1 }}>
      <P.Thumb asChild>
        <Animated.View style={[{ marginLeft: 3, width: 20, height: 20, borderRadius: 10, backgroundColor: on ? color["accent-ink"] : color["text-2"] }, thumb]} />
      </P.Thumb>
    </P.Root>
  );
}
