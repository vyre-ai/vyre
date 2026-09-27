import { useEffect, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";
import { Icon } from "./Icon";
import { badgeLabel, badgeText, elapsed, nextTick } from "./status-words.js";

export type Status = "needsYou" | "failed" | "running" | "unread" | "done";

/** The status-mark spec's sizes: dots 8, the running ring 10, the failed glyph 12, badge and count 18. */
const DOT = 8;
const RING = 10;
const FAILED = tokens.icon.sizes[0];
const PILL = 18;
const STROKE = tokens.icon.stroke;

type Props = {
  status: Status;
  /** The word is printed beside the mark by the caller, so the mark itself is hidden. */
  hidden?: boolean;
  /** Print the status word beside the mark ("running · 4m"); the mark is then hidden. */
  word?: boolean;
  /** What follows the word: "history" in "failed · history", "plan" in "waiting · plan". */
  detail?: string;
  /** Running only: when it started (ms since the epoch); the elapsed time shows beside the ring. */
  since?: number;
};

/**
 * The one status model (tokens.status): needs you (the beacon dot, the only violet), failed (the
 * failed icon, a circle with a cross, text2), running (the focus ring and its elapsed time), unread
 * (text dot), done (a hollow dot, 1.5 inset). Shape and colour come from the tokens; the word is
 * the accessibility label, unless it is printed beside the mark.
 */
export function StatusMark({ status, hidden, word, detail, since }: Props) {
  const { color } = useTheme();
  const t = tokens.status[status];
  const c = color[t.color as keyof typeof color];
  const time = useElapsed(status === "running" ? since : undefined);
  const line = [word ? t.word : null, word ? detail : null, time].filter(Boolean).join(" · ");
  const quiet = { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const };
  if (!line) return <Mark mark={t.mark} c={c} a11y={hidden ? quiet : { accessibilityLabel: t.word, accessible: true }} />;
  // The word or the time is printed: the mark hides and the line reads as one ("running, 4m").
  const name = [t.word, word ? detail : null, time].filter(Boolean).join(", ");
  return (
    <View style={styles.st} {...(hidden ? quiet : { accessible: true, accessibilityLabel: name })}>
      <Mark mark={t.mark} c={c} a11y={quiet} />
      <Text numberOfLines={1} style={[type.meta, { color: color.text2 }]}>{line}</Text>
    </View>
  );
}

function Mark({ mark, c, a11y }: { mark: string; c: string; a11y: object }) {
  switch (mark) {
    case "dot":
      return <View {...a11y} style={[round(DOT), { backgroundColor: c }]} />;
    case "ring":
      return <View {...a11y} style={[round(RING), { borderWidth: STROKE, borderColor: c }]} />;
    case "hollow-dot":
      // A border in React Native sits inside the box: the 1.5 inset stroke.
      return <View {...a11y} style={[round(DOT), { borderWidth: STROKE, borderColor: c }]} />;
    case "crossed-circle":
      return (
        <View {...a11y}>
          <Icon name="failed" color={c} size={FAILED} />
        </View>
      );
    default:
      return null;
  }
}

/**
 * The needs-you badge: 18 tall, the beacon fill, 1 to 99 then "99+", named "3 need you". Nothing
 * when nothing waits (the mark's dot goes back to its resting colour).
 */
export function Badge({ count }: { count: number }) {
  const { color } = useTheme();
  if (count <= 0) return null;
  // The badge ink (tokens.css --beacon-badge-ink) is the page colour in both themes.
  return <Pill text={badgeText(count)} fill={color.beacon} ink={color.bg} label={badgeLabel(count)} />;
}

/** The neutral count, the badge's geometry on `hover` with `text2` ink: group sizes, totals. */
export function Count({ count, accessibilityLabel }: { count: number; accessibilityLabel?: string }) {
  const { color } = useTheme();
  return <Pill text={badgeText(count)} fill={color.hover} ink={color.text2} label={accessibilityLabel ?? String(count)} />;
}

function Pill({ text, fill, ink, label }: { text: string; fill: string; ink: string; label: string }) {
  return (
    <View accessible accessibilityLabel={label} style={[styles.pill, { backgroundColor: fill }]}>
      <Text numberOfLines={1} style={[type.metaStrong, { color: ink }]}>{text}</Text>
    </View>
  );
}

/**
 * The elapsed text for a running mark: one timer, only while `since` is set, the mark is mounted
 * and the app is visible, ticking once a second under a minute and once a minute after.
 */
function useElapsed(since: number | undefined): string | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (since === undefined) return;
    let timer: ReturnType<typeof setTimeout> | 0 = 0;
    const tick = () => {
      const n = Date.now();
      setNow(n);
      timer = setTimeout(tick, nextTick(n - since));
    };
    const start = () => {
      if (!timer) tick();
    };
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = 0;
    };
    if (AppState.currentState !== "background") start();
    const sub = AppState.addEventListener("change", (s) => (s === "background" ? stop() : start()));
    return () => {
      stop();
      sub.remove();
    };
  }, [since]);
  return since === undefined ? null : elapsed(now - since);
}

const round = (size: number) => ({ width: size, height: size, borderRadius: tokens.radius.full });

// The .st line: gap 6. The pill: 18 tall, min 18 wide, padding 0 5, fully round, centred.
const styles = StyleSheet.create({
  st: { flexDirection: "row", alignItems: "center", gap: tokens.space[2] + tokens.space[1] },
  pill: {
    height: PILL,
    minWidth: PILL,
    paddingHorizontal: tokens.space[1] + tokens.space[2] - 1,
    borderRadius: tokens.radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
});
