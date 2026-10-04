// Sites from the real box (publish.*): every site in the space with its stage, a Publish sheet that starts a new one as a draft, and a site's page with the
// pipeline, History, Domain, Secrets and the last build's log. Going live, approving and going back are held acts: the box answers with the plan, the person reads it,
// and publish.decide carries their presence. Nothing here is sample.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AskCard, Banner, Button, Card, Chip, Divider, EmptyState, Field, IconTile, Row, Segmented, Sheet, StageSteps, Switch, Tabs, Text, showToast } from "@vyre/ui";
import { Block } from "../places/Page";
import { Footnote, Frame, Sec } from "../places/Frame";
import { act, create, decide, domainAdd, domainRemove, domainVerify, list, preview, retire, secretGrant, secretRevoke, status as statusOf, vaultItems } from "./real";
import { BLANK, PIPE, SOURCES, build, challengeText, decision, domainLine, heldOf, nextStep, planLines, publishRefusal, sites, stepOf, type Dep, type Draft, type Held, type Site, type Status } from "./real-model";

const say = (e: unknown) => publishRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");

export function RealSites() {
  const router = useRouter();
  const [deps, setDeps] = useState<Dep[] | null>(null);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setErr(""); list().then(setDeps).catch((e) => setErr(say(e))); }, []);
  useEffect(load, [load]);
  const save = () => {
    if (!draft) return;
    const b = build(draft);
    if ("error" in b) { setProblem(b.error); return; }
    setProblem(""); setBusy(true);
    create(b.input).then(() => { setDraft(null); showToast("Started as a draft. Nothing is public."); load(); router.push(`/u/sites/${b.input.name}` as never); }).catch((e) => setProblem(say(e))).finally(() => setBusy(false));
  };
  const rows = deps ? sites(deps) : [];
  return (
    <Frame title="Sites" sub="Sites and apps you publish, each one on its own." actions={<Button kind="primary" icon="plus" label="Publish" onPress={() => { setProblem(""); setDraft({ ...BLANK }); }} />}>
      {err ? <Card flush><EmptyState title="Publish did not answer" body={err} action={{ label: "Try again", onPress: load }} /></Card> : null}
      {deps === null && !err ? <Card flush><EmptyState title="Loading" body="Asking your Vyre." /></Card> : null}
      {deps && !rows.length ? <Card flush><EmptyState title="Nothing published in this space" body="Publish a site from a repo or a Drive folder. Nothing goes live until you say so." action={{ label: "Publish", onPress: () => setDraft({ ...BLANK }) }} /></Card> : null}
      {rows.length ? (
        <Card flush>
          {rows.map((s, i) => (
            <View key={s.name}>{i ? <Divider inset={60} /> : null}
              <Row dense chevron onPress={() => router.push(`/u/sites/${s.name}` as never)} lead={<IconTile name="sites" />} title={s.name}
                sub={`${s.live ? `live version ${s.live.version}${s.live.domains[0] ? ` at ${s.live.domains[0].host}` : ""}` : "not live"}${s.current.stage === "Preview" || s.current.stage === "Approved" ? `, version ${s.current.version} in ${s.current.stage.toLowerCase()}` : ""}`}
                end={<Chip tone={s.status.tone}>{s.status.label}</Chip>} />
            </View>
          ))}
        </Card>
      ) : null}
      <Sheet open={!!draft} onClose={() => setDraft(null)} title="Publish">
        {draft ? (
          <View className="gap-s3">
            <Field label="Name" placeholder="client-intake" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} />
            <Segmented label="Source" value={draft.kind} onChange={(kind) => setDraft({ ...draft, kind })} options={SOURCES.map((s) => [s.kind, s.title] as [Draft["kind"], string])} />
            <Field label="Where the source is" placeholder={SOURCES.find((s) => s.kind === draft.kind)?.hint} value={draft.ref} onChangeText={(ref) => setDraft({ ...draft, ref })} />
            <Segmented label="Builds with" value={draft.image} onChange={(image) => setDraft({ ...draft, image })} options={[["static", "Static pages"], ["node-20", "Node 20"], ["node-22", "Node 22"]]} />
            {draft.image !== "static" ? <Field label="Build command" placeholder="npm run build" value={draft.command} onChangeText={(command) => setDraft({ ...draft, command })} /> : null}
            {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
            <Button kind="primary" label={busy ? "Starting" : "Start as a draft"} disabled={busy} onPress={save} />
            <Text size="caption" tone="label">Nothing goes live until you say so.</Text>
          </View>
        ) : null}
      </Sheet>
    </Frame>
  );
}

type Tab = "pipeline" | "history" | "domain" | "secrets" | "logs";

export function RealSite() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [deps, setDeps] = useState<Dep[] | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("pipeline");
  const [held, setHeld] = useState<Held | null>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState("");
  const [host, setHost] = useState("");
  const [challenge, setChallenge] = useState("");
  const load = useCallback(() => { setErr(""); list().then(setDeps).catch((e) => setErr(say(e))); }, []);
  useEffect(load, [load]);
  const site: Site | undefined = deps ? sites(deps).find((s) => s.name === id) : undefined;
  const cur = site?.current;
  useEffect(() => { if (cur) statusOf(cur.id).then(setSt).catch(() => setSt(null)); }, [cur?.id, cur?.stage]);

  const run = (f: () => Promise<unknown>, done?: string) => { setBusy(true); f().then(() => { if (done) showToast(done); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  const step = (tool: "preview" | "approve" | "publish" | "rollback", d: Dep) => {
    setBusy(true);
    (tool === "preview" ? preview(d.id).then((r) => { setLogs(r.logs ?? ""); load(); showToast("Preview built. Nothing is public."); return null; }) : act(tool, d.id).then((r) => { const h = heldOf(r); if (h) setHeld(h); else load(); }))
      .catch((e) => showToast(say(e))).finally(() => setBusy(false));
  };
  const decideHeld = (approve: boolean) => {
    if (!held) return;
    setBusy(true);
    decide(decision(held, approve)).then((r) => { showToast(approve ? "Done." : "Declined."); setHeld(null); load(); void r; }).catch((e) => showToast(say(e))).finally(() => setBusy(false));
  };

  if (err) return <Frame title="Sites" back="/u/sites"><EmptyState title="Publish did not answer" body={err} action={{ label: "Try again", onPress: load }} /></Frame>;
  if (deps === null) return <Frame title="Sites" back="/u/sites"><EmptyState title="Loading" body="Asking your Vyre." /></Frame>;
  if (!site || !cur) return <Frame title="Sites" back="/u/sites"><EmptyState title="That site is not here" body="It may have been retired. Open Sites to see what is published." action={{ label: "Open Sites", onPress: () => router.push("/u/sites" as never) }} /></Frame>;
  const next = nextStep(st && st.id === cur.id ? st : cur);
  const hold = held ? planLines(held.plan) : null;

  const body =
    tab === "pipeline" ? (
      <View className="gap-s4">
        <Sec title={`Version ${cur.version} of ${site.name}`}><StageSteps stages={PIPE} current={Math.min(stepOf(cur), PIPE.length)} /></Sec>
        {cur.url && cur.stage !== "Production" ? <Card><View className="gap-s1"><Text size="caption" tone="label">Private preview</Text><Text mono strong>{cur.url}</Text></View></Card> : null}
        {st?.sealed_check ? <Text size="caption" tone="label">{`Sealed-value check: ${st.sealed_check}.`}</Text> : null}
        {hold && held ? (
          <AskCard title={hold.title} why={hold.lines.join(" ")}
            actions={[{ label: busy ? "Deciding" : "Approve with Face ID", kind: "primary", icon: "faceid", onPress: busy ? () => {} : () => decideHeld(true) }, { label: "Not now", kind: "ghost", onPress: () => decideHeld(false) }]} />
        ) : next ? (
          <View className="self-start"><Button kind="primary" label={busy ? "Working" : next.label} disabled={busy} onPress={() => step(next.tool, cur)} /></View>
        ) : <Banner>{cur.stage === "Production" ? `Version ${cur.version} is live.` : `Nothing to do for version ${cur.version}.`}</Banner>}
        {site.live && cur.id !== site.live.id ? <Text size="caption" tone="label">{`Version ${site.live.version} stays live until this one goes live.`}</Text> : null}
      </View>
    ) : tab === "history" ? (
      <View className="gap-s2">
        <Card flush>
          {site.versions.map((v, i) => (
            <View key={v.id}>{i ? <Divider /> : null}
              <Row title={`Version ${v.version}`} sub={v.url ?? "Not built yet"}
                end={v.stage === "Production" ? <Chip tone="ok">Live</Chip> : v.stage === "Retired" ? <Chip>Retired</Chip> : <Chip tone="accent">{v.stage}</Chip>} />
            </View>
          ))}
        </Card>
        {site.live ? <View className="flex-row gap-s2 pt-s2"><Button kind="ghost" size="sm" label="Go back one version" disabled={busy} onPress={() => step("rollback", site.live!)} /><Button kind="holdText" size="sm" label="Take the live version down" disabled={busy} onPress={() => run(() => retire(site.live!.id), "Taken down. Its record stays.")} /></View> : null}
        <Text size="caption" tone="label">Going back needs you, and takes effect at once. The version you leave stays in the history.</Text>
      </View>
    ) : tab === "domain" ? (
      <View className="gap-s3">
        <Card flush>
          {cur.domains.length ? cur.domains.map((d, i) => (
            <View key={d.host}>{i ? <Divider /> : null}
              <Row title={d.host} sub={domainLine(d)} end={<View className="flex-row gap-s2"><Button kind="ghost" size="sm" label="Check" onPress={() => run(() => domainVerify(d.host).then((r) => { showToast(r.verified ? "Connected." : r.reason ?? "Not connected yet. DNS can take up to an hour."); if (r.challenge) setChallenge(challengeText(r.challenge)); }))} /><Button kind="holdText" size="sm" label="Remove" onPress={() => run(() => domainRemove(d.host), "Disconnected.")} /></View>} />
            </View>
          )) : <EmptyState title="No custom domain" body="Add your own domain. Nothing serves until the DNS record is in place and the site is live." />}
        </Card>
        <Field label="Add a domain" placeholder="www.example.com" value={host} onChangeText={setHost} />
        <View className="self-start"><Button size="sm" label="Add" onPress={() => { const h = host.trim().toLowerCase(); if (!h) return; run(() => domainAdd(h, cur.id).then((r) => { setChallenge(challengeText(r.challenge)); setHost(""); })); }} /></View>
        {challenge ? <Block label="Add this record at your domain provider">{challenge}</Block> : null}
      </View>
    ) : tab === "secrets" ? (
      <Secrets dep={cur} st={st} run={run} reload={() => statusOf(cur.id).then(setSt).catch(() => {})} setHeld={setHeld} />
    ) : (
      <View className="gap-s3">
        <Block label={`Build log, version ${cur.version}`}>{logs || "The build log is shown here right after you build a preview. The box does not keep it."}</Block>
      </View>
    );

  return (
    <Frame back="/u/sites" title={site.name} sub={`${cur.stage === "Production" ? "Live" : cur.stage}${site.live?.domains[0] ? `, ${site.live.domains[0].host}` : ""}`}>
      <Tabs<Tab> value={tab} onChange={setTab} items={[["pipeline", "Publish"], ["history", "History"], ["domain", "Domain"], ["secrets", "Secrets"], ["logs", "Logs"]]} />
      {body}
      <Footnote icon="shield">{`This site runs on its own. It cannot reach your space's data unless you grant it. Granted now: ${st?.secrets.length ? st.secrets.map((s) => s.name).join(", ") : "nothing"}.`}</Footnote>
    </Frame>
  );
}

function Secrets({ dep, st, run, reload, setHeld }: { dep: Dep; st: Status | null; run: (f: () => Promise<unknown>, done?: string) => void; reload: () => void; setHeld: (h: Held) => void }) {
  const [items, setItems] = useState<{ name: string; kind: string; fields: string[] }[] | null>(null);
  const [item, setItem] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [use, setUse] = useState<"build" | "runtime">("runtime");
  useEffect(() => { vaultItems().then(setItems).catch(() => setItems([])); }, []);
  const chosen = items?.find((i) => i.name === item);
  const grant = () => {
    if (!chosen || !field || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) { showToast("Pick an item and a field, and name the setting in capitals, like STRIPE_KEY."); return; }
    run(() => secretGrant(dep.id, `vault://${chosen.name}/${field}`, name, [use]).then((r) => { const h = heldOf(r); if (h) setHeld(h); reload(); setName(""); }));
  };
  return (
    <View className="gap-s3">
      <Card flush>
        {st?.secrets.length ? st.secrets.map((s, i) => <View key={s.name}>{i ? <Divider /> : null}<Row title={s.name} sub={`Granted for ${s.use.join(" and ")}. It can use it, not read it.`} end={<Button kind="holdText" size="sm" label="Revoke" onPress={() => run(() => secretRevoke(dep.id, s.name).then(reload), `${s.name} is revoked.`)} />} /></View>) : <EmptyState title="No secrets granted" body="A site gets only the secrets you grant it, one by one." />}
      </Card>
      {st?.ungranted_env.length ? <Banner>{`Waiting for a grant: ${st.ungranted_env.join(", ")}.`}</Banner> : null}
      <Sec title="Grant one from the Vault">
        <View className="flex-row flex-wrap gap-s2">{(items ?? []).map((i) => <Chip key={i.name} selected={item === i.name} onPress={() => { setItem(i.name); setField(null); }}>{i.name}</Chip>)}</View>
        {chosen ? <View className="flex-row flex-wrap gap-s2">{chosen.fields.map((f) => <Chip key={f} selected={field === f} onPress={() => setField(f)}>{f}</Chip>)}</View> : null}
        <Field label="Setting name" placeholder="STRIPE_KEY" value={name} onChangeText={(v) => setName(v.toUpperCase())} />
        <Segmented label="Used" value={use} onChange={setUse} options={[["runtime", "While running"], ["build", "While building"]]} />
        <View className="self-start"><Button size="sm" label="Grant" onPress={grant} /></View>
        <Text size="caption" tone="label">A real secret needs your approval with Face ID. These come from the Vault.</Text>
      </Sec>
    </View>
  );
}
