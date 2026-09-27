import { StyleSheet, View } from "react-native";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";

export type Status = "needsYou" | "failed" | "running" | "unread" | "done";

const SIZE = 10;

/**
 * The one status model (tokens.status): needs you (violet dot), failed (crossed circle, text
 * colour), running (lime ring), unread (text dot), done (hollow dot). Shape and colour come from
 * the tokens; the word is the accessibility label.
 */
export function StatusMark({ status, size = SIZE }: { status: Status; size?: number }) {
  const { color } = useTheme();
  const t = tokens.status[status];
  const c = color[t.color as keyof typeof color];
  const round = { width: size, height: size, borderRadius: size / 2 };
  const label = { accessibilityLabel: t.word, accessible: true };
  switch (t.mark) {
    case "dot":
      return <View {...label} style={[round, { backgroundColor: c }]} />;
    case "ring":
      return <View {...label} style={[round, { borderWidth: 1.5, borderColor: c }]} />;
    case "hollow-dot":
      return <View {...label} style={[round, { borderWidth: 1, borderColor: c }]} />;
    case "crossed-circle":
      return (
        <View {...label} style={[round, styles.center, { borderWidth: 1.5, borderColor: c }]}>
          <View style={[styles.bar, { width: size, backgroundColor: c }]} />
        </View>
      );
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  bar: { height: 1.5, transform: [{ rotate: "-45deg" }] },
});
