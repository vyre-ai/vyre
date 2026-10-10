// The motion of a live turn, kept small and quiet: a soft caret at the end of text that is still arriving, and a turning mark on the step that is running. Both stand still when the person has asked for reduced motion.
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import { Icon, useUiTheme, type IconName } from "@vyre/ui";

function useStill() {
  const [still, setStill] = useState(false);
  useEffect(() => { let on = true; AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { if (on) setStill(Boolean(v)); }).catch(() => {}); return () => { on = false; }; }, []);
  return still;
}

/** The soft caret: a thin block that breathes at the end of the words while the reply is still coming. */
export function Caret() {
  const still = useStill();
  const { color } = useUiTheme();
  const v = useRef(new Animated.Value(0.9)).current;
  useEffect(() => {
    if (still) return;
    const a = Animated.loop(Animated.sequence([Animated.timing(v, { toValue: 0.15, duration: 650, useNativeDriver: false }), Animated.timing(v, { toValue: 0.9, duration: 650, useNativeDriver: false })]));
    a.start();
    return () => a.stop();
  }, [v, still]);
  return <Animated.Text accessibilityElementsHidden importantForAccessibility="no" style={{ opacity: still ? 0.6 : v, color: color.accent }}>{"\u258D"}</Animated.Text>;
}

/** The mark on the step that is running: it turns, so it is clear which of the lines is the live one. */
export function Turning({ name }: { name: IconName }) {
  const still = useStill();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (still) return;
    const a = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: false }));
    a.start();
    return () => a.stop();
  }, [v, still]);
  return <Animated.View style={{ transform: [{ rotate: still ? "0deg" : v.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }}><Icon name={name} tone="accent" /></Animated.View>;
}
