import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, Divider, Row, Text, showToast } from "@vyre/ui";
import { FaceIdSheet, IconTile } from "../places/Page";
import { Frame, Sec } from "../places/Frame";
import { flowsRepo, type KitCard } from "./data";
import { useFlowsState } from "./store";
import { addsLine } from "./logic.js";

export default function KitsScreen() {
  const router = useRouter();
  const { installed, updated, install } = useFlowsState();
  const [pick, setPick] = useState<KitCard | null>(null);
  const available = flowsRepo.kits().available.filter((k) => !installed.some((i) => i.id === k.id));
  return (
    <Frame back="/u/flows" title="Kits" sub="Ready-made record types, Flows and views for a kind of work. Installing one is a grant you approve.">
      <Sec title="Installed in Harlow Legal">
        <Card flush>
          {installed.map((k, i) => (
            <View key={k.id}>{i ? <Divider /> : null}
              <Row lead={<IconTile icon="box" />} title={k.name} sub={`v${k.v} · ${addsLine(k.adds)} · ${k.space}`}
                end={k.id === "estate" && !updated ? <Button kind="primary" size="sm" label="Update to v4" onPress={() => router.push("/u/kits/estate" as never)} /> : <Chip tone="ok">{k.id === "estate" ? "Up to date" : "Just installed"}</Chip>} />
            </View>
          ))}
        </Card>
      </Sec>
      <Sec title="Available">
        <Card flush>
          {available.length ? available.map((k, i) => (
            <View key={k.id}>{i ? <Divider /> : null}
              <Row lead={<IconTile icon="box" />} title={k.name} sub={`v${k.v} · ${k.blurb}`} end={<Button size="sm" label="Install" onPress={() => setPick(k)} />} />
            </View>
          )) : <View className="p-s4"><Text tone="muted">Everything available is installed.</Text></View>}
        </Card>
      </Sec>
      <FaceIdSheet open={!!pick} onClose={() => setPick(null)} title={pick ? `Install ${pick.name}?` : "Install"} confirm="Install with Face ID"
        body={pick ? `It adds ${addsLine(pick.adds)} to ${pick.space}. Removing it later takes its definitions away and never your records.` : ""}
        onConfirm={() => { if (pick) { install(pick); showToast(`${pick.name} is installed.`); } }}>
        {pick?.notes.map((n) => <Text key={n} size="caption" tone="warn">{n}</Text>)}
        <Text size="caption" tone="label">The Kit's own text counts as outside text until you have read it.</Text>
      </FaceIdSheet>
    </Frame>
  );
}
