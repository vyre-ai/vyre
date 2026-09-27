import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MONO } from "../theme/fonts";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { StatusMark, type Status } from "./StatusMark";

const phone = tokens.type.phone;
const PAD = tokens.space[4];

/** Every row is this tall, so a long list lays out without measuring (padding, three lines, gaps). */
export const ROW_HEIGHT = PAD * 2 + phone.read[1] + phone.base[1] + phone.meta[1] + tokens.space[1] * 2;

export type RowProps = {
  /** One letter for the avatar: the agent's initial. */
  avatar: string;
  title: string;
  age?: string;
  /** One line: the command (mono), the subject, the question. */
  detail: string;
  mono?: boolean;
  /** kind · agent · project */
  meta: string;
  status: Status;
  /** A refusal: shown in the meta line's place, with the failed mark. */
  reason?: string | null;
  onPress?: () => void;
  /** The pressable's testID (data-testid on the web), for the perf job. */
  testID?: string;
};

/**
 * The one row (DIRECTION.md principle 8): title, one line of detail, then who and where. Needs
 * you, Chats and the Capsule's list share it. Fixed height; a refusal replaces the meta line.
 */
export const Row = memo(function Row(p: RowProps) {
  const { color } = useTheme();
  const status: Status = p.reason ? "failed" : p.status;
  return (
    <Pressable
      accessibilityRole="button"
      testID={p.testID}
      onPress={p.onPress}
      style={[styles.row, { backgroundColor: color.bg, borderBottomColor: color.rule }]}
    >
      <View style={styles.avatarBox}>
        <View style={[styles.avatar, { backgroundColor: color.hover }]}>
          <Text style={[styles.avatarText, { color: color.text2 }]}>{p.avatar.slice(0, 1).toLowerCase()}</Text>
        </View>
        <View style={[styles.mark, { backgroundColor: color.bg }]}>
          <StatusMark status={status} size={8} />
        </View>
      </View>
      <View style={styles.col}>
        <View style={styles.line}>
          <Text numberOfLines={1} style={[styles.title, { color: color.text }]}>{p.title}</Text>
          {p.age ? <Text style={[styles.meta, { color: color.label }]}>{p.age}</Text> : null}
        </View>
        <Text numberOfLines={1} style={[styles.detail, p.mono && styles.mono, { color: color.text2 }]}>{p.detail || " "}</Text>
        <Text numberOfLines={1} style={[styles.meta, { color: p.reason ? color.text : color.label }]}>{p.reason ?? p.meta}</Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    width: "100%",
    height: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: tokens.space[4],
    paddingHorizontal: tokens.layout.gutterPhone,
    paddingVertical: PAD,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatarBox: { width: 32, height: 32 },
  avatar: { width: 32, height: 32, borderRadius: tokens.radius.full, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: phone.base[0], lineHeight: phone.base[1], fontWeight: tokens.font.weight.strong },
  mark: { position: "absolute", right: -2, bottom: -2, padding: 2, borderRadius: tokens.radius.full },
  col: { flex: 1, minWidth: 0, gap: tokens.space[1] },
  line: { flexDirection: "row", alignItems: "center", gap: tokens.space[3] },
  title: { flex: 1, fontSize: phone.read[0], lineHeight: phone.read[1], fontWeight: tokens.font.weight.strong },
  detail: { fontSize: phone.base[0], lineHeight: phone.base[1] },
  mono: { fontFamily: MONO, fontSize: tokens.type.mono[1] },
  meta: { fontSize: phone.meta[0], lineHeight: phone.meta[1] },
});
