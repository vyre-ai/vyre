import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Chip, Field, Segmented, Text, allowsMock, showToast, markRef } from "@vyre/ui";
import { RealEngineer } from "./RealEngineer";
import { Block, DiffBlock, FaceIdSheet } from "../places/Page";
import { Frame } from "../places/Frame";
import { flowsRepo } from "./data";
import { useFlowsState } from "./store";

function SampleEngineerScreen() {
  const router = useRouter();
  const p = flowsRepo.proposal();
  const { applied, setApplied } = useFlowsState();
  const [admin, setAdmin] = useState<"1" | "0">("1");
  const [text, setText] = useState(p.asked);
  const [sent, setSent] = useState(false);
  const [face, setFace] = useState(false);
  const [gone, setGone] = useState(false);
  return (
    <Frame back="/u/flows" title="@Engineer" sub="Describe a process in plain words.">
      <View className="flex-row flex-wrap items-center gap-s2">
        <Chip tone="accent" icon="play">Admins only</Chip><Chip>Can change definitions</Chip><Chip>Cannot send, pay or read the vault</Chip>
      </View>
      <Segmented<"1" | "0"> label="Who is asking" value={admin} onChange={setAdmin} options={[["1", "Admin"], ["0", "Member"]]} />
      {admin === "0" ? (
        <Card><View className="items-center gap-s2 p-s4"><Text strong>Only space admins can talk to @Engineer</Text><Text tone="muted" className="text-center">Ask an admin of Juniper Studio, or open Flows to read what it built.</Text><Button label="Open Flows" onPress={() => router.push("/u/flows" as never)} /></View></Card>
      ) : (
        <Card>
          <View className="gap-s3">
            <View className="flex-row items-start gap-s3"><Avatar of={markRef("person", "Alex Rivera")} /><View className="min-w-0 flex-1 gap-s2"><Text strong>You</Text><Field multiline lines={4} value={text} onChangeText={setText} /><View className="self-start"><Button kind="primary" size="sm" label="Send to @Engineer" onPress={() => setSent(true)} /></View></View></View>
            {sent ? (
              <View className="gap-s3 border-t border-edge pt-s3">
                <View className="flex-row items-start gap-s3"><Avatar of={markRef("agent", "@Engineer")} /><View className="min-w-0 flex-1 gap-s1"><Text strong>@Engineer</Text><Text>{p.reply}</Text></View></View>
                <Card>
                  <View className="gap-s3">
                    <Text size="caption" strong tone="label">{p.title}</Text>
                    <DiffBlock lines={p.diff} />
                    <View className="gap-s2">
                      <Block label="Simulation on last month"><Text strong>{`Would have run ${p.sim.runs} times`}</Text><Text size="caption" tone="label">{`${p.sim.asks} approvals asked, ${p.sim.letters} letters waiting for approval, ${p.sim.matters} matters touched`}</Text></Block>
                      <Block label="Tests"><Text strong>{p.tests}</Text><Text size="caption" tone="label">Types check. No unknown fields or stages.</Text></Block>
                    </View>
                    {applied ? (
                      <View className="gap-s2">
                        <Banner><View className="gap-s1"><Text strong>Applied as version 4.</Text><Text size="caption" tone="muted">It is in Flows. Undo is one tap in the history.</Text></View></Banner>
                        <View className="flex-row flex-wrap gap-s2"><Button label="Open the Flow" onPress={() => router.push("/u/flows/engineer" as never)} /><Button kind="ghost" label="Undo" onPress={() => { setApplied(false); showToast("Undone. The old Flow runs again."); }} /></View>
                      </View>
                    ) : gone ? <Text tone="muted">Proposal discarded.</Text> : (
                      <View className="flex-row flex-wrap gap-s2">
                        <Button kind="primary" icon="faceid" label="Approve with Face ID" onPress={() => setFace(true)} />
                        <Button label="Edit first" onPress={() => showToast("Opened in the Flow editor. Changes stay a proposal.")} />
                        <Button kind="ghost" label="Not now" onPress={() => setGone(true)} />
                      </View>
                    )}
                  </View>
                </Card>
              </View>
            ) : null}
          </View>
        </Card>
      )}
      <FaceIdSheet open={face} onClose={() => setFace(false)} title="Approve with Face ID" body="The Flow goes live as version 4 of the Estate planning matter Kit. The old On payment Flow is replaced." confirm="Approve with Face ID" onConfirm={() => { setApplied(true); showToast("Applied. The Flow is in Flows."); }} />
    </Frame>
  );
}

/** The sample proposal in a mock build; writing a Flow in text on the box everywhere else. */
export default function EngineerScreen() {
  return allowsMock() ? <SampleEngineerScreen /> : <RealEngineer />;
}
