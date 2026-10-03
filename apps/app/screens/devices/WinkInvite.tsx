import { useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Card, Chip, Field, Ring, Text, showToast, spaceRef } from "@vyre/ui";
import { Page } from "../shell/Page";

const CAN = [["Intake", true], ["Billing", true], ["Admin", false]] as const;

/** Invite someone to a space: make the invitation, send the link, and see the card they will read. */
export function WinkInvite() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("Sam Rivera");
  const first = name.trim().split(" ")[0] || "them";
  return (
    <Page title="Invite someone" sub="To Harlow Legal. They read one card and tap Join." back="/u/wink">
      {step === 0 ? (
        <Card className="max-w-read gap-s3">
          <Field label="Their name, for your own list" value={name} onChangeText={setName} />
          <View className="gap-s2">
            <Text size="caption" strong tone="label">What they can do</Text>
            <View className="flex-row flex-wrap gap-s2">{CAN.map(([l, on]) => <Chip key={l} tone={on ? "accent" : "plain"}>{on ? l : `${l} (needs your Face ID)`}</Chip>)}</View>
          </View>
          <View className="flex-row"><Button kind="primary" label="Make the invitation" onPress={() => setStep(1)} /></View>
        </Card>
      ) : step === 1 ? (
        <Card className="max-w-read items-center gap-s3">
          <View className="w-ring"><Ring seed={3} /></View>
          <Text strong>{`Invitation for ${first}`}</Text>
          <Text tone="muted" className="text-center">Good for 24 hours. Goes into Harlow Legal.</Text>
          <Button size="sm" label="Send the link" onPress={() => setStep(2)} />
        </Card>
      ) : step === 2 ? (
        <Card className="max-w-read gap-s3">
          <Text size="caption" strong tone="label">What they see</Text>
          <View className="flex-row items-center gap-s3"><Avatar of={spaceRef("Harlow Legal")} size={56} /><View><Text strong>Join Harlow Legal</Text><Text size="caption" tone="label">Chris invited you to work in Harlow Legal's space.</Text></View></View>
          <Text tone="muted">Allows: read and add to Intake and Billing. Not: admin.</Text>
          <Text tone="muted">Harlow Legal will see which of your devices touch its data. Nothing else on your devices, your Mine space or your other spaces.</Text>
          <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Join Harlow Legal" onPress={() => setStep(3)} /><Button kind="ghost" size="sm" label="Not now" onPress={() => setStep(0)} /></View>
        </Card>
      ) : (
        <Card className="max-w-read items-center gap-s3">
          <Chip tone="ok" icon="check">Joined</Chip>
          <Text strong>{`${first} joined Harlow Legal`}</Text>
          <Text tone="muted" className="text-center">They are a Member. Change that in Spaces and members.</Text>
          <Button size="sm" label="Done" onPress={() => { showToast(`${first} was added.`); setStep(0); }} />
        </Card>
      )}
    </Page>
  );
}
