import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import { Button, Field, FlowStep, Text } from "@vyre/ui";
import { afterSpace } from "../../../../lib/first-run-shape.js";
import { MOCK } from "../../src/real/box";
import { encodePhoto, pickPhoto } from "../../src/state/profile-photo";
import { useProfiles } from "../../src/state/profiles";
import { AFTER_COPY } from "./after-space-copy.js";
import { photoOffer, photoSkipped, saveChosenPhoto, spaceForPhoto } from "./after-space-photo.js";
import { firstChat, identityHere, listSpaces, setDisplayName } from "./real.js";

type Next = "setup.photo" | "setup.assistant" | "setup.chat" | "ready";

/** The square GitHub already gave, measured so the same centre-crop the picker uses can save it. */
function measurePhoto(uri: string): Promise<{ uri: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => {
      if (!(width > 0) || !(height > 0)) reject(new Error("That photo could not be read. Choose one from this computer."));
      else resolve({ uri, width, height });
    }, () => reject(new Error("That photo could not be read. Choose one from this computer.")));
  });
}

/** The three steps added after a Space is online. The assistant and the model stay in FirstRun. */
export function AfterSpace({ screen, steps, back, backLabel, failure, busy, first, last, space, go, run, setFailure }: {
  screen: "setup.name" | "setup.photo" | "setup.chat";
  steps: { labels: string[]; current: number; kind: "phase" };
  back?: () => void;
  backLabel: string;
  failure: string;
  busy: boolean;
  first: string;
  last: string;
  /** The Space just made. Empty on a resumed step: the list's current Space is used then. */
  space: string;
  go: (next: Next) => void;
  run: (fn: () => Promise<void>) => void;
  setFailure: (s: string) => void;
}) {
  const [name, setName] = useState(`${first} ${last}`.replace(/\s+/g, " ").trim());
  const [listed, setListed] = useState("");
  const [offer, setOffer] = useState(() => photoOffer(null));
  const [text, setText] = useState("");
  const spaceId = space || listed;

  useEffect(() => {
    if (screen !== "setup.chat") return;
    let live = true;
    void firstChat().then((r) => { if (live) setText(r.ok ? String((r as { text?: string }).text || "") : r.message); });
    return () => { live = false; };
  }, [screen]);

  useEffect(() => {
    if (screen !== "setup.photo") return;
    let live = true;
    void identityHere().then((r) => { if (live) setOffer(photoOffer(r.ok ? r : null)); });
    if (!space) void listSpaces().then((r) => { if (live && r.ok) setListed(spaceForPhoto("", r)); });
    return () => { live = false; };
  }, [screen, space]);

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
    const keep = async (pick: { uri?: string; width: number; height: number }) => {
      if (!MOCK && !spaceId) throw new Error("This Space is not ready for a photo yet. Skip for now.");
      await saveChosenPhoto(pick, spaceId || "sample", name.trim(), encodePhoto, MOCK
        ? async () => {}
        : (s, pic, n) => useProfiles.getState().setPhoto(s, pic, n));
      go(photoSkipped() as Next);
    };
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={AFTER_COPY.photoTitle} lead={AFTER_COPY.photoLead} failure={failure}
        secondary={{ label: offer.skip, onPress: () => go(photoSkipped() as Next) }}
        primary={{ label: offer.choose, loading: busy, disabled: busy, onPress: () => void run(async () => {
          const pick = await pickPhoto();
          if (!pick) return;
          await keep(pick);
        }) }}>
        {offer.github ? (
          <View style={{ alignItems: "center", alignSelf: "stretch", gap: 12 }}>
            <View style={{ width: 96, height: 96, borderRadius: 48, overflow: "hidden" }}>
              <Image source={{ uri: offer.github.photo }} accessibilityLabel="Your GitHub photo" accessibilityIgnoresInvertColors style={{ width: 96, height: 96 }} />
            </View>
            <Button kind="secondary" size="lg" className="w-full" label={offer.github.label} disabled={busy} onPress={() => { const photo = offer.github ? offer.github.photo : ""; void run(async () => { await keep(await measurePhoto(photo)); }); }} />
          </View>
        ) : null}
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
