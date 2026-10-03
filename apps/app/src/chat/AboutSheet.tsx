// "About this chat": what the header leaves out. Who is in it (people and assistants, each with
// their card), the record it belongs to, what the assistant can see and how many fields are sealed,
// where it runs (with a Move action), mute and pin. A bottom sheet on a phone, centred on a wide
// screen; it scrolls when it is tall.
//
// NOTE (native-core): @vyre/ui's Sheet drops its className on @rn-primitives' Content and Overlay in
// the exported web build (computed style is empty: no scrim, no background, no padding), so this
// draws the same sheet with style props from the theme. Swap it for <Sheet> when that is fixed.

import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { Avatar, Button, Chip, Row, Switch, Text, useUiTheme } from "@vyre/ui";
import type { Participant } from "./group.js";

export type AboutInfo = {
  record?: { title: string; type: string } | null;
  space?: string;
  /** How many fields on the tagged records are sealed from assistants. */
  sealed: number;
  runsOn: "mac" | "server";
};

const fam = (f: string) => (f === "assistant" ? "assistant" : f === "model" ? "agent" : "person");

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 4 }}>
      <Text size="caption" tone="label" strong>{label}</Text>
      {children}
    </View>
  );
}

export function AboutSheet({ open, onClose, title, participants, viewer, info, muted, pinned, onMute, onPin, onMove, onOpenTerminal, onOpenParticipant }: {
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
}) {
  const { height } = useWindowDimensions();
  const { color, phone } = useUiTheme();
  const here = info.runsOn === "mac" ? "This Mac" : "The server";
  const there = info.runsOn === "mac" ? "the server" : "this Mac";
  if (!open) return null;
  return (
    <View accessibilityViewIsModal role="dialog" aria-label="About this chat" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, justifyContent: phone ? "flex-end" : "center", alignItems: phone ? "stretch" : "center", zIndex: 50 }}>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: color.scrim ?? "rgba(0,0,0,0.5)" }} />
      <View style={{ backgroundColor: color["surface-3"], borderWidth: 1, borderColor: color["edge-strong"], padding: 16, gap: 12, width: phone ? "100%" : 560, maxWidth: "100%", maxHeight: Math.round(height * 0.92), borderTopLeftRadius: 20, borderTopRightRadius: 20, borderBottomLeftRadius: phone ? 0 : 20, borderBottomRightRadius: phone ? 0 : 20 }}>
      <Text size="title" strong>About this chat</Text>
      <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 16, paddingBottom: 8 }}>
        <Section label={`In this chat (${participants.length})`}>
          {participants.map((p) => (
            <Row
              key={p.id}
              lead={<Avatar name={p.name} family={fam(p.family)} size="md" />}
              title={p.name}
              sub={p.id === viewer ? "You" : p.family === "assistant" ? `Assistant${p.role ? `, ${p.role}` : ""}` : p.role ?? "Person"}
              end={p.family === "assistant" ? <Chip tone="accent">assistant</Chip> : undefined}
              onPress={onOpenParticipant ? () => onOpenParticipant(p.id) : undefined}
              accessibilityLabel={`${p.name}, open card`}
            />
          ))}
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
          {onOpenTerminal ? <Row title="Open full terminal" sub="The shell in this session's folder" onPress={() => { onClose(); onOpenTerminal(); }} /> : null}
        </Section>

      </ScrollView>
      <View style={{ borderTopWidth: 1, borderTopColor: color.edge, paddingTop: 8, gap: 2 }}>
        <Row title="Mute" sub="No alerts from this chat. Mentions still reach you." end={<Switch on={muted} onChange={onMute} label="Mute this chat" />} />
        <Row title="Pin" sub="Keep it at the top of Chat." end={<Switch on={pinned} onChange={onPin} label="Pin this chat" />} />
      </View>
      <Button kind="ghost" label="Close" onPress={onClose} />
      </View>
    </View>
  );
}
