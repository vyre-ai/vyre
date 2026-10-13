// A publish an agent asked for, waiting for the person's one yes. The same card sits on Now (the item's page) and in the chat where the agent asked. It shows the plan in the box's own words
// (what goes public, at which address, with which secrets, replacing which version); the yes calls publish.decide with the plan's hash, and the box asks for Face ID or the click.
import { useState } from "react";
import { Linking, Platform, View } from "react-native";
import { AskCard, Banner, Button, Text } from "@vyre/ui";
import { presenceText } from "../../screens/shell/FaceIdSheet";
import { decision, planLines, publishRefusal, type Held } from "../../screens/sites/real-model";
import { setNeeds, needsStore, type Need } from "../state/needs";
import { tool } from "../real/box";
import { addressOf } from "./preview-model.js";

type Step = { kind: "asking" } | { kind: "deciding" } | { kind: "done"; address: string } | { kind: "declined" } | { kind: "problem"; text: string };

const heldOf = (n: Need): Held | null => (n.plan && n.planHash ? ({ held: true, task: n.ref, plan: { ...(n.plan as object), hash: n.planHash } } as Held) : null);
const leave = (n: Need) => setNeeds(needsStore.get().items.filter((x) => x.id !== n.id), needsStore.get().from === "cache" ? "cache" : "box");
const open = (a: string) => { const url = /^https?:/.test(a) ? a : `https://${a}`; if (Platform.OS === "web") window.open(url, "_blank", "noopener"); else void Linking.openURL(url); };

export function PublishHold({ need, who }: { need: Need; who?: string }) {
  const [step, setStep] = useState<Step>({ kind: "asking" });
  const held = heldOf(need);
  if (!held) return null;
  const hold = planLines(held.plan);
  const decide = (approve: boolean) => {
    if (!approve) { void tool("publish.decide", decision(held, false)).catch(() => {}); setStep({ kind: "declined" }); leave(need); return; }
    setStep({ kind: "deciding" });
    tool<{ deployment?: { url?: string | null; domains?: { host: string }[] } }>("publish.decide", decision(held, true))
      .then((r) => { setStep({ kind: "done", address: addressOf(r.deployment ?? null) }); leave(need); })
      .catch((e) => setStep({ kind: "problem", text: publishRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "") }));
  };
  if (step.kind === "done") {
    return (
      <View style={{ gap: 8 }}>
        <Banner><Text>{step.address ? `It is live at ${step.address}.` : "It is live."}</Text></Banner>
        {step.address ? <View style={{ flexDirection: "row" }}><Button kind="primary" icon="external" label="Open it" onPress={() => open(step.address)} /></View> : null}
      </View>
    );
  }
  if (step.kind === "declined") return <Text tone="label">Not published. Nothing changed.</Text>;
  return (
    <View style={{ gap: 8 }}>
      <AskCard title={hold.title} why={[who ? `${who} asked for this.` : "", ...hold.lines].filter(Boolean).join(" ")}
        actions={[
          { label: step.kind === "deciding" ? "Putting it live" : presenceText("Put it on the internet"), kind: "primary", icon: "faceid", onPress: step.kind === "deciding" ? () => {} : () => decide(true) },
          { label: "Not now", kind: "ghost", onPress: () => decide(false) },
        ]} />
      {step.kind === "problem" ? <Banner tone="warn"><Text>{step.text}</Text></Banner> : null}
    </View>
  );
}
