import { useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Card, Chip, Divider, Row, Switch, Text, showToast, markRef , allowsMock} from "@vyre/ui";
import { Group, Page } from "../places/Frame";
import { FaceIdSheet, type FaceAsk } from "../shell/FaceIdSheet";
import { loadAccount } from "./data";
import { useSettings } from "./state";
import { RealAccount } from "./RealAccount";

const A = loadAccount();

/** Your identity: a permanent id and a short signed list of who can speak for you (DESIGN-wink.md section 2). */
function SampleAccountScreen() {
  const { newCode, setNewCode, pin, setPin } = useSettings();
  const [face, setFace] = useState<FaceAsk | null>(null);
  return (
    <Page title="Account and recovery" back="/u/settings">
      <Card><Row lead={<Avatar of={markRef("person", A.name)} size={40} />} title={A.name} sub={`${A.vyreName} · ${A.line}`} className="px-0" /></Card>
      <Group title="Ways in" note="Any one signs you in. Any one can add or remove the others.">
        <Card flush>
          {A.ways.map((w, i) => <View key={w.id}>{i ? <Divider /> : null}<Row lead={<Avatar of={markRef("device", w.name)} />} title={w.name} sub={w.line} end={w.here ? <Chip tone="ok">This phone</Chip> : undefined} /></View>)}
        </Card>
      </Group>
      <Group title="Recovery">
        <Card className="gap-s3">
          <Text strong>Recovery code</Text>
          <Text tone="muted">{newCode ? "A new recovery code is ready. Keep it somewhere safe. The old one no longer works." : `Saved. Last checked ${A.checked}. With it you are back in at once if you lose every device.`}</Text>
          {newCode ? <Card className="bg-surface-1"><Text mono size="title">{A.newCode}</Text></Card>
            : <View className="flex-row"><Button size="sm" icon="faceid" label="Make a new recovery code" onPress={() => setFace({ title: "Make a new recovery code", body: "Face ID confirms it is you. The old code stops working.", label: "Make it with Face ID", onApprove: () => setNewCode(true) })} /></View>}
        </Card>
        <Card><Row title="Add a PIN to the code" sub="A PIN you memorise, so the paper alone is useless." end={<Switch label="Add a PIN to the code" on={pin} onChange={(v) => { setPin(v); showToast(v ? "The code now needs your PIN." : "The code works without a PIN."); }} />} /></Card>
      </Group>
      <Group title="Recovery contacts" note="Optional. Two of them approve with Face ID to bring you back if you lose everything.">
        <Card flush>
          {A.contacts.map((c, i) => <View key={c.id}>{i ? <Divider /> : null}<Row lead={<Avatar of={markRef("person", c.name, c.id)} />} title={c.name} sub="Recovery contact" /></View>)}
        </Card>
        <View className="flex-row"><Button size="sm" icon="plus" label="Add a contact" onPress={() => showToast("Ask them to scan your Wink card. They approve with Face ID.")} /></View>
      </Group>
      <FaceIdSheet ask={face} onClose={() => setFace(null)} />
    </Page>
  );
}

/** The sample page in a mock build; the box's own identity everywhere else. */
export function AccountScreen() {
  return allowsMock() ? <SampleAccountScreen /> : <RealAccount />;
}
