// Haptics: one helper, four moments. No-op on the web and wherever the module is not there (a simulator without a taptic engine just returns).
import { Platform } from "react-native";
import * as Haptics from "expo-haptics";
import { HAPTICS } from "./haptic-map.js";

export type HapticName = keyof typeof HAPTICS;

function fire(name: HapticName) {
  if (Platform.OS === "web") return;
  const h = HAPTICS[name];
  try {
    if (h.kind === "selection") void Haptics.selectionAsync();
    else if (h.kind === "notification") void Haptics.notificationAsync(Haptics.NotificationFeedbackType[h.style as keyof typeof Haptics.NotificationFeedbackType]);
    else void Haptics.impactAsync(Haptics.ImpactFeedbackStyle[h.style as keyof typeof Haptics.ImpactFeedbackStyle]);
  } catch { /* a device without haptics: nothing to do */ }
}

/**
 * haptic.approve: an approval went through (Send with Face ID, Approve, Mark done). haptic.stage: a record moved to another stage.
 * haptic.selection: a choice flipped (Switch, a swipe revealing its buttons). haptic.warn: a held press completed on something that removes.
 */
export const haptic = {
  approve: () => fire("approve"),
  stage: () => fire("stage"),
  selection: () => fire("selection"),
  warn: () => fire("warn"),
};
