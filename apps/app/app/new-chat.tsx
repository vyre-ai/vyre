import { useEffect, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { agentsList, providers } from "../screens/settings/real";
import { SURFACE } from "../src/state/live";
import { tool } from "../src/real/box";
import { agentChoices, defaultAccount, startInput, threadIdOf } from "../src/state/new-chat-model.js";
import { useTheme } from "../src/theme/theme";
import { tokens } from "../src/theme/tokens";
import { type } from "../src/theme/type";
import { Button } from "../src/ui/Button";
import { ListRow } from "../src/ui/Row";
import { Empty, Screen } from "../src/ui/Screen";
import { Text } from "react-native";

/** New chat: pick an agent (your assistant is the default), say what you want first if you like, and start. threads.start runs as you, naming the agent and the AI account; the new session opens. */
export default function NewChat() {
  const { color } = useTheme();
  const router = useRouter();
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
    const r = startInput({ agent, account, text, root, surface: SURFACE });
    if ("error" in r) { setErr(r.error); return; }
    setBusy(true); setErr("");
    try {
      const id = threadIdOf(await tool("threads.start", r.input));
      if (!id) throw new Error("The chat started but Vyre did not say which one. Open it from Chats.");
      router.replace({ pathname: "/session/[id]", params: { id } });
    } catch (e) { setErr(e instanceof Error ? e.message : "The chat did not start."); } finally { setBusy(false); }
  };
  return (
    <Screen title="New chat" back backTo="Chats">
      <Stack.Screen options={{ presentation: "modal" }} />
      {loadErr ? <Empty text="Your Vyre did not answer" line={loadErr} action={{ label: "Back to Chats", onPress: () => router.back() }} />
        : agents === null ? <Empty text="Asking your Vyre" />
        : !agents.length ? <Empty text="No assistants yet" line="A chat needs an assistant to talk to." action={{ label: "Connect your AI account", onPress: () => router.replace("/u/settings/ai" as never) }} />
        : (
          <View>
            <Text style={[type.meta, styles.label, { color: color.label }]}>Chat with</Text>
            {agents.map((a) => <ListRow key={a.name} testID={`new-chat-${a.name}`} title={a.name} meta={a.assistant ? "Your assistant" : "Agent"} selected={pick === a.name} onPress={() => setPick(a.name)} />)}
            <Text style={[type.meta, styles.label, { color: color.label }]}>First message (optional)</Text>
            <TextInput testID="new-chat-text" value={text} onChangeText={setText} multiline placeholder="What do you want to work on?" placeholderTextColor={color.label} style={[type.read, styles.input, { color: color.text, borderColor: color.rule }]} />
            {err ? <Text style={[type.base, styles.err, { color: color.text2 }]}>{err}</Text> : null}
            <View style={styles.action}><Button kind="primary" label="Start chat" busy={busy} busyLabel="Starting" disabled={!pick || busy} onPress={() => void start()} /></View>
          </View>
        )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { paddingHorizontal: tokens.layout.gutterPhone, paddingTop: tokens.space[4], paddingBottom: tokens.space[2] },
  input: { marginHorizontal: tokens.layout.gutterPhone, minHeight: 88, borderWidth: StyleSheet.hairlineWidth, borderRadius: tokens.space[3], padding: tokens.space[3], textAlignVertical: "top" },
  err: { paddingHorizontal: tokens.layout.gutterPhone, paddingTop: tokens.space[3] },
  action: { padding: tokens.layout.gutterPhone, alignSelf: "flex-start" },
});
