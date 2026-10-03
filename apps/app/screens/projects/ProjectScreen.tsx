import { ScrollView } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { EmptyState, ErrorState, ProjectView, useProject, useTaskActions } from "@vyre/ui";

/** /u/project/:id: a record of a type that holds work, as a project: stages made of tasks, the team, linked records, chats and files. */
export default function ProjectScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useProject(String(id));
  const go = (p: string) => router.push(p as never);
  const { run, sheets } = useTaskActions(q.data?.world, go);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/u/projects" as never));
  return (
    <ScrollView contentContainerClassName="gap-s4 p-s4 pb-s12 max-w-page w-full self-center">
      {q.error && !q.data ? <ErrorState title="That project could not be opened." reason={q.error.message} retry={q.reload} />
        : !q.data ? <EmptyState title="Loading" />
        : !q.data.found ? <EmptyState title="That project is not here" body="It may have been removed, or it lives in a space you cannot see." action={{ label: "Back to Projects", onPress: back }} />
        : <ProjectView world={q.data.world} {...q.data.found} onBack={back} onOpenTask={(t) => void run(t, "open")} />}
      {sheets}
    </ScrollView>
  );
}
