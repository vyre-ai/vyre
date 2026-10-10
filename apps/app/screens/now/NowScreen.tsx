import { useLocalSearchParams, useRouter } from "expo-router";
import { collect, today } from "../calendar/logic.js";
import { useEffect, useMemo, useState } from "react";
import { useMembers } from "../spaces/state";
import { PhoneApprovals } from "../shell/PhoneApprovals";
import { ModuleNowCards } from "../modules/ModuleNowCards";
import { GapNotice, WaitingOnYou } from "./WaitingOnYou";
import { UpdateNotice } from "./UpdateNotice";
import { VaultHealthCard } from "./VaultHealthCard";
import { useSpaces } from "../shell/state";
import { PairingCards } from "../pairing/PairingCards";
import { CreateAssistantCard } from "../assistants/CreateAssistantCard";
import { createCardSource } from "../assistants/create-card-source";
import { CREATE_ASSISTANT, shouldShow, type AgentRow } from "../assistants/create-card-model";
import { callT } from "../../src/real/call-tool";
import { useGap, useSetupBanner } from "../../src/state/setup-gap";
import { GetStarted } from "./GetStarted";
import { RecordsSetup } from "./RecordsSetup";
import { getStarted } from "./get-started.js";
import { SETUP_BANNER } from "../install/first-run.js";
import { Button, ErrorState, allowsMock, useRecordsWorld, LargeTitleScreen, LoadingState, NowView, usePlayScenario, useTaskActions, useWorld } from "@vyre/ui";

/** /u/now: Now, a view over tasks. Pull to refresh on a phone; the title collapses into the bar as it scrolls. `?scenario=client-pays` plays "a client pays" on a fresh mock store and ends with the Welcome email waiting for one tap. */
export default function NowScreen() {
  const router = useRouter();
  const { scenario, scroll } = useLocalSearchParams<{ scenario?: string; scroll?: string }>();
  const play = usePlayScenario(scenario);
  const q = useWorld(play.epoch);
  // On a real vyred today's items are every dated record (screens/calendar/logic.js), not the store's own calendar; the sample world keeps its sample day.
  const real = !allowsMock();
  const rw = useRecordsWorld();
  const calendar = useMemo(() => (real && rw.data && q.data ? today(collect(rw.data.types, rw.data.byType), q.data.now).map((i: any) => ({ id: `${i.urn}/${i.field}`, at: i.start.getTime(), title: i.title, sub: i.event ? i.typeLabel : `${i.typeLabel}: ${i.fieldLabel}`, record: i.urn })) : null), [real, rw.data, q.data]);
  const world = q.data && calendar ? { ...q.data, calendar } : q.data;
  // Edit Now opens Customize, which only an owner or admin can use: other roles are not offered it.
  const members = useMembers();
  const showing = useSpaces((s) => s.space);
  const mine = members.spaces.find((x) => x.id === showing)?.role;
  const canEdit = !real || !mine || mine === "owner" || mine === "admin";
  useEffect(() => { if (real) void members.load(); }, [real]);
  // a new box with a phone to add and an assistant to make shows one "Get started" card, not an amber banner over a full-width card
  const setup = useSetupBanner();
  const gap = useGap() ?? setup;
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  useEffect(() => { if (!real) return; let live = true; void createCardSource(callT).agents().then((a) => { if (live) setAgents(a); }); return () => { live = false; }; }, [real]);
  const started = real ? getStarted(gap, shouldShow(agents, mine) ? CREATE_ASSISTANT : null) : null;
  const go = (p: string) => router.push(p as never);
  const { run, sheets } = useTaskActions(world, go);
  return (
    <LargeTitleScreen title="Now" own wide onRefresh={q.reload} startAt={allowsMock() ? Number(scroll) || undefined : undefined}>
      {real ? <RecordsSetup /> : null}
      {started ? <GetStarted title={started.title} steps={started.steps} /> : null}
      {real && !started ? <GapNotice gap={gap} /> : null}
      {real ? <UpdateNotice /> : null}
      {real ? <VaultHealthCard /> : null}
      {real ? <PairingCards /> : null}
      {real && !started && !(gap && gap.route === SETUP_BANNER.route) ? <CreateAssistantCard role={mine} agents={agents} /> : null}
      {real ? <WaitingOnYou /> : null}
      {real ? <ModuleNowCards /> : null}
      {q.error && !q.data ? <ErrorState title="Now did not load" reason={q.error.message} retry={q.reload} />
        : !q.data ? <LoadingState rows={4} />
        : <NowView world={world ?? q.data} notice={play.notice} onEdit={canEdit ? () => go("/u/settings/customize") : undefined} onMore={(k) => go(`/u/now/${k}`)} onAction={(t, id, input) => void run(t, id, input)} onOpen={(t) => void run(t, "open")} />}
      {real ? <PhoneApprovals /> : null}
      {scenario ? <Button kind="ghost" size="sm" label="Play: client pays" onPress={play.replay} /> : null}
      {sheets}
    </LargeTitleScreen>
  );
}
