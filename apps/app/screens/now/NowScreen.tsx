import { ScrollView } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, EmptyState, ErrorState, NowView, usePlayScenario, useTaskActions, useWorld } from "@vyre/ui";

/** /u/now: Now, a view over tasks. `?scenario=client-pays` plays "a client pays" on a fresh mock store and ends with the Welcome email waiting for one tap. */
export default function NowScreen() {
  const router = useRouter();
  const { scenario } = useLocalSearchParams<{ scenario?: string }>();
  const play = usePlayScenario(scenario);
  const q = useWorld(play.epoch);
  const go = (p: string) => router.push(p as never);
  const { run, sheets } = useTaskActions(q.data, go);
  return (
    <ScrollView contentContainerClassName="gap-s4 p-s4 pb-s12 max-w-page w-full self-center">
      {q.error && !q.data ? <ErrorState title="Could not load Now." reason={q.error.message} retry={q.reload} />
        : !q.data ? <EmptyState title="Loading" />
        : <NowView world={q.data} notice={play.notice} onAction={(t, id, input) => void run(t, id, input)} onOpen={(t) => void run(t, "open")} />}
      {scenario ? <Button kind="ghost" size="sm" label="Play: client pays" onPress={play.replay} /> : null}
      {sheets}
    </ScrollView>
  );
}
