import { useLocalSearchParams, useRouter } from "expo-router";
import { collect, today } from "../calendar/logic.js";
import { useEffect, useMemo, useState } from "react";
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
import { useNeedsCount } from "../../src/state/needs";
import { nowModel } from "../../ui/tasks/model.js";
import { HomeAgents } from "./HomeAgents";
import { AskDock } from "./AskDock";
import { SETUP_BANNER } from "../install/first-run.js";
import { Button, ErrorState, allowsMock, useRecordsWorld, LargeTitleScreen, LoadingState, NowView, usePlayScenario, useTaskActions, useWorld } from "@vyre/ui";

/** /u/now: Now, a view over tasks. Pull to refresh on a phone; the title collapses into the bar as it scrolls. `?scenario=client-pays` plays "a client pays" on a fresh mock store and ends with the Welcome email waiting for one tap. */
export default function NowScreen() {
  const router = useRouter();
  const { scenario, scroll, act, card } = useLocalSearchParams<{ scenario?: string; scroll?: string; act?: string; card?: string }>();
  const want = useMemo(() => actFrom({ act, card }), [act, card]);
  const play = usePlayScenario(scenario);
  const q = useWorld(play.epoch);
  // On a real vyred today's items are every dated record (screens/calendar/logic.js), not the store's own calendar; the sample world keeps its sample day.
  const real = !allowsMock();
  const rw = useRecordsWorld();
  const calendar = useMemo(() => (real && rw.data && q.data ? today(collect(rw.data.types, rw.data.byType), q.data.now).map((i: any) => ({ id: `${i.urn}/${i.field}`, at: i.start.getTime(), title: i.title, sub: i.event ? i.typeLabel : `${i.typeLabel}: ${i.fieldLabel}`, record: i.urn })) : null), [real, rw.data, q.data]);
  const fresh = useMemo(() => (q.data && calendar ? { ...q.data, calendar } : q.data), [q.data, calendar]);
  // Stale while revalidate: the last good world for this Space draws at once and the box's answer replaces it in place; the placeholder rows show only when nothing is kept yet.
  const home = useHomeWorld(fresh);
  const world = home.world;
  // The person's role in the showing Space decides which create cards Home offers.
  const members = useMembers();
  const showing = useSpaces((s) => s.space);
  const mine = members.spaces.find((x) => x.id === showing)?.role;
  useEffect(() => { if (real) void members.load(); }, [real]);
  // One greeting, named by the person's display name or username (never "You"), and one count of what waits: the tasks that need them and the Needs you list.
  const name = useHomeName(real);
  const waitingNeeds = useNeedsCount();
  const waiting = (world ? nowModel(world).needs.length : 0) + (real ? waitingNeeds : 0);
  useEffect(() => { void loadSnoozed(); }, []);
  const setup = useSetupBanner();
  const gap = useGap() ?? setup;
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  useEffect(() => { if (!real) return; let live = true; void createCardSource(callT).agents().then((a) => { if (live) setAgents(a); }); return () => { live = false; }; }, [real]);
  const [working, setWorking] = useState(0);
  const [ask, setAsk] = useState<{ names: string[]; assistant: string }>({ names: [], assistant: "" });
  const go = (p: string) => router.push(p as never);
  const { run, sheets } = useTaskActions(world, go);
  return (
    <LargeTitleScreen title="Now" own wide onRefresh={q.reload} dock={real && ask.assistant ? <AskDock names={ask.names} assistant={ask.assistant} /> : undefined} startAt={allowsMock() ? Number(scroll) || undefined : undefined}>
      <HomeHeader name={name} waiting={waiting} now={world?.now ?? Date.now()} today={calendar?.length ?? (real && home.stale ? world?.calendar?.length : undefined)} working={working} updating={home.stale} />
      {real ? <HomeAgents onCount={setWorking} onNames={(names, assistant) => setAsk({ names, assistant })} /> : null}
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
        : <NowView world={world} notice={play.notice} onMore={(k) => go(`/u/now/${k}`)} onAction={(t, id, input, extra) => run(t, id, input, extra)} onOpen={(t) => void run(t, "open")} />}
      {real ? <PhoneApprovals want={want} /> : null}
      {scenario ? <Button kind="ghost" size="sm" label="Play: client pays" onPress={play.replay} /> : null}
      {sheets}
    </LargeTitleScreen>
  );
}
