// Publish from a preview card (R032-07): one tap builds the folder as a site and asks for the one yes; the yes puts it live and the card shows the address. The words of the plan are the box's
// own (screens/sites/real-model planLines); nothing here names a tool, a path or a task.
import { useEffect, useRef, useState } from "react";
import { Linking, Platform, View } from "react-native";
import { AskCard, Banner, Button, Sheet, Text } from "@vyre/ui";
import { presenceText } from "../../screens/shell/FaceIdSheet";
import { decision, heldOf, planLines, publishRefusal, type Held } from "../../screens/sites/real-model";
import { tool } from "../real/box";
import { addressOf, publishWords, siteNameOf } from "./preview-model.js";

export type Step = { kind: "building" } | { kind: "asking"; held: Held; later: string } | { kind: "deciding"; held: Held; later: string } | { kind: "done"; address: string; later: string } | { kind: "declined" } | { kind: "problem"; text: string };

const say = (e: unknown) => publishRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");

export function PublishSheet({ open, onClose, preview }: { open: boolean; onClose: () => void; preview: { id: string; title: string } }) {
  const [step, setStep] = useState<Step>({ kind: "building" });
  const started = useRef(false);
  useEffect(() => {
    if (!open) { started.current = false; return; }
    if (started.current) return;
    started.current = true;
    setStep({ kind: "building" });
    tool<any>("publish.quick", { name: siteNameOf(preview.title), preview: preview.id })
      .then((r) => { const held = heldOf(r); setStep(held ? { kind: "asking", held, later: publishWords(r).later } : { kind: "problem", text: "Publishing did not ask for your yes. Nothing went live." }); })
      .catch((e) => setStep({ kind: "problem", text: say(e) }));
  }, [open, preview.id, preview.title]);
  const decide = (held: Held, later: string, approve: boolean) => {
    if (!approve) { void tool("publish.decide", decision(held, false)).catch(() => {}); setStep({ kind: "declined" }); return; }
    setStep({ kind: "deciding", held, later });
    tool<{ deployment?: { url?: string | null; domains?: { host: string }[] } }>("publish.decide", decision(held, true))
      .then((r) => setStep({ kind: "done", address: addressOf(r.deployment ?? null), later }))
      .catch((e) => setStep({ kind: "problem", text: say(e) }));
  };
  const openAddress = (a: string) => { const url = /^https?:/.test(a) ? a : `https://${a}`; if (Platform.OS === "web") window.open(url, "_blank", "noopener"); else void Linking.openURL(url); };
  return (
    <Sheet open={open} onClose={onClose} title={`Publish ${preview.title}`}>
      <PublishView step={step} onApprove={(h, l) => decide(h, l, true)} onDecline={(h, l) => decide(h, l, false)} onOpen={openAddress} onClose={onClose} />
    </Sheet>
  );
}

/** What the sheet shows at each step; the container above makes the calls. */
export function PublishView({ step, onApprove, onDecline, onOpen, onClose }: { step: Step; onApprove: (held: Held, later: string) => void; onDecline: (held: Held, later: string) => void; onOpen: (address: string) => void; onClose: () => void }) {
  return (
    <View style={{ gap: 12 }}>
        {step.kind === "building" ? <Text tone="label">Building your site. Nothing is public yet.</Text> : null}
        {step.kind === "asking" || step.kind === "deciding" ? (() => {
          const hold = planLines(step.held.plan);
          return (
            <>
              <AskCard title={hold.title} why={hold.lines.join(" ")}
                actions={[{ label: step.kind === "deciding" ? "Putting it live" : presenceText("Put it on the internet"), kind: "primary", icon: "faceid", onPress: step.kind === "deciding" ? () => {} : () => onApprove(step.held, step.later) }, { label: "Not now", kind: "ghost", onPress: () => onDecline(step.held, step.later) }]} />
              {step.later ? <Text size="caption" tone="label">{step.later}</Text> : null}
            </>
          );
        })() : null}
        {step.kind === "done" ? (
          <>
            <Banner><Text>{step.address ? `It is live at ${step.address}.` : "It is live."}</Text></Banner>
            {step.later ? <Text size="caption" tone="label">{step.later}</Text> : null}
            <View style={{ flexDirection: "row", gap: 8 }}>
              {step.address ? <Button kind="primary" icon="external" label="Open it" onPress={() => onOpen(step.address)} /> : null}
              <Button kind="ghost" label="Done" onPress={onClose} />
            </View>
          </>
        ) : null}
        {step.kind === "declined" ? <><Text tone="label">Not published. Your preview is as it was.</Text><View style={{ flexDirection: "row" }}><Button kind="ghost" label="Close" onPress={onClose} /></View></> : null}
        {step.kind === "problem" ? <><Banner tone="warn"><Text>{step.text}</Text></Banner><View style={{ flexDirection: "row" }}><Button kind="ghost" label="Close" onPress={onClose} /></View></> : null}
    </View>
  );
}
