import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";

/** A tab page: the phone header and a body. Layout branches on width only, never the platform. */
export function Screen({ title, children }: { title: string; children?: ReactNode }) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.page, { backgroundColor: color.bg, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: color.rule }]}>
        <Text accessibilityRole="header" style={[styles.title, { color: color.text }]}>{title}</Text>
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

/** The quiet empty state: one line, the label colour. */
export function Empty({ text }: { text: string }) {
  const { color } = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyText, { color: color.label }]}>{text}</Text>
    </View>
  );
}

const phone = tokens.type.phone;
const styles = StyleSheet.create({
  page: { flex: 1 },
  header: {
    height: tokens.layout.phoneHeader,
    paddingHorizontal: tokens.layout.gutterPhone,
    justifyContent: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: phone.title[0], lineHeight: phone.title[1], fontWeight: tokens.font.weight.strong },
  body: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.layout.gutterPhone },
  emptyText: { fontSize: phone.read[0], lineHeight: phone.read[1] },
});
