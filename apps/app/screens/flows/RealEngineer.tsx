// @Engineer: the assistant you talk to ("make me an intake Flow for estate leads"). It proposes Flows, types and Kits; each lands as a card you approve. The conversation is the app's chat
// on the Engineer's thread (src/chat, over threads.send); the cards are what the box lists as waiting. Owners and admins only.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, EmptyState, Field, Row, Text, showToast } from "@vyre/ui";
import { ChatScreen } from "../../src/chat/ChatScreen";
import { Frame } from "../places/Frame";
import { ENGINEER, INSTRUCTIONS, engineerRefusal, findEngineer, mayTalk, proposals, stateOf, type Agent } from "./assistant-model";
import { createEngineer, listAgents, listFlowRows, listKitRows, myRole, sayToEngineer } from "./assistant";

type Wait = { key: string; title: string; sub: string; href: string | null };
const said = (e: unknown) => engineerRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");

export function RealEngineer() {
  const router = useRouter();
  const [role, setRole] = useState<string | null>(null);
  const [agent, setAgent] = useState<Agent | null | undefined>(undefined);
  const [waiting, setWaiting] = useState<Wait[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    setErr("");
    myRole().then(setRole).catch(() => setRole("member"));
    listAgents().then((a) => setAgent(findEngineer(a))).catch((e) => { setErr(said(e)); setAgent(null); });
    Promise.all([listFlowRows().catch(() => []), listKitRows().catch(() => [])]).then(([f, k]) => setWaiting(proposals(f, k)));
  }, []);
  useEffect(load, [load]);
  // What is waiting is read when the page opens, when you come back, and once a minute while it is open: never faster.
  useEffect(() => { const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const setup = () => { setBusy(true); createEngineer(ENGINEER, INSTRUCTIONS).then(() => { showToast("@Engineer is set up."); load(); }).catch((e) => setErr(said(e))).finally(() => setBusy(false)); };
  const send = () => { const t = text.trim(); if (!t) return; setBusy(true); sayToEngineer(agent?.name ?? ENGINEER, t).then(() => { setText(""); load(); }).catch((e) => setErr(said(e))).finally(() => setBusy(false)); };

  const head = (
    <View className="flex-row flex-wrap items-center gap-s2"><Chip tone="accent" icon="play">Admins only</Chip><Chip>Proposes, never acts</Chip><Chip>Cannot send, pay or read the vault</Chip></View>
  );
  if (role !== null && !mayTalk(role)) {
    return <Frame back="/u/flows" title="@Engineer" sub="Describe a process in plain words.">{head}<Card><EmptyState title="Only space admins can talk to @Engineer" body="Ask an admin of this space, or open Flows to read what it built." /></Card></Frame>;
  }
  const state = agent === undefined ? null : stateOf(agent);
  const cards = waiting.length ? (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">Waiting for you</Text>
      <Card flush>{waiting.map((w) => <Row key={w.key} dense title={w.title} sub={w.sub} chevron={!!w.href} onPress={w.href ? () => router.push(w.href as never) : undefined} />)}</Card>
    </View>
  ) : null;

  if (state === "ready" && agent?.thread) {
    return (
      <View style={{ flex: 1, minHeight: 0 }}>
        {cards ? <View className="p-s3">{cards}</View> : null}
        <ChatScreen sessionId={agent.thread} title="@Engineer" onBack={() => router.push("/u/flows" as never)} onBranched={(id) => router.push({ pathname: "/session/[id]", params: { id } } as never)} />
      </View>
    );
  }
  return (
    <Frame back="/u/flows" title="@Engineer" sub="Describe a process in plain words.">
      {head}
      {err ? <Banner tone="warn"><Text>{err}</Text></Banner> : null}
      {state === null ? <Card><EmptyState title="Loading" body="Asking your Vyre." /></Card> : null}
      {state === "none" ? (
        <Card>
          <View className="gap-s3">
            <Text strong>Set up @Engineer</Text>
            <Text tone="muted">@Engineer is an assistant you talk to. It proposes Flows, record types and Kits for you to approve, and never acts on its own.</Text>
            <View className="self-start"><Button kind="primary" label={busy ? "Setting up" : "Set up @Engineer"} disabled={busy} onPress={setup} /></View>
          </View>
        </Card>
      ) : null}
      {state === "new" ? (
        <Card>
          <View className="gap-s3">
            <Text strong>Tell @Engineer what you need</Text>
            <Field label="Your message" multiline lines={4} value={text} onChangeText={setText} placeholder="Make me an intake Flow for estate leads." />
            <View className="self-start"><Button kind="primary" label={busy ? "Sending" : "Send"} disabled={busy || !text.trim()} onPress={send} /></View>
          </View>
        </Card>
      ) : null}
      {cards}
    </Frame>
  );
}
