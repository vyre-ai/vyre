import { ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { DoingPage, EmptyState, ErrorState, NeedsPage, SkeletonRows, useTaskActions, useWorld } from "@vyre/ui";

/** /u/now/needs and /u/now/doing: the pages "5 more waiting" and "9 running" push on a phone. */
export default function NowListScreen({ kind }: { kind: "needs" | "doing" }) {
  const router = useRouter();
  const q = useWorld();
  const go = (p: string) => router.push(p as never);
  const { run, sheets } = useTaskActions(q.data, go);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/u/now" as never));
  const open = (t: any) => void run(t, "open");
  return (
    <ScrollView contentContainerClassName="pb-s12 max-w-page w-full self-center">
      {q.error && !q.data ? <ErrorState title="Now did not load" reason={q.error.message} retry={q.reload} />
        : !q.data ? <SkeletonRows rows={4} />
        : kind === "needs" ? <NeedsPage world={q.data} onAction={(t, id, input) => void run(t, id, input)} onOpen={open} onBack={back} />
        : q.data.tasks ? <DoingPage world={q.data} onOpen={open} onBack={back} /> : <EmptyState title="Nothing is running" />}
      {sheets}
    </ScrollView>
  );
}
