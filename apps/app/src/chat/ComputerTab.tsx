// The Computer tab: the computer of the agent in this chat. With several agents in the chat a chip row picks whose. Status loads once and again every minute while the tab is open; waking
// is checked a few times after the tap, not on a fast timer.
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { AgentComputerPane, Chip, EmptyState, LoadingState } from "@vyre/ui";
import type { ComputerView } from "@vyre/ui";
import { agentComputer } from "../../screens/chat-tools/computer-source";

export function ComputerTab({ agents, onLeave }: { agents: readonly string[]; /** Called before the full-screen view opens, so the panel can close. */ onLeave?: () => void }) {
  const router = useRouter();
  const [who, setWho] = useState(agents[0] ?? "");
  const [view, setView] = useState<ComputerView | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (!agents.includes(who)) setWho(agents[0] ?? ""); }, [agents, who]);
  const load = useCallback(async (): Promise<ComputerView | null> => {
    if (!who) return null;
    const r = await agentComputer.status(who);
    if (!live.current) return null;
    if ("view" in r) { setView(r.view); setProblem(""); return r.view; }
    setProblem(r.problem);
    return null;
  }, [who]);
  useEffect(() => { setView(null); void load(); const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);
  // After Wake: look again a few times, 4 seconds apart, until the screen is live.
  const settle = async (tries = 3) => { for (let i = 0; i < tries && live.current; i++) { await new Promise((r) => setTimeout(r, 4000)); const v = await load(); if (v && v.state !== "waking") return; } };
  const act = async (fn: () => Promise<string | null>, follow?: boolean) => {
    setBusy(true); setProblem("");
    const why = await fn();
    setBusy(false);
    if (why) { setProblem(why); return; }
    await load();
    if (follow) void settle();
  };
  const leave = (app?: string) => { onLeave?.(); router.push(`/u/glass/${encodeURIComponent(who)}${app ? `?app=${app}` : ""}` as never); };
  if (!agents.length) return <EmptyState title="No agent in this chat" body="An agent's computer shows here when the agent is in the chat." />;
  return (
    <View style={{ gap: 12 }}>
      {agents.length > 1 ? <View accessibilityLabel="Whose computer" style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>{agents.map((a) => <Chip key={a} selected={a === who} onPress={() => setWho(a)}>{a}</Chip>)}</View> : null}
      {!view && !problem ? <LoadingState rows={2} /> : (
        <AgentComputerPane name={who} view={view} busy={busy} problem={problem}
          onWake={() => void act(() => agentComputer.wake(who), true)} onSleep={() => void act(() => agentComputer.sleep(who))} onOpen={() => leave()} onDock={(id) => leave(id)} />
      )}
    </View>
  );
}
