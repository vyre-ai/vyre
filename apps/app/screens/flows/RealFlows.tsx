// The Flows list from the real vyred (flows.list, with each Flow's trigger line from flows.graph). The switch pauses and resumes a Flow (a person's own call).
import { useEffect, useState } from "react";
import { openEngineer } from "../engineer/openEngineer";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Menu, Card, Chip, Divider, EmptyState, IconTile, Row, Switch, Text, showToast, ErrorState, LoadingState } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { usePhone } from "../places/Page";
import { listReal, setPausedReal, type RealFlow } from "./real";
import { healthRow, listWaits } from "./real-model.js";
import { PlaceTag } from "../../src/real/PlaceTag";

export function RealFlows() {
  const router = useRouter();
  const phone = usePhone();
  const [flows, setFlows] = useState<RealFlow[] | null>(null);
  const [err, setErr] = useState("");
  const load = () => { setErr(""); listReal().then(setFlows).catch((e) => setErr(e instanceof Error ? e.message : "Flows did not answer.")); };
  useEffect(load, []);
  const toggle = (f: RealFlow, on: boolean) =>
    setPausedReal(f.id, !on).then(() => setFlows((xs) => xs && xs.map((x) => (x.id === f.id ? { ...x, paused: on ? null : "paused" } : x)))).catch((e) => showToast(e instanceof Error ? e.message : "That did not work."));
  return (
    <Frame title="Flows" sub="Jobs Vyre does on its own. When something happens, it follows the steps.">
      <PlaceTag of="showing" />
      <Card flush>
        {err ? <ErrorState title="Flows did not load" reason={err} retry={load} /> : null}
        {!err && flows === null ? <LoadingState rows={3} /> : null}
        {!err && flows && !flows.length ? <EmptyState title="No Flows yet" body="Flows live in a space. Ask @Engineer to write one, or install a Kit." /> : null}
        {(flows ?? []).map((f, i) => {
          const waiting = listWaits(f);
          const health = healthRow(f);
          return (
            <View key={f.id}>{i ? <Divider inset={68} /> : null}
              <Row dense onPress={() => router.push(`/u/flows/${f.id}` as never)} lead={<IconTile size={40} name="flows" />} title={f.sentence ? <Text strong numberOfLines={3}>{f.sentence}</Text> : f.name} sub={<View className="gap-s1">{f.sentence ? <Text size="secondary" tone="label" numberOfLines={1}>{f.name}</Text> : null}{!waiting && health.sub ? <Text size="secondary" tone="label" numberOfLines={1}>{health.sub}</Text> : null}</View>} chevron={waiting}
                end={waiting ? <Chip tone="accent">Waiting for you</Chip> : (
                <View className="flex-row items-center gap-s3">
                  {health.chip ? <Chip tone="err">{health.chip}</Chip> : null}
                  <Switch label={`${f.name} is ${f.paused ? "off" : "on"}`} on={!f.paused} onChange={(on) => toggle(f, on)} />
                </View>
              )} />
            </View>
          );
        })}
      </Card>
      <View className="flex-row pt-s4">
        <Menu align="start" trigger={<Button kind="primary" size="lg" icon="plus" label="New flow" />} items={[{ label: "Build it here", onPress: () => router.push("/u/flows/new" as never) }, { label: "Ask @Engineer to write it", onPress: () => openEngineer(router, { source: "flow" }) }]} />
      </View>
    </Frame>
  );
}
