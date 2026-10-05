import { useState } from "react";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { Button, ErrorState, LargeTitleScreen, LoadingState, NewMenu, ProjectsList, Text, showToast, useStore, useUiTheme, useWork } from "@vyre/ui";

import { RepoPicker } from "../connections/RealGithub";
import { connections } from "../connections/source-real";
import { callT } from "../../src/real/call-tool";
import type { GithubAccount } from "../connections/model";
import { creationRefusal, findProjectId, githubProjectSource, madeLine, startedLine } from "./from-github";

const fromRepo = githubProjectSource(callT);

/** /u/projects: every record of a type that holds work, in one list. */
export default function ProjectsScreen() {
  const router = useRouter();
  const store = useStore();
  const q = useWork();
  const { phone } = useUiTheme();
  const open = (id: string) => router.push(`/u/project/${id}` as never);
  const [picking, setPicking] = useState<GithubAccount[] | null>(null);
  const [making, setMaking] = useState("");
  /** New project > From a GitHub repo: the repo picker, then github.project clones it and makes the project, and the new project opens. */
  const chooseRepo = () => { connections.githubAccounts().then(setPicking).catch(() => setPicking([])); };
  const make = async (full: string, account: string) => {
    setPicking(null); setMaking(startedLine(full));
    try {
      const made = await fromRepo.create(full, account);
      showToast(madeLine(full));
      await q.reload();
      const id = findProjectId(await store.list("project"), made.project);
      if (id) open(id);
    } catch (e) { showToast(creationRefusal(e as { code?: string; message?: string }, full)); }
    finally { setMaking(""); }
  };
  const create = async (type: string) => {
    try { const t = q.data!.world.types.get(type); const r = await store.create(type, { [t.fields[0].name]: `New ${t.label.toLowerCase()}` }); open(r.id); } catch (e) { showToast(String((e as Error)?.message || e)); }
  };
  return (
    <View className="min-h-0 flex-1">
      <LargeTitleScreen title="Projects" own onRefresh={q.reload}>
        {q.error && !q.data ? <ErrorState title="Projects did not load" reason={q.error.message} retry={q.reload} />
          : !q.data ? <LoadingState rows={5} />
          : <><View className="flex-row flex-wrap items-center gap-s2 pb-s2"><Button kind="ghost" size="sm" icon="plus" label="New project from a GitHub repo" disabled={Boolean(making)} onPress={chooseRepo} />{making ? <Text size="secondary" tone="muted">{making}</Text> : null}</View><ProjectsList world={q.data.world} items={q.data.items} onOpen={open} onNew={create} />{phone ? <View style={{ height: 40 }} /> : null}</>}
      </LargeTitleScreen>
      <RepoPicker open={picking !== null} accounts={picking ?? []} onClose={() => setPicking(null)} onPick={(r, account) => void make(r.full, account)} />
      {phone && q.data ? <View style={{ position: "absolute", right: 16, bottom: 16 }}><NewMenu floating items={q.data.items} onNew={create} /></View> : null}
    </View>
  );
}
