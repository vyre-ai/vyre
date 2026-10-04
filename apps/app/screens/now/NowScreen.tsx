import { useLocalSearchParams, useRouter } from "expo-router";
import { collect, today } from "../calendar/logic.js";
import { useEffect, useMemo } from "react";
import { useMembers } from "../spaces/state";
import { useShell } from "../shell/shared";
import { isRawId } from "../../ui/tasks/model.js";
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
  // The box may name the person by their id; the identity's own name (the shell's) is what a person is called.
  const meName = useShell((s) => s.data.me.name);
  const named = q.data && !allowsMock() && meName && Array.isArray(q.data.actors) ? { ...q.data, actors: q.data.actors.map((a: any) => (a.id === q.data!.me && isRawId(a.name) ? { ...a, name: meName } : a)) } : q.data;
  const world = named && calendar ? { ...named, calendar } : named;
  // Edit Now is Customize: owners and admins only. A box that has not said who you are shows no Edit.
  const { spaces: mySpaces, load: loadSpaces } = useMembers();
  useEffect(() => { if (real) void loadSpaces(); }, [real]);
  const canEdit = !real || mySpaces.some((s) => s.role === "owner" || s.role === "admin");
  const go = (p: string) => router.push(p as never);
  const { run, sheets } = useTaskActions(world, go);
  return (
    <LargeTitleScreen title="Now" own wide onRefresh={q.reload} startAt={allowsMock() ? Number(scroll) || undefined : undefined}>
      {q.error && !q.data ? <ErrorState title="Could not load Now." reason={q.error.message} retry={q.reload} />
        : !q.data ? <LoadingState rows={4} />
        : <NowView world={world ?? q.data} notice={play.notice} onEdit={canEdit ? () => go("/u/settings/customize") : undefined} onMore={(k) => go(`/u/now/${k}`)} onAction={(t, id, input) => void run(t, id, input)} onOpen={(t) => void run(t, "open")} />}
      {scenario ? <Button kind="ghost" size="sm" label="Play: client pays" onPress={play.replay} /> : null}
      {sheets}
    </LargeTitleScreen>
  );
}
