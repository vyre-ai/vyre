import { useEffect, useRef } from "react";
import { Animated, Platform, View } from "react-native";
import { useUiTheme } from "../theme";
import { useReducedMotion } from "../motion/useReducedMotion";
import { Sheet } from "./Sheet";
import { sidePanelMode } from "./side-panel.js";

/**
 * A panel that slides in over the view it was opened from, on the right, so the list stays visible and in place behind it: one record, one thing opened from a list. Escape closes it. On a phone it is a Sheet,
 * the one way a thing opens from the bottom there. The caller draws what is inside, with its own header and close button.
 */
export function SidePanel({ open, onClose, title, children, width = 520 }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode; width?: number }) {
  const { phone } = useUiTheme();
  const reduced = useReducedMotion();
  const x = useRef(new Animated.Value(0)).current;
  const mode = sidePanelMode({ open, phone });
  useEffect(() => {
    if (mode !== "panel") return;
    x.setValue(reduced ? 0 : 56);
    Animated.timing(x, { toValue: 0, duration: reduced ? 0 : 180, useNativeDriver: true }).start();
  }, [mode, reduced, x]);
  useEffect(() => {
    if (mode !== "panel" || Platform.OS !== "web") return undefined;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [mode, onClose]);
  if (mode === "closed") return null;
  if (mode === "sheet") return <Sheet open onClose={onClose} title={title} scroll={false}>{children}</Sheet>;
  return (
    <Animated.View accessibilityViewIsModal={false} accessibilityLabel={title} className="border-l border-edge bg-bg" style={{ position: "absolute", top: 0, right: 0, bottom: 0, width, maxWidth: "92%", transform: [{ translateX: x }] }}>
      <View className="min-h-0 flex-1">{children}</View>
    </Animated.View>
  );
}
