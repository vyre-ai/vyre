import { useEffect, useRef, useState } from "react";
import { Animated, Easing } from "react-native";
import { View } from "react-native";
import { Avatar, type AvatarRef } from "../components/Avatar";

import { Banner } from "../components/Banner";
import { Card, Divider } from "../components/Card";
import { Icon } from "../components/Icon";
import { Row } from "../components/Row";
import { Text } from "../components/Text";
import { ActorMark } from "./ActorMark";
import { Section } from "./Section";
import { TaskCard } from "./TaskCard";
import { useNowScope } from "./scope";
import { groupAsks, groupKeyOf } from "./ask-model.js";
import { useSnoozed } from "../../src/state/snooze";
import { nameOf, nowModel, recordTitle, spaceTag, workingLine, who, type World } from "./model";
import { SpaceTag } from "../components/SpaceTag";
import { Stagger } from "../motion/Appear";
import { Pulse } from "../motion/Pulse";
import { PressableScale } from "../motion/PressableScale";
import type { SwipeSet } from "../motion/SwipeActions";
import { useUiTheme } from "../theme";
import { aid } from "../../src/store-core/kernel-view.js";

/** How many Needs you cards show before "N more waiting": three on a wide screen, two (both hero cards) on a phone. */
const SHOW = { wide: 3, phone: 2 };
const RUNNING = 5;

type Props = { world: World; onAction: (task: any, id: string, input?: string, extra?: unknown) => void | Promise<void>; onOpen: (task: any) => void };

/** The project emblem a record shows as, at any size. */
export const emblemOf = (world: World, rec: any): AvatarRef => ({ kind: "project", id: rec?.id ?? "", name: recordTitle(world, rec), seed: rec?.data?.avatar_seed });

/** A text row that opens more: "4 more waiting", "Show fewer". */
function MoreRow({ label, onPress, up }: { label: string; onPress: () => void; up?: boolean }) {
  return (
    <PressableScale depth={0.985} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", paddingHorizontal: 4 }}>
      <Text medium tone="muted" style={{ fontSize: 15, lineHeight: 20 }}>{label}</Text>
      <Icon name={up ? "chevron-up" : "chevron-down"} size={16} tone="text-2" />
    </PressableScale>
  );
}

/** One running task as a row: the assistant doing it, what it is doing, a pulsing dot and the project's emblem. */
export function DoingRow({ world, t, onOpen, swipe }: { world: World; t: any; onOpen: () => void; swipe?: SwipeSet }) {
  const rec = world.records.get(t.record);
  return (
    <Row
      lead={<ActorMark who={who(world, aid(t.doer))} />}
      title={recordTitle(world, rec)}
      sub={workingLine(world, t)}
      end={<>{spaceTag(world, t.space) ? <SpaceTag text={spaceTag(world, t.space)} /> : null}<Pulse active><View className="rounded-full bg-ok" style={{ width: 6, height: 6 }} /></Pulse>{rec ? <Avatar of={emblemOf(world, rec)} size={20} /> : null}</>}
      onPress={onOpen}
      swipe={swipe}
    />
  );
}

/** A grouped card of running tasks. */
export function DoingList({ world, list, onOpen, swipe }: { world: World; list: any[]; onOpen: (t: any) => void; swipe?: (t: any) => SwipeSet }) {
  return (
    <Card flush>
      {list.map((t, i) => (
        <View key={t.id}>
          {i > 0 ? <Divider inset={60} /> : null}
          <DoingRow world={world} t={t} onOpen={() => onOpen(t)} swipe={swipe?.(t)} />
        </View>
      ))}
    </Card>
  );
}

/** A card that has been answered: it fades and folds away in a fifth of a second, then it is gone. */
function Leaving({ children, onDone }: { children: React.ReactNode; onDone: () => void }) {
  const t = useRef(new Animated.Value(1)).current;
  const [h, setH] = useState<number | null>(null);
  useEffect(() => {
    if (h === null) return;
    Animated.timing(t, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start(onDone);
  }, [h]);
  return (
    <Animated.View pointerEvents="none" style={{ opacity: t, overflow: "hidden", ...(h === null ? null : { height: t.interpolate({ inputRange: [0, 1], outputRange: [0, h] }) }) }}>
      <View onLayout={(e) => { if (h === null) setH(e.nativeEvent.layout.height); }}>{children}</View>
    </Animated.View>
  );
}

/** Four or more asks from one project or Flow fold into one row that opens to show them. */
function AskGroup({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-s3">
      <Card>
        <Row dense title={title} sub={`${count} things wait on you here`} end={<Icon name={open ? "chev-d" : "chev-r"} size={16} tone="muted" />} onPress={() => setOpen(!open)} />
      </Card>
      {open ? <View className="gap-s3">{children}</View> : null}
    </View>
  );
}

/** What waits on the person, from the `from`th card on, as standard cards (the page "N more waiting" pushes shows these). */
export function NeedsList({ world, list, showSpace, onAction, onOpen, hero = 0 }: Props & { list: any[]; showSpace: boolean; hero?: number }) {
  // A card the list just lost was answered: keep drawing it for the length of its fade, in the place it was.
  const prev = useRef<any[]>([]);
  const [gone, setGone] = useState<{ task: any; at: number }[]>([]);
  useEffect(() => {
    const ids = new Set(list.map((t) => t.id));
    const left = prev.current.map((t, at) => ({ task: t, at })).filter((x) => !ids.has(x.task.id));
    prev.current = list;
    if (left.length) setGone((g) => [...g, ...left.filter((x) => !g.some((y) => y.task.id === x.task.id))]);
  }, [list]);
  const card = (t: any, i: number) => <TaskCard key={t.id} world={world} task={t} showSpace={showSpace} hero={i < hero} onAction={(id, input, extra) => onAction(t, id, input, extra)} onOpen={() => onOpen(t)} />;
  const keyName = (k: string) => {
    if (k.startsWith("flow:")) return `Flow ${k.slice(5)}`;
    const rec = [...world.records.values()].find((r: any) => r.id === k.slice(8));
    return rec ? recordTitle(world, rec) : "One project";
  };
  const rows = groupAsks(list, groupKeyOf);
  const out: React.ReactNode[] = [];
  let n = 0;
  for (const r of rows) {
    if (r.group) out.push(<AskGroup key={r.key} title={keyName(r.key)} count={r.items.length}>{r.items.map((t) => card(t, 99))}</AskGroup>);
    else out.push(card(r.item, n++));
  }
  for (const g of gone) out.splice(Math.min(g.at, out.length), 0, <Leaving key={`gone-${g.task.id}`} onDone={() => setGone((x) => x.filter((y) => y.task.id !== g.task.id))}>{card(g.task, 99)}</Leaving>);
  return (
    <View className="gap-s3">
      <Stagger>{out}</Stagger>
    </View>
  );
}

/**
 * Needs you and Doing on Home. Three cards show before the rest fold open here. What finished today is a quiet line under Doing.
 * Today, Tasks and Recent are the sections that follow this one.
 */
export function NowView({ world, onAction, onOpen, notice }: Props & { notice?: string | null }) {
  const { scope } = useNowScope(world);
  const [moreNeeds, setMoreNeeds] = useState(false);
  const [moreDoing, setMoreDoing] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const { phone } = useUiTheme();
  const later = useSnoozed(world.now);
  const m = nowModel(world, scope, later);
  const showSpace = scope === "all";
  const openSwipe = (t: any): SwipeSet => ({ trailing: [{ id: "open", label: "Open", icon: "chev-r", tone: "plain", haptic: "selection", onPress: () => onOpen(t) }] });

  const limit = phone ? SHOW.phone : SHOW.wide;
  const hidden = m.needs.length - limit;
  const needsShown = moreNeeds ? m.needs : m.needs.slice(0, limit);
  const needs = (
    <Section first title="Needs you" count={m.needs.length}>
      {m.needs.length ? (
        <View className="gap-s3">
          <NeedsList world={world} list={needsShown} showSpace={showSpace} onAction={onAction} onOpen={onOpen} hero={phone ? limit : 1} />
          {hidden > 0 ? <MoreRow label={moreNeeds ? "Show fewer" : `${hidden} more waiting`} up={moreNeeds} onPress={() => setMoreNeeds(!moreNeeds)} /> : null}
        </View>
      ) : <Card><Row dense lead={<Icon name="check" size={20} tone="ok" />} title="Nothing needs you" sub="Tasks that wait on you show up here." /></Card>}
    </Section>
  );

  const runningShown = moreDoing ? m.working : m.working.slice(0, RUNNING);
  const done = m.doneToday.length ? (
    <View className="min-w-0 gap-s2 pt-s6">
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
  ) : null;
  const doing = (
    <Section title="Doing">
      {!m.working.length ? <Text tone="label">Nobody is working right now.</Text> : (
        <View className="gap-s2">
          <DoingList world={world} list={runningShown} onOpen={onOpen} swipe={openSwipe} />
          {m.working.length > RUNNING ? <MoreRow label={moreDoing ? "Show fewer" : `${m.working.length - RUNNING} more running`} up={moreDoing} onPress={() => setMoreDoing(!moreDoing)} /> : null}
        </View>
      )}
      {done}
    </Section>
  );

  return (
    <View className="gap-s4">
      {/* The greeting, the date and what needs the person are Home's one header (screens/now/HomeHeader.tsx), not repeated here. Today, Tasks and Recent follow this block. */}
      {notice ? <Banner>{notice}</Banner> : null}
      <View className="gap-s2">{needs}{doing}</View>
    </View>
  );
}

