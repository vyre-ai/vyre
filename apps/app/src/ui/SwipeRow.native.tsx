// The approve swipe in the native builds: the web's rule (swipe.js, the needs-row release),
// driven by Gesture Handler with the row's offset on Reanimated's UI thread. On release a full 100
// reveal or a fling commits (the row's height goes to 0 from that frame); 40 to 100 rests open with
// the action showing, a pressable that commits; under 40 it springs back.

import { useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import type { Decision } from "../state/needs-model";
import { afterPaint, perf } from "../perf";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";
import type { SwipeRowProps } from "./SwipeRow";
import { ACTION_W, release } from "./swipe.js";

export function SwipeRow({ children, height, onSwipe, approveLabel, rejectLabel, testID }: SwipeRowProps) {
  const { color } = useTheme();
  const [width, setWidth] = useState(0);
  const x = useSharedValue(0);
  const start = useSharedValue(0);
  const h = useSharedValue(height);
  // Which side rests open: 1 approve, -1 deny. State, so the revealed action renders as a pressable.
  const [open, setOpen] = useState<0 | 1 | -1>(0);

  const rest = (to: number) => {
    setOpen(to > 0 ? 1 : to < 0 ? -1 : 0);
    x.value = withSpring(to);
  };

  const settle = (d: Decision) => {
    setOpen(0);
    x.value = withTiming((d === "approve" ? 1 : -1) * (width || 1), { duration: tokens.motion.tap });
    perf.mark("approve.commit");
    if (onSwipe(d)) {
      h.value = withTiming(0, { duration: tokens.motion.tap });
      afterPaint((t) => perf.measure("approve.collapse", "approve.commit", t));
    } else x.value = withSpring(0);
  };

  // Gesture Handler's velocity is px/s; release() takes px/ms.
  const end = (at: number, vx: number) => {
    const r = release(at, vx / 1000);
    if (r === "commit-right") settle("approve");
    else if (r === "commit-left") settle("reject");
    else rest(r === "open-right" ? ACTION_W : r === "open-left" ? -ACTION_W : 0);
  };

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-8, 8])
    .onStart(() => {
      start.value = x.value;
    })
    .onUpdate((e) => {
      x.value = start.value + e.translationX;
    })
    .onEnd((e) => {
      runOnJS(end)(x.value, e.velocityX);
    });

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const outerStyle = useAnimatedStyle(() => ({ height: h.value }));
  const approveStyle = useAnimatedStyle(() => ({ opacity: x.value > 0 ? 1 : 0 }));
  const rejectStyle = useAnimatedStyle(() => ({ opacity: x.value < 0 ? 1 : 0 }));

  return (
    <Animated.View style={[styles.outer, outerStyle]} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.side, { backgroundColor: color.primaryBg }, approveStyle]}>
        <Text style={[type.baseStrong, { color: color.primaryInk }]}>{approveLabel}</Text>
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, styles.side, styles.end, { backgroundColor: color.hover }, rejectStyle]}>
        <Text style={[type.baseStrong, { color: color.text }]}>{rejectLabel}</Text>
      </Animated.View>
      {open === 1 ? (
        <Pressable accessibilityRole="button" accessibilityLabel={approveLabel} onPress={() => settle("approve")} style={[styles.action, { left: 0 }]} />
      ) : open === -1 ? (
        <Pressable accessibilityRole="button" accessibilityLabel={rejectLabel} onPress={() => settle("reject")} style={[styles.action, { right: 0 }]} />
      ) : null}
      <GestureDetector gesture={pan}>
        <Animated.View testID={testID} style={[{ height }, rowStyle]}>
          <View style={{ flex: 1 }}>{children}</View>
          {/* A tap on a row resting open closes it, as on the web. */}
          {open ? <Pressable accessible={false} importantForAccessibility="no" onPress={() => rest(0)} style={StyleSheet.absoluteFill} /> : null}
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  outer: { overflow: "hidden" },
  side: { flexDirection: "row", alignItems: "center", paddingHorizontal: tokens.space[6] },
  end: { justifyContent: "flex-end" },
  // The revealed action: the 100 px a resting row uncovers.
  action: { position: "absolute", top: 0, bottom: 0, width: ACTION_W },
});
