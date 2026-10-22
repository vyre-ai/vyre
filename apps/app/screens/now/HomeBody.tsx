import { useMemo } from "react";
import { View } from "react-native";
import { Text } from "@vyre/ui";
import { nowModel, type World } from "../../ui/tasks/model";
import { useNowScope } from "../../ui/tasks/scope";
import { useSnoozed } from "../../src/state/snooze";
import { rangeOf } from "../calendar/logic.js";
import { isQuietDay, QUIET_LINE } from "./home-model.js";
import { HomeWork } from "./HomeWork";
import { HomeToday, type Dated } from "./HomeToday";
import { HomeTasks } from "./HomeTasks";
import { HomeRecent } from "./HomeRecent";

/** Needs you, Doing, Today, the task field and Recent. A quiet day is one line plus the task field. */
export function HomeBody({ world, items, notice, onAction, onOpen, openDone }: {
  world: World;
  items: Dated[];
  notice?: string | null;
  onAction: (task: any, id: string, input?: string, extra?: unknown) => void | Promise<void>;
  onOpen: (task: any) => void;
  /** A picture starts with what finished today open. */
  openDone?: boolean;
}) {
  const { scope } = useNowScope(world);
  const later = useSnoozed(world.now);
  const m = nowModel(world, scope, later);
  const today = useMemo(() => {
    const { from, to } = rangeOf("week", new Date(world.now));
    return items.filter((e) => e.at >= from.getTime() && e.at < to.getTime()).length;
  }, [items, world.now]);
  const quiet = isQuietDay({ needs: m.needs.length, doing: m.working.length + m.doneToday.length, today, recent: m.recent.length });
  return (
    <View className="gap-s6">
      <HomeWork world={world} notice={notice} onAction={onAction} onOpen={onOpen} openDone={openDone} />
      {quiet ? <Text tone="muted">{QUIET_LINE}</Text> : null}
      <HomeToday items={items} now={world.now} />
      <HomeTasks />
      <HomeRecent world={world} />
    </View>
  );
}
