import { useState } from "react";
import { View } from "react-native";
import { Banner, Card, Divider, Icon, PressableScale, Row, SpaceTag, Text, useUiTheme } from "@vyre/ui";
import type { SwipeSet } from "@vyre/ui";
import { aid } from "../../src/store-core/kernel-view.js";
import { ActorMark } from "../../ui/tasks/ActorMark";
import { DoingList, NeedsList } from "../../ui/tasks/NowView";
import { nameOf, nowModel, recordTitle, spaceTag, who, type World } from "../../ui/tasks/model";
import { useNowScope } from "../../ui/tasks/scope";
import { useSnoozed } from "../../src/state/snooze";
import { HomeSection } from "./HomeSection";

/** How many Needs you cards show before "N more waiting": three on a wide screen, two on a phone. */
const SHOW = { wide: 3, phone: 2 };
const RUNNING = 5;

type Act = (task: any, id: string, input?: string, extra?: unknown) => void | Promise<void>;

/** A text row that opens more: "4 more waiting", "Show fewer". */
function MoreRow({ label, onPress, up }: { label: string; onPress: () => void; up?: boolean }) {
  return (
    <PressableScale depth={0.985} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", paddingHorizontal: 4 }}>
      <Text medium tone="muted" style={{ fontSize: 15, lineHeight: 20 }}>{label}</Text>
      <Icon name={up ? "chevron-up" : "chevron-down"} size={16} tone="text-2" />
    </PressableScale>
  );
}

/**
 * Needs you and Doing, only when they have something. Three cards show before the rest fold open here.
 * What finished today is a quiet line under Doing. Empty days draw neither section.
 */
export function HomeWork({ world, notice, onAction, onOpen, openDone = false }: {
  world: World;
  notice?: string | null;
  onAction: Act;
  onOpen: (task: any) => void;
  /** A picture starts with what finished today open. */
  openDone?: boolean;
}) {
  const { scope } = useNowScope(world);
  const [moreNeeds, setMoreNeeds] = useState(false);
  const [moreDoing, setMoreDoing] = useState(false);
  const [doneOpen, setDoneOpen] = useState(openDone);
  const { phone } = useUiTheme();
  const later = useSnoozed(world.now);
  const m = nowModel(world, scope, later);
  const showSpace = scope === "all";
  const openSwipe = (t: any): SwipeSet => ({ trailing: [{ id: "open", label: "Open", icon: "chev-r", tone: "plain", haptic: "selection", onPress: () => onOpen(t) }] });
  const limit = phone ? SHOW.phone : SHOW.wide;
  const hidden = m.needs.length - limit;
  const needsShown = moreNeeds ? m.needs : m.needs.slice(0, limit);
  const runningShown = moreDoing ? m.working : m.working.slice(0, RUNNING);
  if (!notice && !m.needs.length && !m.working.length && !m.doneToday.length) return null;
  return (
    <View className="gap-s6">
      {notice ? <Banner>{notice}</Banner> : null}
      {m.needs.length ? (
        <HomeSection title="Needs you" count={m.needs.length}>
          <View className="gap-s2">
            <NeedsList world={world} list={needsShown} showSpace={showSpace} onAction={onAction} onOpen={onOpen} hero={phone ? limit : 1} />
            {hidden > 0 ? <MoreRow label={moreNeeds ? "Show fewer" : `${hidden} more waiting`} up={moreNeeds} onPress={() => setMoreNeeds(!moreNeeds)} /> : null}
          </View>
        </HomeSection>
      ) : null}
      {m.working.length || m.doneToday.length ? (
        <HomeSection title="Doing" count={m.working.length || m.doneToday.length}>
          {m.working.length ? (
            <View className="gap-s2">
              <DoingList world={world} list={runningShown} onOpen={onOpen} swipe={openSwipe} />
              {m.working.length > RUNNING ? <MoreRow label={moreDoing ? "Show fewer" : `${m.working.length - RUNNING} more running`} up={moreDoing} onPress={() => setMoreDoing(!moreDoing)} /> : null}
            </View>
          ) : null}
          {m.doneToday.length ? (
            <View className="min-w-0 gap-s2">
              <PressableScale depth={0.985} accessibilityRole="button" accessibilityState={{ expanded: doneOpen }} onPress={() => setDoneOpen(!doneOpen)} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", paddingHorizontal: 4 }}>
                <Text tone="muted" medium style={{ fontSize: 15, lineHeight: 20 }}>{`${m.doneToday.length} done today`}</Text>
                <Icon name={doneOpen ? "chevron-up" : "chevron-down"} size={16} tone="label" />
              </PressableScale>
              {doneOpen ? (
                <Card flush>
                  {m.doneToday.map((t, i) => (
                    <View key={t.id}>
                      {i > 0 ? <Divider inset={60} /> : null}
                      <Row lead={<ActorMark who={who(world, aid(t.doer))} />} title={t.title} sub={`${nameOf(world, aid(t.doer))} · ${recordTitle(world, world.records.get(t.record))}`} end={<>{spaceTag(world, t.space) ? <SpaceTag text={spaceTag(world, t.space)} /> : null}<Icon name="check" size={16} tone="ok" /></>} onPress={() => onOpen(t)} swipe={openSwipe(t)} />
                    </View>
                  ))}
                </Card>
              ) : null}
            </View>
          ) : null}
        </HomeSection>
      ) : null}
    </View>
  );
}
