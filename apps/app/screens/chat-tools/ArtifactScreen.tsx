// One artifact full screen (the Deck's /a/<id>?v=N): the version, who made it, its versions, what happened to it, and a public link.
// The page it made is untrusted: it runs in a sealed frame and sits under a line that says so. A link is posting as the person, so the box asks their yes.
import { dayTimeOf } from "../../src/time/show.js";
import { ASSISTANT_MARK } from "../../src/store-core/kernel-view.js";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, LoadingState, Row, SectionLabel, Text, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { chatTools } from "./instance";
import { moreTools } from "./instance";
import { ArtifactFrame } from "./ArtifactFrame";
import type { Activity } from "./more-model.ts";
import type { Version } from "./model.ts";

const say = (e: unknown, f: string) => (e instanceof Error && e.message ? e.message : f);
const when = (at: number | null) => (at ? dayTimeOf(at) : "");

export function ArtifactScreen({ id, version }: { id: string; version?: number }) {
  const [art, setArt] = useState<any>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [log, setLog] = useState<Activity[]>([]);
  const [err, setErr] = useState("");
  const [v, setV] = useState<number | undefined>(version);
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setErr("");
    chatTools.artifact(id).then(setArt).catch((e) => setErr(say(e, "This could not be read.")));
    chatTools.versions(id).then(setVersions).catch(() => setVersions([]));
    moreTools.activity(id).then(setLog).catch(() => setLog([]));
  }, [id]);
  useEffect(load, [load]);
  const latest = versions.length ? Math.max(...versions.map((x) => x.v)) : Number(art?.version ?? art?.v ?? 1) || 1;
  const shown = v ?? latest;
  const share = () => { setBusy(true); setProblem(""); chatTools.share(id, "7d").then((r) => { if (r.ok) { setLink(r.url); showToast("The link is ready."); moreTools.activity(id).then(setLog).catch(() => undefined); } else setProblem(r.reason); }).finally(() => setBusy(false)); };
  const title = String(art?.title || art?.name || "Shared");
  const by = String(art?.agent || art?.by || "");
  return (
    <Page title={title} back="/u/drive">
      {err ? <Card flush><ErrorState title="This did not load" reason={err} retry={load} /></Card> : null}
      {!art && !err ? <LoadingState rows={4} /> : null}
      {art ? (
        <View className="gap-s3">
          <Text size="caption" tone="muted">{`${by ? `Made by ${by}. ` : "Made by an agent. "}It runs on its own and is not part of Vyre.`}</Text>
          <ArtifactFrame id={id} v={shown} title={title} kind={String(art.kind || art.type || "page")} onLeft={() => void moreTools.frameLeft(id)} />
          <Card flush>
            <SectionLabel first>Versions</SectionLabel>
            {versions.length ? versions.slice().sort((a, b) => b.v - a.v).map((x, i) => (
              <View key={x.v}>{i ? <Divider /> : null}<Row dense title={`Version ${x.v}`} sub={[when(x.at), x.by].filter(Boolean).join(" · ") || undefined} state={x.v === shown ? "Showing" : undefined} chevron={x.v !== shown} onPress={x.v === shown ? undefined : () => setV(x.v)} /></View>
            )) : <EmptyState title="One version" body="A new version shows here when the assistant changes it." />}
          </Card>
          <Card flush>
            <SectionLabel first>What happened</SectionLabel>
            {log.length ? log.slice(0, 20).map((e, i) => <View key={i}>{i ? <Divider /> : null}<Row dense title={e.line} sub={[when(e.at), e.by, e.via ? ASSISTANT_MARK : ""].filter(Boolean).join(" · ") || undefined} /></View>) : <EmptyState title="Nothing yet" body="Opens, links and changes show here." />}
          </Card>
          {problem ? <Banner tone="warn">{problem}</Banner> : null}
          {link ? <Text selectable>{link}</Text> : null}
          <View className="self-start"><Button label={link ? "Make another link" : "Create a link (7 days)"} disabled={busy} onPress={share} /></View>
        </View>
      ) : null}
    </Page>
  );
}
