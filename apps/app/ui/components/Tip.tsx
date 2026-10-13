import { useRef, useState } from "react";
import { Platform, View, type ViewStyle } from "react-native";
import { useUiTheme } from "../theme";
import { Text } from "./Text";

/**
 * A name on hover or focus, for an icon with no label (the folded rail). Web only; a phone has no hover. The bubble is drawn fixed to the window, so a scrolling list around the icon
 * cannot clip it. `hint` is the shortcut, shown after the name.
 */
export function Tip({ label, hint, children, side = "right" }: { label: string; hint?: string; children: React.ReactNode; side?: "right" | "top" }) {
  const { color } = useUiTheme();
  const ref = useRef<View>(null);
  const [at, setAt] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  if (Platform.OS !== "web") return <>{children}</>;
  const show = () => ref.current?.measureInWindow((x, y, w, h) => setAt({ x, y, w, h }));
  const place: ViewStyle | null = at ? ({ position: "fixed", zIndex: 1000, ...(side === "right" ? { left: at.x + at.w + 8, top: at.y + at.h / 2 - 14 } : { left: at.x + at.w / 2, top: at.y - 34 }) } as unknown as ViewStyle) : null;
  return (
    <View ref={ref} onPointerEnter={show} onPointerLeave={() => setAt(null)} onFocus={show} onBlur={() => setAt(null)} style={{ alignSelf: "stretch" }}>
      {children}
      {place ? (
        <View pointerEvents="none" style={[place, { flexDirection: "row", gap: 8, alignItems: "center", paddingHorizontal: 10, height: 28, borderRadius: 8, backgroundColor: color.primary }]}>
          <Text size="caption" medium style={{ color: color["primary-ink"] }}>{label}</Text>
          {hint ? <Text size="caption" style={{ color: color["primary-ink"], opacity: 0.6 }}>{hint}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
