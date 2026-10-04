import { useState } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import { Avatar, AvatarStack, type AvatarRef } from "../components/Avatar";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { Card, Divider } from "../components/Card";
import { Icon } from "../components/Icon";
import { Row } from "../components/Row";
import { Segmented } from "../components/Segmented";
import { Text } from "../components/Text";
import { ActorMark } from "./ActorMark";
import { Section } from "./Section";
import { TaskCard } from "./TaskCard";
import { useNowScope } from "./scope";
import { nameOf, nextEvent, nowModel, recordTitle, whenLabel, workingLine, who, type World } from "./model";
import { Stagger } from "../motion/Appear";
import { Pulse } from "../motion/Pulse";
import { PressableScale } from "../motion/PressableScale";
import type { SwipeSet } from "../motion/SwipeActions";
import { useUiTheme } from "../theme";
import { aid } from "../../../../deck/ui/kernel-view.js";

const WIDE = 1000;
/** How many Needs you cards show before "N more waiting": three on a wide screen, two (both hero cards) on a phone. */
const SHOW = { wide: 3, phone: 2 };
const RUNNING = 5;

type Props = { world: World; onAction: (task: any, id: string, input?: string) => void; onOpen: (task: any) => void };

/** The project emblem a record shows as, at any size. */
export const emblemOf = (world: World, rec: any): AvatarRef => ({ kind: "project", id: rec?.id ?? "", name: recordTitle(world, rec), seed: rec?.data?.avatar_seed });

/** An accent text row that opens more: "4 more waiting", "Show fewer". */
function MoreRow({ label, onPress, up }: { label: string; onPress: () => void; up?: boolean }) {
  return (
    <PressableScale depth={0.985} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", paddingHorizontal: 4 }}>
      <Text medium tone="accent" style={{ fontSize: 15, lineHeight: 20 }}>{label}</Text>
      <Icon name={up ? "chevron-up" : "chevron-down"} size={16} tone="accent" />
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
      end={<><Pulse active><View className="rounded-full bg-ok" style={{ width: 6, height: 6 }} /></Pulse>{rec ? <Avatar of={emblemOf(world, rec)} size={20} /> : null}</>}
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

/** What waits on the person, from the `from`th card on, as standard cards (the page "N more waiting" pushes shows these). */
export function NeedsList({ world, list, showSpace, onAction, onOpen, hero = 0 }: Props & { list: any[]; showSpace: boolean; hero?: number }) {
  return (
    <View className="gap-s3">
      <Stagger>{list.map((t, i) => <TaskCard key={t.id} world={world} task={t} showSpace={showSpace} hero={i < hero} onAction={(id, input) => onAction(t, id, input)} onOpen={() => onOpen(t)} />)}</Stagger>
    </View>
  );
}

/**
 * Now: a view over tasks (DESIGN-tasks.md). The greeting and one scope control, then what needs you (the first card is the hero: a step up, the one to do first;
 * three show, the rest fold under "N more waiting"), what is being worked on (one grouped card), what finished today (one quiet line) and, in the side column,
 * today's calendar and recent events. A phone is one short column: the next event as a strip, two hero cards, "5 more waiting" and "9 running" each push a page,
 * and Recent lives in Chat.
 */
export function NowView({ world, onAction, onOpen, onEdit, onMore, notice }: Props & { onEdit?: () => void; onMore?: (kind: "needs" | "doing") => void; notice?: string | null }) {
  const { scope, setScope } = useNowScope();
  const [moreNeeds, setMoreNeeds] = useState(false);
  const [moreDoing, setMoreDoing] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const { width } = useWindowDimensions();
  const { phone } = useUiTheme();
  const m = nowModel(world, scope);
  const wide = width >= WIDE;
  const showSpace = scope === "all";
  const openSwipe = (t: any): SwipeSet => ({ trailing: [{ id: "open", label: "Open", icon: "chev-r", tone: "plain", haptic: "selection", onPress: () => onOpen(t) }] });

  const next = nextEvent(m.calendar, world.now);
  const limit = phone ? SHOW.phone : SHOW.wide;
  const hidden = m.needs.length - limit;
  const needsShown = !phone && moreNeeds ? m.needs : m.needs.slice(0, limit);
  const needs = (
    <Section first={wide || (phone && !next)} title="Needs you" count={m.needs.length}>
      {m.needs.length ? (
        <View className="gap-s3">
          <NeedsList world={world} list={needsShown} showSpace={showSpace} onAction={onAction} onOpen={onOpen} hero={phone ? limit : 1} />
          {hidden > 0 ? (phone
            ? <MoreRow label={`${hidden} more waiting`} onPress={() => onMore?.("needs")} />
            : <MoreRow label={moreNeeds ? "Show fewer" : `${hidden} more waiting`} up={moreNeeds} onPress={() => setMoreNeeds(!moreNeeds)} />) : null}
        </View>
      ) : <Card><Row dense lead={<Icon name="check" size={20} tone="ok" />} title="Nothing needs you" sub="Tasks that wait on you show up here." /></Card>}
    </Section>
  );

  const doers = [...new Map(m.working.map((t) => { const a = who(world, aid(t.doer)); return [aid(t.doer), { kind: (a?.family === "assistant" ? "assistant" : a?.family === "teammate" ? "teammate" : a?.family === "service" ? "agent" : "person") as AvatarRef["kind"], id: aid(t.doer), name: a?.name || aid(t.doer), seed: a?.seed }] as const; })).values()];
  const runningShown = moreDoing ? m.working : m.working.slice(0, RUNNING);
  const doing = (
    <Section title="Doing now">
      {!m.working.length ? <Text tone="label">Nobody is working right now.</Text>
        : phone ? (
          <Card flush>
            <Row lead={<AvatarStack of={doers} size={28} max={4} />} title={`${m.working.length} running`} end={<Icon name="chevron" size={16} tone="faint" />} onPress={() => onMore?.("doing")} />
          </Card>
        ) : (
          <View className="gap-s2">
            <DoingList world={world} list={runningShown} onOpen={onOpen} swipe={openSwipe} />
            {m.working.length > RUNNING ? <MoreRow label={moreDoing ? "Show fewer" : `${m.working.length - RUNNING} more running`} up={moreDoing} onPress={() => setMoreDoing(!moreDoing)} /> : null}
          </View>
        )}
    </Section>
  );

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
              <Row lead={<ActorMark who={who(world, aid(t.doer))} />} title={t.title} sub={`${nameOf(world, aid(t.doer))} · ${recordTitle(world, world.records.get(t.record))}`} end={<Icon name="check" size={16} tone="ok" />} onPress={() => onOpen(t)} swipe={openSwipe(t)} />
            </View>
          ))}
        </Card>
      ) : null}
    </View>
  ) : null;

  const calendarWide = m.calendar.length ? (
    <Section first title="Today">
      <Card>
        <View className="gap-s4">
          {m.calendar.map((e: any) => (
            <View key={e.id} className="flex-row gap-s3">
              <Text mono tone="label" className="flex-none" style={{ minWidth: 40 }}>{whenLabel(e.at, world.now)}</Text>
              <View className="min-w-0 flex-1"><Text medium style={{ fontSize: 15, lineHeight: 20 }}>{e.title}</Text>{e.sub ? <Text size="secondary" tone="label">{e.sub}</Text> : null}</View>
            </View>
          ))}
        </View>
      </Card>
    </Section>
  ) : null;
  const contact = next ? [...world.records.values()].find((r: any) => r.type === "contact" && next.title.includes(recordTitle(world, r))) : null;
  const withName = next && / with (.+)$/.exec(next.title)?.[1];
  const calendarPhone = next ? (
    <Card className="justify-center" style={{ minHeight: 56, paddingVertical: 0 }}>
      <View className="flex-row items-center gap-s3" style={{ minHeight: 56 }}>
        {contact ? <Avatar of={{ kind: "person", id: contact.id, name: recordTitle(world, contact) }} size={32} /> : withName ? <Avatar of={{ kind: "person", id: withName, name: withName }} size={32} /> : null}
        <Text numberOfLines={1} className="min-w-0 flex-1"><Text tone="label">Next </Text><Text mono tone="label">{whenLabel(next.at, world.now)}</Text><Text strong>{`  ${next.title}`}</Text></Text>
      </View>
    </Card>
  ) : null;

  const recent = (
    <Section title="Recent">
      {m.recent.length ? (
        <View>
          {m.recent.map((e) => {
            const a = who(world, e.actor);
            const name = e.actor === world.me ? "You" : a?.family === "person" ? a.name.split(" ")[0] : a?.name || "Vyre";
            return (
              <View key={e.id} className="min-h-control flex-row items-center gap-s3 py-s1">
                <ActorMark who={a} size="sm" />
                <Text size="secondary" className="min-w-0 flex-1" numberOfLines={1}>{`${name} ${e.what}`}</Text>
                <Text mono size="caption" tone="faint">{whenLabel(e.at, world.now)}</Text>
              </View>
            );
          })}
        </View>
      ) : <Text tone="label">Nothing has happened yet.</Text>}
    </Section>
  );

  return (
    <View className="gap-s4">
      <View className="flex-row items-start gap-s3">
        <View className="min-w-0 flex-1 gap-s1">
          <Text size="page" strong numberOfLines={1}>{m.greeting}</Text>
          <Text size="caption" tone="label" numberOfLines={1}>{m.meta}</Text>
        </View>
        {!phone && onEdit ? <Button kind="ghost" size="sm" label="Edit Now" onPress={onEdit} /> : null}
      </View>
      <Segmented fill={phone} label="Spaces" value={scope} onChange={setScope} options={[["all", "All spaces"], ...world.spaces.map((s: any) => [s.id, s.name] as [string, string])]} />
      {notice ? <Banner>{notice}</Banner> : null}
      {wide ? (
        <View className="flex-row items-start gap-s8">
          <View className="min-w-0 flex-1 gap-s2">{needs}{doing}{done}</View>
          <View className="w-side gap-s2">{calendarWide}{recent}</View>
        </View>
      ) : (
        <View className="gap-s2">{phone ? calendarPhone : calendarWide}{needs}{doing}{done}{phone ? null : recent}</View>
      )}
    </View>
  );
}

