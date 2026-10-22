import { useEffect, useState } from "react";
import { Field, FlowStep, Text } from "@vyre/ui";
import { afterSpace } from "../../../../lib/first-run-shape.js";
import { AFTER_COPY } from "./after-space-copy.js";
import { firstChat, setDisplayName, setPhoto } from "./real.js";

type Next = "setup.photo" | "setup.assistant" | "setup.chat" | "ready";

/** The three steps added after a Space is online. The assistant and the model stay in FirstRun. */
export function AfterSpace({ screen, steps, back, backLabel, failure, busy, first, last, go, run, setFailure }: {
  screen: "setup.name" | "setup.photo" | "setup.chat";
  steps: { labels: string[]; current: number; kind: "phase" };
  back?: () => void;
  backLabel: string;
  failure: string;
  busy: boolean;
  first: string;
  last: string;
  go: (next: Next) => void;
  run: (fn: () => Promise<void>) => void;
  setFailure: (s: string) => void;
}) {
  const [name, setName] = useState(`${first} ${last}`.replace(/\s+/g, " ").trim());
  const [photo, setPhotoUrl] = useState("");
  const [text, setText] = useState("");

  useEffect(() => {
    if (screen !== "setup.chat") return;
    let live = true;
    void firstChat().then((r) => { if (live) setText(r.ok ? String((r as { text?: string }).text || "") : r.message); });
    return () => { live = false; };
  }, [screen]);

  if (screen === "setup.name") {
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={AFTER_COPY.nameTitle} lead={AFTER_COPY.nameLead} failure={failure}
        primary={{ label: AFTER_COPY.continue, loading: busy, disabled: busy || !name.trim(), onPress: () => void run(async () => {
          const r = await setDisplayName(name.trim());
          if (!r.ok) { setFailure(r.message); return; }
          go(afterSpace("setup.name") as Next);
        }) }}>
        <Field label={AFTER_COPY.nameLabel} value={name} onChangeText={setName} />
      </FlowStep>
    );
  }

  if (screen === "setup.photo") {
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={AFTER_COPY.photoTitle} lead={AFTER_COPY.photoLead} failure={failure}
        secondary={{ label: AFTER_COPY.photoSkip, onPress: () => go(afterSpace("setup.photo") as Next) }}
        primary={{ label: AFTER_COPY.continue, loading: busy, disabled: busy || !photo.trim(), onPress: () => void run(async () => {
          const r = await setPhoto(photo.trim());
          if (!r.ok) { setFailure(r.message); return; }
          go(afterSpace("setup.photo") as Next);
        }) }}>
        <Field label={AFTER_COPY.photoLabel} value={photo} onChangeText={setPhotoUrl} placeholder="https://" />
      </FlowStep>
    );
  }

  return (
    <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={AFTER_COPY.chatTitle} lead={AFTER_COPY.chatLead} failure={failure}
      primary={{ label: AFTER_COPY.continue, loading: busy, disabled: busy || !text, onPress: () => go("ready") }}>
      {text ? <Text>{text}</Text> : <Text tone="muted">{AFTER_COPY.chatWait}</Text>}
    </FlowStep>
  );
}
