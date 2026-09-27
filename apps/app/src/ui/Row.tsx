import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";
import { Avatar } from "./Avatar";
import { focusData } from "./Button";
import type { Status } from "./StatusMark";

const phone = tokens.type.phone;
const PAD = tokens.space[4];

/** Every row is this tall, so a long list lays out without measuring (padding, three lines, gaps). */
export const ROW_HEIGHT = PAD * 2 + phone.read[1] + phone.base[1] + phone.meta[1] + tokens.space[1] * 2;

export type RowProps = {
  /** The avatar's name: the agent's, or the item's. */
  avatar: string;
  title: string;
  age?: string;
  /** One line: the command (mono), the subject, the question. */
  detail: string;
  mono?: boolean;
  /** kind · agent · project */
  meta: string;
  /** The mark on the avatar; none for a place's rows (a vault item has no status). */
  status?: Status;
  /** A refusal: shown in the meta line's place, with the failed mark. */
  reason?: string | null;
  onPress?: () => void;
  /** The pressable's testID (data-testid on the web), for the perf job. */
  testID?: string;
};

/**
 * The three-line row (DIRECTION.md principle 8): title, one line of detail, then who and where.
 * Needs you, Chats and the vault share it. Fixed height; a refusal replaces the meta line.
 */
export const Row = memo(function Row(p: RowProps) {
  const { color, scheme } = useTheme();
  const status: Status | undefined = p.reason ? "failed" : p.status;
  return (
    <Pressable
      accessibilityRole="button"
      testID={p.testID}
      onPress={p.onPress}
      {...focusData(scheme)}
      style={(st) => [styles.row, { backgroundColor: st.pressed ? color.hover : color.bg, borderBottomColor: color.rule }]}
    >
      <Avatar name={p.avatar} status={status} />
      <View style={styles.col}>
        <View style={styles.line}>
          <Text numberOfLines={1} style={[type.readStrong, styles.title, { color: color.text }]}>{p.title}</Text>
          {p.age ? <Text style={[type.meta, { color: color.label }]}>{p.age}</Text> : null}
        </View>
        <Text numberOfLines={1} style={[p.mono ? type.mono : type.base, { color: color.text2 }]}>{p.detail || " "}</Text>
        <Text numberOfLines={1} style={[type.meta, { color: p.reason ? color.text : color.label }]}>{p.reason ?? p.meta}</Text>
      </View>
    </Pressable>
  );
});

/**
 * The two-line list row (list-row spec, group row): a title and a meta line, 56 with meta, the
 * whole row the target. Places and Settings share it.
 */
export function ListRow({ title, meta, onPress, testID }: { title: string; meta?: string; onPress?: () => void; testID?: string }) {
  const { color, scheme } = useTheme();
  const body = (
    <>
      <Text numberOfLines={1} style={[type.readStrong, { color: color.text }]}>{title}</Text>
      {meta ? <Text numberOfLines={1} style={[type.meta, { color: color.label }]}>{meta}</Text> : null}
    </>
  );
  if (!onPress) return <View style={[styles.listRow, { borderBottomColor: color.rule }]}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      onPress={onPress}
      {...focusData(scheme)}
      style={(st) => [styles.listRow, { backgroundColor: st.pressed || (st as { hovered?: boolean }).hovered ? color.hover : undefined, borderBottomColor: color.rule }]}
    >
      {body}
    </Pressable>
  );
}

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
  col: { flex: 1, minWidth: 0, gap: tokens.space[1] },
  line: { flexDirection: "row", alignItems: "center", gap: tokens.space[3] },
  title: { flex: 1 },
  listRow: {
    minHeight: tokens.control.touchLg,
    justifyContent: "center",
    gap: tokens.space[1],
    paddingHorizontal: tokens.layout.gutterPhone,
    paddingVertical: tokens.space[4],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
