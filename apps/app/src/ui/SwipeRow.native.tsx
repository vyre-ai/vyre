// The approve swipe in the native builds: the same shape as the web's scroll-snap strip, driven
// by Gesture Handler with the row's offset on Reanimated's UI thread. Past 40% of the width on
// release it commits (the row's height goes to 0 from that frame); short of it, it springs back.

import { useState } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import type { Decision } from "../state/needs-model";
import { afterPaint, perf } from "../perf";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import type { SwipeRowProps } from "./SwipeRow";

const COMMIT = 0.4;

export function SwipeRow({ children, height, onSwipe, approveLabel, rejectLabel }: SwipeRowProps) {
  const { color } = useTheme();
  const [width, setWidth] = useState(0);
  const x = useSharedValue(0);
  const h = useSharedValue(height);

  const settle = (d: Decision) => {
    perf.mark("approve.commit");
    if (onSwipe(d)) {
      h.value = withTiming(0, { duration: tokens.motion.tap });
      afterPaint((t) => perf.measure("approve.collapse", "approve.commit", t));
    } else x.value = withSpring(0);
  };

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-8, 8])
    .onUpdate((e) => {
      x.value = e.translationX;
    })
    .onEnd(() => {
      const w = width || 1;
      if (x.value > w * COMMIT) {
        x.value = withTiming(w, { duration: tokens.motion.tap });
        runOnJS(settle)("approve");
      } else if (x.value < -w * COMMIT) {
        x.value = withTiming(-w, { duration: tokens.motion.tap });
        runOnJS(settle)("reject");
      } else x.value = withSpring(0);
    });

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const outerStyle = useAnimatedStyle(() => ({ height: h.value }));
  const approveStyle = useAnimatedStyle(() => ({ opacity: x.value > 0 ? 1 : 0 }));
  const rejectStyle = useAnimatedStyle(() => ({ opacity: x.value < 0 ? 1 : 0 }));

  return (
    <Animated.View style={[styles.outer, outerStyle]} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.side, { backgroundColor: color.primaryBg }, approveStyle]}>
        <Text style={[styles.label, { color: color.primaryInk }]}>{approveLabel}</Text>
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, styles.side, styles.end, { backgroundColor: color.hover }, rejectStyle]}>
        <Text style={[styles.label, { color: color.text }]}>{rejectLabel}</Text>
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[{ height }, rowStyle]}>
          <View style={{ flex: 1 }}>{children}</View>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  outer: { overflow: "hidden" },
  side: { flexDirection: "row", alignItems: "center", paddingHorizontal: tokens.space[6] },
  end: { justifyContent: "flex-end" },
  label: { fontSize: tokens.type.phone.base[0], lineHeight: tokens.type.phone.base[1], fontWeight: tokens.font.weight.strong },
});
