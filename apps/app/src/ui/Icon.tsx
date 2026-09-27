import { StyleSheet, View, type ViewStyle } from "react-native";
import { tokens } from "../theme/tokens";

/**
 * The icons the app draws so far, from the one set (the icons spec), on its 16 grid. The app has
 * no SVG renderer, so each path is its straight segments as bars with round caps (the StatusMark
 * way): the same coordinates as the set's path data, the same 1.5 stroke, scaled to 12, 16 or 20.
 */
export type IconName = "send" | "stop" | "check" | "x";

type Seg = readonly [x1: number, y1: number, x2: number, y2: number];
type Rect = { x: number; y: number; w: number; h: number; rx: number };

// Each drawing is the set's path data unchanged, split into segments.
const SET: Record<IconName, { segs?: readonly Seg[]; rect?: Rect }> = {
  // M8 13V3 M4 7l4-4 4 4
  send: { segs: [[8, 13, 8, 3], [4, 7, 8, 3], [8, 3, 12, 7]] },
  // rect x4 y4 w8 h8 rx1.5
  stop: { rect: { x: 4, y: 4, w: 8, h: 8, rx: 1.5 } },
  // M3 8.5l3 3 7-7
  check: { segs: [[3, 8.5, 6, 11.5], [6, 11.5, 13, 4.5]] },
  // M4 4l8 8 M12 4l-8 8
  x: { segs: [[4, 4, 12, 12], [12, 4, 4, 12]] },
};

const GRID = tokens.icon.grid;
const STROKE = tokens.icon.stroke;

/** Decorative: the control around it carries the name. The ink is the caller's (the row's, the button's). */
export function Icon({ name, color, size = tokens.icon.sizes[1] }: { name: IconName; color: string; size?: number }) {
  const k = size / GRID;
  const d = SET[name];
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      {d.rect ? <View style={[styles.abs, rectStyle(d.rect, k), { borderColor: color }]} /> : null}
      {d.segs?.map((s, i) => <View key={i} style={[styles.abs, segStyle(s, k), { backgroundColor: color }]} />)}
    </View>
  );
}

// A segment is a bar as long as the line plus both round caps, centred on the line, turned to its angle.
function segStyle([x1, y1, x2, y2]: Seg, k: number): ViewStyle {
  const len = Math.hypot(x2 - x1, y2 - y1) * k + STROKE;
  const cx = ((x1 + x2) / 2) * k;
  const cy = ((y1 + y2) / 2) * k;
  const deg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  return { left: cx - len / 2, top: cy - STROKE / 2, width: len, height: STROKE, borderRadius: STROKE / 2, transform: [{ rotate: `${deg}deg` }] };
}

// A stroked rect: the border sits on the path, half inside and half outside.
function rectStyle(r: Rect, k: number): ViewStyle {
  const h = STROKE / 2;
  return { left: r.x * k - h, top: r.y * k - h, width: r.w * k + STROKE, height: r.h * k + STROKE, borderRadius: r.rx * k + h, borderWidth: STROKE };
}

const styles = StyleSheet.create({
  abs: { position: "absolute" },
});
