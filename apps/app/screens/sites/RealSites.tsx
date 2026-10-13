// Sites from the real box (publish.*): every site in the space with its stage, a Publish sheet that starts a new one as a draft, and a site's page with the
// pipeline, History, Domain, Secrets and the last build's log. Going live, approving and going back are held acts: the box answers with the plan, the person reads it,
// and publish.decide carries their presence. Nothing here is sample.
import { useCallback, useEffect, useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { presenceText } from "../shell/FaceIdSheet";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AskCard, Banner, Button, Card, Chip, Divider, EmptyState, Field, Row, Segmented, Sheet, StageSteps, Switch, Tabs, Text, showToast, ErrorState, LoadingState, useUiTheme } from "@vyre/ui";
import { Block } from "../places/Page";
import { Footnote, Frame, Sec } from "../places/Frame";
import { act, create, decide, domainAdd, domainRemove, domainVerify, door, edgeDown, edgeUp, jobAttention, jobRun, jobRuns, list, preview, retire, secretGrant, secretRevoke, status as statusOf, vaultItems } from "./real";
import { SitesList } from "./SitesList";
import { BLANK, CHECK_EVERY_MS, PIPE, SOURCES, build, canonicalChoice, canonicalInput, checkOf, doorBanner, dockerBanner, grantProblem, jobLine, type Canonical, type Check, type JobRun, decision, domainLine, heldOf, nextStep, planLines, publishRefusal, recordOf, repoGrant, sites, stepOf, versionRows, waitingRows, type Dep, type Draft, type Held, type Site, type Status } from "./real-model";
import { personName } from "../spaces/real.js";
import { useMembers } from "../spaces/state";
import { PlaceTag } from "../../src/real/PlaceTag";
import { useMayMakeTemplates } from "../templates/role";

const say = (e: unknown) => publishRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");

/** Whether the public door is on, asked once per change in what is live. Null until it answers. */
function useDoor(key: unknown) {
  const [names, setNames] = useState<{ listening?: unknown } | null>(null);
  useEffect(() => { door().then(setNames).catch(() => setNames(null)); }, [key]);
  return names;
}

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
    const token = repoGrant(draft);
    create(b.input).then(() => { setDraft(null); showToast(token ? "Started as a draft. Grant the GitHub token next." : "Started as a draft. Nothing is public."); load(); router.push((`/u/sites/${b.input.name}` + (token ? `?tab=secrets&grant=${token.name}` : "")) as never); }).catch((e) => setProblem(say(e))).finally(() => setBusy(false));
  };
  const { color } = useUiTheme();
  // Taking sites online or offline is for an owner or an admin (the same role rule as making a playbook).
  const mayServe = useMayMakeTemplates();
  const rows = deps ? sites(deps) : [];
  const [noDocker, setNoDocker] = useState<string | null>(null);
  const names = useDoor(deps);
  const offline = doorBanner(names, rows.some((s) => !!s.live));
  const [failing, setFailing] = useState<{ deployment: string; name: string; message: string }[]>([]);
  useEffect(() => { jobAttention().then(setFailing).catch(() => setFailing([])); }, [deps]);
  return (
    <Frame title="Sites" sub="Sites and apps you publish, each one on its own." actions={<Button kind="primary" icon="plus" label="Publish" onPress={() => { setProblem(""); setDraft({ ...BLANK }); }} />}>
      <PlaceTag of="home" />
      {err ? <Card flush><ErrorState title="Publish did not load" reason={err} retry={load} /></Card> : null}
      {deps === null && !err ? <LoadingState rows={3} /> : null}
      {deps && !rows.length ? <Card flush><EmptyState title="Nothing published in this space" body="Publish a site from a repo or a Files folder. Nothing goes live until you say so." action={{ label: "Publish", onPress: () => setDraft({ ...BLANK }) }} /></Card> : null}
      {noDocker ? <Banner tone="warn"><Text>{noDocker}</Text></Banner> : null}
      {offline && !noDocker ? <Banner tone="warn"><Text>{offline}</Text></Banner> : null}
      {failing.length ? (
        <View accessibilityRole="alert" style={{ borderRadius: 12, padding: 12, gap: 4, backgroundColor: color["accent-wash"] }}>
          <Text strong tone="accent">{failing.length === 1 ? "A job needs you" : `${failing.length} jobs need you`}</Text>
          {failing.map((j) => <Text key={j.deployment} size="caption">{`${j.name} failed on its last run. Open the site's Jobs to see it.`}</Text>)}
        </View>
      ) : null}
      {rows.length ? <SitesList rows={rows} onOpen={(name) => router.push(`/u/sites/${name}` as never)} /> : null}
      {rows.length && mayServe ? <Serving onNoDocker={setNoDocker} /> : null}
      <Sheet open={!!draft} onClose={() => setDraft(null)} title="Publish">
        {draft ? (
          <View className="gap-s3">
            <Field label="Name" placeholder="client-intake" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} />
            <Segmented label="Source" value={draft.kind} onChange={(kind) => setDraft({ ...draft, kind })} options={SOURCES.map((s) => [s.kind, s.title] as [Draft["kind"], string])} />
            <Field label="Where the source is" placeholder={SOURCES.find((s) => s.kind === draft.kind)?.hint} value={draft.ref} onChangeText={(ref) => setDraft({ ...draft, ref })} />
            {draft.kind === "repo" ? (
              <View className="gap-s1">
                <View className="flex-row items-center justify-between gap-s3"><Text>This repo is private</Text><Switch on={draft.private} onChange={(v) => setDraft({ ...draft, private: v })} label="This repo is private" /></View>
                {draft.private ? <Text size="caption" tone="label">Next you pick a GitHub token from the Vault. It is used to read the repo while building, and nothing else.</Text> : null}
              </View>
            ) : null}
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

type Tab = "pipeline" | "history" | "domain" | "secrets" | "jobs" | "logs";

export function RealSite() {
  const { phone } = useUiTheme();
  const { id, tab: tabParam, grant } = useLocalSearchParams<{ id: string; tab?: string; grant?: string }>();
  const router = useRouter();
  const [deps, setDeps] = useState<Dep[] | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>((["pipeline", "history", "domain", "secrets", "jobs", "logs"] as string[]).includes(String(tabParam)) ? (tabParam as Tab) : "pipeline");
  const [held, setHeld] = useState<Held | null>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState("");
  const [host, setHost] = useState("");
  const [pick, setPick] = useState<Canonical>("apex");
  const [setup, setSetup] = useState<{ host: string; challenge: unknown } | null>(null);
  const [hist, setHist] = useState<Record<string, Status | undefined>>({});
  const self = useMembers((m) => m.selfId);
  const load = useCallback(() => { setErr(""); list().then(setDeps).catch((e) => setErr(say(e))); }, []);
  useEffect(load, [load]);
  const site: Site | undefined = deps ? sites(deps).find((s) => s.name === id) : undefined;
  const cur = site?.current;
  useEffect(() => { if (cur) statusOf(cur.id).then(setSt).catch(() => setSt(null)); }, [cur?.id, cur?.stage]);
  // History reads each version's own status for who approved it and when it went live
  const ids = site ? site.versions.map((v) => v.id).join(",") : "";
  useEffect(() => { if (tab === "history" && ids) ids.split(",").forEach((vid) => statusOf(vid).then((x) => setHist((h) => ({ ...h, [vid]: x }))).catch(() => {})); }, [tab, ids, cur?.stage]);
  const names = useDoor(deps);
  const offline = doorBanner(names, !!site?.live);

  const run = (f: () => Promise<unknown>, done?: string) => { setBusy(true); f().then(() => { if (done) showToast(done); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  const step = (tool: "preview" | "approve" | "go" | "publish" | "rollback", d: Dep) => {
    setBusy(true);
    (tool === "preview" ? preview(d.id).then((r) => { setLogs(r.logs ?? ""); load(); showToast("Preview built. Nothing is public."); return null; }) : act(tool, d.id).then((r) => { const h = heldOf(r); if (h) setHeld(h); else load(); }))
      .catch((e) => showToast(say(e))).finally(() => setBusy(false));
  };
  const decideHeld = (approve: boolean) => {
    if (!held) return;
    setBusy(true);
    decide(decision(held, approve)).then((r) => { showToast(approve ? "Done." : "Declined."); setHeld(null); load(); void r; }).catch((e) => showToast(say(e))).finally(() => setBusy(false));
  };

  if (err) return <Frame title="Sites" back="/u/sites"><ErrorState title="Publish did not load" reason={err} retry={load} /></Frame>;
  if (deps === null) return <Frame title="Sites" back="/u/sites"><LoadingState rows={3} /></Frame>;
  if (!site || !cur) return <Frame title="Sites" back="/u/sites"><EmptyState title="That site is not here" body="It may have been retired. Open Sites to see what is published." action={{ label: "Open Sites", onPress: () => router.push("/u/sites" as never) }} /></Frame>;
  const next = nextStep(st && st.id === cur.id ? st : cur);
  const hold = held ? planLines(held.plan) : null;

  const body =
    tab === "pipeline" ? (
      <View className="gap-s4">
        {offline ? <Banner tone="warn"><Text>{offline}</Text></Banner> : null}
        <Sec title={`Version ${cur.version} of ${site.name}`}><StageSteps stages={PIPE} current={Math.min(stepOf(cur), PIPE.length)} /></Sec>
        {cur.url && cur.stage !== "Production" ? <Card><View className="gap-s1"><Text size="caption" tone="label">Private preview</Text><Text mono strong>{cur.url}</Text></View></Card> : null}
        {st?.sealed_check ? <Text size="caption" tone="label">{`Sealed-value check: ${st.sealed_check}.`}</Text> : null}
        {hold && held ? (
          <AskCard title={hold.title} why={hold.lines.join(" ")}
            actions={[{ label: busy ? "Deciding" : presenceText("Approve with Face ID"), kind: "primary", icon: "faceid", onPress: busy ? () => {} : () => decideHeld(true) }, { label: "Not now", kind: "ghost", onPress: () => decideHeld(false) }]} />
        ) : next ? (
          <View className="self-start"><Button kind="primary" label={busy ? "Working" : next.label} disabled={busy} onPress={() => step(next.tool, cur)} /></View>
        ) : <Banner>{cur.stage === "Production" ? `Version ${cur.version} is live.` : `Nothing to do for version ${cur.version}.`}</Banner>}
        {site.live && cur.id !== site.live.id ? <Text size="caption" tone="label">{`Version ${site.live.version} stays live until this one goes live.`}</Text> : null}
      </View>
    ) : tab === "history" ? (
      <View className="gap-s2">
        <VersionTable rows={versionRows(site.versions, hist, (who) => personName(who, self))} phone={phone} />
        {site.live ? <View className="flex-row gap-s2 pt-s2"><Button kind="ghost" size="sm" label="Go back one version" disabled={busy} onPress={() => step("rollback", site.live!)} /><Button kind="holdText" size="sm" label="Take the live version down" disabled={busy} onPress={() => run(() => retire(site.live!.id), "Taken down. Its record stays.")} /></View> : null}
        <Text size="caption" tone="label">Going back needs you, and takes effect at once. The version you leave stays in the history.</Text>
      </View>
    ) : tab === "domain" ? (
      <View className="gap-s3">
        <Card flush>
          {cur.domains.length ? cur.domains.map((d, i) => (
            <View key={d.host}>{i ? <Divider /> : null}
              <Row title={d.host} sub={domainLine(d)} end={<View className="flex-row gap-s2"><Button kind="ghost" size="sm" label={checkOf(d).state === "verified" ? "Details" : "Set up"} onPress={() => setSetup({ host: d.host, challenge: null })} /><Button kind="holdText" size="sm" label="Remove" onPress={() => run(() => domainRemove(d.host), "Disconnected.")} /></View>} />
            </View>
          )) : <EmptyState title="No custom domain" body="Add your own domain. Nothing serves until the DNS record is in place and the site is live." />}
        </Card>
        <Field label="Add a domain" placeholder="example.com or www.example.com" value={host} onChangeText={setHost} />
        {canonicalChoice(host) ? <Segmented label="Visitors land on" value={pick} onChange={setPick} options={[["apex", canonicalChoice(host)!.apex], ["www", canonicalChoice(host)!.www]]} /> : null}
        <View className="self-start"><Button size="sm" label="Add" onPress={() => { const h = host.trim().toLowerCase(); if (!h) return; run(() => domainAdd(h, cur.id, canonicalInput(h, pick)).then((r) => { setSetup({ host: r.domain.host, challenge: r.challenge }); setHost(""); })); }} /></View>
        <DomainSheet setup={setup} onClose={() => setSetup(null)} onChanged={load} />
      </View>
    ) : tab === "secrets" ? (
      <Secrets dep={cur} st={st} run={run} reload={() => statusOf(cur.id).then(setSt).catch(() => {})} setHeld={setHeld} start={grant === "GITHUB_TOKEN" ? repoGrant({ kind: "repo", private: true }) : null} />
    ) : tab === "jobs" ? (
      <Jobs dep={site.live ?? cur} />
    ) : (
      <View className="gap-s3">
        <Block label={`Build log, version ${cur.version}`}>{logs || "The build log is shown here right after you build a preview. Vyre does not keep it."}</Block>
      </View>
    );

  return (
    <Frame back="/u/sites" title={site.name} sub={phone ? [site.status.label, site.live?.domains[0]?.host].filter(Boolean).join(" · ") : site.live?.domains[0]?.host ?? ""} actions={phone ? undefined : <Chip tone={site.status.tone}>{site.status.label}</Chip>}>
      <Tabs<Tab> value={tab} onChange={setTab} items={[["pipeline", "Publish"], ["history", "History"], ["domain", "Domain"], ["secrets", "Secrets"], ["jobs", "Jobs"], ["logs", "Logs"]]} />
      {body}
      <Footnote icon="shield">{`This site runs on its own. It cannot reach your space's data unless you grant it. Granted now: ${st?.secrets.length ? st.secrets.map((s) => s.name).join(", ") : "nothing"}.`}</Footnote>
    </Frame>
  );
}

function Secrets({ dep, st, run, reload, setHeld, start }: { dep: Dep; st: Status | null; run: (f: () => Promise<unknown>, done?: string) => void; reload: () => void; setHeld: (h: Held) => void; start: { name: string; use: "build" | "runtime" } | null }) {
  const [items, setItems] = useState<{ name: string; kind: string; fields: string[] }[] | null>(null);
  const [item, setItem] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);
  // a name the form is fixed to: a private repo's token, or a name the site is waiting on
  const [fixed, setFixed] = useState<string | null>(start?.name ?? null);
  const [name, setName] = useState(start?.name ?? "");
  const [use, setUse] = useState<"build" | "runtime">(start?.use ?? "runtime");
  useEffect(() => { vaultItems().then(setItems).catch((e) => { setItems([]); showToast(say(e)); }); }, []);
  const chosen = items?.find((i) => i.name === item);
  const pickFor = (n: string) => { setFixed(n); setName(n); setUse(n === repoGrant({ kind: "repo", private: true })!.name ? "build" : "runtime"); };
  const grant = () => {
    const no = grantProblem(item, field, name);
    if (no || !chosen || !field) { showToast(no ?? ""); return; }
    run(() => secretGrant(dep.id, `vault://${chosen.name}/${field}`, name, [use]).then((r) => { const h = heldOf(r); if (h) setHeld(h); reload(); setName(""); setFixed(null); }));
  };
  const waiting = waitingRows(st?.ungranted_env);
  return (
    <View className="gap-s3">
      <Card flush>
        {st?.secrets.length ? st.secrets.map((s, i) => <View key={s.name}>{i ? <Divider /> : null}<Row title={s.name} sub={`Granted for ${s.use.join(" and ")}. It can use it, not read it.`} end={<Button kind="holdText" size="sm" label="Revoke" onPress={() => run(() => secretRevoke(dep.id, s.name).then(reload), `${s.name} is revoked.`)} />} /></View>) : <EmptyState title="No secrets granted" body="A site gets only the secrets you grant it, one by one." />}
      </Card>
      {waiting.length ? (
        <Sec title="Waiting for a grant">
          <Card flush>{waiting.map((w, i) => <View key={w.name}>{i ? <Divider /> : null}<Row title={w.name} sub={w.sub} end={<Button size="sm" kind="secondary" label="Pick from Vault" onPress={() => pickFor(w.name)} />} /></View>)}</Card>
        </Sec>
      ) : null}
      <Sec title={fixed ? `Grant ${fixed} from the Vault` : "Grant one from the Vault"}>
        <View className="flex-row flex-wrap gap-s2">{(items ?? []).map((i) => <Chip key={i.name} selected={item === i.name} onPress={() => { setItem(i.name); setField(null); }}>{i.name}</Chip>)}</View>
        {chosen ? <View className="flex-row flex-wrap gap-s2">{chosen.fields.map((f) => <Chip key={f} selected={field === f} onPress={() => setField(f)}>{f}</Chip>)}</View> : null}
        {fixed ? (
          <View className="flex-row items-center justify-between gap-s3"><Text>Setting name</Text><View className="flex-row items-center gap-s2"><Text mono strong>{fixed}</Text><Button kind="ghost" size="sm" label="Change" onPress={() => { setFixed(null); setName(""); }} /></View></View>
        ) : <Field label="Setting name" placeholder="STRIPE_KEY" value={name} onChangeText={(v) => setName(v.toUpperCase())} />}
        <Segmented label="Used" value={use} onChange={setUse} options={[["runtime", "While running"], ["build", "While building"]]} />
        <View className="self-start"><Button size="sm" label="Grant" onPress={grant} /></View>
        <Text size="caption" tone="label">A real secret needs your approval with Face ID. These come from the Vault. If a key changes in the Vault, live sites restart with the new one.</Text>
      </Sec>
    </View>
  );
}

/** The History table: version, who approved it, when it went live and its address. A phone stacks each version as one row. */
function VersionTable({ rows, phone }: { rows: ReturnType<typeof versionRows>; phone: boolean }) {
  const chip = (stage: string) => (stage === "Production" ? <Chip tone="ok">Live</Chip> : stage === "Retired" ? <Chip>Retired</Chip> : <Chip tone="accent">{stage}</Chip>);
  if (phone) return (
    <Card flush>
      {rows.map((v, i) => (
        <View key={v.id}>{i ? <Divider /> : null}
          <Row title={`Version ${v.version}`} sub={[v.approvedBy && `Approved by ${v.approvedBy}`, v.wentLive && `Live ${v.wentLive}`, v.address].filter(Boolean).join(" · ")} end={chip(v.stage)} />
        </View>
      ))}
    </Card>
  );
  const cell = "flex-1 min-w-0";
  return (
    <Card flush>
      <View className="flex-row items-center gap-s3 px-s4 py-s2">
        <View className="w-[88px]"><Text size="caption" tone="label">Version</Text></View>
        <View className={cell}><Text size="caption" tone="label">Approved by</Text></View>
        <View className={cell}><Text size="caption" tone="label">Went live</Text></View>
        <View className="flex-[2] min-w-0"><Text size="caption" tone="label">Address</Text></View>
        <View className="w-[72px]" />
      </View>
      {rows.map((v) => (
        <View key={v.id}><Divider />
          <View className="flex-row items-center gap-s3 px-s4 py-s3">
            <View className="w-[88px]"><Text strong>{`Version ${v.version}`}</Text></View>
            <View className={cell}><Text>{v.approvedBy || " "}</Text></View>
            <View className={cell}><Text>{v.wentLive || " "}</Text></View>
            <View className="flex-[2] min-w-0"><Text mono size="caption" numberOfLines={1}>{v.address}</Text></View>
            <View className="w-[72px] items-end">{chip(v.stage)}</View>
          </View>
        </View>
      ))}
    </Card>
  );
}

/** One DNS record part with its Copy button. */
function RecordPart({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  const copy = () => { Clipboard.setStringAsync(value).then(() => { setDone(true); showToast("Copied"); setTimeout(() => setDone(false), 2000); }).catch(() => showToast("This device would not copy it.")); };
  return (
    <View className="flex-row items-center justify-between gap-s3">
      <View className="min-w-0 flex-1 gap-s1"><Text size="caption" tone="label">{label}</Text><Text mono selectable>{value}</Text></View>
      <Button kind="ghost" size="sm" label={done ? "Copied" : "Copy"} onPress={copy} />
    </View>
  );
}

/** Connect a domain: the record to add as a card (type, name, value, each with Copy) and its state. It checks by itself every 20 seconds while open, until it is connected. */
function DomainSheet({ setup, onClose, onChanged }: { setup: { host: string; challenge: unknown } | null; onClose: () => void; onChanged: () => void }) {
  const [rec, setRec] = useState<ReturnType<typeof recordOf>>(null);
  const [check, setCheck] = useState<Check>({ state: "pending", line: "Checking." });
  const [vyreRun, setVyreRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const host = setup?.host ?? "";
  const connected = useRef(false);
  const verify = useCallback(() => {
    if (!host || connected.current) return Promise.resolve();
    setBusy(true);
    return domainVerify(host).then((r) => {
      const c = r.challenge ?? null;
      if (c) { setRec(recordOf(c)); setVyreRun((c as { type?: string }).type === "names"); }
      setCheck(checkOf(r.verified ? { host, status: "verified" } : r.domain, r.reason));
      if (r.verified) { connected.current = true; onChanged(); }
    }).catch((e) => setCheck({ state: "failed", line: say(e) })).finally(() => setBusy(false));
  }, [host, onChanged]);
  useEffect(() => {
    if (!setup) return;
    setRec(recordOf(setup.challenge)); setVyreRun((setup.challenge as { type?: string } | null)?.type === "names");
    setCheck({ state: "pending", line: "Checking." });
    connected.current = false;
    void verify();
    const t = setInterval(() => { void verify(); }, CHECK_EVERY_MS);
    return () => clearInterval(t);
  }, [setup, verify]);
  return (
    <Sheet open={!!setup} onClose={onClose} title={host ? `Connect ${host}` : "Connect a domain"}>
      {setup ? (
        <View className="gap-s3">
          {rec ? (
            <Card className="gap-s3">
              <Text strong>Add this record at your domain&apos;s DNS provider</Text>
              <RecordPart label="Type" value={rec.type} />
              <Divider />
              <RecordPart label="Name" value={rec.name} />
              <Divider />
              <RecordPart label="Value" value={rec.value} />
            </Card>
          ) : vyreRun ? <Text tone="muted">This name is on vyre.run, so there is no record to add.</Text> : <Text tone="muted">Looking up the record.</Text>}
          <Banner tone={check.state === "failed" ? "err" : "plain"} icon={check.state === "pending" ? "info" : undefined}>
            <View className="gap-s1"><Text strong>{check.state === "verified" ? "Verified" : check.state === "failed" ? "Failed" : "Pending"}</Text><Text size="caption">{check.line}</Text></View>
          </Banner>
          <View className="flex-row gap-s2"><Button size="sm" kind="secondary" label={busy ? "Checking" : "Check now"} disabled={busy} onPress={() => { void verify(); }} /><Button size="sm" kind="ghost" label="Done" onPress={onClose} /></View>
          <Text size="caption" tone="label">Checks again every 20 seconds while this is open. Nothing serves until the record is in place and the site is live.</Text>
        </View>
      ) : null}
    </Sheet>
  );
}

/** A live job (a site's scheduled task): run it now and read its last runs. Only a live version runs jobs; the box waits five minutes after a run and never overlaps two. */
function Jobs({ dep }: { dep: Dep }) {
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { jobRuns(dep.id).then(setRuns).catch(() => setRuns([])); }, [dep.id]);
  useEffect(load, [load]);
  const go = () => { setBusy(true); jobRun(dep.id).then((r) => { showToast(r.ok ? "It ran." : r.message || "It failed."); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  if (dep.stage !== "Production") return <Card><Text tone="muted">Jobs run on the live version. Put this site live first.</Text></Card>;
  return (
    <View className="gap-s3">
      <View className="self-start"><Button size="sm" kind="secondary" label={busy ? "Running" : "Run it now"} disabled={busy} onPress={go} /></View>
      {runs === null ? <LoadingState rows={2} /> : runs.length ? (
        <Card flush>{runs.map((r, i) => <View key={r.at + ":" + i}>{i ? <Divider /> : null}<Row dense title={jobLine(r)} end={<Chip tone={r.ok ? "ok" : "warn"}>{r.ok ? "Ran" : "Failed"}</Chip>} /></View>)}</Card>
      ) : <Card><EmptyState title="No runs yet" body="A job this site declares runs on its own schedule. Its runs show here." /></Card>}
      <Text size="caption" tone="label">Vyre waits five minutes after a run and never runs two at once.</Text>
    </View>
  );
}

/** Serving: start or stop the edge that answers for every live site (an owner's and admin's act). A box with no way to start containers says what to run by hand. */
function Serving({ onNoDocker }: { onNoDocker: (words: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const act2 = (up: boolean) => {
    setBusy(true);
    (up ? edgeUp() : edgeDown()).then(() => { onNoDocker(null); showToast(up ? "Your sites are online." : "Your sites are offline."); })
      .catch((e) => { const no = dockerBanner((e as { code?: string }).code); if (no) onNoDocker(no); else showToast(say(e)); }).finally(() => setBusy(false));
  };
  return (
    <Sec title="Online">
      <Card className="gap-s2">
        <Text tone="muted">Your live sites are answered by one service. Taking it offline takes every site offline; their files and certificates stay.</Text>
        <View className="flex-row gap-s2"><Button size="sm" kind="secondary" label="Put sites online" disabled={busy} onPress={() => act2(true)} /><Button size="sm" kind="ghost" label="Take sites offline" disabled={busy} onPress={() => act2(false)} /></View>
      </Card>
    </Sec>
  );
}
