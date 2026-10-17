// Sheets and inline cards for chat capabilities (rewind, second opinion, background tasks, /later).
import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { BackgroundTasksCard, LaterPlannerNote, RewindSheet, SecondOpinionSheet, showToast, type LaterPlannerState } from "@vyre/ui";
import { chatTools } from "../../screens/chat-tools/instance";
import { taskLive } from "../../screens/chat-tools/model.ts";
import { tool } from "../real/box";
import { laterNoteFromLine, rewindPointsFromStore, secondOpinionTargets } from "./capabilities-model.js";
import type { ChatStore } from "./store";

export function useLaterPlanner() {
  const [s, setS] = useState<LaterPlannerState>(null);
  const noteFromSend = (line: string) => {
    const n = laterNoteFromLine(line);
    if (n) setS({ kind: "scheduled", title: n.title, when: n.when });
  };
  return { s, noteFromSend, clear: () => setS(null) };
}

export function useChatCapabilityChrome({
  chat, store, faces, real, onOpenPanel,
}: {
  chat: string;
  store: ChatStore;
  faces: readonly { id: string; name: string; family: string }[];
  real: boolean;
  onOpenPanel: (page: "tasks") => void;
}) {
  const router = useRouter();
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindBusy, setRewindBusy] = useState(false);
  const [rewindProblem, setRewindProblem] = useState("");
  const [opinionOpen, setOpinionOpen] = useState(false);
  const [opinionBusy, setOpinionBusy] = useState(false);
  const [opinionProblem, setOpinionProblem] = useState("");
  const [opinionMsg, setOpinionMsg] = useState<string | null>(null);
  const [opinionAuthor, setOpinionAuthor] = useState("");
  const [tasks, setTasks] = useState<{ id: string; title: string; status: string; live: boolean }[]>([]);

  const points = useMemo(() => rewindPointsFromStore(store), [store, store.meta().rev]);
  const opinionTargets = useMemo(() => (opinionMsg ? secondOpinionTargets(faces, opinionAuthor) : []), [faces, opinionMsg, opinionAuthor]);

  useEffect(() => {
    if (!real) return;
    let live = true;
    chatTools.tasks(chat).then((t) => {
      if (live) setTasks(t.map((x) => ({ id: x.id, title: x.title, status: x.status, live: taskLive(x) })));
    }).catch(() => { if (live) setTasks([]); });
    return () => { live = false; };
  }, [real, chat, store.meta().rev, store.meta().busy]);

  const doRewind = async (uuid: string) => {
    setRewindBusy(true); setRewindProblem("");
    const why = await store.send(`/rewind ${uuid}`);
    setRewindBusy(false);
    if (why) setRewindProblem(why);
    else { setRewindOpen(false); showToast("Went back."); }
  };

  const doOpinion = async (to: string) => {
    if (!opinionMsg) return;
    setOpinionBusy(true); setOpinionProblem("");
    try {
      await tool("stream.second-opinion", { chat, message: opinionMsg, to });
      setOpinionOpen(false);
      showToast("Asked for a second opinion.");
    } catch (e) {
      setOpinionProblem(e instanceof Error ? e.message : "That did not go through.");
    } finally {
      setOpinionBusy(false);
    }
  };

  const openRewind = useCallback(() => { setRewindProblem(""); setRewindOpen(true); }, []);
  const rewindTo = useCallback((uuid: string) => { void doRewind(uuid); }, [store]);
  const openSecondOpinion = useCallback((message: string) => {
    const it = store.item(`m:${message}`) ?? store.item(`u:${message}`) as { author?: string } | null;
    setOpinionAuthor(String(it?.author ?? ""));
    setOpinionMsg(message);
    setOpinionProblem("");
    setOpinionOpen(true);
  }, [store]);
  const api = useMemo(() => ({ openRewind, rewindTo, openSecondOpinion }), [openRewind, rewindTo, openSecondOpinion]);

  return {
    api,
    ui: (
      <>
        {real && tasks.some((t) => t.live) ? (
          <View style={{ width: "100%", maxWidth: 860, alignSelf: "center", paddingHorizontal: 12, paddingTop: 6 }}>
            <BackgroundTasksCard tasks={tasks} onOpen={() => onOpenPanel("tasks")} onStop={(id) => { void chatTools.stopTask(chat, id).then(() => chatTools.tasks(chat).then((t) => setTasks(t.map((x) => ({ id: x.id, title: x.title, status: x.status, live: taskLive(x) }))))); }} />
          </View>
        ) : null}
        <RewindSheet open={rewindOpen} points={points} busy={rewindBusy} problem={rewindProblem} onClose={() => setRewindOpen(false)} onPick={(u) => void doRewind(u)} />
        <SecondOpinionSheet open={opinionOpen} targets={opinionTargets} busy={opinionBusy} problem={opinionProblem} onClose={() => setOpinionOpen(false)} onPick={(to) => void doOpinion(to)} />
      </>
    ),
  };
}

export function LaterPlannerBar({ s, onClear }: { s: LaterPlannerState; onClear: () => void }) {
  const router = useRouter();
  if (!s || s.kind !== "scheduled") return null;
  return (
    <View style={{ width: "100%", maxWidth: 860, alignSelf: "center", paddingHorizontal: 16 }}>
      <LaterPlannerNote s={s} onOpenPlanner={() => router.push("/u/planner" as never)} onClear={onClear} />
    </View>
  );
}
