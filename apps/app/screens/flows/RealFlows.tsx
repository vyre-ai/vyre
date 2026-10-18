// The Flows list from the real vyred (flows.list, with each Flow's trigger line from flows.graph). The switch pauses and resumes a Flow (a person's own call).
import { useEffect, useState } from "react";
import { openEngineer } from "../engineer/openEngineer";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Menu, Card, Chip, Divider, EmptyState, Field, IconTile, Row, Switch, Text, showToast, ErrorState, LoadingState } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { usePhone } from "../places/Page";
import { listReal, setPausedReal, type RealFlow } from "./real";
import { groupFlows, healthRow, listWaits } from "./real-model.js";
import { callT } from "../../src/real/call-tool";
import { attentionSource, type AttentionRow } from "./attention-source";
import { answersFor, rowWords } from "./attention-model.js";
import { PlaceTag } from "../../src/real/PlaceTag";

export function RealFlows() {
  const router = useRouter();
  const phone = usePhone();
  const [flows, setFlows] = useState<RealFlow[] | null>(null);
  const [err, setErr] = useState("");
  const [wish, setWish] = useState("");
  const att = attentionSource(callT);
  const [rows, setRows] = useState<AttentionRow[]>([]);
  const [why, setWhy] = useState<{ run: string; text: string } | null>(null);
  const loadRows = () => { void att.list().then(setRows); };
  useEffect(loadRows, []);
  const answer = async (run: string, action: "retry" | "skip" | "stop" | "advance", reason?: string) => {
    const o = await att.settle(run, action, reason);
    if (o.message) showToast(o.message);
    if (o.refresh) { setWhy(null); loadRows(); load(); }
  };
  const load = () => { setErr(""); listReal().then(setFlows).catch((e) => setErr(e instanceof Error ? e.message : "Flows did not answer.")); };
  useEffect(load, []);
  const needsYou = (flows ?? []).filter((f) => listWaits(f) || healthRow(f).chip);
  const toggle = (f: RealFlow, on: boolean) =>
    setPausedReal(f.id, !on).then(() => setFlows((xs) => xs && xs.map((x) => (x.id === f.id ? { ...x, paused: on ? null : "paused" } : x)))).catch((e) => showToast(e instanceof Error ? e.message : "That did not work."));
  return (
    <Frame title="Flows" sub="Jobs Vyre does on its own. When something happens, it follows the steps.">
      <PlaceTag of="showing" />
      <View className="gap-s2 pb-s4">
        <Field label="What should happen on its own?" value={wish} onChangeText={setWish} placeholder="For example, when a form comes in, tell me and add it to Records" onSubmit={() => wish.trim() && openEngineer(router, { source: "flow", words: wish.trim() })} />
        <View className="flex-row"><Button kind="primary" size="sm" label="Let Engineer draft it" disabled={!wish.trim()} onPress={() => openEngineer(router, { source: "flow", words: wish.trim() })} /></View>
      </View>
      {needsYou.length || rows.length ? (
        <View className="gap-s2 pb-s4">
          <Text size="caption" strong tone="label">Needs you</Text>
          <Card flush>{rows.map((r, i) => (
            <View key={r.run}>{i ? <Divider /> : null}
              <Row dense title={rowWords(r).title} sub={rowWords(r).sub}
                end={<View className="flex-row gap-s2">{answersFor(r).map((a) => <Button key={a.action} kind="ghost" size="sm" label={a.label} onPress={() => (a.reason ? setWhy({ run: r.run, text: "" }) : void answer(r.run, a.action))} />)}</View>} />
              {why && why.run === r.run ? <View className="gap-s2 p-s3"><Field label="Why move it on?" value={why.text} onChangeText={(text) => setWhy({ run: r.run, text })} /><View className="flex-row"><Button kind="primary" size="sm" label="Move on" disabled={!why.text.trim()} onPress={() => void answer(r.run, "advance", why.text)} /></View></View> : null}
            </View>
          ))}{needsYou.map((f, i) => <View key={f.id}>{i ? <Divider /> : null}<Row dense title={f.sentence || f.name} sub={listWaits(f) ? "Waiting for you" : healthRow(f).chip || ""} chevron onPress={() => router.push(`/u/flows/${f.id}` as never)} /></View>)}</Card>
        </View>
      ) : null}
      {err ? <Card flush><ErrorState title="Flows did not load" reason={err} retry={load} /></Card> : null}
      {!err && flows === null ? <Card flush><LoadingState rows={3} /></Card> : null}
      {!err && flows && !flows.length ? <Card flush><EmptyState title="No Flows yet" body="Flows live in a space. Ask @Engineer to write one, or install a Kit." /></Card> : null}
      {groupFlows(flows ?? []).map((group) => (
        <View key={group.name} className="gap-s2 pb-s3">
          {groupFlows(flows ?? []).length > 1 ? <Text size="caption" strong tone="label">{group.name}</Text> : null}
          <Card flush>
        {group.rows.map((f, i) => {
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
        </View>
      ))}
      <View className="flex-row pt-s4">
        <Menu align="start" trigger={<Button kind="primary" size="lg" icon="plus" label="New flow" />} items={[{ label: "Build it here", onPress: () => router.push("/u/flows/new" as never) }, { label: "Ask @Engineer to write it", onPress: () => openEngineer(router, { source: "flow" }) }]} />
      </View>
    </Frame>
  );
}
