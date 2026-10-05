import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { EmptyState, ErrorState, PageHeader, ProjectView, Segmented, SkeletonRows, projectHeader, useProject, useTaskActions } from "@vyre/ui";
import { TeamTab } from "../teammates/TeamTab";
import { BriefTab, FilesTab, MemoryTab } from "./ProjectTabs";
import { TAB_LABELS, type Tab } from "./tabs-model";

/** /u/project/:id: a record of a type that holds work, as a project: stages made of tasks, the team, linked records, chats and files. */
export default function ProjectScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useProject(String(id));
  const [tab, setTab] = useState<Tab>("project");
  const go = (p: string) => router.push(p as never);
  const { run, sheets } = useTaskActions(q.data?.world, go);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/u/projects" as never));
  const f = q.data?.found;
  const h = f && q.data ? projectHeader(q.data.world, f.def, f.row) : null;
  // The box keys a project's team by the Project record id; the other tabs ask the box for its short name themselves (work.project.ref).
  const projectId = f ? String(f.row.id) : "";
  return (
    <View className="min-h-0 flex-1">
      <PageHeader title={h?.title ?? "Project"} context={h?.context} faces={h?.faces} onBack={back} />
      <ScrollView contentContainerClassName="gap-s4 px-s4 pb-s12 pt-s2 max-w-page w-full self-center">
        {q.error && !q.data ? <ErrorState title="That project did not load" reason={q.error.message} retry={q.reload} />
          : !q.data ? <SkeletonRows rows={4} />
          : !q.data.found ? <EmptyState title="That project is not here" body="It may have been removed, or it lives in a space you cannot see." action={{ label: "Back to Projects", onPress: back }} />
          : (
            <>
              <Segmented label="Project" value={tab} onChange={setTab} options={TAB_LABELS} />
              {tab === "brief" ? <BriefTab project={projectId} onNewChat={() => go(`/u/chats/new?project=${encodeURIComponent(projectId)}`)} /> : null}
              {tab === "files" ? <FilesTab project={projectId} /> : null}
              {tab === "memory" ? <MemoryTab project={projectId} /> : null}
              {tab === "brief" || tab === "files" || tab === "memory" ? null : tab === "team" ? <TeamTab project={projectId} />
                : <ProjectView world={q.data.world} {...q.data.found} onOpenTask={(t) => void run(t, "open")} onNewChat={() => go(`/u/chats/new?project=${encodeURIComponent(projectId)}`)} />}
            </>
          )}
        {sheets}
      </ScrollView>
    </View>
  );
}
