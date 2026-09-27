// The Glass mini-view on the phone (docs/design/system/components/glass-mini.md, the App parts):
// the Card (a 16:10 still of an agent's computer and the step line under it) and the Pill (the
// step line alone, 28 tall) for a thread whose frame is collapsed. Read only: watching changes
// nothing. The whole card is one button, "Open Glass for kit's computer"; the phone has no Glass
// screen yet, so it opens the step's thread when there is one. The picture is hidden from
// assistive tech; a polite live region says a new step at most once every 5 s.

import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, AppState, Image, PixelRatio, Platform, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { sessionOpening } from "../perf";
import { watchGlass, useGlassFrame, type TargetView } from "../state/glass";
import { COPY, ageTick, announceText, announceWait, frameWidth, nextPhaseIn, openLabel, phaseOf, pictureLook, stepLine } from "../state/glass-model.js";
import { usePath } from "../state/connection";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";
import { focusData } from "./Button";
import { Icon } from "./Icon";
import { useReducedMotion } from "./pointer";
import { StatusMark } from "./StatusMark";
import { useOnScreen } from "./useOnScreen";

type Props = {
  view: TargetView;
  /** What the agent waits on you for, when it does: the line reads "Waiting for you: <what>". */
  waiting?: string | null;
  /** The screen showing it has focus (tabs stay mounted): no stills for a card behind another page. */
  visible: boolean;
  /** The thread already on screen: pressing opens nothing new. */
  here?: string | null;
};

/** The screen this sits on has focus: false while another tab or page covers it. */
export function useScreenFocused(): boolean {
  const [on, setOn] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setOn(true);
      return () => setOn(false);
    }, []),
  );
  return on;
}

/** The app is in front (the web: the page is visible). */
function useForeground(): boolean {
  const [front, setFront] = useState(AppState.currentState !== "background");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setFront(s === "active"));
    return () => sub.remove();
  }, []);
  return front;
}

/** The phase (card, pill, stopped, gone), moved on by one timeout, cleared on unmount. */
function usePhase(view: TargetView) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const n = Date.now();
    setNow(n);
    const wait = nextPhaseIn(view, n);
    if (wait === null) return;
    const t = setTimeout(() => setNow(Date.now()), wait + 1);
    return () => clearTimeout(t);
  }, [view]);
  return phaseOf(view, now);
}

/** The step's age, ticking at most once a second, only while it is on screen and the app in front. */
function useAge(at: number | undefined, on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (at === undefined || !on) return;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const n = Date.now();
      setNow(n);
      t = setTimeout(tick, Math.max(1000, ageTick(n - at)));
    };
    tick();
    return () => clearTimeout(t);
  }, [at, on]);
  return now;
}

/** The live region's words: the newest step, at most once every 5 s (one trailing timeout). */
function useAnnounce(words: string): string {
  // What shows when the card mounts is not news: only a change is spoken.
  const [said, setSaid] = useState(words);
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!words || words === said) return;
    const say = () => {
      last.current = Date.now();
      setSaid(words);
      // iOS has no live regions: VoiceOver hears it once, here.
      if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(words);
    };
    const wait = announceWait(Date.now(), last.current);
    if (!wait) return say();
    const t = setTimeout(say, wait);
    return () => clearTimeout(t);
  }, [words, said]);
  return said;
}

/** The step line's text fades in over 150 when it changes; it never slides. None under reduced motion. */
function useSwap(key: string) {
  const reduced = useReducedMotion();
  const o = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reduced) return;
    o.setValue(0);
    const a = Animated.timing(o, { toValue: 1, duration: tokens.motion.reveal, useNativeDriver: Platform.OS !== "web" });
    a.start();
    return () => a.stop();
  }, [key, reduced, o]);
  return o;
}

function useOpen(view: TargetView, here?: string | null) {
  const router = useRouter();
  return useCallback(() => {
    const t = view.thread;
    if (!t || t === here) return;
    sessionOpening();
    router.push({ pathname: "/session/[id]", params: { id: t } });
  }, [router, view.thread, here]);
}

type Line = ReturnType<typeof stepLine>;

function Mark({ mark }: { mark: Line["mark"] }) {
  const { color } = useTheme();
  if (mark === "ok") return <Icon name="check" size={tokens.icon.sizes[0]} color={color.text2} />;
  if (mark === "failed") return <StatusMark status="failed" hidden />;
  if (mark === "waiting" || mark === "stopped") return <StatusMark status="done" hidden />;
  return <StatusMark status="running" hidden />;
}

/** The mark, the summary in `text`, then a middle dot and the age (or the holder) in `label`. */
function StepText({ line, pill }: { line: Line; pill?: boolean }) {
  const { color } = useTheme();
  const o = useSwap(line.text);
  return (
    <View style={styles.line}>
      <Mark mark={line.mark} />
      <Animated.View style={[styles.lineText, pill ? styles.lineTextPill : null, { opacity: o }]}>
        <Text numberOfLines={1} style={[type.base, styles.summary, { color: color.text }]}>{line.text}</Text>
        {line.trail && !pill ? <Text numberOfLines={1} style={[type.meta, styles.trail, { color: color.label }]}>{`· ${line.trail}`}</Text> : null}
      </Animated.View>
    </View>
  );
}

/** A visually hidden polite live region: "kit: Clicked Compose in Mail", at most every 5 s. */
function LiveLine({ text }: { text: string }) {
  const web = Platform.OS === "web" ? ({ "aria-live": "polite", role: "status" } as Record<string, unknown>) : {};
  return (
    <Text accessibilityLiveRegion="polite" {...web} style={styles.hiddenText}>
      {text}
    </Text>
  );
}

/**
 * The Card: one per acting agent, the screen width less 32 (the caller's gutter), drawn outside
 * any card. 16:10, radius 8, `codeBg` with a 1 px `ruleStrong`, the still letterboxed and never
 * cropped, the Live badge 8 in at the top left while it is live.
 */
export function GlassCard({ view, waiting = null, visible, here }: Props) {
  const { color, scheme } = useTheme();
  const phase = usePhase(view);
  const front = useForeground();
  const path = usePath();
  const frame = useGlassFrame();
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);
  // Scrolled out of view counts as hidden: no stills for a card nobody can see (glass-mini.md).
  const frameRef = useRef<View>(null);
  const onScreen = useOnScreen(frameRef);
  const shows = phase === "card" || phase === "stopped";
  const on = visible && onScreen && front && shows;
  const now = useAge(view.step?.at, on);
  const line = stepLine(view, now, waiting);
  const said = useAnnounce(line.text ? announceText(view.agent, line.text) : "");
  const open = useOpen(view, here);

  // Say where the card is and how wide, for the light rule (glass.ts). maxWidth moves in steps of 80.
  const watch = useRef<ReturnType<typeof watchGlass> | null>(null);
  useEffect(() => {
    const w = watchGlass(view.target);
    watch.current = w;
    return () => {
      w.stop();
      watch.current = null;
    };
  }, [view.target]);
  const maxWidth = frameWidth(width, PixelRatio.get());
  useEffect(() => {
    watch.current?.set({ visible: visible && onScreen && shows && width > 0, width: maxWidth });
  }, [visible, onScreen, shows, width, maxWidth]);

  if (phase === "gone") return null;
  if (phase === "pill") return <GlassPill view={view} waiting={waiting} here={here} />;
  const look = pictureLook(view, { path, frame });
  const still = view.still;
  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={openLabel(view.agent)}
        testID="glass-card"
        onPress={open}
        {...focusData(scheme)}
        style={(st) => [styles.card, st.pressed ? { backgroundColor: color.hover } : null]}
      >
        <View
          ref={frameRef}
          onLayout={onLayout}
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.frame, { backgroundColor: color.codeBg, borderColor: color.ruleStrong }]}
        >
          {still ? (
            <Image
              accessible={false}
              source={{ uri: `data:image/jpeg;base64,${still.image}` }}
              resizeMode="contain"
              style={[StyleSheet.absoluteFill, look.dim ? styles.dim : null]}
            />
          ) : null}
          {look.badge && phase === "card" ? (
            <View style={[styles.badge, { backgroundColor: color.panel, borderColor: color.ruleStrong }]}>
              <View style={[styles.badgeDot, { backgroundColor: color.focus }]} />
              <Text style={[type.metaStrong, { color: color.text }]}>{COPY.live}</Text>
            </View>
          ) : null}
        </View>
        <StepText line={line} />
        {line.why ? <Text numberOfLines={2} style={[type.meta, { color: color.text2 }]}>{line.why}</Text> : null}
        {look.note && phase === "card" ? <Text numberOfLines={1} style={[type.meta, { color: color.label }]}>{look.note}</Text> : null}
      </Pressable>
      <LiveLine text={said} />
    </View>
  );
}

/**
 * The Pill: no picture, 28 tall (pill.md's shape: `panel`, 1 px `ruleStrong`, fully round, padding
 * 0 12, gap 8) with the mark and the step line at 13 `text`. Its target is 44 tall.
 */
export function GlassPill({ view, waiting = null, here }: Omit<Props, "visible">) {
  const { color, scheme } = useTheme();
  const line = stepLine(view, Date.now(), waiting);
  const said = useAnnounce(line.text ? announceText(view.agent, line.text) : "");
  const open = useOpen(view, here);
  return (
    <View style={styles.pillWrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={openLabel(view.agent)}
        testID="glass-pill"
        onPress={open}
        hitSlop={(tokens.control.touch - tokens.control.xs) / 2}
        {...focusData(scheme)}
        style={(st) => [styles.pill, { backgroundColor: st.pressed ? color.hover : color.panel, borderColor: color.ruleStrong }]}
      >
        <StepText line={line} pill />
      </Pressable>
      <LiveLine text={said} />
    </View>
  );
}

const BADGE = 20;
const styles = StyleSheet.create({
  wrap: { width: "100%" },
  // The whole card is the target; it is far taller than 44.
  card: { gap: tokens.space[3], borderRadius: tokens.radius.field, minHeight: tokens.control.touch },
  frame: {
    width: "100%",
    aspectRatio: 16 / 10,
    borderRadius: tokens.radius.field,
    borderWidth: 1,
    overflow: "hidden",
  },
  dim: { opacity: 0.6 },
  badge: {
    position: "absolute",
    top: tokens.space[3],
    left: tokens.space[3],
    height: BADGE,
    paddingHorizontal: tokens.space[3],
    borderRadius: BADGE / 2,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space[2] + tokens.space[1],
  },
  badgeDot: { width: 6, height: 6, borderRadius: tokens.radius.full },
  line: { flexDirection: "row", alignItems: "center", gap: tokens.space[3], minWidth: 0 },
  lineText: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: tokens.space[2] },
  lineTextPill: { flex: 0, flexShrink: 1 },
  summary: { flexShrink: 1 },
  trail: { flexShrink: 0 },
  pillWrap: { alignSelf: "flex-start", maxWidth: "100%" },
  pill: {
    height: tokens.control.xs,
    paddingHorizontal: tokens.space[4],
    borderRadius: tokens.radius.full,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space[3],
    maxWidth: "100%",
  },
  hiddenText: { position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0.01 },
});
