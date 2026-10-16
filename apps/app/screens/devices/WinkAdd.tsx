import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Card, Row, type IconName, IconTile } from "@vyre/ui";
import { Page } from "../places/Frame";
import { type DeviceKind } from "./wink.js";
import { isPhone } from "../install/first-run.js";
import { deviceKindHere } from "../../src/real/pair-say";
import { RealAdd } from "./RealAdd";

const KINDS: { id: DeviceKind; icon: IconName; title: string; body: string }[] = [
  { id: "phone", icon: "phone", title: "A phone", body: "It gets a link to open Vyre and sign in." },
  { id: "computer", icon: "laptop", title: "A computer", body: "Sign in to your space from it with your username and master password." },
  { id: "server", icon: "box", title: "Another computer", body: "One that stays on, to take heavy work. You run one command on it." },
];

/** Add a device: pick the kind, then the same onboard tools the first run uses (RealAdd): a phone gets a link, a computer signs in, a server gets the one install command. */
export function WinkAdd() {
  const router = useRouter();
  const [kind, setKind] = useState<DeviceKind | null>(null);
  // A phone or a browser never hosts or picks a server: it adds a phone or a computer (DESIGN-first-run-per-platform).
  const kinds = isPhone(deviceKindHere()) || deviceKindHere() === "web" ? KINDS.filter((k) => k.id !== "server") : KINDS;
  const reset = () => setKind(null);

  if (!kind) {
    return (
      <Page title="Add a device" sub="What are you adding?" back="/u/wink">
        <Card flush>
          {kinds.map((k, i) => <View key={k.id}>{i ? <View className="h-px bg-edge" /> : null}<Row lead={<IconTile name={k.icon} size={40} />} title={k.title} sub={k.body} onPress={() => setKind(k.id)} /></View>)}
        </Card>
      </Page>
    );
  }
  return <RealAdd kind={kind} onBack={reset} onDone={() => { reset(); router.push("/u/settings/devices" as never); }} />;
}
