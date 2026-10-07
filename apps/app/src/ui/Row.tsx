import { memo, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";
import { Avatar } from "./Avatar";
import { focusData } from "./Button";
import { Icon } from "./Icon";
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

/** The list row's heights (list-row spec, phone): 44 single line, about 56 with a meta line. */
export const LIST_ROW_SINGLE = tokens.control.touch;
export const LIST_ROW_DOUBLE = tokens.control.touch + tokens.space[4];

export type ListRowProps = {
  title: string;
  /** The meta line under the title: the two-line row. Leave it out for the 44 single-line row. */
  meta?: string;
  /** Right-aligned meta: an age, a count, a value ("3m", "12 threads", "On"). */
  trailing?: string;
  /** A 16 icon, an avatar or a status mark before the title. */
  leading?: ReactNode;
  /** Opens another screen: a 12 chevron at the end. */
  push?: boolean;
  /** The row the detail answers: the signal wash, meta and trailing step up to text2. */
  selected?: boolean;
  /** Keyboard focus drawn by the caller (a key-driven list); the web draws :focus-visible itself. */
  focused?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  testID?: string;
};

/**
 * The list row (list-row spec): the 44 single-line row (title, trailing meta) or the two-line row
 * (title and a meta line), on the page with a bottom rule, never in a card. The whole row is the
 * target; pressed and hovered fill `hover`, selected fills the signal wash, focus is a 2 px focus
 * outline inset by 2 with square corners. Places and Settings share it.
 */
export function ListRow(p: ListRowProps) {
  const { color, scheme } = useTheme();
  const quiet = p.selected ? color.text2 : color.label;
  const body = (
    <>
      {p.leading}
      <View style={styles.col}>
        <Text numberOfLines={1} style={[type.readStrong, { color: color.text }]}>{p.title}</Text>
        {p.meta ? <Text numberOfLines={1} style={[type.meta, { color: quiet }]}>{p.meta}</Text> : null}
      </View>
      {p.trailing ? <Text numberOfLines={1} style={[type.meta, styles.trailing, { color: quiet }]}>{p.trailing}</Text> : null}
      {p.push ? <Icon name="chev-r" size={tokens.icon.sizes[0]} color={color.label} /> : null}
    </>
  );
  const shape = [styles.listRow, { minHeight: p.meta ? LIST_ROW_DOUBLE : LIST_ROW_SINGLE, borderBottomColor: color.rule }];
  const ring = p.focused ? { borderColor: color.focus } : null;
  const rest = p.selected ? color.signalWash : color.bg;
  if (!p.onPress) {
    return (
      <View testID={p.testID} style={[shape, { backgroundColor: rest }]}>
        {body}
        {ring ? <View pointerEvents="none" style={[styles.ring, ring]} /> : null}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={p.accessibilityLabel}
      accessibilityState={p.selected !== undefined ? { selected: p.selected } : undefined}
      testID={p.testID}
      onPress={p.onPress}
      {...rowFocus(scheme)}
      style={(st) => [shape, { backgroundColor: p.selected ? color.signalWash : st.pressed || (st as { hovered?: boolean }).hovered ? color.hover : color.bg }]}
    >
      {body}
      {ring ? <View pointerEvents="none" style={[styles.ring, ring]} /> : null}
    </Pressable>
  );
}

const web = Platform.OS === "web";

/** The row's own focus ring on the web: inside the row (offset -2) and square, from the keyboard only. */
function rowFocus(scheme: "dark" | "paper"): Record<string, unknown> {
  return web ? { dataSet: { vyrow: scheme } } : focusData(scheme);
}

if (web && typeof document !== "undefined" && !document.getElementById("vy-row-css")) {
  const css = document.createElement("style");
  css.id = "vy-row-css";
  css.textContent = (["dark", "paper"] as const)
    .map((s) => `[data-vyrow="${s}"]:focus-visible{outline:2px solid ${tokens.color[s].focus} !important;outline-offset:-2px;border-radius:0}`)
    .join("\n");
  document.head.appendChild(css);
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
  // Padding 8 16: a 24 title makes the 44 single line, and title, gap and a 16 meta about 56.
  listRow: {
    // An explicit full width: on Android a row in a modal route laid out at zero width and drew only its chevron.
    alignSelf: "stretch",
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space[4],
    paddingHorizontal: tokens.layout.gutterPhone,
    paddingVertical: tokens.space[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  trailing: { flexShrink: 0, maxWidth: "40%" },
  ring: { ...StyleSheet.absoluteFillObject, borderWidth: tokens.space[1] },
});
