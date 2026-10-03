import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Button, Card, Chip, Ring, Row, Text, type IconName, IconTile } from "@vyre/ui";
import { Page } from "../shell/Page";
import { FaceIdSheet, type FaceAsk } from "../shell/FaceIdSheet";
import { useDevices } from "./state";
import { DEFAULT_NAMES, canFallback, lastStep, pick, stepLine, stepWords, type DeviceKind } from "./wink.js";

const KINDS: { id: DeviceKind; icon: IconName; title: string; body: string }[] = [
  { id: "phone", icon: "phone", title: "A phone", body: "Open Vyre on it and scan." },
  { id: "computer", icon: "laptop", title: "A computer", body: "The default is a scan. No typing." },
  { id: "server", icon: "box", title: "A server", body: "One you own, to take heavy work." },
];
const FP = "7KQM 4P2X";
const CODE = "WINK-7K4Q-M2XD";

function Screen({ cap, dim, children }: { cap: string; dim?: boolean; children: React.ReactNode }) {
  return (
    <Card className={`min-w-menu flex-1 items-center gap-s3 ${dim ? "opacity-60" : ""}`}>
      <Text size="caption" strong tone="label">{cap}</Text>
      {children}
    </Card>
  );
}

/** Add a device: pick the kind, then two screens side by side (the new device and your phone), reverse scan first. */
export function WinkAdd() {
  const router = useRouter();
  const addDevice = useDevices((s) => s.addDevice);
  const [kind, setKind] = useState<DeviceKind | null>(null);
  const [step, setStep] = useState(0);
  const [fb, setFb] = useState(false);
  const [face, setFace] = useState<FaceAsk | null>(null);
  const [wrong, setWrong] = useState(false);
  const reset = () => { setKind(null); setStep(0); setFb(false); setWrong(false); };

  if (!kind) {
    return (
      <Page title="Add a device" sub="What are you adding?" back="/u/wink">
        <Card flush>
          {KINDS.map((k, i) => <View key={k.id}>{i ? <View className="h-px bg-edge" /> : null}<Row lead={<IconTile name={k.icon} size={40} />} title={k.title} sub={k.body} onPress={() => setKind(k.id)} /></View>)}
        </Card>
      </Page>
    );
  }
  const fallback = fb && canFallback(kind);
  const name = DEFAULT_NAMES[kind];
  const noun = kind === "phone" ? "phone" : kind === "server" ? "server" : "computer";
  const newCap = `New ${noun}`;
  const done = step === lastStep(fallback);
  const finish = () => {
    addDevice({ id: `d${Date.now() % 100000}`, kind: "Device", device: kind, family: "device", name, allows: "Does everything you can, until you remove it. Face ID approves each send and payment.", since: "3 Oct", last: "Now" }, ["mine"]);
    reset();
    router.push("/u/settings/devices" as never);
  };

  let left: React.ReactNode, right: React.ReactNode;
  if (!fallback) {
    if (step === 0) {
      left = <Screen cap={newCap}><View className="w-ring"><Ring seed={kind === "server" ? 5 : 4} /></View><Text strong>{`Add this ${noun}`}</Text><Text tone="muted" className="text-center">Open Vyre on your phone, then scan this. Good for 5 minutes.</Text><Chip>{FP}</Chip>{canFallback(kind) ? <Button kind="ghost" size="sm" label="No camera path? Use a code instead" onPress={() => { setFb(true); setStep(0); }} /> : null}</Screen>;
      right = <Screen cap="Your phone"><Text strong>Access</Text><Text tone="muted">Devices, people, assistants</Text><Button kind="primary" size="sm" icon="plus" label={`Add a ${noun}`} onPress={() => setStep(1)} /></Screen>;
    } else if (step === 1) {
      left = <Screen cap={newCap} dim><View className="w-ring"><Ring seed={kind === "server" ? 5 : 4} /></View><Text tone="muted">Waiting for your phone</Text></Screen>;
      right = <Screen cap="Your phone"><Text strong>{`Add a ${noun}`}</Text><Card className="w-full items-center border-accent p-s6"><Text size="caption" tone="label">point at the ring</Text></Card><Button size="sm" label="Simulate a scan" onPress={() => setStep(2)} /></Screen>;
    } else if (step === 2) {
      left = <Screen cap={newCap} dim><Text strong>{`Your phone found this ${noun}`}</Text><Text tone="muted">Approve it on your phone.</Text><Chip>{FP}</Chip></Screen>;
      right = <Screen cap="Your phone"><Text strong>{kind === "server" ? "Add nova to Mine?" : `Add this ${noun} to your server?`}</Text><Text tone="muted">{name}</Text><Chip>{FP}</Chip><Text size="caption" tone="label">Same as its screen. Seen 6 seconds ago.</Text>
        <View className="flex-row gap-s2"><Button kind="primary" size="sm" icon="faceid" label="Add with Face ID" onPress={() => setFace({ title: `Add ${name}`, body: `Face ID adds ${name} to your server.`, label: "Add with Face ID", onApprove: () => setStep(3) })} /><Button kind="ghost" size="sm" label="Not me" onPress={() => setStep(0)} /></View></Screen>;
    } else {
      left = <Screen cap={newCap}><Chip tone="ok" icon="check">Done</Chip><Text strong>You are in</Text><Text tone="muted" className="text-center">{`${name} is added to your server.`}</Text></Screen>;
      right = <Screen cap="Your phone"><Text strong tone="ok">Added</Text><Text tone="muted" className="text-center">{`${name} can now reach your server.`}</Text><Button size="sm" label="Done" onPress={finish} /></Screen>;
    }
  } else if (step === 0) {
    left = <Screen cap={newCap}><Text strong>Enter the code from your phone</Text><Text mono size="title">{CODE}</Text><Button size="sm" label="I typed it" onPress={() => { setWrong(false); setStep(1); }} /></Screen>;
    right = <Screen cap="Your phone"><Text strong>Type this on the new computer</Text><Text mono size="title">{CODE}</Text><Text size="caption" tone="label">Good for 5 minutes</Text></Screen>;
  } else if (step === 1) {
    left = <Screen cap={newCap}><Text strong>Pick this number on your phone</Text><Text mono size="display">47</Text><Chip>{FP}</Chip></Screen>;
    right = <Screen cap="Your phone"><Text strong>Is this your computer?</Text><Text tone="muted">{name}</Text><Chip>{FP}</Chip><Text size="caption" tone="label">Tap the number on its screen. One try.</Text>
      <View className="w-full flex-row gap-s2">{["12", "47", "85"].map((n) => <Button key={n} className="flex-1" label={n} onPress={() => { if (pick(n).ok) setStep(2); else { setWrong(true); setStep(0); } }} />)}</View></Screen>;
  } else {
    left = <Screen cap={newCap}><Chip tone="ok" icon="check">Done</Chip><Text strong>You are in</Text></Screen>;
    right = <Screen cap="Your phone"><Text strong tone="ok">Added</Text><Text tone="muted" className="text-center">{`${name} can now reach your server.`}</Text><Button size="sm" label="Done" onPress={finish} /></Screen>;
  }
  return (
    <Page title={`Add ${kind === "computer" ? "a computer" : kind === "phone" ? "a phone" : "a server"}`} sub={stepLine(step, fallback)}>
      {wrong ? <Text tone="warn">That is not the number on the screen. A new code is showing.</Text> : null}
      <View className="flex-row flex-wrap gap-s3">{left}{right}</View>
      <Text tone="muted" className="text-center">{stepWords(kind, step, fallback)}</Text>
      <View className="flex-row flex-wrap justify-center gap-s2">
        <Button kind="ghost" size="sm" icon="chevron-left" label="Back" onPress={reset} />
        {step > 0 && !done ? <Button kind="ghost" size="sm" label="Start over" onPress={() => { setStep(0); setWrong(false); }} /> : null}
        {fallback ? <Button kind="ghost" size="sm" label="Use the scan instead" onPress={() => { setFb(false); setStep(0); }} /> : null}
      </View>
      <FaceIdSheet ask={face} onClose={() => setFace(null)} />
    </Page>
  );
}
