import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, Ring, Row, Text, type IconName, IconTile } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useDevices } from "./state";
import { COPY, DEFAULT_NAMES, lastStep, showsRing, stepLine, stepWords, wordsStep, type DeviceKind } from "./wink.js";
import { installLine } from "../install/first-run.js";
import { shell } from "../../src/shell/shell";
import { PairEntry, PairWords, openPairing, type LongCode } from "./PairParts";
import { SAMPLE_CODE } from "../../src/api/wink-code";
import { wordsLine, type PairingSession } from "../../src/api/pairing-session";
import { MOCK } from "../../src/real/box";
import { RealAdd } from "./RealAdd";

const KINDS: { id: DeviceKind; icon: IconName; title: string; body: string }[] = [
  { id: "phone", icon: "phone", title: "A phone", body: "Open Vyre on it and scan." },
  { id: "computer", icon: "laptop", title: "A computer", body: "Scan its code, then confirm three words." },
  { id: "server", icon: "box", title: "Another computer", body: "One that stays on, to take heavy work." },
];
const FP = "7KQM 4P2X";

function Screen({ cap, dim, children }: { cap: string; dim?: boolean; children: React.ReactNode }) {
  return (
    <Card className={`min-w-menu flex-1 items-center gap-s3 ${dim ? "opacity-60" : ""}`}>
      <Text size="caption" strong tone="label">{cap}</Text>
      {children}
    </Card>
  );
}

/** Add a device: pick the kind, then two screens side by side. Scan or paste, then confirm the same three words on both. */
export function WinkAdd() {
  const router = useRouter();
  const addDevice = useDevices((s) => s.addDevice);
  const [kind, setKind] = useState<DeviceKind | null>(null);
  const [step, setStep] = useState(0);
  const [session, setSession] = useState<PairingSession | null>(null);
  const [said, setSaid] = useState("");
  const reset = () => { setKind(null); setStep(0); setSession(null); };
  const restart = (say = "") => { setStep(0); setSession(null); setSaid(say); };

  if (!kind) {
    return (
      <Page title="Add a device" sub="What are you adding?" back="/u/wink">
        <Card flush>
          {KINDS.map((k, i) => <View key={k.id}>{i ? <View className="h-px bg-edge" /> : null}<Row lead={<IconTile name={k.icon} size={40} />} title={k.title} sub={k.body} onPress={() => setKind(k.id)} /></View>)}
        </Card>
      </Page>
    );
  }
  if (!MOCK) return <RealAdd kind={kind} onBack={reset} onDone={() => { reset(); router.push("/u/settings/devices" as never); }} />;
  const name = DEFAULT_NAMES[kind];
  const noun = kind === "phone" ? "phone" : kind === "server" ? "server" : "computer";
  const newCap = `New ${noun}`;
  const ring = showsRing(kind);
  const done = step === lastStep(kind);
  const atWords = step === wordsStep(kind);
  const finish = () => {
    addDevice({ id: `d${Date.now() % 100000}`, kind: "Device", device: kind, family: "device", name, allows: "Does everything you can, until you remove it.", since: "3 Oct", last: "Now" }, ["mine"]);
    reset();
    router.push("/u/settings/devices" as never);
  };
  const got = (c: LongCode) => { setSaid(""); setSession(openPairing(c)); setStep(wordsStep(kind)); };
  const words = session ? (
    <PairWords session={session} who={name} onConfirmed={() => setStep(lastStep(kind))} onRejected={() => restart(COPY.rejected)} />
  ) : null;

  let left: React.ReactNode, right: React.ReactNode;
  if (ring) {
    if (step === 0) {
      left = <Screen cap={newCap}><View className="w-ring"><Ring seed={kind === "computer" ? 5 : 4} /></View><Text strong>{`Add this ${noun}`}</Text><Text tone="muted" className="text-center">Open Vyre on your phone, then scan this, or paste the long code. Good for 5 minutes.</Text><Chip>{FP}</Chip></Screen>;
      right = <Screen cap="Your phone"><Text strong>Access</Text><Text tone="muted">Devices, people, assistants</Text><Button kind="primary" size="sm" icon="plus" label={`Add a ${noun}`} onPress={() => setStep(1)} /></Screen>;
    } else if (step === 1) {
      left = <Screen cap={newCap} dim><View className="w-ring"><Ring seed={kind === "computer" ? 5 : 4} /></View><Text tone="muted">Waiting for your phone</Text></Screen>;
      right = <Screen cap="Your phone"><Text strong>{`Add a ${noun}`}</Text><PairEntry onCode={got} sample={SAMPLE_CODE} /></Screen>;
    } else if (atWords) {
      left = <Screen cap={newCap} dim><Text strong>{`Your phone found this ${noun}`}</Text>{session ? <Text mono size="title" strong className="text-center">{wordsLine(session.words())}</Text> : null}<Text tone="muted">Waiting for you to confirm on your phone.</Text></Screen>;
      right = <Screen cap="Your phone">{words}</Screen>;
    } else {
      left = <Screen cap={newCap}><Chip tone="ok" icon="check">Done</Chip><Text strong>You are in</Text><Text tone="muted" className="text-center">{`${name} is added to your server.`}</Text></Screen>;
      right = <Screen cap="Your phone"><Text strong tone="ok">Added</Text><Text tone="muted" className="text-center">{`${name} can now reach your server.`}</Text><Button size="sm" label="Done" onPress={finish} /></Screen>;
    }
  } else if (step === 0) {
    left = <Screen cap="Your server"><Text strong>Run this on it</Text><Text mono size="caption">{installLine(shell()?.version)}</Text><Text tone="muted" className="text-center">It prints a QR code and a long code.</Text></Screen>;
    right = <Screen cap="Your phone"><Text strong>Scan it, or paste the long code</Text><PairEntry onCode={got} sample={SAMPLE_CODE} /></Screen>;
  } else if (atWords) {
    left = <Screen cap="Your server" dim><Text strong>{`${name} is waiting`}</Text>{session ? <Text mono size="title" strong className="text-center">{wordsLine(session.words())}</Text> : null}<Text tone="muted" className="text-center">It shows who is asking and waits for yes.</Text></Screen>;
    right = <Screen cap="Your phone">{words}</Screen>;
  } else {
    left = <Screen cap="Your server"><Chip tone="ok" icon="check">Done</Chip><Text strong>Paired</Text></Screen>;
    right = <Screen cap="Your phone"><Text strong tone="ok">Added</Text><Text tone="muted" className="text-center">{`${name} can now take work from your server.`}</Text><Button size="sm" label="Done" onPress={finish} /></Screen>;
  }
  return (
    <Page title={`Add ${kind === "computer" ? "a computer" : kind === "phone" ? "a phone" : "a server"}`} sub={stepLine(step, kind)}>
      {said ? <Text tone="warn">{said}</Text> : null}
      <View className="flex-row flex-wrap gap-s3">{left}{right}</View>
      <Text tone="muted" className="text-center">{stepWords(kind, step)}</Text>
      <View className="flex-row flex-wrap justify-center gap-s2">
        <Button kind="ghost" size="sm" icon="chevron-left" label="Back" onPress={reset} />
        {step > 0 && !done ? <Button kind="ghost" size="sm" label="Start over" onPress={() => restart()} /> : null}
      </View>
    </Page>
  );
}
