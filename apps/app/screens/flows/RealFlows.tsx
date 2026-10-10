// The Flows list from the real vyred (flows.list, with each Flow's trigger line from flows.graph). The switch pauses and resumes a Flow (a person's own call).
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, Divider, EmptyState, IconTile, Row, Switch, showToast, ErrorState, LoadingState } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { usePhone } from "../places/Page";
import { listReal, setPausedReal, type RealFlow } from "./real";
import { healthRow, listWaits } from "./real-model.js";

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
    <Frame title="Flows" sub="What happens on its own when something changes, and who is asked.">
      <Card flush>
        {err ? <ErrorState title="Flows did not load" reason={err} retry={load} /> : null}
        {!err && flows === null ? <LoadingState rows={3} /> : null}
        {!err && flows && !flows.length ? <EmptyState title="No Flows yet" body="Flows live in a space. Ask @Engineer to write one, or install a Kit." /> : null}
        {(flows ?? []).map((f, i) => {
          const waiting = listWaits(f);
          const health = healthRow(f);
          return (
            <View key={f.id}>{i ? <Divider inset={68} /> : null}
              <Row dense onPress={() => router.push(`/u/flows/${f.id}` as never)} lead={<IconTile size={40} name="flows" />} title={f.name} sub={waiting ? f.trigger || undefined : health.sub} chevron={waiting}
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
      <View className="pt-s4"><Button kind="primary" size="lg" className={phone ? undefined : "self-start"} icon="spark" label="Ask @Engineer to write one" onPress={() => router.push("/u/engineer" as never)} /></View>
    </Frame>
  );
}
