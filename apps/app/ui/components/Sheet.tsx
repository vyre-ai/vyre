import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "./Text";
import { IconButton } from "./Button";
import { elevation } from "../lib/elevation";
import { useUiTheme } from "../theme";
import { SPRING, motion } from "../motion/tokens";
import { useReducedMotion } from "../motion/useReducedMotion";

/**
 * The native Sheet (iOS and Android): a bottom sheet that springs up from the bottom edge and drags down to dismiss; a tap on the dim area or the
 * Close button closes it too (so the gesture is never the only way). Built on reanimated and gesture-handler with the token springs. The same props
 * as the web Sheet (Sheet.web.tsx, a dialog): `open`, `onClose`, `title`, children. The caller owns `open`.
 * Drag from the grabber or the title; the body scrolls on its own.
 */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const { height } = useWindowDimensions();
  const inset = useSafeAreaInsets();
  const { resolved, color, map } = useUiTheme();
  const radius = parseInt(String(map["--r-sheet"]), 10) || 20;
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const panelH = useSharedValue(height);
  const y = useSharedValue(height);
  const fade = useSharedValue(0);
  const unmount = () => setMounted(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      if (reduced) { y.value = 0; fade.value = withTiming(1, { duration: motion.duration.state }); }
      else { fade.value = withTiming(1, { duration: motion.duration.panel }); y.value = withSpring(0, SPRING["spatial.default"]); }
    } else if (mounted) {
      if (reduced) { fade.value = withTiming(0, { duration: motion.duration.state }, (done) => { if (done) runOnJS(unmount)(); }); }
      else {
        fade.value = withTiming(0, { duration: motion.duration.panel });
        y.value = withSpring(panelH.value, SPRING["spatial.fast"], (done) => { if (done) runOnJS(unmount)(); });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reduced]);

  const pan = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .onUpdate((e) => { y.value = Math.max(0, e.translationY); })
    .onEnd((e) => {
      if (e.translationY > panelH.value * 0.3 || e.velocityY > 900) runOnJS(onClose)();
      else y.value = withSpring(0, SPRING["spatial.default"]);
    });

  const panel = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }], opacity: reduced ? fade.value : 1 }));
  const scrim = useAnimatedStyle(() => ({ opacity: fade.value }));
  if (!mounted) return null;
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: color.scrim }, scrim]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" style={{ flex: 1 }} onPress={onClose} />
        </Animated.View>
        <KeyboardAvoidingView pointerEvents="box-none" behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, justifyContent: "flex-end" }}>
          <Animated.View
            accessibilityViewIsModal
            onLayout={(e) => { panelH.value = e.nativeEvent.layout.height; if (y.value > e.nativeEvent.layout.height && open && !reduced) y.value = withSpring(0, SPRING["spatial.default"]); }}
            style={[{ maxHeight: height * 0.9, backgroundColor: color["surface-3"], borderColor: color["edge-strong"], borderWidth: 1, borderBottomWidth: 0, borderTopLeftRadius: radius, borderTopRightRadius: radius, paddingBottom: Math.max(inset.bottom, 16) }, elevation(resolved.scheme, 3), panel]}
          >
            <GestureDetector gesture={pan}>
              <View>
                <View style={{ alignItems: "center", paddingTop: 8, paddingBottom: 4 }}><View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: color["edge-strong"] }} /></View>
                <View className="min-h-control flex-row items-center gap-s3 px-s4 pb-s2">
                  <Text size="title" strong accessibilityRole="header" className="min-w-0 flex-1">{title ?? ""}</Text>
                  <IconButton icon="x" label="Close" onPress={onClose} />
                </View>
              </View>
            </GestureDetector>
            <ScrollView className="flex-shrink px-s4" contentContainerClassName="gap-s3 pb-s2" keyboardShouldPersistTaps="handled">{children}</ScrollView>
          </Animated.View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}
