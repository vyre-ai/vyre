import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { callT } from "../../src/real/call-tool";
import { projectIdOf } from "../templates/model";
import { newThingCall } from "./new.js";
import { templates } from "../templates/templates";
import { newChoices } from "../templates/use";
import { startWords } from "../templates/model";
import type { Row as TemplateRow } from "../templates/model";
import { StartSheet } from "./StartSheet";
import { Button, ErrorState, LargeTitleScreen, LoadingState, NewMenu, ProjectsList, showToast, useStore, useUiTheme, useWork } from "@vyre/ui";

/** /u/projects: every record of a type that holds work, in one list. */
export default function ProjectsScreen() {
  const router = useRouter();
  const store = useStore();
  const q = useWork();
  const { phone } = useUiTheme();
  // the live templates of this Space, by what each calls its projects: "New matter", "New campaign", then "New blank project"
  const [rows, setRows] = useState<TemplateRow[]>([]);
  useEffect(() => { templates.list().then(setRows).catch(() => setRows([])); }, []);
  const choices = newChoices(rows).map((c) => ({ label: c.label, key: c.template }));
  const [from, setFrom] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const picked = rows.find((r) => r.template === from);
  const choose = (key: string | null) => { if (key) setFrom(key); else void create("project"); };
  const start = async (name: string) => {
    setStarting(true);
    try { const r = await templates.start(from!, name); setFrom(null); showToast(startWords(name, r)); open(projectIdOf(r.project)); } catch (e) { showToast(String((e as Error)?.message || e)); } finally { setStarting(false); }
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
        {q.error && !q.data ? <ErrorState title="Projects did not load" reason={q.error.message} retry={q.reload} />
          : !q.data ? <LoadingState rows={5} />
          : <><View className="flex-row"><Button kind="ghost" size="sm" icon="box" label="Templates" onPress={() => router.push("/u/templates" as never)} /></View><ProjectsList world={q.data.world} items={q.data.items} onOpen={open} onNew={create} choices={choices} onChoose={choose} />{phone ? <View style={{ height: 40 }} /> : null}</>}
      </LargeTitleScreen>
      {phone && q.data ? <View style={{ position: "absolute", right: 16, bottom: 16 }}><NewMenu floating items={q.data.items} onNew={create} choices={choices} onChoose={choose} /></View> : null}
      <StartSheet noun={picked?.noun?.one || picked?.name || "project"} open={from !== null} busy={starting} onClose={() => setFrom(null)} onStart={(n) => void start(n)} />
    </View>
  );
}
