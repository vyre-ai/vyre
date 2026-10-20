import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, EmptyState, Row, Tabs, Text, allowsMock } from "@vyre/ui";
import { ThreadsTab } from "../../src/chat/ThreadsTab";
import { ComputerTab } from "../../src/chat/ComputerTab";
import { Face } from "../../src/chat/Face";
import { useChatMembers } from "../../src/chat/useChatMembers";
import { tool } from "../../src/real/box";
import { AgentRoutines } from "../assistants/AgentRoutines";
import { agentWords } from "../../src/state/agent-name.js";
import { whoLabel, type WhoKind } from "./who-model.js";

export type { WhoKind };
type AgentTab = "threads" | "computer" | "routines" | "files";
type GroupTab = "members" | "threads";
const AGENT_TABS: [AgentTab, string][] = [["threads", "Threads"], ["computer", "Computer"], ["routines", "Routines"], ["files", "Files"]];

/**
 * The side pane for one who: what the shell mounts in its right pane when the name or avatar in a chat's title is pressed (or an avatar is right-clicked anywhere).
 *  - assistant, agent: their threads with you (newest first, New thread), their computer (screen, Files, Terminal), Routines and Watchers, and the files they share.
 *  - person: their profile and role.
 *  - group: its members, and its own threads.
 * Picking a thread opens it in the main chat view (/u/chats/<id>); New thread opens an empty chat with that agent (/u/chats/new-thread?agent=<name>), where the first message creates it.
 * `id` is the agent's name, the person's id (with or without "person:") or the group's chat id. `onOpen` runs before the main view navigates, so a pane on a phone can close itself.
 */
export function WhoPane({ kind, id, onOpen }: { kind: WhoKind; id: string; onOpen?: () => void }) {
  const router = useRouter();
  const go = (path: string) => { onOpen?.(); router.push(path as never); };
  if (kind === "person") return <PersonPane id={id} />;
  if (kind === "group") return <GroupPane id={id} go={go} />;
  return <AgentPane name={id} go={go} onOpen={onOpen} />;
}

function Head({ name, family, id, line }: { name: string; family: "person" | "assistant"; id: string; line?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 8 }}>
      <Face name={name} family={family} size={44} id={id} />
      <View style={{ flex: 1, minWidth: 0 }}><Text medium numberOfLines={1}>{name}</Text>{line ? <Text size="caption" tone="label" numberOfLines={1}>{line}</Text> : null}</View>
    </View>
  );
}

function AgentPane({ name, go, onOpen }: { name: string; go: (p: string) => void; onOpen?: () => void }) {
  const [tab, setTab] = useState<AgentTab>("threads");
  const shown = agentWords(name);
  return (
    <View style={{ gap: 12 }} accessibilityLabel={`About ${shown}`}>
      <Head name={shown} family="assistant" id={`agent:${name}`} line={whoLabel("agent")} />
      <Tabs items={AGENT_TABS} value={tab} onChange={setTab} />
      {tab === "threads" ? <ThreadsTab agent={name} onSwitch={(t) => go(`/u/chats/${encodeURIComponent(t)}`)} onNew={async () => { go(`/u/chats/new-thread?agent=${encodeURIComponent(name)}`); return null; }} /> : null}
      {tab === "computer" ? <ComputerTab agents={[name]} onLeave={onOpen} /> : null}
      {tab === "routines" ? <AgentRoutines agent={name} /> : null}
      {tab === "files" ? (
        <Card><View style={{ gap: 8 }}>
          <Text tone="muted">Files {shown} keeps and files shared with it.</Text>
          <View style={{ alignSelf: "flex-start" }}><Button kind="secondary" size="sm" label="Open Files" onPress={() => go(`/u/files?agent=${encodeURIComponent(name)}`)} /></View>
        </View></Card>
      ) : null}
    </View>
  );
}

function PersonPane({ id }: { id: string }) {
  const pid = id.replace(/^person:/, "");
  const [who, setWho] = useState<{ name: string; role: string } | null | undefined>(undefined);
  useEffect(() => {
    if (allowsMock()) { setWho({ name: pid, role: "" }); return; }
    let live = true;
    void tool<{ actors?: { id: string; name?: string; role?: string; title?: string }[] }>("records.actors", {}).then((r) => {
      if (!live) return;
      const a = (r.actors ?? []).find((x) => x.id === pid);
      setWho(a ? { name: a.name && !/^per_/.test(a.name) ? a.name : "Someone", role: String(a.role || a.title || "") } : null);
    }).catch(() => { if (live) setWho(null); });
    return () => { live = false; };
  }, [pid]);
  if (who === undefined) return <Text tone="label">Loading</Text>;
  if (!who) return <EmptyState title="Someone" body="Vyre has no profile for this person yet." />;
  return (
    <View style={{ gap: 12 }} accessibilityLabel={`About ${who.name}`}>
      <Head name={who.name} family="person" id={`person:${pid}`} line={who.role || whoLabel("person")} />
      <Card><View style={{ gap: 4 }}><Text size="caption" tone="label">Role</Text><Text>{who.role || "No role set"}</Text></View></Card>
    </View>
  );
}

function GroupPane({ id, go }: { id: string; go: (p: string) => void }) {
  const here = useChatMembers(id);
  const [tab, setTab] = useState<GroupTab>("members");
  const tabs: [GroupTab, string][] = [["members", `Members${here.members.length ? ` (${here.members.length})` : ""}`], ["threads", "Threads"]];
  return (
    <View style={{ gap: 12 }} accessibilityLabel="About this group">
      <Tabs items={tabs} value={tab} onChange={setTab} />
      {tab === "members" ? (here.members.length ? here.members.map((m) => <Row key={m.id} dense lead={<Face name={m.name} family={m.family} size={28} id={m.id} />} title={m.name} sub={m.family === "assistant" ? "Assistant" : "Person"} />) : <EmptyState title="No members yet" body="Who is in this group shows here." />) : null}
      {tab === "threads" ? <ThreadsTab agent="" chat={id} onSwitch={(t) => go(`/u/chats/${encodeURIComponent(t)}`)} /> : null}
    </View>
  );
}
