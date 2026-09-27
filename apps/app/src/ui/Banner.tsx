import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";

/**
 * One fact in the page flow, above what it is about, with at most one action (the banner spec):
 * a quiet `hover` fill, never a colour, no border. The action is an outline Button, 44 on the phone.
 */
export function Banner({ fact, detail, action, live }: { fact: string; detail?: string | null; action?: ReactNode; live?: boolean }) {
  const { color } = useTheme();
  return (
    <View style={styles.wrap}>
      <View style={[styles.banner, { backgroundColor: color.hover }]}>
        <View style={styles.text} accessibilityLiveRegion={live ? "polite" : undefined} accessibilityRole={live ? "summary" : undefined}>
          <Text style={[type.baseStrong, { color: color.text }]}>{fact}</Text>
          {detail ? (
            <Text numberOfLines={1} style={[type.meta, { color: color.text2 }]}>
              {detail}
            </Text>
          ) : null}
        </View>
        {action}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: tokens.layout.gutterPhone, paddingTop: tokens.space[3] },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space[4],
    paddingVertical: tokens.space[3],
    paddingLeft: tokens.space[5],
    paddingRight: tokens.space[4],
    borderRadius: tokens.radius.buttonTouch,
  },
  text: { flex: 1, minWidth: 0 },
});
