import { useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, EmptyState, ErrorState, PageHeader, ProjectView, Segmented, SkeletonRows, Text, projectHeader, useProject, useTaskActions } from "@vyre/ui";
import { TeamTab } from "../teammates/TeamTab";
import { projectId } from "../teammates/model";
import { LABEL, WIDE, firstTab, panesAt, tabsFor, type PaneId } from "./panes";
import { ChatsPane, FilesPane, MemoryPane, StagesPane, TimelinePane } from "./ProjectPanes";

/** /u/project/:id: a record of a type that holds work, as a project: stages made of tasks, the team, linked records, chats and files. */
export default function ProjectScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useProject(String(id));
  const [picked, setTab] = useState<PaneId | null>(null);
  const { width } = useWindowDimensions();
  const go = (p: string) => router.push(p as never);
  const { run, sheets } = useTaskActions(q.data?.world, go);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/u/projects" as never));
  const f = q.data?.found;
  const h = f && q.data ? projectHeader(q.data.world, f.def, f.row) : null;
  const pid = f ? projectId(f.row) : "";
  const data = (f?.row as { data?: Record<string, unknown> } | undefined)?.data;
  const tab = picked ?? firstTab(data);
  const shown = panesAt(width, tab, data);
  const pane = (p: PaneId) => {
    const slug = String(data?.slug || "");
    if (p === "team") return pid ? <TeamTab project={pid} /> : <EmptyState title="No team here" body="This project has no id the box can keep a team under." />;
    if (p === "stages") return <>{data?.template_snapshot ? <StagesPane snapshot={String(data.template_snapshot)} stage={data.template_stage ? String(data.template_stage) : undefined} template={data.template ? String(data.template) : undefined} /> : null}{q.data && f ? <ProjectView world={q.data.world} {...f} onOpenTask={(t) => void run(t, "open")} /> : null}</>;
    if (p === "timeline") return slug ? <TimelinePane slug={slug} /> : <EmptyState title="No timeline here" body="This project has no short name a timeline can be read under." />;
    if (p === "chats") return slug ? <ChatsPane slug={slug} /> : <EmptyState title="No chats here" body="This project has no short name chats can be filed under." />;
    if (p === "files") return pid ? <FilesPane id={pid} /> : <EmptyState title="No files here" body="This project has no id the Drive can keep files under." />;
    return pid ? <MemoryPane id={pid} /> : <EmptyState title="No memory here" body="This project has no id memory can be kept under." />;
  };
  return (
    <View className="min-h-0 flex-1">
      <PageHeader title={h?.title ?? "Project"} context={h?.context} faces={h?.faces} onBack={back} actions={f ? <Button kind="secondary" size="sm" label="Chat about this" onPress={() => router.push(`/u/chats/new?about=${encodeURIComponent(String((f.row as { urn?: string }).urn ?? ""))}&name=${encodeURIComponent(h?.title ?? "")}` as never)} /> : undefined} />
      <ScrollView contentContainerClassName={`gap-s4 px-s4 pb-s12 pt-s2 w-full self-center ${shown.length > 1 ? "max-w-full" : "max-w-page"}`}>
        {q.error && !q.data ? <ErrorState title="That project did not load" reason={q.error.message} retry={q.reload} />
          : !q.data ? <SkeletonRows rows={4} />
          : !q.data.found ? <EmptyState title="That project is not here" body="It may have been removed, or it lives in a space you cannot see." action={{ label: "Back to Projects", onPress: back }} />
          : (
            <>
              {width >= WIDE
                // wide: the panes sit side by side as the Overview; the Timeline and the Team are one tap away
                ? <Segmented label="Project" value={picked ?? "overview"} onChange={(v: string) => setTab(v === "overview" ? null : (v as PaneId))} options={[["overview", "Overview"], ...tabsFor(data).filter(([p]) => p === "timeline" || p === "team")]} />
                : <Segmented label="Project" value={tab} onChange={setTab} options={tabsFor(data)} />}
              {shown.length > 1 && tab !== "team" && tab !== "timeline" ? (
                <View className="flex-row items-start gap-s4">{shown.map((p) => (<View key={p} className="min-w-0 flex-1 gap-s3"><Text size="caption" strong tone="label">{LABEL[p]}</Text>{pane(p)}</View>))}</View>
              ) : pane(tab)}
            </>
          )}
        {sheets}
      </ScrollView>
    </View>
  );
}
