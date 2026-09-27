import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";

/**
 * `panel` plus a hairline (the card spec). An optional header (a mark, the 12/600 label, meta on
 * the right), the body, and an optional footer for the buttons under a rule. The card itself never
 * carries colour: a card that needs you says so with the dot and the label in its header.
 */
export function Card({ mark, label, meta, footer, children, testID }: { mark?: ReactNode; label?: string; meta?: string; footer?: ReactNode; children?: ReactNode; testID?: string }) {
  const { color } = useTheme();
  const head = mark || label || meta;
  return (
    <View testID={testID} accessibilityLabel={label} style={[styles.card, { backgroundColor: color.panel, borderColor: color.rule }]}>
      {head ? (
        <View style={styles.head}>
          {mark}
          {label ? <Text style={[type.metaStrong, { color: color.label }]}>{label}</Text> : null}
          {meta ? (
            <Text numberOfLines={1} style={[type.meta, styles.meta, { color: color.label }]}>
              {meta}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View style={[styles.body, head ? null : styles.bodyAlone]}>{children}</View>
      {footer ? <View style={[styles.footer, { borderTopColor: color.rule }]}>{footer}</View> : null}
    </View>
  );
}

// Phone: radius card-phone (10), content padding 0 14 (the spec's phone values: 16 less 2).
const PAD = tokens.space[5] - tokens.space[1];
const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: tokens.radius.cardPhone, overflow: "hidden" },
  head: { minHeight: tokens.control.touch, flexDirection: "row", alignItems: "center", gap: tokens.space[3], paddingHorizontal: PAD },
  meta: { flex: 1, textAlign: "right" },
  body: { paddingHorizontal: PAD, paddingBottom: tokens.space[4], gap: tokens.space[3] },
  bodyAlone: { paddingTop: tokens.space[4] },
  footer: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: tokens.space[3], paddingHorizontal: PAD, paddingVertical: tokens.space[4], borderTopWidth: StyleSheet.hairlineWidth },
});
