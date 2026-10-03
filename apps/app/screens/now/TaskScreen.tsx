import { ScrollView } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { EmptyState, ErrorState, TaskDetail, useStore, useTaskActions, useWorld, showToast } from "@vyre/ui";

/** /u/task/:id: one task, as a page. */
export default function TaskScreen() {
  const router = useRouter();
  const store = useStore();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useWorld();
  const go = (p: string) => router.push(p as never);
  const { run, sheets } = useTaskActions(q.data, go);
  const task = q.data?.tasks.find((t) => t.id === id);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/u/now" as never));
  return (
    <ScrollView contentContainerClassName="gap-s4 p-s4 pb-s12 max-w-page w-full self-center">
      {q.error && !q.data ? <ErrorState title="Could not load this task." reason={q.error.message} retry={q.reload} />
        : !q.data ? <EmptyState title="Loading" />
        : !task ? <EmptyState title="That task is gone" body="It may have been removed." action={{ label: "Back to Now", onPress: back }} />
        : <TaskDetail world={q.data} task={task} onBack={back} onAction={(a, input) => void run(task, a, input)}
            onHow={async (how) => { try { await store.editTask(task.id, { how: how as never }, q.data!.me); } catch (e) { showToast(String((e as Error)?.message || e)); } }}
            onOpenRecord={(rid) => go(`/u/project/${rid}`)} />}
      {sheets}
    </ScrollView>
  );
}
