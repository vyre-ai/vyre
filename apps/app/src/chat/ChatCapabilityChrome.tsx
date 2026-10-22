// Sheets and inline cards for chat capabilities (rewind, second opinion, background tasks, /later).
import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { BackgroundTasksCard, LaterPlannerNote, RewindSheet, SecondOpinionSheet, showToast, type LaterPlannerState } from "@vyre/ui";
import { chatTools } from "../../screens/chat-tools/instance";
import { taskLive } from "../../screens/chat-tools/model.ts";
import { callQuiet } from "./call-quiet.js";
import { tool } from "../real/box";
import { providers } from "../../screens/settings/real";
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
  chat, thread, store, faces, real, onOpenPanel,
}: {
  chat: string;
  /** The run's thread id. A chat id is not a thread: with none, threads.tasks is not called. */
  thread: string | null;
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
  // The person's connected accounts (providers.list): a model the chat does not have yet can give the second opinion, joining in the same step.
  const [provRows, setProvRows] = useState<unknown[]>([]);
  useEffect(() => {
    if (!real || !opinionOpen) return;
    let live = true;
    providers().then((r) => { if (live) setProvRows(r); }).catch(() => {});
    return () => { live = false; };
  }, [real, opinionOpen]);
  const opinionTargets = useMemo(() => (opinionMsg ? secondOpinionTargets(faces, opinionAuthor, provRows) : []), [faces, opinionMsg, opinionAuthor, provRows]);

  const showTasks = (t: { id: string; title: string; status: string }[]) => t.map((x) => ({ id: x.id, title: x.title, status: x.status, live: taskLive(x) }));
  // A failure waits (call-quiet). The stream's rev is not a reason to ask again: a gap reconnect used to call this several times a second, with the chat id.
  useEffect(() => {
    if (!real || !thread) { setTasks([]); return; }
    let live = true;
    const load = () => {
      void callQuiet("threads.tasks:" + thread, () => chatTools.tasks(thread)).then((r) => {
        if (!live || !r || r.skipped) return;
        setTasks(r.ok ? showTasks(r.value) : []);
      });
    };
    load();
    const timer = setInterval(load, 10_000);
    return () => { live = false; clearInterval(timer); };
  }, [real, thread]);

  const doRewind = async (uuid: string) => {
    setRewindBusy(true); setRewindProblem("");
    // Later messages move to a fork (spec): a copy of the whole thread is made first (threads.branch at the live end), then this one goes back.
    const branch = store.actions?.branch;
    if (branch) {
      const b = await branch("");
      if (!b.ok) { setRewindBusy(false); setRewindProblem(b.reason); return; }
    }
    const why = await store.send(`/rewind ${uuid}`);
    setRewindBusy(false);
    if (why) setRewindProblem(why);
    else { setRewindOpen(false); showToast(branch ? "Went back. The later messages are in a new thread." : "Went back."); }
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
          <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: 12, paddingTop: 6 }}>
            <BackgroundTasksCard tasks={tasks} onOpen={() => onOpenPanel("tasks")} onStop={(id) => { if (!thread) return; void chatTools.stopTask(thread, id).then(() => callQuiet("threads.tasks:" + thread, () => chatTools.tasks(thread))).then((r) => { if (r && r.ok) setTasks(showTasks(r.value)); }); }} />
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
    <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: 16 }}>
      <LaterPlannerNote s={s} onOpenPlanner={() => router.push("/u/now" as never)} onClear={onClear} />
    </View>
  );
}
