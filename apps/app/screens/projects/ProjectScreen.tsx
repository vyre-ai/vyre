import { useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, EmptyState, ErrorState, PageHeader, ProjectView, Segmented, SkeletonRows, Text, projectHeader, showToast, useProject, useTaskActions } from "@vyre/ui";
import { templates } from "../templates/templates";
import { useMayMakeTemplates } from "../templates/role";
import { TeamTab } from "../teammates/TeamTab";
import { projectId } from "../teammates/model";
import { PAGE_LABEL, RAIL_LABEL, WIDE, chatLabel, pageTabs, railFor, refOf, type PageTab, type RailId } from "./panes";
import { ChatsPane, FilesPane, MemoryPane, StagesPane, TimelinePane } from "./ProjectPanes";
import { ProjectContext, ProjectInstructions } from "./ProjectDocs";
import { ProjectHeaderStrip } from "./ProjectHeaderStrip";

/** /u/project/:id: a record of a type that holds work, as a project: stages made of tasks, the team, linked records, chats and files. */
export default function ProjectScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useProject(String(id));
  const [tab, setTab] = useState<PageTab | "overview" | null>(null);
  const [makingTemplate, setMaking] = useState(false);
  const mayMake = useMayMakeTemplates();
  // a template from this project (its stages, or for a free-flow project its tasks and team), as a draft the person refines in the studio
  const makeTemplate = async (slug: string) => {
    setMaking(true);
    try { const v = await templates.fromProject(slug); showToast(`${v.name} is a draft template. Edit it, try it, then put it live.`); router.push(`/u/templates/${v.template}` as never); } catch (e) { showToast(e instanceof Error && e.message ? e.message : "That did not work."); } finally { setMaking(false); }
  };
  const { width } = useWindowDimensions();
  const go = (p: string) => router.push(p as never);
  const { run, sheets } = useTaskActions(q.data?.world, go);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/u/projects" as never));
  const f = q.data?.found;
  const h = f && q.data ? projectHeader(q.data.world, f.def, f.row) : null;
  const pid = f ? projectId(f.row) : "";
  const data = (f?.row as { data?: Record<string, unknown> } | undefined)?.data;
  const slug = String(data?.slug || "");
  const ref = refOf(slug, pid);
  const wide = width >= WIDE;
  const at: PageTab | "overview" = tab ?? (wide ? "overview" : "chats");
  const stages = data?.template_snapshot ? <StagesPane snapshot={String(data.template_snapshot)} stage={data.template_stage ? String(data.template_stage) : undefined} template={data.template ? String(data.template) : undefined} /> : null;
  const rail = (r: RailId) => {
    if (r === "stages") return stages;
    if (r === "instructions") return pid ? <ProjectInstructions pid={pid} /> : <EmptyState title="No instructions here" body="This project has no id the Drive can keep a folder under." />;
    if (r === "context") return pid ? <ProjectContext pid={pid} /> : <EmptyState title="No context here" body="This project has no id the Drive can keep a folder under." />;
    if (r === "files") return pid ? <FilesPane id={pid} /> : <EmptyState title="No files here" body="This project has no id the Drive can keep files under." />;
    return pid ? <MemoryPane id={pid} /> : <EmptyState title="No memory here" body="This project has no id memory can be kept under." />;
  };
  const chats = ref ? <ChatsPane refId={ref} slug={slug} name={h?.title} /> : <EmptyState title="No chats here" body="This project has no id the box can file chats under." />;
  const section = (r: RailId) => { const body = rail(r); return body ? <View key={r} className="gap-s2"><Text size="caption" strong tone="label">{RAIL_LABEL[r]}</Text>{body}</View> : null; };
  const pageBody = (): React.ReactNode => {
    if (at === "team") return pid ? <TeamTab project={pid} /> : <EmptyState title="No team here" body="This project has no id the box can keep a team under." />;
    if (at === "timeline") return ref ? <TimelinePane slug={ref} /> : <EmptyState title="No timeline here" body="This project has no id a timeline can be read under." />;
    if (at === "overview") return (
      <View className="flex-row items-start gap-s6">
        <View className="min-w-0 gap-s3" style={{ flex: 2 }}><Text size="caption" strong tone="label">Chats</Text>{chats}</View>
        <View className="min-w-0 gap-s5" style={{ flex: 1, maxWidth: 420 }}>{railFor(data).map(section)}</View>
      </View>
    );
    if (at === "about") return <View className="gap-s5">{railFor(data).filter((r) => r === "stages" || r === "instructions" || r === "context").map(section)}</View>;
    if (at === "files") return rail("files");
    if (at === "memory") return rail("memory");
    return chats;
  };
  return (
    <View className="min-h-0 flex-1">
      <PageHeader title={h?.title ?? "Project"} context={h?.context} faces={h?.faces} onBack={back} actions={f ? <><Button kind="secondary" size="sm" label={chatLabel(width)} onPress={() => router.push(`/u/chats/new?about=${encodeURIComponent(String((f.row as { urn?: string }).urn ?? ""))}&name=${encodeURIComponent(h?.title ?? "")}` as never)} />{mayMake && data?.slug ? <Button kind="ghost" size="sm" label={makingTemplate ? "Making" : "Make a template"} loading={makingTemplate} onPress={() => void makeTemplate(String(data.slug))} /> : null}</> : undefined} />
      <ScrollView contentContainerClassName={`gap-s4 px-s4 pb-s12 pt-s2 w-full self-center ${wide && (at === "overview") ? "max-w-full" : "max-w-page"}`}>
        {q.error && !q.data ? <ErrorState title="That project did not load" reason={q.error.message} retry={q.reload} />
          : !q.data ? <SkeletonRows rows={4} />
          : !q.data.found ? <EmptyState title="That project is not here" body="It may have been removed, or it lives in a space you cannot see." action={{ label: "Back to Projects", onPress: back }} />
          : (
            <>
              <ProjectHeaderStrip data={data} slug={slug} onManage={() => setTab("team")} />
              {wide
                ? <Segmented label="Project" value={at === "timeline" || at === "team" ? at : "overview"} onChange={(v: string) => setTab(v as never)} options={[["overview", "Overview"], ["timeline", "Timeline"], ["team", "Team"]]} />
                : <Segmented label="Project" value={at as PageTab} onChange={(v: PageTab) => setTab(v)} options={pageTabs()} />}
              {pageBody()}
            </>
          )}
        {sheets}
      </ScrollView>
    </View>
  );
}
