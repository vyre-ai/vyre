import { useEffect, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { View } from "react-native";
import { callT } from "../../src/real/call-tool";
import { projectIdOf } from "../templates/model";
import { newThingCall } from "./new.js";
import { templates } from "../templates/templates";
import { newChoices } from "../templates/use";
import { ofPlaybook, playbookPath } from "../templates/board";
import { startWords } from "../templates/model";
import type { Row as TemplateRow } from "../templates/model";
import { StartSheet, type StartExtras } from "./StartSheet";
import { Button, ErrorState, Field, LargeTitleScreen, Sheet, Text, LoadingState, NewMenu, ProjectsList, showToast, useStore, useUiTheme, useWork } from "@vyre/ui";
import { PlaceTag, usePlaceText } from "../../src/real/PlaceTag";
import { tagFor } from "../../src/real/place-tag.js";
import { useMembers } from "../spaces/state";
import { useSpaces } from "../shell/state";

/** /u/projects: every record of a type that holds work, in one list. */
export default function ProjectsScreen() {
  const router = useRouter();
  const { playbook: playbookParam = "" } = useLocalSearchParams<{ playbook?: string }>();
  const [playbook, setPlaybook] = useState<string>(playbookParam);
  const [renaming, setRenaming] = useState<{ slug: string; name: string } | null>(null);
  const [archiving, setArchiving] = useState<{ slug: string; name: string } | null>(null);
  const store = useStore();
  const q = useWork();
  const cards = useMembers((s) => s.spaces);
  const showing = useSpaces((s) => s.space);
  usePlaceText("showing");   // loads the spaces the tags are read from
  const { phone } = useUiTheme();
  // the live templates of this Space, by what each calls its projects: "New matter", "New campaign", then "New blank project"
  const [rows, setRows] = useState<TemplateRow[]>([]);
  useEffect(() => { templates.list().then(setRows).catch(() => setRows([])); }, []);
  const choices = newChoices(rows).map((c) => ({ label: c.label, key: c.template }));
  const [from, setFrom] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const picked = rows.find((r) => r.template === from);
  const choose = (key: string | null) => { if (key) setFrom(key); else void create("project"); };
  const start = async (name: string, extras: StartExtras) => {
    setStarting(true);
    try {
      const r = await templates.start(from!, name, extras);
      setFrom(null); showToast(startWords(name, r));
      open(projectIdOf(r.project));
    } catch (e) { showToast(String((e as Error)?.message || e)); } finally { setStarting(false); }
  };
  const open = (id: string) => router.push(`/u/project/${id}` as never);
  const create = async (type: string) => {
    try {
      // a project is made by the work hub: it gives the project its short name, its Drive folder and its memory, so chats and files can be kept under it (a bare record would have none)
      const call = newThingCall(type);
      if (call) {
        const r = await callT<{ project: string }>(call.tool, call.input);
        if (r.error) throw new Error(r.error.message);
        open(projectIdOf(r.data!.project));
        return;
      }
      const t = q.data!.world.types.get(type); const r = await store.create(type, { [t.fields[0].name]: `New ${t.label.toLowerCase()}` }); open(r.id);
    } catch (e) { showToast(String((e as Error)?.message || e)); }
  };
  return (
    <View className="min-h-0 flex-1">
      <LargeTitleScreen title="Projects" own onRefresh={q.reload}>
        <PlaceTag of="showing" />
        {q.error && !q.data ? <ErrorState title="Projects did not load" reason={q.error.message} retry={q.reload} />
          : !q.data ? <LoadingState rows={5} />
          : <><View className="flex-row"><Button kind="ghost" size="sm" icon="box" label="Playbooks" onPress={() => router.push(playbookPath() as never)} /></View><ProjectsList playbook={playbook || null} playbookName={rows.find((r) => r.template === playbook)?.name} onClearPlaybook={() => setPlaybook("")} onRename={(r: any) => r?.data?.slug ? setRenaming({ slug: String(r.data.slug), name: String(r.data.title ?? r.data.name ?? "") }) : showToast("This project has no short name to rename it by.")} onArchive={(r: any) => r?.data?.slug ? setArchiving({ slug: String(r.data.slug), name: String(r.data.title ?? r.data.name ?? "") }) : showToast("This project has no short name to archive it by.")} tagOf={(sid) => tagFor(cards, sid || showing, showing)} world={q.data.world} items={ofPlaybook(q.data.items, playbook)} onOpen={open} onNew={create} choices={choices} onChoose={choose} />{phone ? <View style={{ height: 96 }} /> : null}</>}
      </LargeTitleScreen>
      {phone && q.data ? <View style={{ position: "absolute", right: 16, bottom: 16 }}><NewMenu floating items={q.data.items} onNew={create} choices={choices} onChoose={choose} /></View> : null}
      <Sheet open={!!renaming} onClose={() => setRenaming(null)} title="Rename project">
        {renaming ? (
          <View className="gap-s3">
            <Field name="Project name" value={renaming.name} onChangeText={(n) => setRenaming({ ...renaming, name: n })} />
            <View className="self-start"><Button kind="primary" size="sm" label="Save" disabled={!renaming.name.trim()} onPress={async () => { const r0 = renaming; setRenaming(null); const r = await callT("projects.rename", { project: r0.slug, name: r0.name.trim() }); if (r.error) showToast(r.error.message || "That did not go through."); else { showToast("Renamed."); q.reload(); } }} /></View>
          </View>
        ) : null}
      </Sheet>
      <Sheet open={!!archiving} onClose={() => setArchiving(null)} title="Archive this project?">
        {archiving ? (
          <View className="gap-s3">
            <Text tone="muted">{`${archiving.name || "This project"} leaves the list. Its folder, chats, team and history stay as they are, and you can bring it back.`}</Text>
            <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Archive" onPress={async () => { const a = archiving; setArchiving(null); const r = await callT("projects.archive", { project: a.slug, archived: true }); if (r.error) showToast(r.error.message || "That did not go through."); else { showToast("Archived."); q.reload(); } }} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setArchiving(null)} /></View>
          </View>
        ) : null}
      </Sheet>
      <StartSheet noun={picked?.noun?.one || picked?.name || "project"} playbook={picked?.name} open={from !== null} busy={starting} onClose={() => setFrom(null)} onStart={(n, x) => void start(n, x)} />
    </View>
  );
}
