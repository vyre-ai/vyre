import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Divider, Chip, EmptyState, Field, LoadingState, Row, SectionLabel, Text, markRef, useStore } from "@vyre/ui";
import { Page } from "../places/Frame";
import { agentsList } from "../settings/real";
import { writeDraft } from "../../src/chat/drafts";
import { newUuid } from "@vyre/chat-core/composer-state.js";
import { SURFACE } from "../../src/state/live";
import { tool } from "../../src/real/box";
import { chatIdOf, inputFor, pickerGroups } from "../../src/state/new-chat-model.js";
import { agentRow, visibleAgents } from "../agents/home-model.js";
import { assistantChatRoute } from "../../src/state/start-chat";
import { useTeam } from "../teammates/useTeam";
import { teammates } from "../teammates/teammates";
import { ringForNewChat } from "../../src/state/chat-start";

/** /u/chats/new: a picker of who to talk to, in three groups: your assistant, the people on your team, and the agents the Agents screen shows. Search, and pick one or several; more than one makes a group chat
 * (people only: the AI answers when mentioned). Say what you want first if you like. work.chat.create makes the chat; it opens with your first words ready to send. */
export default function NewChatScreen() {
  const router = useRouter();
  const st = useStore();
  // "Chat about this": a record or project opens a new chat with its urn and name; the chat is linked to it, and the first words name it so the assistant can read it
  const { about, name, project: projectParam } = useLocalSearchParams<{ about?: string; name?: string; project?: string }>();
  // New chat from a project: the chat is made in it, and its own team is listed first (removable)
  const [project, setProject] = useState(typeof projectParam === "string" ? projectParam : "");
  const [projectName, setProjectName] = useState("");
  const team = useTeam(project || null);
  useEffect(() => { let live = true; if (project) void teammates.names([project]).then((n) => { if (live) setProjectName(n[project] || ""); }).catch(() => {}); return () => { live = false; }; }, [project]);
  const aboutUrn = typeof about === "string" && about.startsWith("vyre://") ? about : "";
  const [agents, setAgents] = useState<{ name: string; kind: string; assistant: boolean }[] | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string; role?: string }[]>([]);
  const [me, setMe] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState(aboutUrn ? `About ${typeof name === "string" && name ? name : "this"} (${aboutUrn}): ` : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [loadErr, setLoadErr] = useState("");
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const m = String((await (st.me?.() as Promise<string> | undefined)?.catch(() => "")) ?? "");
        const a = await agentsList();
        const rows = visibleAgents(a.map((x: any) => agentRow(x, m)), m).map((r) => ({ name: r.name, kind: r.kind, assistant: r.kind === "assistant" }));
        const who = await Promise.resolve(st.actors()).catch(() => []);
        if (!live) return;
        setMe(m); setAgents(rows);
        setPeople(who.filter((w: any) => w.family === "person" && w.name).map((w: any) => ({ id: String(w.id), name: String(w.name), role: w.role ? String(w.role) : undefined })));
      } catch (e) { if (live) setLoadErr(e instanceof Error ? e.message : "Your Vyre did not answer."); }
    })();
    return () => { live = false; };
  }, [st]);
  const groups = useMemo(() => pickerGroups({ agents: agents ?? [], people, me, q, team: project ? [...(team.rows ?? []).map((t) => t.agent), ...team.members.map((m) => m.agent)] : [] }), [agents, people, me, q, project, team.rows, team.members]);
  const toggle = (k: string) => setPicked((p) => (k === "assistant" ? (p.includes(k) ? [] : [k]) : p.includes(k) ? p.filter((x) => x !== k) : [...p.filter((x) => x !== "assistant"), k]));
  const start = async () => {
    setBusy(true); setErr("");
    try {
      let id: string | null = null;
      if (picked.includes("assistant")) {
        const route = await assistantChatRoute();
        id = decodeURIComponent(route.replace("/u/chats/", "")) || null;
        if (!id || route === "/u/chats") { router.replace("/u/chats" as never); return; }
      } else {
        const made = await ringForNewChat();
        if ("say" in made) { setErr(made.say); return; }
        const sel = inputFor({ people: picked.filter((k) => k.startsWith("p:")).map((k) => k.slice(2)), agents: picked.filter((k) => k.startsWith("a:")).map((k) => k.slice(2)) });
        id = chatIdOf(await tool("work.chat.create", { ...sel, ...(project ? { project } : {}), ...made }));
        if (!id) throw new Error("The chat started but Vyre did not say which one. Open it from Chat.");
      }
      // linked to the record it is about; private to its people until they share it on the record's timeline
      if (aboutUrn) await tool("work.chat.link", { chat: id, record: aboutUrn }).catch(() => undefined);
      // The first words are sent into the new chat (work.chat.create takes none); that send starts the chat's run. If it fails they wait in the chat's box instead.
      if (text.trim()) {
        const first = await tool("stream.send", { chat: id, text: text.trim(), message: newUuid(), surface: SURFACE }).then(() => null).catch((e: Error) => e);
        if (first) writeDraft(id, text.trim());
      }
      router.replace({ pathname: "/u/chats/[id]", params: { id } });
    } catch (e) { setErr(e instanceof Error ? e.message : "The chat did not start."); } finally { setBusy(false); }
  };
  const row = (k: string, title: string, sub: string, mark: React.ReactNode) => <Row key={k} lead={mark} title={title} sub={sub} selected={picked.includes(k)} onPress={() => toggle(k)} />;
  const lists = [
    groups.assistant ? { title: "Your assistant", rows: [row("assistant", groups.assistant.name, "Your one chat, always at the top of Chat", <Avatar of={markRef("assistant", groups.assistant.name)} size={40} />)] } : null,
    groups.team.length ? { title: `On ${projectName || "this project"}`, rows: groups.team.map((a) => row(`a:${a.name}`, a.name, "On this project", <Avatar of={markRef("teammate", a.name)} size={40} />)) } : null,
    groups.people.length ? { title: "People", rows: groups.people.map((p) => row(`p:${p.id}`, p.name, p.role || "Person", <Avatar of={markRef("person", p.name)} size={40} />)) } : null,
    groups.agents.length ? { title: "Agents", rows: groups.agents.map((a) => row(`a:${a.name}`, a.name, "Agent", <Avatar of={markRef("teammate", a.name)} size={40} />)) } : null,
  ].filter(Boolean) as { title: string; rows: React.ReactNode[] }[];
  const several = picked.length > 1;
  const onlyPeople = picked.length > 0 && picked.every((k) => k.startsWith("p:"));
  return (
    <Page title="New chat" sub="Who do you want to talk to?" back="/u/chats">
      {loadErr ? <Card><EmptyState title="Your Vyre did not answer" body={loadErr} action={{ label: "Back to Chat", onPress: () => router.replace("/u/chats" as never) }} /></Card>
        : agents === null ? <LoadingState rows={3} />
        : (
          <View className="gap-s3">
            {project ? <View className="flex-row"><Chip onPress={() => setProject("")} accessibilityLabel={`Remove ${projectName || "the project"} from this chat`}>{`In ${projectName || "this project"}  ×`}</Chip></View> : null}
            <Field name="Search" value={q} onChangeText={setQ} placeholder="Search people and agents" />
            {lists.length ? lists.map((g) => (
              <View key={g.title} className="gap-s1">
                <SectionLabel>{g.title}</SectionLabel>
                <Card flush>{g.rows.map((r, i) => <View key={i}>{i ? <Divider /> : null}{r}</View>)}</Card>
              </View>
            )) : <Card><EmptyState title="Nobody matches that" body="Clear the search to see everyone." action={{ label: "Clear", onPress: () => setQ("") }} /></Card>}
            {several ? <Banner tone="plain"><Text>{onlyPeople ? "This is a group chat. The AI answers when someone mentions it." : "This is a group chat with everyone you picked."}</Text></Banner> : null}
            {aboutUrn ? <Banner tone="plain"><Text>{`This chat is about ${typeof name === "string" && name ? name : "that record"}. It stays private to the people in it until you share it on the timeline.`}</Text></Banner> : null}
            <Field label="First message (optional)" value={text} onChangeText={setText} placeholder="What do you want to work on?" multiline />
            {err ? <Banner tone="warn"><Text>{err}</Text></Banner> : null}
            <View className="flex-row"><Button kind="primary" label={busy ? "Starting" : several ? "Start group chat" : "Start chat"} disabled={!picked.length || busy} onPress={() => void start()} /></View>
          </View>
        )}
    </Page>
  );
}
