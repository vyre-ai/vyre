import { ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { EmptyState, ErrorState, PageHeader, TaskDetail, taskHeader, useStore, useTaskActions, useWorld, showToast, SkeletonRows } from "@vyre/ui";

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
  const h = q.data && task ? taskHeader(q.data, task) : null;
  return (
    <View className="min-h-0 flex-1">
      <PageHeader title={h?.title ?? "Task"} context={h?.context} faces={h?.faces} onBack={back} />
      <ScrollView contentContainerClassName="gap-s4 px-s4 pb-s12 pt-s2 max-w-page w-full self-center">
        {q.error && !q.data ? <ErrorState title="This task did not load" reason={q.error.message} retry={q.reload} />
          : !q.data ? <SkeletonRows rows={3} />
          : !task ? <EmptyState title="That task is gone" body="It may have been removed." action={{ label: "Back to Now", onPress: back }} />
          : <TaskDetail world={q.data} task={task} onAction={(a, input) => void run(task, a, input)}
              onHow={async (how) => { try { await store.editTask(task.id, { how: how as never }, q.data!.me); } catch (e) { showToast(String((e as Error)?.message || e)); } }}
              onOpenRecord={(rid) => go(`/u/project/${rid}`)} />}
        {sheets}
      </ScrollView>
    </View>
  );
}
