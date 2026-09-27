import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { afterPaint, perf, sessionOpening } from "../../src/perf";
import { useTabDrawn } from "../../src/perf/tabs";
import { visibleNeeds } from "../../src/state/answers";
import { useGlassCards } from "../../src/state/glass";
import { answers } from "../../src/state/live";
import { age, canCommit, type Decision, type Need } from "../../src/state/needs-model";
import { useHidden, useNeeds, useNeedsFrom, useRefused } from "../../src/state/needs";
import { useTheme } from "../../src/theme/theme";
import { tokens } from "../../src/theme/tokens";
import { type } from "../../src/theme/type";
import { List } from "../../src/ui/List";
import { NotifyBar } from "../../src/ui/NotifyBar";
import { Row, ROW_HEIGHT } from "../../src/ui/Row";
import { GlassCard, useScreenFocused } from "../../src/ui/GlassMini";
import { Empty, Screen } from "../../src/ui/Screen";
import { SignInBar } from "../../src/ui/SignInBar";
import { StatusMark } from "../../src/ui/StatusMark";
import { SwipeRow } from "../../src/ui/SwipeRow";

/** Where tapping an item goes: an ask to its session, a Gate item to its detail. */
function useOpen() {
  const router = useRouter();
  return useCallback(
    (n: Need) => {
      if (n.source === "ask" && n.thread) {
        sessionOpening();
        router.push({ pathname: "/session/[id]", params: { id: n.thread, ask: n.ref } });
      } else router.push({ pathname: "/need/[id]", params: { id: n.id } });
    },
    [router],
  );
}

/** A minute clock for the ages, so rows do not re-render every second. */
function useMinute() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * open.cold: performance.timeOrigin to the first frame with Needs drawn (from the cache or the
 * box, whichever came first). open.warm: back to visible to the next frame with Needs drawn.
 */
function useOpenMarks(drawn: boolean) {
  const cold = useRef(false);
  useEffect(() => {
    if (!drawn || cold.current || !perf.on) return;
    cold.current = true;
    afterPaint((t) => perf.record("open.cold", t));
  }, [drawn]);
  useEffect(() => {
    if (!perf.on || Platform.OS !== "web" || typeof document === "undefined") return;
    const on = () => {
      if (document.visibilityState !== "visible") return;
      const t0 = perf.now();
      afterPaint((t) => perf.record("open.warm", t - t0));
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
}

function NeedRow({ n, now, reason, open }: { n: Need; now: number; reason: string | null; open: (n: Need) => void }) {
  const approve = canCommit(n, "approve");
  const reject = canCommit(n, "reject");
  const onSwipe = useCallback(
    (d: Decision) => {
      const ok = d === "approve" ? approve.ok : reject.ok;
      // Refused for presence or a question: never a silent failure, the item opens instead.
      if (!ok) {
        open(n);
        return false;
      }
      return answers.commit(n, d);
    },
    [n, approve.ok, reject.ok, open],
  );
  const meta = [n.agent, n.project].filter(Boolean).join(" · ") || (n.source === "gate" ? "Gate" : "Ask");
  return (
    <SwipeRow
      height={ROW_HEIGHT}
      onSwipe={onSwipe}
      approveLabel={approve.ok ? (n.source === "gate" && n.kind === "send" ? "Send" : "Approve") : "Open"}
      rejectLabel={reject.ok ? (n.source === "gate" ? "Discard" : "Deny") : "Open"}
      testID="now-row-swipe"
    >
      <Row
        avatar={n.agent ?? (n.source === "gate" ? "g" : "a")}
        title={n.title}
        age={age(n.at, now)}
        detail={n.error ? `Failed: ${n.error}` : n.detail}
        mono={n.mono && !n.error}
        meta={meta}
        status="needsYou"
        reason={reason}
        testID="now-row"
        onPress={() => {
          if (reason) answers.dismiss(n.id);
          open(n);
        }}
      />
    </SwipeRow>
  );
}

/**
 * The agents at work on their computers (glass-mini.md, the Card): Now lists no agents, so one card
 * per acting agent sits in a small section after the waiting rows, at the screen width less 32.
 */
function GlassSection({ list }: { list: readonly Need[] }) {
  const cards = useGlassCards();
  const focused = useScreenFocused();
  if (!cards.length) return null;
  const waitingFor = (agent: string) => list.find((n) => n.agent === agent)?.title ?? null;
  return (
    <View style={styles.glass}>
      {cards.map((v) => (
        <GlassCard key={v.target} view={v} waiting={waitingFor(v.agent)} visible={focused} />
      ))}
    </View>
  );
}

export default function Now() {
  const { color } = useTheme();
  const items = useNeeds();
  const from = useNeedsFrom();
  const hidden = useHidden();
  const refused = useRefused();
  const now = useMinute();
  const open = useOpen();
  useTabDrawn();
  const list = useMemo(() => visibleNeeds(items, hidden), [items, hidden]);
  const glass = useGlassCards().length > 0;
  useOpenMarks(from !== "none");

  const header = (
    <View style={styles.section}>
      {list.length ? <StatusMark status="needsYou" hidden /> : null}
      <Text style={[type.readStrong, { color: color.text }]}>Needs you</Text>
      <Text style={[type.meta, styles.count, { color: color.label }]}>{list.length ? `${list.length} · oldest first` : ""}</Text>
    </View>
  );
  return (
    <Screen title="Now">
      <SignInBar />
      <NotifyBar />
      {header}
      {list.length === 0 && glass ? (
        <ScrollView style={styles.fill}>
          <Text style={[type.read, styles.quiet, { color: color.label }]}>{from === "none" ? " " : "Nothing needs you"}</Text>
          <GlassSection list={list} />
        </ScrollView>
      ) : list.length === 0 ? (
        <Empty text={from === "none" ? " " : "Nothing needs you"} />
      ) : (
        <List
          items={list}
          keyOf={(n) => n.id}
          rowHeight={ROW_HEIGHT}
          render={(n) => <NeedRow n={n} now={now} reason={refused.get(n.id) ?? null} open={open} />}
          footer={
            <>
              <Text style={[type.meta, styles.hint, { color: color.label }]}>Swipe right to approve, left to deny.</Text>
              <GlassSection list={list} />
            </>
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space[3],
    paddingHorizontal: tokens.layout.gutterPhone,
    paddingTop: tokens.space[4],
    paddingBottom: tokens.space[3],
  },
  count: { marginLeft: "auto" },
  hint: { paddingHorizontal: tokens.layout.gutterPhone, paddingVertical: tokens.space[4] },
  fill: { flex: 1 },
  quiet: { paddingHorizontal: tokens.layout.gutterPhone, paddingVertical: tokens.space[5] },
  // Outside any card, the screen width less 32; a gap of 24 between computers.
  glass: { paddingHorizontal: tokens.layout.gutterPhone, paddingTop: tokens.space[4], paddingBottom: tokens.space[6], gap: tokens.space[6] },
});
