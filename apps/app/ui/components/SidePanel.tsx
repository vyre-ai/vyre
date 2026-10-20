import { useEffect, useRef } from "react";
import { Animated, Platform, View, useWindowDimensions } from "react-native";
import { elevation } from "../lib/elevation";
import { useUiTheme } from "../theme";
import { useReducedMotion } from "../motion/useReducedMotion";
import { Sheet } from "./Sheet";
import { NARROW, closesPanel, sidePanelBox, sidePanelMode } from "./side-panel.js";

/**
 * A panel that slides in beside the view it was opened from, on the right, so the list stays visible and in place next to it: one record, one thing opened from a list. The caller puts it in a row after the view (flex-row); it is never laid over the view. Escape closes it. On a phone it is a Sheet,
 * the one way a thing opens from the bottom there. The caller draws what is inside, with its own header and close button.
 */
export function SidePanel({ open, onClose, title, children, width = 520 }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode; width?: number }) {
  const { phone, color, resolved } = useUiTheme();
  const reduced = useReducedMotion();
  const x = useRef(new Animated.Value(0)).current;
  const mode = sidePanelMode({ open, phone });
  useEffect(() => {
    if (mode !== "panel") return;
    x.setValue(reduced ? 0 : 56);
    Animated.timing(x, { toValue: 0, duration: reduced ? 0 : 180, useNativeDriver: true }).start();
  }, [mode, reduced, x]);
  const narrow = useWindowDimensions().width < NARROW;
  const box = useRef<any>(null);
  const back = useRef<HTMLElement | null>(null);
  // Escape and a press outside close it, and focus goes back to where it was (the row that opened it).
  useEffect(() => {
    if (mode !== "panel" || Platform.OS !== "web") return undefined;
    back.current = (document.activeElement as HTMLElement | null) ?? null;
    const field = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']");
    const key = (e: KeyboardEvent) => { if (closesPanel({ type: "key", key: e.key, inField: field(e.target) })) { e.stopPropagation(); onClose(); } };
    const press = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const el = box.current as unknown as HTMLElement | null;
      if (closesPanel({ type: "press", inside: !!(el && t && el.contains(t)), onTop: !!t?.closest?.("[role='menu'], [role='dialog'], [role='tooltip'], [aria-modal='true']") })) onClose();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", press, true);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("mousedown", press, true); try { back.current?.focus?.(); } catch { /* gone */ } };
  }, [mode, onClose]);
  if (mode === "closed") return null;
  if (mode === "sheet") return <Sheet open onClose={onClose} title={title} scroll={false}>{children}</Sheet>;
  return (
    <Animated.View ref={box} accessibilityViewIsModal={false} accessibilityLabel={title} style={{ ...(sidePanelBox(width, narrow) as object), backgroundColor: color["surface-3"], borderLeftWidth: 1, borderColor: color["edge-strong"], ...elevation(resolved.scheme, 2), zIndex: 2, transform: [{ translateX: x }] }}>
      <View className="min-h-0 flex-1">{children}</View>
    </Animated.View>
  );
}
