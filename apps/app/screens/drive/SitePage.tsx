// A site inside Files (Files > Sites > <site>): a live preview, whether changes wait to be published, the address and who has it, and the two acts a person wants here: Publish changes and
// "Change it with Engineer". Everything is publish.* through the Sites source (screens/sites/real.ts); a held act (going live) shows its plan and is decided here, as on the Sites page. Visits,
// signups and where form answers go are not published by core/publish, so nothing here shows them: a number that nothing measured is never drawn.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { AskCard, Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, LoadingState, Row, Text, showToast } from "@vyre/ui";
import { presenceText } from "../shell/FaceIdSheet";
import { act, decide, list, preview, status as statusOf } from "../sites/real";
import { sites, nextStep, domainLine, heldOf, planLines, decision, publishRefusal, type Held, type Site, type Status } from "../sites/real-model";
import { siteAddress, unpublished } from "./site-page-model.js";

const say = (e: unknown) => publishRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");

export function SitePage({ name, onBack }: { name: string; onBack: () => void }) {
  const router = useRouter();
  const [deps, setDeps] = useState<Parameters<typeof sites>[0] | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [held, setHeld] = useState<Held | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setErr(""); list().then(setDeps).catch((e) => setErr(say(e))); }, []);
  useEffect(load, [load]);
  const site: Site | undefined = deps ? sites(deps).find((s) => s.name === name) : undefined;
  const cur = site?.current;
  useEffect(() => { if (cur) statusOf(cur.id).then(setSt).catch(() => setSt(null)); }, [cur?.id, cur?.stage]);

  if (err) return <ErrorState title="Publish did not load" reason={err} retry={load} />;
  if (deps === null) return <LoadingState rows={3} />;
  if (!site || !cur) return <EmptyState title="That site is not here" body="It may have been retired." action={{ label: "Back to Files", onPress: onBack }} />;

  const address = siteAddress(site);
  const waiting = unpublished(site);
  const next = nextStep(st && st.id === cur.id ? st : cur);
  const hold = held ? planLines(held.plan) : null;
  const publish = () => {
    if (!next) return;
    setBusy(true);
    (next.tool === "preview" ? preview(cur.id).then(() => { showToast("Preview built. Nothing is public."); load(); }) : act(next.tool, cur.id).then((r) => { const h = heldOf(r); if (h) setHeld(h); else { showToast("Done."); load(); } }))
      .catch((e) => showToast(say(e))).finally(() => setBusy(false));
  };
  const decideHeld = (approve: boolean) => {
    if (!held) return;
    setBusy(true);
    decide(decision(held, approve)).then(() => { showToast(approve ? "Done." : "Declined."); setHeld(null); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false));
  };
  return (
    <View className="gap-s3">
      <View className="flex-row flex-wrap items-center gap-s2">
        <Button kind="ghost" size="sm" label="Files" onPress={onBack} />
        <Text strong>{site.name}</Text>
        <Chip tone={site.status.tone}>{site.status.label}</Chip>
        <View className="flex-1" />
        <Button kind="ghost" size="sm" label="Change it with Engineer" onPress={() => router.push(`/u/chats/new?start=${encodeURIComponent(`Change my site ${site.name}: `)}` as never)} />
        {address.url ? <Button kind="ghost" size="sm" label="Visit" onPress={() => { window.open(address.url!, "_blank", "noopener"); }} /> : null}
        {next && !held ? <Button kind="primary" size="sm" label={busy ? "Working" : waiting ? "Publish changes" : next.label} disabled={busy} onPress={publish} /> : null}
      </View>
      {hold && held ? (
        <AskCard title={hold.title} why={hold.lines.join(" ")}
          actions={[{ label: busy ? "Deciding" : presenceText("Approve with Face ID"), kind: "primary", icon: "faceid", onPress: busy ? () => {} : () => decideHeld(true) }, { label: "Not now", kind: "ghost", onPress: () => decideHeld(false) }]} />
      ) : null}
      {waiting ? <Banner><Text>{`Version ${cur.version} is not published yet. Version ${site.live!.version} is what visitors see.`}</Text></Banner> : null}
      <Card flush>
        <View style={{ height: 360 }}>
          {address.preview ? <iframe title={`${site.name} preview`} src={address.preview} style={{ width: "100%", height: "100%", border: 0, background: "white" }} sandbox="allow-scripts allow-same-origin allow-forms" /> : <EmptyState title="No preview yet" body="Build a preview to see the site here. Nothing is public until you publish." />}
        </View>
      </Card>
      <Card flush>
        <Row title="Address" sub={address.url ?? "Not live yet"} />
        {cur.domains.map((d) => <View key={d.host}><Divider /><Row title={d.host} sub={domainLine(d)} /></View>)}
        <Divider />
        <Row title="More settings" sub="History, domains, secrets, jobs and logs" end={<Button kind="ghost" size="sm" label="Open" onPress={() => router.push(`/u/sites/${encodeURIComponent(site.name)}` as never)} />} />
      </Card>
    </View>
  );
}
