import { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Divider, EmptyState, Field, LoadingState, Row, Text, markRef } from "@vyre/ui";
import { Page } from "../places/Frame";
import { agentsList, providers } from "../settings/real";
import { SURFACE } from "../../src/state/live";
import { tool } from "../../src/real/box";
import { agentChoices, defaultAccount, isProjectRecordId, slugFromRef, startInput, threadIdOf } from "../../src/state/new-chat-model.js";

/** /u/chats/new: pick an agent (your assistant is the default), say what you want first if you like, and start. threads.start runs as you, naming the agent and the AI account; the new session opens. */
export default function NewChatScreen() {
  const router = useRouter();
  // From a project's Chats card the project comes in the address (?project=<short name>); the chat is filed there.
  const { project: projectParam } = useLocalSearchParams<{ project?: string }>();
  const project = typeof projectParam === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(projectParam) ? projectParam : null;
  const [projectName, setProjectName] = useState("");
  useEffect(() => { if (project) tool<{ name?: string }>("work.project.ref", { project }).then((r) => setProjectName(String(r?.name ?? ""))).catch(() => {}); }, [project]);
  const [agents, setAgents] = useState<ReturnType<typeof agentChoices> | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [loadErr, setLoadErr] = useState("");
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [a, p, d] = await Promise.all([agentsList(), providers().catch(() => []), tool<{ roots?: { path?: string }[] }>("files.dirs", {}).catch(() => null)]);
        if (!live) return;
        const c = agentChoices(a);
        setAgents(c); setPick(c[0]?.name ?? null); setAccount(defaultAccount(p)); setRoot(d?.roots?.[0]?.path ?? null);
      } catch (e) { if (live) setLoadErr(e instanceof Error ? e.message : "Your Vyre did not answer."); }
    })();
    return () => { live = false; };
  }, []);
  const start = async () => {
    const agent = agents?.find((a) => a.name === pick) ?? null;
    // A project's page names it by its record id; threads.start takes the short name, which the box gives for the id.
    let slug = project;
    if (project && isProjectRecordId(project)) {
      slug = slugFromRef(await tool("work.project.ref", { project }).catch(() => null));
      if (!slug) { setErr("That project is not here any more."); return; }
    }
    const r = startInput({ agent, account, text, root, surface: SURFACE, project: slug });
    if ("error" in r) { setErr(r.error); return; }
    setBusy(true); setErr("");
    try {
      const id = threadIdOf(await tool("threads.start", r.input));
      if (!id) throw new Error("The chat started but Vyre did not say which one. Open it from Chat.");
      router.replace({ pathname: "/u/chats/[id]", params: { id } });
    } catch (e) { setErr(e instanceof Error ? e.message : "The chat did not start."); } finally { setBusy(false); }
  };
  return (
    <Page title="New chat" sub={project ? `In the project ${projectName || "you opened this from"}. Who do you want to talk to?` : "Who do you want to talk to?"} back="/u/chats">
      {loadErr ? <Card><EmptyState title="Your Vyre did not answer" body={loadErr} action={{ label: "Back to Chat", onPress: () => router.replace("/u/chats" as never) }} /></Card>
        : agents === null ? <LoadingState rows={3} />
        : !agents.length ? <Card><EmptyState title="No assistants yet" body="A chat needs an assistant to talk to." action={{ label: "Connect your AI account", onPress: () => router.replace("/u/settings/ai" as never) }} /></Card>
        : (
          <View className="gap-s3">
            <Card flush>
              {agents.map((a, i) => (
                <View key={a.name}>{i ? <Divider /> : null}
                  <Row lead={<Avatar of={markRef(a.assistant ? "assistant" : "agent", a.name)} size={40} />} title={a.name} sub={a.assistant ? "Your assistant" : "Agent"} selected={pick === a.name} onPress={() => setPick(a.name)} />
                </View>
              ))}
            </Card>
            <Field label="First message (optional)" value={text} onChangeText={setText} placeholder="What do you want to work on?" multiline />
            {err ? <Banner tone="warn"><Text>{err}</Text></Banner> : null}
            <View className="flex-row"><Button kind="primary" label={busy ? "Starting" : "Start chat"} disabled={!pick || busy} onPress={() => void start()} /></View>
          </View>
        )}
    </Page>
  );
}
