import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, ErrorState, LargeTitleScreen, LoadingState, NowView, usePlayScenario, useTaskActions, useWorld } from "@vyre/ui";

/** /u/now: Now, a view over tasks. Pull to refresh on a phone; the title collapses into the bar as it scrolls. `?scenario=client-pays` plays "a client pays" on a fresh mock store and ends with the Welcome email waiting for one tap. */
export default function NowScreen() {
  const router = useRouter();
  const { scenario } = useLocalSearchParams<{ scenario?: string }>();
  const play = usePlayScenario(scenario);
  const q = useWorld(play.epoch);
  const go = (p: string) => router.push(p as never);
  const { run, sheets } = useTaskActions(q.data, go);
  return (
    <LargeTitleScreen title="Now" own wide onRefresh={q.reload}>
      {q.error && !q.data ? <ErrorState title="Could not load Now." reason={q.error.message} retry={q.reload} />
        : !q.data ? <LoadingState rows={4} />
        : <NowView world={q.data} notice={play.notice} onEdit={() => go("/u/settings/customize")} onMore={(k) => go(`/u/now/${k}`)} onAction={(t, id, input) => void run(t, id, input)} onOpen={(t) => void run(t, "open")} />}
      {scenario ? <Button kind="ghost" size="sm" label="Play: client pays" onPress={play.replay} /> : null}
      {sheets}
    </LargeTitleScreen>
  );
}
