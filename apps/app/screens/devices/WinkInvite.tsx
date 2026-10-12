import { useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Card, Chip, Field, Ring, Text, showToast, spaceRef } from "@vyre/ui";
import { screenRole } from "../roles/roles";
import { MOCK } from "../../src/real/box";
import { Page } from "../places/Frame";
import { RealInvite } from "./RealInvite";
import { InviteRolePicker } from "../roles/InviteRolePicker";
import { MOCK_PROJECTS, sampleRoles } from "../roles/mock.js";

/** Invite someone to a space: make the invitation, send the link, and see the card they will read. */
export function WinkInvite() {
  return MOCK ? <SampleInvite /> : <RealInvite />;
}

function SampleInvite() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("Sam Rivera");
  const [role, setRole] = useState("member");
  const [projects, setProjects] = useState<string[]>([]);
  const [days, setDays] = useState("7");
  const first = name.trim().split(" ")[0] || "them";
  return (
    <Page title="Invite someone" sub="To Juniper Studio. They read one card and tap Join." back="/u/wink">
      {step === 0 ? (
        <Card className="max-w-read gap-s3">
          <Field label="Their name, for your own list" value={name} onChangeText={setName} />
          <InviteRolePicker actor="owner" role={role} onRole={setRole} projects={projects} onProjects={setProjects} days={days} onDays={setDays} />
          <View className="flex-row"><Button kind="primary" label="Make the invitation" onPress={() => setStep(1)} /></View>
        </Card>
      ) : step === 1 ? (
        <Card className="max-w-read items-center gap-s3">
          <View className="w-ring"><Ring seed={3} /></View>
          <Text strong>{`Invitation for ${first}`}</Text>
          <Text tone="muted" className="text-center">Good for 24 hours. Goes into Juniper Studio.</Text>
          <Button size="sm" label="Send the link" onPress={() => setStep(2)} />
        </Card>
      ) : step === 2 ? (
        <Card className="max-w-read gap-s3">
          <Text size="caption" strong tone="label">What they see</Text>
          <View className="flex-row items-center gap-s3"><Avatar of={spaceRef("Juniper Studio")} size={56} /><View><Text strong>Join Juniper Studio</Text><Text size="caption" tone="label">Chris invited you to work in Juniper Studio's space.</Text></View></View>
          <Text tone="muted">{`Joins as ${sampleRoles().find((r) => r.id === screenRole(role))?.name ?? role}${projects.length ? `, on ${projects.map((p) => MOCK_PROJECTS.find((x) => x.id === p)?.name ?? p).join(", ")}` : ""}.`}</Text>
          <Text tone="muted">Juniper Studio will see which of your devices touch its data. Nothing else on your devices, your Mine space or your other spaces.</Text>
          <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Join Juniper Studio" onPress={() => setStep(3)} /><Button kind="ghost" size="sm" label="Not now" onPress={() => setStep(0)} /></View>
        </Card>
      ) : (
        <Card className="max-w-read items-center gap-s3">
          <Chip tone="ok" icon="check">Joined</Chip>
          <Text strong>{`${first} joined Juniper Studio`}</Text>
          <Text tone="muted" className="text-center">They are a Member. Change that in Spaces and members.</Text>
          <Button size="sm" label="Done" onPress={() => { showToast(`${first} was added.`); setStep(0); }} />
        </Card>
      )}
    </Page>
  );
}
