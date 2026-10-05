// "In this chat": what the header leaves out. Who is in it (people and assistants, each with
// their card), the record it belongs to, what the assistant can see and how many fields are sealed,
// where it runs (with a Move action), mute and pin. A bottom sheet on a phone, centred on a wide
// screen; it scrolls when it is tall.

import { useState } from "react";
import { View } from "react-native";
import { Button, Chip, Row, Sheet, Switch, Text, useUiTheme } from "@vyre/ui";
import { Face } from "./Face";
import type { Participant } from "./group.js";

export type AboutInfo = {
  record?: { title: string; type: string } | null;
  space?: string;
  /** How many fields on the tagged records are sealed from assistants. */
  sealed: number;
  runsOn: "mac" | "server";
};

const fam = (f: string) => (f === "assistant" ? "assistant" : f === "model" ? "model" : "person");

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 4 }}>
      <Text size="caption" tone="label" strong>{label}</Text>
      {children}
    </View>
  );
}

export function AboutSheet({ open, onClose, title, participants, viewer, info, muted, pinned, onMute, onPin, onMove, onOpenTerminal, onOpenParticipant, addable, onAdd }: {
  open: boolean;
  onClose: () => void;
  title: string;
  participants: readonly Participant[];
  viewer: string;
  info: AboutInfo;
  muted: boolean;
  pinned: boolean;
  onMute: (on: boolean) => void;
  onPin: (on: boolean) => void;
  onMove?: () => void;
  onOpenTerminal?: () => void;
  onOpenParticipant?: (id: string) => void;
  /** Teammates who could be added (people and assistants not in the chat), and the add. Both absent: the chat cannot change who is in it here. */
  addable?: readonly { name: string; id?: string; family: string }[];
  onAdd?: (who: { name: string; id?: string; family: string }) => Promise<string | null>;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const { color } = useUiTheme();
  const here = info.runsOn === "mac" ? "This Mac" : "The server";
  const there = info.runsOn === "mac" ? "the server" : "this Mac";
  return (
    <Sheet open={open} onClose={onClose} title="In this chat">
      <View style={{ gap: 16, paddingBottom: 8 }}>
        <Section label={`In this chat (${participants.length})`}>
          {participants.map((p) => (
            <Row
              key={p.id}
              lead={<Face name={p.name} family={fam(p.family)} size={32} id={p.id} />}
              title={p.name}
              sub={p.id === viewer ? "You" : p.family === "assistant" ? `Assistant${p.role ? `, ${p.role}` : ""}` : p.role ?? "Person"}
              onPress={onOpenParticipant ? () => onOpenParticipant(p.id) : undefined}
              accessibilityLabel={`${p.name}, open card`}
            />
          ))}
          {onAdd && addable ? (
            adding ? (
              <View style={{ gap: 4 }}>
                {addable.length ? addable.map((a) => (
                  <Row key={a.id ?? a.name} lead={<Face name={a.name} family={fam(a.family)} size={32} id={a.id ?? a.name} />} title={a.name} sub={a.family === "assistant" ? "Assistant" : "Person"}
                    end={<Button size="sm" kind="secondary" label="Add" loading={busy === (a.id ?? a.name)} onPress={async () => { setBusy(a.id ?? a.name); setProblem(""); const r = await onAdd(a); setBusy(""); if (r) setProblem(r); else setAdding(false); }} />} />
                )) : <Text tone="muted">Everyone you can add is already in this chat.</Text>}
                {problem ? <Text tone="err">{problem}</Text> : null}
              </View>
            ) : <View style={{ flexDirection: "row", paddingHorizontal: 12 }}><Button size="sm" kind="secondary" icon="plus" label="Add a teammate" onPress={() => { setProblem(""); setAdding(true); }} /></View>
          ) : null}
        </Section>

        <Section label="Record">
          {info.record ? <Row title={info.record.title} sub={`${info.record.type}${info.space ? " in " + info.space : ""}`} /> : <Text tone="muted">Not attached to a record. Type # and a record name in a message to attach one.</Text>}
        </Section>

        <Section label="What assistants can see">
          <Text tone="muted">This chat and the records you tag, with the grants of whoever asked.</Text>
          <View style={{ flexDirection: "row", paddingTop: 4 }}>
            <Chip tone="sealed" icon="shield">{info.sealed > 0 ? `${info.sealed} sealed field${info.sealed === 1 ? "" : "s"}, never shown` : "No sealed fields here"}</Chip>
          </View>
        </Section>

        <Section label="Where it runs">
          <Row title={here} sub={`Or on ${there}`} />
          {onMove ? <View style={{ flexDirection: "row", paddingHorizontal: 12 }}><Button size="sm" kind="secondary" label={`Move to ${there}`} onPress={onMove} /></View> : null}
          {onOpenTerminal ? <Row title="Open full terminal" sub="The shell in this chat's folder" onPress={() => { onClose(); onOpenTerminal(); }} /> : null}
        </Section>

      <View style={{ borderTopWidth: 1, borderTopColor: color.edge, paddingTop: 8, gap: 2 }}>
        <Row title="Mute" sub="No alerts from this chat. Mentions still reach you." end={<Switch on={muted} onChange={onMute} label="Mute this chat" />} />
        <Row title="Pin" sub="Keep it at the top of Chat." end={<Switch on={pinned} onChange={onPin} label="Pin this chat" />} />
      </View>
      </View>
    </Sheet>
  );
}
