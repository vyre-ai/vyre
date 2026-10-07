// A Kit update on the real box: the installed version against the library's newer one (flows.kit.diff, read only), what changes, what the Kit can do that it could
// not before, and the risks. Asking to update changes nothing: it puts a card in Now for a person to approve (flows.kit.propose).
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Card, Chip, EmptyState, ErrorState, LoadingState, Text, showToast } from "@vyre/ui";
import { DiffBlock } from "../places/Page";
import { Frame, Sec } from "../places/Frame";
import { diffLines, hasChanges, kitName, kitRefusal, proposeNote, risks, versionLine, widenings, type KitDiff } from "./kits-model";
import { diffKit, libraryKit, proposeKit } from "./kits";

export default function RealKitUpdate() {
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [got, setGot] = useState<{ kit: unknown; diff: KitDiff } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => {
    setErr(""); setGot(null);
    libraryKit(id).then(async (kit) => setGot({ kit, diff: await diffKit(kit) })).catch((e) => setErr(kitRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "")));
  }, [id]);
  useEffect(load, [load]);
  const back = "/u/kits";
  const open = { label: "Open Kits", onPress: () => router.push(back as never) };
  if (err) return <Frame title="Kits" back={back}><Card flush><ErrorState title="This update did not load" reason={err} retry={load} /></Card></Frame>;
  if (!got) return <Frame title="Kits" back={back}><LoadingState rows={3} /></Frame>;
  const d = got.diff;
  if (!hasChanges(d)) return <Frame title={kitName(id)} back={back} sub={versionLine(d)}><EmptyState title="No update for that Kit" body={d.installed ? "It is up to date." : "It is not installed in this space."} action={open} /></Frame>;
  const ask = () => {
    setBusy(true); setProblem("");
    proposeKit(got.kit).then((r) => { const n = proposeNote(r); if (n.ok) { setAsked(true); showToast(n.text); } else setProblem(n.text); }).catch((e) => setProblem(kitRefusal((e as { code?: string }).code, e instanceof Error ? e.message : ""))).finally(() => setBusy(false));
  };
  const w = widenings(d), r = risks(d);
  return (
    <Frame back={back} title={`Update: ${kitName(id)}`} sub={versionLine(d)}>
      <DiffBlock lines={diffLines(d)} />
      <Sec title="What it can do that it could not before">
        <Card><View className="gap-s2">{w.length ? w.map((x) => <View key={x.part + x.what} className="gap-s1"><Text strong>{x.part}</Text><Text tone="muted">{x.what}</Text></View>) : <Text tone="muted">Nothing new. It can do what it could before.</Text>}</View></Card>
      </Sec>
      {r.length ? (
        <Sec title="Worth knowing">
          <Card><View className="gap-s2">{r.map((x) => <View key={x.part + x.what} className="gap-s1"><Text strong>{x.part}</Text><Text tone="muted">{x.what}</Text></View>)}</View></Card>
        </Sec>
      ) : null}
      {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
      <View className="flex-row flex-wrap items-center gap-s2">
        {asked ? <Chip tone="ok">Waiting for your yes in Now</Chip> : <Button kind="primary" label={busy ? "Asking" : `Ask to update to v${d.to}`} onPress={busy ? () => {} : ask} />}
        <Button kind="ghost" label={asked ? "Back to Kits" : "Not now"} onPress={() => router.push(back as never)} />
      </View>
      <Text size="caption" tone="label">Asking changes nothing yet. It puts a card in Now for you to approve, and your records stay as they are.</Text>
    </Frame>
  );
}
