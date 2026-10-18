// Forward…: the message goes into another chat or an agent as a quoted forward ("Forwarded from <chat>"), sent like any message (so it is encrypted on this device like one). Forwarding to an agent
// starts a new thread for it. The same people-and-agents choice as the New menu.
import { useMemo, useState } from "react";
import { View } from "react-native";
import { Avatar, Field, Row, Sheet, Text, allowsMock, markRef, newMenuRows, showToast } from "@vyre/ui";
import type { Convo } from "@vyre/ui";
import { useChats } from "../state/chats";
import { useConvos } from "../../screens/chats/useConvos";
import { startChat } from "../state/start-chat";
import { agentThreads } from "./threads-source";
import { boxStream } from "./box-stream";
import { forwardText } from "./forward-model.js";

export function ForwardSheet({ open, text, from, onClose }: { open: boolean; text: string; from: string; onClose: () => void }) {
  const chats = useChats();
  const convos = useConvos(chats.rows);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(convos.map((c) => [c.id, c])), [convos]);
  const rows = useMemo(() => newMenuRows(q, convos.filter((c) => c.lone === "agent").map((c) => ({ id: c.id, name: c.title })), convos.filter((c) => c.lone === "person").map((c) => ({ id: c.id, name: c.title }))), [q, convos]);
  const groups = convos.filter((c) => c.kind === "group" && c.title.toLowerCase().includes(q.trim().toLowerCase()));
  const send = async (chat: string, label: string) => { const why = await boxStream(chat).sendText(forwardText(text, from)); showToast(why ? `Not forwarded: ${why}` : `Forwarded to ${label}.`); };
  const go = async (c: Convo | undefined, label: string, kind: "agent" | "person" | "group") => {
    if (busy) return;
    if (allowsMock()) { showToast(`Forwarded to ${label}.`); onClose(); return; }
    setBusy(true);
    try {
      if (kind === "agent") { const r = await agentThreads.start(label); if ("problem" in r) showToast(r.problem); else await send(r.thread, `${label} in a new thread`); }
      else if (c?.chat) await send(c.chat, label);
      else if (c) { const made = await startChat({ people: c.person ? [c.person] : [], agents: [] }); if ("chat" in made) await send(made.chat, label); else showToast(made.say); }
      onClose();
    } finally { setBusy(false); }
  };
  if (!open) return null;
  const face = (kind: "agent" | "person", id: string, name: string) => <Avatar of={markRef(kind, name, id)} size={32} />;
  return (
    <Sheet open onClose={onClose} title="Forward to">
      <View style={{ gap: 8 }}>
        <Field name="To" value={q} onChangeText={setQ} placeholder="A person, a group or an agent" autoFocus />
        {rows.agents.length ? <Text size="caption" tone="label">Agents, each starts a new thread</Text> : null}
        {rows.agents.map((r) => <Row key={r.id} dense lead={face("agent", r.id, r.label)} title={r.label} onPress={() => void go(byId.get(r.id), r.label, "agent")} />)}
        {rows.people.length ? <Text size="caption" tone="label">People</Text> : null}
        {rows.people.map((r) => <Row key={r.id} dense lead={face("person", r.id, r.label)} title={r.label} onPress={() => void go(byId.get(r.id), r.label, "person")} />)}
        {groups.length ? <Text size="caption" tone="label">Groups</Text> : null}
        {groups.map((c) => <Row key={c.id} dense title={c.title} sub={c.sub} onPress={() => void go(c, c.title, "group")} />)}
      </View>
    </Sheet>
  );
}
