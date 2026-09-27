import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";

type Props = {
  /** A status mark or a 16 icon before the label. */
  mark?: ReactNode;
  /** 12/600, sentence case: "Permission", "Draft to send". */
  label?: string;
  /** Right-aligned meta: "kit · 14:40". */
  meta?: string;
  /** It waits for you: the label takes the attention colour beside the dot the caller passes as `mark`. */
  needsYou?: boolean;
  /** Decided: the label is the decision in 13/600 `text` ("Allowed once"), beside a neutral glyph. */
  decided?: boolean;
  footer?: ReactNode;
  children?: ReactNode;
  /** The section's name, when it says more than the label ("Permission ask from kit"). */
  accessibilityLabel?: string;
  testID?: string;
};

/**
 * `panel` plus a hairline (the card spec). An optional header (a mark, the 12/600 label, meta on
 * the right), the body, and an optional footer for the buttons under a rule. The card itself never
 * carries colour: a card that needs you says so with the dot and the label in its header.
 */
export function Card({ mark, label, meta, needsYou, decided, footer, children, accessibilityLabel, testID }: Props) {
  const { color } = useTheme();
  const head = mark || label || meta;
  const name = accessibilityLabel ?? label;
  const labelStyle = decided ? [type.baseStrong, { color: color.text }] : [type.metaStrong, { color: needsYou ? color.beacon : color.label }];
  return (
    <View testID={testID} role={name ? "region" : undefined} accessibilityLabel={name} style={[styles.card, { backgroundColor: color.panel, borderColor: color.rule }]}>
      {head ? (
        <View style={styles.head}>
          {mark}
          {label ? <Text style={labelStyle}>{label}</Text> : null}
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

/** Code in a card, the only inner box it allows: `codeBg`, radius 8, padding 8 12, mono 13/18, wraps. */
export function CardCode({ text }: { text: string }) {
  const { color } = useTheme();
  return (
    <View style={[styles.code, { backgroundColor: color.codeBg }]}>
      <Text selectable style={[type.mono, { color: color.text }]}>{text}</Text>
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
  code: { borderRadius: tokens.radius.field, paddingVertical: tokens.space[3], paddingHorizontal: tokens.space[4] },
});
