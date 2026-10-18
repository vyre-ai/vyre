// The Threads tab of an agent's panel (the Runs tab of a Flow's): New thread, then every thread with that agent, newest first with the live one on top. One tap switches to it; the old ones stay saved.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Chip, EmptyState, Icon, LoadingState, Row } from "@vyre/ui";
import { agentThreads, type ThreadRow } from "./threads-source";
import { ageOf } from "../../screens/chats/chat-model.js";

export function ThreadsTab({ agent, noun = "thread", current, onSwitch, onNew }: {
  agent: string; /** "thread", or "run" for a Flow. */ noun?: "thread" | "run";
  /** The thread showing now. */ current?: string;
  onSwitch: (thread: string) => void;
  /** Starts a thread; the tab looks again after. */ onNew?: () => Promise<string | null>;
}) {
  const [rows, setRows] = useState<ThreadRow[] | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { const r = await agentThreads.list(agent); if ("rows" in r) { setRows(r.rows); setProblem(""); } else { setRows([]); setProblem(r.problem); } }, [agent]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const make = async () => { if (!onNew || busy) return; setBusy(true); const why = await onNew(); setBusy(false); if (why) setProblem(why); else await load(); };
  const now = Date.now();
  return (
    <View style={{ gap: 8 }}>
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      {onNew && noun === "thread" ? <View style={{ flexDirection: "row" }}><Button kind="secondary" size="sm" label="New thread" disabled={busy} onPress={() => void make()} /></View> : null}
      {rows === null ? <LoadingState rows={3} /> : !rows.length ? <EmptyState title={noun === "run" ? "No runs yet" : "No threads yet"} body={noun === "run" ? "Each run of this Flow is its own thread." : `Your first message to ${agent} starts one.`} /> : rows.map((t) => (
        <Row key={t.id} dense selected={t.id === current} lead={<Icon name={t.live ? "spark" : "chat"} size={20} />} title={t.title}
          sub={t.live ? (t.needs ? "Live, needs you" : "Live") : t.at ? ageOf(t.at, now) : ""} end={t.needs ? <Chip tone="accent">Needs you</Chip> : undefined} onPress={() => onSwitch(t.id)} />
      ))}
    </View>
  );
}
