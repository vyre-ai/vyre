import { StyleSheet, View } from "react-native";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";

export type Status = "needsYou" | "failed" | "running" | "unread" | "done";

/** The status-mark spec's sizes: dots 8, the running ring 10, the failed glyph 12. */
const DOT = 8;
const RING = 10;
const FAILED = 12;
const STROKE = tokens.icon.stroke;

/**
 * The one status model (tokens.status): needs you (the beacon dot, the only violet), failed (a
 * circle with a cross, text2), running (the focus ring), unread (text dot), done (hollow dot).
 * Shape and colour come from the tokens; the word is the accessibility label, unless the caller
 * prints the word beside the mark (`hidden`).
 */
export function StatusMark({ status, hidden }: { status: Status; hidden?: boolean }) {
  const { color } = useTheme();
  const t = tokens.status[status];
  const c = color[t.color as keyof typeof color];
  const label = hidden ? { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const } : { accessibilityLabel: t.word, accessible: true };
  switch (t.mark) {
    case "dot":
      return <View {...label} style={[round(DOT), { backgroundColor: c }]} />;
    case "ring":
      return <View {...label} style={[round(RING), { borderWidth: STROKE, borderColor: c }]} />;
    case "hollow-dot":
      return <View {...label} style={[round(DOT), { borderWidth: STROKE, borderColor: c }]} />;
    case "crossed-circle":
      return (
        <View {...label} style={[round(FAILED), styles.center, { borderWidth: STROKE, borderColor: c }]}>
          <View style={[styles.bar, styles.cw, { backgroundColor: c }]} />
          <View style={[styles.bar, styles.ccw, { backgroundColor: c }]} />
        </View>
      );
    default:
      return null;
  }
}

const round = (size: number) => ({ width: size, height: size, borderRadius: tokens.radius.full });

// The cross sits inside the circle: each arm is half the glyph long.
const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  bar: { position: "absolute", width: FAILED / 2, height: STROKE },
  cw: { transform: [{ rotate: "45deg" }] },
  ccw: { transform: [{ rotate: "-45deg" }] },
});
