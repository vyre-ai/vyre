import { useLocalSearchParams, useRouter } from "expo-router";
import { collect, rangeOf } from "../calendar/logic.js";
import { HomeBody } from "./HomeBody";
import { type Dated } from "./HomeToday";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useMembers } from "../spaces/state";
import { PhoneApprovals } from "../shell/PhoneApprovals";
import { actFrom } from "../../src/real/notice-act.js";
import { ModuleNowCards } from "../modules/ModuleNowCards";
import { GapNotice, WaitingOnYou } from "./WaitingOnYou";
import { UpdateNotice } from "./UpdateNotice";
import { AwayCard } from "./AwayCard";
import { SignInAgain } from "./SignInAgain";
import { VaultHealthCard } from "./VaultHealthCard";
import { useSpaces } from "../shell/state";
import { CreateAssistantCard } from "../assistants/CreateAssistantCard";
import { createCardSource } from "../assistants/create-card-source";
import { type AgentRow } from "../assistants/create-card-model";
import { callT } from "../../src/real/call-tool";
import { loadSnoozed } from "../../src/state/snooze";
import { useGap, useSetupBanner } from "../../src/state/setup-gap";
import { RecordsSetup } from "./RecordsSetup";
import { HomeHeader } from "./HomeHeader";
import { useHomeName, useHomeWorld } from "./home-world";
import { HomeComposer } from "./AskDock";
import { HomeColumn } from "./HomeSection";
import { SETUP_BANNER } from "../install/first-run.js";
import { Button, ErrorState, allowsMock, useRecordsWorld, LargeTitleScreen, LoadingState, usePlayScenario, useTaskActions, useWorld } from "@vyre/ui";

/** /u/now: Home. Pull to refresh on a phone; the title collapses into the bar as it scrolls. `?scenario=client-pays` plays "a client pays" on a fresh mock store and ends with the Welcome email waiting for one tap. */
export default function NowScreen() {
  const router = useRouter();
  const { scenario, scroll, act, card } = useLocalSearchParams<{ scenario?: string; scroll?: string; act?: string; card?: string }>();
  const want = useMemo(() => actFrom({ act, card }), [act, card]);
  const play = usePlayScenario(scenario);
  const q = useWorld(play.epoch);
  // On a real vyred today's items are every dated record (screens/calendar/logic.js), not the store's own calendar; the sample world keeps its sample day.
  const real = !allowsMock();
  const rw = useRecordsWorld();
  const dated = useMemo(() => (real && rw.data && q.data ? collect(rw.data.types, rw.data.byType).map((i: any): Dated => ({ id: `${i.urn}/${i.field}`, at: i.start.getTime(), title: i.title, sub: i.event ? i.typeLabel : `${i.typeLabel}: ${i.fieldLabel}` })) : null), [real, rw.data, q.data]);
  const calendar = useMemo(() => {
    if (!dated || !q.data) return null;
    const { from, to } = rangeOf("day", new Date(q.data.now));
    return dated.filter((e) => e.at >= from.getTime() && e.at < to.getTime()).map((e) => ({ ...e, record: "" }));
  }, [dated, q.data]);
  const fresh = useMemo(() => (q.data && calendar ? { ...q.data, calendar } : q.data), [q.data, calendar]);
  // The last good world for this Space draws at once and the computer's answer replaces it in place. Placeholder rows show only when nothing is kept yet.
  const home = useHomeWorld(fresh);
  const world = home.world;
  // The person's role in the showing Space decides which create cards Home offers.
  const members = useMembers();
  const showing = useSpaces((s) => s.space);
  const mine = members.spaces.find((x) => x.id === showing)?.role;
  useEffect(() => { if (real) void members.load(); }, [real]);
  const name = useHomeName(real);
  useEffect(() => { void loadSnoozed(); }, []);
  const setup = useSetupBanner();
  const gap = useGap() ?? setup;
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  useEffect(() => { if (!real) return; let live = true; void createCardSource(callT).agents().then((a) => { if (live) setAgents(a); }); return () => { live = false; }; }, [real]);
  const go = (p: string) => router.push(p as never);
  const { run, sheets } = useTaskActions(world, go);
  return (
    <LargeTitleScreen title="Home" own wide onRefresh={q.reload} startAt={allowsMock() ? Number(scroll) || undefined : undefined}>
      <HomeColumn>
        <View className="gap-s4">
          <HomeHeader name={name} now={world?.now ?? Date.now()} updating={home.stale} />
          {real ? <HomeComposer live /> : null}
        </View>
        {real ? <RecordsSetup /> : null}
        {real ? <GapNotice gap={gap} /> : null}
        {real ? <UpdateNotice /> : null}
        {real ? <VaultHealthCard /> : null}
        {real && !(gap && gap.route === SETUP_BANNER.route) ? <CreateAssistantCard role={mine} agents={agents} /> : null}
        {real ? <AwayCard /> : null}
        {real ? <SignInAgain /> : null}
        {real ? <WaitingOnYou /> : null}
        {real ? <ModuleNowCards /> : null}
        {q.error && !world ? <ErrorState title="Now did not load" reason={q.error.message} retry={q.reload} />
          : !world ? <LoadingState rows={4} />
          : <HomeBody world={world} items={dated ?? world.calendar ?? []} notice={play.notice} onAction={(t, id, input, extra) => run(t, id, input, extra)} onOpen={(t) => void run(t, "open")} />}
        {real ? <PhoneApprovals want={want} /> : null}
        {scenario ? <Button kind="ghost" size="sm" label="Play: client pays" onPress={play.replay} /> : null}
      </HomeColumn>
      {sheets}
    </LargeTitleScreen>
  );
}
