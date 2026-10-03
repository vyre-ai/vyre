import { useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AskCard, Avatar, Banner, Button, Card, Chip, Divider, EmptyState, Row, StageSteps, Switch, Tabs, Text, showToast, markRef } from "@vyre/ui";
import { Block, FaceIdSheet } from "../places/Page";
import { Footnote, Frame, Sec } from "../places/Frame";
import { SPACES } from "../places/scope";
import { sitesRepo, type Site } from "./data";
import { useSites } from "./store";
import { flowText, goLive, grantedOf, liveOf, PIPE, previewOf, rollBack, setSecret, waitingOnYou } from "./logic.js";

type Tab = "pipeline" | "history" | "domain" | "secrets" | "logs";

export default function SiteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { sites, setSites } = useSites();
  const s = sites.find((x) => x.id === id);
  const [tab, setTab] = useState<Tab>("pipeline");
  const [face, setFace] = useState<null | { kind: "live" } | { kind: "back"; v: string }>(null);
  const [asText, setAsText] = useState(false);
  if (!s) return <Frame title="Sites" back="/u/sites"><EmptyState title="That site is not here" body="It may have been removed. Open Sites to see what is published." action={{ label: "Open Sites", onPress: () => router.push("/u/sites" as never) }} /></Frame>;
  const edit = (f: (x: Site) => Site) => setSites((xs) => xs.map((x) => (x.id === s.id ? f(x) : x)));
  const live = liveOf(s), pre = previewOf(s), d = pre ?? live ?? s.dep[0];
  const cur = d.pipe.findIndex((p) => p === "cur");
  const granted = grantedOf(s);

  const body =
    tab === "pipeline" ? (
      <View className="gap-s4">
        <Card>
          <View className="gap-s2">
            <Text size="caption" strong tone="label">Source</Text>
            <View className="flex-row flex-wrap items-center gap-s2"><Chip icon={s.src[0] === "GitHub repo" ? "link" : s.src[0] === "Drive folder" ? "drive" : "chat"}>{s.src[0]}</Chip><Text strong>{s.src[1]}</Text><Text size="caption" tone="label">{s.src[2]}</Text></View>
          </View>
        </Card>
        <Sec title={`The pipeline for ${d.v} (${pre ? "preview" : "live"})`}>
          <StageSteps stages={PIPE} current={cur >= 0 ? cur : PIPE.length} />
        </Sec>
        {pre ? (
          <Card>
            <View className="gap-s1"><Text size="caption" tone="label">Preview URL</Text><Text mono strong>{sitesRepo.previewUrl(s)}</Text><Text size="caption" tone="muted">{sitesRepo.checksLine(pre.pipe[2] === "done")}</Text></View>
          </Card>
        ) : null}
        {waitingOnYou(s) && pre ? (
          <AskCard lead={<Avatar of={markRef("assistant", "kit")} size={40} />} title={`Go live with ${s.name} ${pre.v}?`}
            why={`It goes live now at ${s.dom.name}.${live ? ` Rolling back to ${live.v} is one tap.` : ""}`}
            actions={[{ label: "Go live with Face ID", kind: "primary", icon: "faceid", onPress: () => setFace({ kind: "live" }) }, { label: "Not now", kind: "ghost", onPress: () => showToast("Kept in preview.") }]} />
        ) : pre ? <Banner>Waiting for checks to finish before it can ask you.</Banner> : <Banner>{`Nothing waiting. ${live?.v ?? "No version"} is live.`}</Banner>}
        <View className="gap-s2">
          <View className="self-start"><Button kind="ghost" size="sm" icon={asText ? "chev-d" : "chev-r"} label="The publish Flow, as text" onPress={() => setAsText(!asText)} /></View>
          {asText ? <Block>{flowText(s)}</Block> : null}
        </View>
      </View>
    ) : tab === "history" ? (
      <View className="gap-s2">
        <Card flush>
          {s.dep.map((x, i) => (
            <View key={x.v}>{i ? <Divider /> : null}
              <Row title={`${x.v}, ${x.msg}`} sub={`${x.by} · ${x.when}`}
                end={x.st === "live" ? <Chip tone="ok">Live</Chip> : x.st === "preview" ? <Chip tone="accent">Preview</Chip> : <Button kind="ghost" size="sm" label={`Roll back to ${x.v}`} onPress={() => setFace({ kind: "back", v: x.v })} />} />
            </View>
          ))}
        </Card>
        <Text size="caption" tone="label">Rolling back needs Face ID and takes effect at once. The version you leave stays in the history.</Text>
      </View>
    ) : tab === "domain" ? (
      <Card title="Custom domain">
        <View className="gap-s3">
          <View className="flex-row flex-wrap items-center gap-s2"><Text mono strong>{s.dom.name}</Text>{s.dom.ok ? <Chip tone="ok">Connected, secure</Chip> : <Chip tone="accent">Waiting for DNS</Chip>}</View>
          {s.dom.ok ? <Text tone="muted">Vyre keeps the certificate renewed. Nothing to do.</Text> : (
            <>
              <Block label="Add this record at your domain provider">CNAME  @  sites.vyre.run</Block>
              <View className="self-start"><Button kind="primary" size="sm" label="Check again" onPress={() => showToast("Not connected yet. DNS can take up to an hour to update.")} /></View>
            </>
          )}
        </View>
      </Card>
    ) : tab === "secrets" ? (
      <View className="gap-s2">
        <Card flush>
          {Object.keys(s.sec).map((k, i) => (
            <View key={k}>{i ? <Divider /> : null}
              <Row title={k} sub={s.sec[k] ? "Granted to this deployment. It can use it, not read it." : "Not granted."} end={<Switch label={`Grant ${k}`} on={s.sec[k]} onChange={(on) => edit((x) => setSecret(x, k, on) as Site)} />} />
            </View>
          ))}
        </Card>
        <Text size="caption" tone="label">These come from the Vault. Removing one takes effect on the next deploy.</Text>
      </View>
    ) : (
      <View className="gap-s3">
        <Block label={`Build log, ${d.v}`}>{s.logs.build.join("\n")}</Block>
        <Block label="Runtime log">{s.logs.run.join("\n")}</Block>
      </View>
    );

  return (
    <Frame back="/u/sites" title={s.name} sub={`${s.type}, ${s.dom.name}`} marks={[markRef("space", SPACES[s.sp].name)]}>
      <Tabs<Tab> value={tab} onChange={setTab} items={[["pipeline", "Publish"], ["history", "History"], ["domain", "Domain"], ["secrets", "Secrets"], ["logs", "Logs"]]} />
      {body}
      <Footnote icon="shield">{`This ${s.type.toLowerCase()} runs on its own. It cannot reach your spaces' data unless you grant it. Granted now: ${granted.length ? granted.join(", ") : "nothing"}.`}</Footnote>
      <FaceIdSheet open={!!face} onClose={() => setFace(null)} title={face?.kind === "back" ? `Roll back to ${face.v}` : "Go live with Face ID"}
        body={face?.kind === "back" ? `${face.v} goes live now. The version you leave stays in the history.` : `${pre?.v ?? ""} goes live now at ${s.dom.name}.`}
        confirm="Approve with Face ID"
        onConfirm={() => {
          if (face?.kind === "back") { edit((x) => rollBack(x, face.v) as Site); showToast(`Rolled back to ${face.v}.`); }
          else { edit((x) => goLive(x) as Site); showToast(`${pre?.v ?? "It"} is live.`); }
        }} />
    </Frame>
  );
}
