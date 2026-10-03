import { useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { Banner } from "../components/Banner";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { EmptyState } from "../components/States";
import { FilterPills } from "../components/FilterPills";
import { Row } from "../components/Row";
import { Text } from "../components/Text";
import { ActorMark } from "./ActorMark";
import { Section } from "./Section";
import { TaskCard } from "./TaskCard";
import { nowModel, nameOf, recordTitle, spaceName, whenLabel, workingLine, who, type World } from "./model";
import { aid } from "../../../../deck/ui/kernel-view.js";

const WIDE = 1000;

/**
 * Now: a view over tasks (DESIGN-tasks.md). The greeting, scope pills, then what needs you (a card each), what is being worked on, what finished today, today's
 * calendar (when the store has one) and recent events. From 1000 px the calendar and recent sit in a side column; a phone gets one column in the same order.
 */
export function NowView({ world, onAction, onOpen, notice }: { world: World; onAction: (task: any, id: string, input?: string) => void; onOpen: (task: any) => void; notice?: string | null }) {
  const [scope, setScope] = useState("all");
  const { width } = useWindowDimensions();
  const m = nowModel(world, scope);
  const showSpace = scope === "all";
  const spaceOf = (t: any) => (showSpace ? <Chip tone="space">{spaceName(world, t.space)}</Chip> : null);

  const needs = (
    <Section title="Needs you" count={m.needs.length}>
      {m.needs.length ? <View className="gap-s3">{m.needs.map((t) => <TaskCard key={t.id} world={world} task={t} showSpace={showSpace} onAction={(id, input) => onAction(t, id, input)} onOpen={() => onOpen(t)} />)}</View>
        : <Card><EmptyState title="Nothing needs you" body="Tasks that wait on you show up here." /></Card>}
    </Section>
  );
  const doing = (
    <Section title="Doing now">
      {m.working.length ? (
        <Card flush>
          {m.working.map((t, i) => (
            <View key={t.id}>
              {i > 0 ? <Divider /> : null}
              <Row lead={<ActorMark who={who(world, aid(t.doer))} />} title={recordTitle(world, world.records.get(t.record))} sub={workingLine(world, t)} end={spaceOf(t)} onPress={() => onOpen(t)} />
            </View>
          ))}
        </Card>
      ) : <Text tone="label">Nobody is working right now.</Text>}
    </Section>
  );
  const done = m.doneToday.length ? (
    <Section title="Done today" count={m.doneToday.length}>
      <Card flush>
        {m.doneToday.map((t, i) => (
          <View key={t.id}>
            {i > 0 ? <Divider /> : null}
            <Row lead={<ActorMark who={who(world, aid(t.doer))} />} title={t.title} sub={`${nameOf(world, aid(t.doer))} · ${recordTitle(world, world.records.get(t.record))}`} end={<Chip tone="ok">Done</Chip>} onPress={() => onOpen(t)} />
          </View>
        ))}
      </Card>
    </Section>
  ) : null;
  const calendar = world.calendar.length ? (
    <Section title="Today's calendar">
      <Card>
        <View className="gap-s3">
          {m.calendar.map((e: any) => (
            <View key={e.id} className="flex-row gap-s3">
              <Text mono tone="label" className="flex-none">{whenLabel(e.at, world.now)}</Text>
              <View className="min-w-0 flex-1"><Text strong>{e.title}</Text>{e.sub ? <Text size="caption" tone="label">{e.sub}</Text> : null}</View>
            </View>
          ))}
        </View>
      </Card>
    </Section>
  ) : null;
  const recent = (
    <Section title="Recent">
      {m.recent.length ? (
        <View>
          {m.recent.map((e) => {
            const a = who(world, e.actor);
            const name = e.actor === world.me ? "You" : a?.family === "person" ? a.name.split(" ")[0] : a?.name || "Vyre";
            return (
              <View key={e.id} className="min-h-row flex-row items-center gap-s3 py-s1">
                <ActorMark who={a} size="sm" />
                <Text className="min-w-0 flex-1" numberOfLines={1}>{`${name} ${e.what}`}</Text>
                <Text size="caption" tone="label">{whenLabel(e.at, world.now)}</Text>
              </View>
            );
          })}
        </View>
      ) : <Text tone="label">Nothing has happened yet.</Text>}
    </Section>
  );

  const main = <View className="min-w-0 flex-1 gap-s5">{needs}{doing}{done}</View>;
  const side = <View className="min-w-0 gap-s5">{calendar}{recent}</View>;
  return (
    <View className="gap-s4">
      <View className="flex-row items-start gap-s3">
        <View className="min-w-0 flex-1 gap-s1">
          <Text size="page" strong>{m.greeting}</Text>
          <Text size="caption" tone="label">{m.meta}</Text>
        </View>
        <View className="flex-row">{m.faces.map((id) => <ActorMark key={id} who={who(world, id)} size="sm" />)}</View>
      </View>
      <FilterPills label="Spaces" value={scope} onChange={setScope} options={[["all", "All spaces"], ...world.spaces.map((s: any) => [s.id, s.name] as [string, string])]} />
      {notice ? <Banner>{notice}</Banner> : null}
      {width >= WIDE ? <View className="flex-row items-start gap-s6"><View className="min-w-0 flex-[3]">{main}</View><View className="min-w-0 flex-[2]">{side}</View></View> : <View className="gap-s5">{main}{side}</View>}
    </View>
  );
}
