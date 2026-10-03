import { ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { EmptyState, ErrorState, ProjectsList, showToast, useStore, useWork } from "@vyre/ui";

/** /u/projects: every record of a type that holds work, in one list. */
export default function ProjectsScreen() {
  const router = useRouter();
  const store = useStore();
  const q = useWork();
  const open = (id: string) => router.push(`/u/project/${id}` as never);
  return (
    <ScrollView contentContainerClassName="gap-s4 p-s4 pb-s12 max-w-page w-full self-center">
      {q.error && !q.data ? <ErrorState title="Projects are not available." reason={q.error.message} retry={q.reload} />
        : !q.data ? <EmptyState title="Loading" />
        : <ProjectsList world={q.data.world} items={q.data.items} onOpen={open} onNew={async (type) => {
            try { const t = q.data!.world.types.get(type); const r = await store.create(type, { [t.fields[0].name]: `New ${t.label.toLowerCase()}` }); open(r.id); } catch (e) { showToast(String((e as Error)?.message || e)); }
          }} />}
    </ScrollView>
  );
}
