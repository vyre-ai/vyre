import { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Chip, Divider, Field, Row, Ring, Segmented, Text, showToast, type IconName, spaceRef, IconTile } from "@vyre/ui";
import { FaceIdSheet, type FaceAsk } from "../shell/FaceIdSheet";
import { loadInstall } from "./data";
import { AFTER_HOME, CONTINUE_HERE, SERVER_FAILED, serverSay, RECOVERY_CODE, SERVER_LONG_CODE, WHERE_STEP, backOf, connectedLine, isResumable, nextSetup, packProgress, unpackProgress, homeLine, nameNote, nameStatus, pairToOptions, serverLines, slug, startStep } from "./flow.js";
import { PairEntry, PairWatch, PairWords, openPairing, type LongCode } from "../devices/PairParts";
import { serverSession } from "../../src/real/pairing";
import { COPY } from "../devices/wink.js";
import { parseWinkCode } from "../../src/api/wink-code";
import { readProgress, writeProgress } from "../../src/state/setup-progress";
import { wordsLine, type PairingSession } from "../../src/api/pairing-session";
import { MOCK, said } from "../../src/real/box";
import { clearJoin } from "../../src/shell/join-hold.js";
import { acceptInvite, checkName, claimSetup, createIdentity, createSpace, kitChoices, listSpaces, previewInvite, proposeKitFor, readIdentity, resumeSpace, saveSetup } from "../../src/real/install";
import { applyClaim, createInput, inviteFrom, nameNoteReal, pendingLines, nameStatusReal, savesAt, setupElsewhere, setupFrom } from "./real.js";
import { HIDDEN, claimBlocked } from "../shell/rc";
import { setupElsewhere as setupElsewhereLine } from "./flow.js";

type Made = { name: string; look: string; addr: string; line: string };
const DATA = loadInstall();
const parseSample = () => parseWinkCode(SERVER_LONG_CODE) as LongCode;

function Page({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <View className="gap-s4">
      <View className="gap-s1"><Text size="page" strong>{title}</Text>{sub ? <Text tone="muted">{sub}</Text> : null}</View>
      {children}
    </View>
  );
}

function Choice({ icon, title, sub, onPress }: { icon: IconName; title: string; sub: string; onPress: () => void }) {
  return <Row lead={<IconTile name={icon} />} title={title} sub={sub} onPress={onPress} />;
}

function Terminal({ lines, cursor }: { lines: string[]; cursor?: string }) {
  return (
    <Card className="gap-s1 bg-surface-1">
      {lines.map((l, i) => <Text key={i} mono size="caption">{l || " "}</Text>)}
      {cursor !== undefined ? <Text mono size="caption">{cursor}_</Text> : null}
    </Card>
  );
}

function CopyLine({ text, big }: { text: string; big?: boolean }) {
  return (
    <Card className="flex-row items-center gap-s3">
      <Text mono size={big ? "title" : "body"} className="flex-1">{text}</Text>
      <Button size="sm" label="Copy" onPress={() => { Clipboard.setStringAsync(text).catch(() => {}); showToast("Copied"); }} />
    </Card>
  );
}

function NameField({ value, onChange, label, also, space, real, onRetry }: { value: string; onChange: (v: string) => void; label: string; also?: string[]; space?: boolean; real?: ReturnType<typeof nameStatusReal>; onRetry?: () => void }) {
  const st = real ?? nameStatus(value, also);
  const note = real ? nameNoteReal(real, !!space) : nameNote(st as ReturnType<typeof nameStatus>, !!space);
  return (
    <View className="gap-s2">
      <Field label={label} value={value} onChangeText={onChange} placeholder="name" help=".vyre.run goes after it" />
      <View className="min-h-s6">{st.state === "empty" ? null : <View className="flex-row flex-wrap items-center gap-s2"><Chip tone={st.state === "ok" ? "ok" : st.state === "taken" || st.state === "unknown" ? "warn" : "plain"} icon={st.state === "ok" ? "check" : undefined}>{note}</Chip>{st.state === "unknown" && onRetry ? <Button kind="ghost" size="sm" label="Check again" onPress={onRetry} /> : null}</View>}</View>
    </View>
  );
}

/** The install flow, one thing per screen. `start` is the route: first run, create a space, or join one. */
export function InstallScreen({ start, link: linkIn, external }: { start?: "create" | "join"; link?: string; external?: boolean }) {
  const router = useRouter();
  const first = !start;
  const [step, setStep] = useState(startStep(start));
  const [name, setName] = useState("");
  const [spaceName, setSpaceName] = useState(DATA.defaultSpaceName);
  const [addr, setAddr] = useState<string | null>(null);
  const [look, setLook] = useState("amber");
  const [where, setWhere] = useState<"server" | "vps" | "here">("server");
  const [made, setMade] = useState<Made[]>([]);
  const [face, setFace] = useState<FaceAsk | null>(null);
  const [wrong, setWrong] = useState("");
  const [session, setSession] = useState<PairingSession | null>(null);
  const [pairTo, setPairTo] = useState("me");
  const [pickConnectors, setPickConnectors] = useState<string[]>([]);
  const [pickKit, setPickKit] = useState<string | null>(null);
  // Real box: the Kits it offers (null: it offers none) and what asking for the picked one came to, for the done page.
  const [kitList, setKitList] = useState<{ id: string; label: string; sub: string }[] | null | undefined>(undefined);
  const [kitResult, setKitResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [inviteLine, setInviteLine] = useState("");
  const [loaded, setLoaded] = useState(false);
  // Real box only: what the directory said about each name, the space being made, the recovery code (shown once, never kept), another device's setup, the invite.
  const [taken, setTaken] = useState<Record<string, "free" | "taken" | "unknown">>({});
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [owned, setOwned] = useState(0);
  const noId = useRef(false);
  const [recheck, setRecheck] = useState(0);
  const [elsewhere, setElsewhere] = useState<ReturnType<typeof setupElsewhere>>([]);
  const [link, setLink] = useState(linkIn ?? "");
  // A link that opened the app (vyre://join?link=... or /join?link=...): read the card at once, no paste.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (MOCK || !linkIn || opened.current === linkIn) return;
    opened.current = linkIn;
    setLink(linkIn); setBusy(true); setWrong("");
    previewInvite(linkIn.trim()).then((p) => { setInvite(inviteFrom(p, linkIn.trim())); setStep((s) => (noId.current ? s : "invite")); }).catch((e) => setWrong(said(e))).finally(() => setBusy(false));
  }, [linkIn]);
  const [invite, setInvite] = useState<ReturnType<typeof inviteFrom> | null>(null);
  const device = Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "phone" : "computer";
  const me = MOCK ? nameStatus(name) : nameStatusReal(name, taken[slug(name)] ?? null);
  const spaceSlug = addr ?? slug(spaceName);
  const spaceSt = MOCK ? nameStatus(spaceSlug, [name]) : nameStatusReal(spaceSlug, taken[slug(spaceSlug)] ?? null, [name]);
  const sn = spaceName.trim() || DATA.defaultSpaceName;
  const vps = where === "vps";
  // Opened from Spaces on Create or Join, the first step has nothing behind it: Close goes back to Spaces.
  const back = !first && step === startStep(start) ? null : backOf(step, { vps });
  const finish = () => router.replace((first ? "/u/now" : "/u/spaces") as never);
  // The space has its home (the server is paired, or it lives here): setup carries on by itself on this device, with no refresh and no second sign-in.
  const make = (w: "server" | "vps" | "here") => {
    setMade((m) => [...m, { name: sn, look, addr: `${spaceSt.slug}.vyre.run`, line: homeLine(w) }]);
    setStep(AFTER_HOME);
  };
  // The real box makes the space first (spaces.create), then setup carries on. A failure stays on the step with the box's words.
  const makeReal = async (w: "server" | "vps" | "here") => {
    setBusy(true); setWrong("");
    try {
      let r = await createSpace(createInput({ slug: spaceSt.slug, name: sn, where: w }));
      if (r.state === "running" && r.id) r = await resumeSpace(r.id);
      if (r.state !== "done") { setWrong(r.say || "Setting up the space did not finish."); if (r.id) setSpaceId(r.id); return; }
      setSpaceId(r.id);
      make(w);
    } catch (e) { setWrong(said(e)); } finally { setBusy(false); }
  };
  // Real box: the phone asks the server to pair (wink.pair.server), shows the three words it made, and the person says yes AT THE SERVER. Nothing is picked or typed here.
  const startServer = (c: LongCode) => {
    setWrong("");
    if (MOCK) { setSession(openPairing(c)); setStep("srv2"); return; }
    setBusy(true);
    const s = serverSession(c);
    s.ready!().then(() => { setSession(s); setStep("srv2"); }).catch((e: Error) => setWrong(serverSay(e))).finally(() => setBusy(false));
  };
  const doMake = (w: "server" | "vps" | "here") => (MOCK ? make(w) : void makeReal(w));
  // The invite token lives only as long as the join steps: leaving them (cancel, done, any other step) forgets it.
  useEffect(() => { if (step !== "join" && step !== "invite") clearJoin(); }, [step]);
  const advance = (from: string) => {
    if (from === "kit" && !MOCK && spaceId && pickKit) {
      setBusy(true);
      void proposeKitFor(spaceId, pickKit).then((r) => { setKitResult(r); setStep(nextSetup(from)); }).finally(() => setBusy(false));
      return;
    }
    setStep(nextSetup(from));
  };
  useEffect(() => { if (!MOCK && step === "kit" && kitList === undefined) void kitChoices().then(setKitList); }, [step]);

  // Closing and reopening resumes at the same step: read what was kept once, then keep every resumable step.
  useEffect(() => {
    readProgress().then((raw) => {
      const p = unpackProgress(raw);
      if (p && start !== "join") {
        setName(p.name); setSpaceName(p.spaceName); setAddr(p.addr); setLook(p.look); setWhere(p.where as typeof where); setPairTo(p.pairTo);
        setPickConnectors(p.picks?.connectors ?? []); setPickKit(p.picks?.kit ?? null);
        setStep(p.step);
      }
      setLoaded(true);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Real box: who this device already is, and setups other devices left unfinished.
  useEffect(() => {
    if (MOCK) return;
    void (async () => {
      try {
        const who = await readIdentity();
        if (who) { setName(who.label); setStep((s) => (first && s === "name" ? "spaces" : s)); }
        // Identity first: a device with no name cannot create or join a space, so any other way in starts at the name. A kept invite waits for it.
        else { noId.current = true; setStep((s) => (["scan", "scanwords", "recovery"].includes(s) ? s : "name")); }
        // The box names the device a setup is on but the app does not know its own device id: a setup this device began is the one whose name matches the progress it kept.
        const kept = unpackProgress(await readProgress());
        const all = await listSpaces();
        setOwned(all.length);
        const mine = kept ? all.find((r) => r.setup && (r.displayName || r.label) === kept.spaceName)?.id ?? null : null;
        if (mine) setSpaceId(mine);
        setElsewhere(setupElsewhere(all, mine));
      } catch (e) {
        // First run, naming yourself: there is no box yet, and none is needed (the name goes to the directory). Say nothing about it.
        if (!(first && step === "name")) setWrong(said(e));
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Each name the person types is asked of the directory once it is long enough, after they stop typing.
  const asked = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (MOCK) return;
    const want = [step === "name" ? slug(name) : "", step === "create" ? slug(spaceSlug) : ""].filter((n) => n.length >= 3 && !asked.current.has(n));
    if (!want.length) return;
    const t = setTimeout(() => want.forEach((n) => { asked.current.add(n); void checkName(n).then((a) => { if (a === "unknown") asked.current.delete(n); setTaken((m) => ({ ...m, [n]: a })); }); }), 400);
    return () => clearTimeout(t);
  }, [step, name, spaceSlug, recheck]);
  // Every setup step is kept on the box so another device can carry on; the last one clears it.
  useEffect(() => {
    if (MOCK || !spaceId) return;
    if (savesAt(step)) void saveSetup(spaceId, setupFrom({ step, name: sn, addr: spaceSt.slug || null, look, where, connectors: pickConnectors, kit: pickKit })).catch((e) => setWrong(said(e)));
    else if (step === "done") void saveSetup(spaceId, null).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, spaceId, look, pickConnectors, pickKit]);
  const lastKept = useRef("");
  useEffect(() => {
    if (!loaded) return;
    const raw = isResumable(step) ? packProgress({ step, name, spaceName, addr, look, where, pairTo, device, picks: { connectors: pickConnectors, kit: pickKit } }) : null;
    if (raw === lastKept.current) return;
    lastKept.current = raw ?? "";
    // A step that is not resumable (done, spaces, join) means setup is over or not begun: forget it.
    if (raw !== null || step === "done" || step === "spaces") writeProgress(raw);
  }, [loaded, step, name, spaceName, addr, look, where, pairTo, device, pickConnectors, pickKit]);
  const retryName = (n: string) => () => { asked.current.delete(slug(n)); setTaken((m) => { const { [slug(n)]: _gone, ...rest } = m; return rest; }); setRecheck((x) => x + 1); };
  const canClose = !first || made.length > 0 || owned > 0;
  const last = made[made.length - 1];
  const inv = MOCK ? DATA.invite : invite ?? { ...DATA.invite, space: "", address: "", from: "", role: "", roleLine: "", sees: "", link: "" };

  let body: React.ReactNode = null;
  if (step === "name" && !MOCK && claimBlocked()) {
    // RC1: the key is made on the phone, so a browser cannot claim a name (screens/shell/rc.ts).
    body = (
      <Page title={HIDDEN.claimTitle} sub={HIDDEN.claimBody}>
        <Button kind="primary" label={HIDDEN.claimAction} onPress={() => setStep("scan")} />
      </Page>
    );
  } else if (step === "name") {
    body = (
      <Page title="Choose your Vyre name" sub={MOCK ? "It is how people find you. You can add your own domain later." : `It is how people find you. Vyre makes a key for it on this ${device}, and the key stays here.`}>
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        <NameField label="Your Vyre name" value={name} onChange={setName} onRetry={retryName(name)} real={MOCK ? undefined : (me as ReturnType<typeof nameStatusReal>)} />
        <Button kind="primary" label={busy ? "Creating your name" : "Create my name"} disabled={me.state !== "ok" || busy}
          onPress={() => { if (MOCK) return setStep("recovery"); setBusy(true); setWrong(""); void createIdentity(me.slug, device).then((r) => { setRecovery(r.recoveryCode); setStep("recovery"); }).catch((e) => setWrong(said(e))).finally(() => setBusy(false)); }} />
        {me.state === "taken" ? <Text size="caption" tone="muted">{"If this name is yours, scan from another device that has it. The key on this " + device + " cannot be rebuilt from the name."}</Text> : null}
        <Button kind="ghost" label="I already have a name, scan instead" onPress={() => setStep("scan")} />
      </Page>
    );
  } else if (step === "scan") {
    body = (
      <Page title="Scan from your other device" sub="Open Vyre on a device that has your name and scan this, or paste the long code on it.">
        <View className="w-ring self-center"><Ring seed={4} /></View>
        {MOCK ? <Button kind="primary" label="Simulate the scan" onPress={() => { setSession(openPairing(parseSample())); setStep("scanwords"); }} /> : <PairEntry onCode={(c: LongCode) => { setSession(openPairing(c)); setStep("scanwords"); }} />}
      </Page>
    );
  } else if (step === "scanwords") {
    body = session ? (
      <Page title="Check the three words" sub="Your other device shows the same three words.">
        <PairWords session={session} who="Your other device" onConfirmed={() => { noId.current = false; if (MOCK) setName("alex"); else void readIdentity().then((w) => w && setName(w.label)).catch(() => {}); setStep(invite ? "invite" : "spaces"); }} onRejected={() => { setSession(null); setWrong(COPY.rejected); setStep("scan"); }} />
      </Page>
    ) : null;
  } else if (step === "recovery") {
    body = (
      <Page title="Save your recovery code" sub="It is the only way back in if you lose every device.">
        <CopyLine text={MOCK ? RECOVERY_CODE : recovery ?? ""} big />
        {MOCK ? <Banner>You can add a PIN you memorise later, so the paper alone is useless.</Banner> : <Banner>It is shown once. Anyone who holds it can get back into your name, so keep it somewhere only you can reach.</Banner>}
        <Button kind="primary" label="I saved it" onPress={() => { noId.current = false; setRecovery(null); setStep(invite ? "invite" : "spaces"); }} />
      </Page>
    );
  } else if (step === "spaces") {
    body = (
      <Page title="Your spaces" sub="A space is where a team or a part of your life keeps its work.">
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        {elsewhere.map((e) => (
          <Card key={e.space} className="gap-s2">
            <Text strong>{e.spaceName}</Text>
            <Text tone="muted">{setupElsewhereLine(e.device)}</Text>
            <Button kind="primary" label={CONTINUE_HERE} onPress={() => void claimSetup(e.space).then((c) => {
              const a = applyClaim(c);
              if (!a) return;
              setSpaceId(a.space); setSpaceName(a.name || e.spaceName); setAddr(a.addr); setLook(a.look); setWhere(a.where as typeof where); setPickConnectors(a.connectors); setPickKit(a.kit); setElsewhere((l) => l.filter((x) => x.space !== e.space)); setStep(a.step);
            }).catch((err) => setWrong(said(err)))} />
          </Card>
        ))}
        <Card flush>
          <Choice icon="plus" title="Create a space" sub="Name it, pick a look, choose where it lives." onPress={() => setStep("create")} />
          <Divider />
          <Choice icon="share" title="Join a space" sub="Scan an invite or open its link." onPress={() => setStep("join")} />
        </Card>
        {made.length ? (
          <View className="gap-s2">
            <Text size="caption" strong tone="label">Added</Text>
            <Card flush>{made.map((m, i) => <View key={m.addr + i}>{i ? <Divider /> : null}<Row lead={<Avatar of={spaceRef(m.name)} />} title={m.name} sub={m.line} /></View>)}</Card>
            <Button kind="primary" label="Done" onPress={finish} />
          </View>
        ) : null}
      </Page>
    );
  } else if (step === "create") {
    body = (
      <Page title="Create a space">
        <Field label="Name" value={spaceName} onChangeText={(v) => { setSpaceName(v); }} />
        <NameField label="Claim its name" value={spaceSlug} onChange={(v) => setAddr(v)} onRetry={retryName(spaceSlug)} also={[name]} space real={MOCK ? undefined : (spaceSt as ReturnType<typeof nameStatusReal>)} />
        <Button kind="primary" label="Continue" disabled={spaceSt.state !== "ok"} onPress={() => setStep("where")} />
      </Page>
    );
  } else if (step === "where") {
    const go = (w: "server" | "vps" | "here") => () => { setWhere(w); setStep(WHERE_STEP[w]); };
    body = (
      <Page title="Where will it live?" sub="Every space runs on one machine that stays on.">
        <Card flush>
          <Choice icon="server" title="On a server you have" sub="One command, about two minutes." onPress={go("server")} />
          <Divider />
          {MOCK ? <><Choice icon="cable" title="On a new server" sub="We set one up for you, about $12 a month." onPress={go("vps")} /><Divider /></> : null}
          <Choice icon="laptop" title="On this computer" sub="Only while it stays on." onPress={go("here")} />
        </Card>
      </Page>
    );
  } else if (step === "cmd") {
    body = (
      <Page title="Run this on your server" sub="Open its terminal and paste the line.">
        <CopyLine text={DATA.installCommand} />
        <Button kind="primary" label="I ran it" onPress={() => setStep("srv1")} />
      </Page>
    );
  } else if (step === "vps") {
    body = (
      <Page title="A new server">
        <Card><Row lead={<IconTile name="cable" />} title="DigitalOcean" sub="2 GB, 2 CPUs, 60 GB disk, Frankfurt" end={<Text strong>$12 a month</Text>} /></Card>
        <Text size="caption" tone="label">Billed by DigitalOcean to your account. You can move the space to another server later.</Text>
        <Button kind="primary" icon="faceid" label="Create the server"
          onPress={() => setFace({ title: "Create a server", body: "Face ID approves creating it on your DigitalOcean account.", label: "Create with Face ID", onApprove: () => { setStep("vpsbusy"); setTimeout(() => setStep("srv1"), 1400); } })} />
      </Page>
    );
  } else if (step === "vpsbusy") {
    body = <Page title="Creating your server"><Terminal lines={["Creating northwind on DigitalOcean", "Installing Vyre"]} cursor="" /></Page>;
  } else if (step === "srv1" || step === "srv2") {
    const two = step === "srv2" && session;
    const to = pairToOptions(name, `${spaceSt.slug}.vyre.run`).find(([id]) => id === pairTo)?.[1] ?? "";
    body = (
      <Page title="Pair your server" sub={two ? (session.kind === "watch" ? "Say yes on the server only if it shows the same three words as below." : "The server shows who is asking and the same three words. Confirm only if they match.") : "The server printed a QR code and a long code. Scan the QR, or paste the long code."}>
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        {MOCK ? <View className="gap-s2">
          <Text size="caption" strong tone="label">Your server</Text>
          <Terminal lines={serverLines(vps, sn, two ? "words" : "code", { to, who: "Your phone", words: two ? wordsLine(session.words()) : "" })} />
        </View> : <Text tone="muted">{two ? "Your server prints three words. Confirm only if they match the ones below." : "Your server printed a QR code and a long code. Scan it or paste it here."}</Text>}
        <View className="gap-s2">
          <Text size="caption" strong tone="label">Your phone</Text>
          {two && session.kind === "watch" ? (
            <PairWatch session={session} who="Your server" onConfirmed={() => { setSession(null); doMake(where); }} onRejected={(say) => { setSession(null); setWrong(serverSay(say)); setStep("srv1"); }} />
          ) : two ? (
            <PairWords session={session} who="Your server" onConfirmed={() => { setSession(null); doMake(where); }} onRejected={() => { setSession(null); setWrong(SERVER_FAILED.rejected); setStep("srv1"); }} />
          ) : (
            <Card className="gap-s3">
              {MOCK ? <View className="gap-s1"><Text size="caption" strong tone="label">Pair to:</Text><Segmented label="Pair to" value={pairTo} onChange={setPairTo} options={pairToOptions(name, `${spaceSt.slug}.vyre.run`)} /></View> : <Text strong>{`Pair this server to ${name ? `${name}.vyre.run` : "your name"}?`}</Text>}
              <PairEntry onCode={startServer} sample={MOCK ? SERVER_LONG_CODE : undefined} />
            </Card>
          )}
        </View>
      </Page>
    );
  } else if (step === "here") {
    body = (
      <Page title="On this computer">
        <Banner tone="warn">{`${sn} is unreachable while this computer sleeps or is off. Moving it to a server later is one action. Nothing is lost.`}</Banner>
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        <Button kind="primary" label={busy ? "Creating it" : "Create it here"} disabled={busy} onPress={() => doMake("here")} />
        <Button kind="ghost" label="Choose a server instead" onPress={() => setStep("where")} />
      </Page>
    );
  } else if (step === "look") {
    body = (
      <Page title={`Give ${sn} a look`} sub="This is how its mark shows on every screen. You can change it later.">
        {where === "here" ? null : MOCK ? <Terminal lines={[connectedLine(sn, device)]} /> : <Chip tone="ok" icon="check">{`${sn} is paired. Setup carries on here.`}</Chip>}
        <View className="items-center gap-s3"><Avatar of={spaceRef(sn)} size={56} /></View>
        <Segmented label="Look" value={look} onChange={setLook} options={DATA.looks.map((l) => [l.id, l.label] as [string, string])} />
        <Button kind="primary" label="Continue" onPress={() => advance("look")} />
      </Page>
    );
  } else if (step === "members") {
    body = (
      <Page title="Who is in it?" sub="Invite people now, or later from Spaces and members. You are the owner.">
        <Row lead={<Avatar of={{ kind: "person", id: "me", name: name || "alex" }} size={40} />} title={name || "alex"} sub="Owner, this device" />
        {MOCK ? <Field label="Invite someone" value={inviteLine} onChangeText={setInviteLine} placeholder="Their email" /> : <Text tone="muted">Invites are made in Spaces and members, where you choose each person's role.</Text>}
        <View className="flex-row gap-s2">
          {MOCK ? <>
            <Button kind="primary" label={inviteLine.trim() ? "Send the invite and continue" : "Continue"} onPress={() => { if (inviteLine.trim()) showToast(`Invite sent to ${inviteLine.trim()}.`); setInviteLine(""); advance("members"); }} />
            <Button kind="ghost" label="Later" onPress={() => advance("members")} />
          </> : <Button kind="primary" label="Continue" onPress={() => advance("members")} />}
        </View>
      </Page>
    );
  } else if (step === "connectors") {
    const on = (id: string) => pickConnectors.includes(id);
    body = (
      <Page title="Connect your tools" sub={MOCK ? "Each one asks for its own sign-in, and only what you pick is connected." : "Pick the ones you will use. Nothing connects yet: each asks for its own sign-in when you set it up."}>
        <Card flush>
          {DATA.connectors.map((c, i) => (
            <View key={c.id}>{i ? <Divider /> : null}<Row dense title={c.label} sub={c.sub} end={<Chip tone={on(c.id) ? "ok" : "plain"} icon={on(c.id) ? "check" : undefined}>{on(c.id) ? "Chosen" : "Choose"}</Chip>} onPress={() => setPickConnectors((l) => (on(c.id) ? l.filter((x) => x !== c.id) : [...l, c.id]))} /></View>
          ))}
        </Card>
        <View className="flex-row gap-s2">
          <Button kind="primary" label="Continue" onPress={() => advance("connectors")} />
          <Button kind="ghost" label="Later" onPress={() => { setPickConnectors([]); advance("connectors"); }} />
        </View>
      </Page>
    );
  } else if (step === "kit") {
    body = (
      <Page title="Start with a Kit" sub="A Kit adds record types, Flows and views in one step. Pick one, or start empty.">
        <Card flush>
          {(MOCK ? DATA.kits : kitList ?? []).map((k) => (
            <Row key={k.id} dense lead={<IconTile name="box" />} title={k.label} sub={k.sub} end={<Chip tone={pickKit === k.id ? "ok" : "plain"} icon={pickKit === k.id ? "check" : undefined}>{pickKit === k.id ? "Chosen" : "Choose"}</Chip>} onPress={() => setPickKit(pickKit === k.id ? null : k.id)} />
          ))}
          {!MOCK && kitList === undefined ? <Row dense title="Looking for Kits" /> : null}
          {!MOCK && kitList !== undefined && !(kitList ?? []).length ? <Row dense title="No Kits to pick here yet" sub="You can add one later from Kits." /> : null}
        </Card>
        <View className="flex-row gap-s2">
          <Button kind="primary" label={busy ? "Asking" : "Finish setup"} onPress={busy ? () => {} : () => advance("kit")} />
          <Button kind="ghost" label="Start empty" onPress={() => { setPickKit(null); advance("kit"); }} />
        </View>
      </Page>
    );
  } else if (step === "done") {
    body = (
      <View className="items-center gap-s3">
        <Avatar of={spaceRef(last?.name ?? sn)} size={56} />
        <Text size="page" strong className="text-center">{`${last?.name ?? sn} is ready`}</Text>
        <Text tone="muted" className="text-center">{last?.line}</Text>
        <Text mono size="caption" tone="label">{last?.addr}</Text>
        {MOCK ? null : pendingLines({ kit: pickKit ? { id: pickKit, label: kitList?.find((k) => k.id === pickKit)?.label ?? pickKit } : null, kitResult, connectors: pickConnectors.map((id) => DATA.connectors.find((c) => c.id === id)?.label ?? id) }).map((l) => <Text key={l} tone="muted" className="text-center">{l}</Text>)}
        <Button kind="primary" label="Continue" onPress={() => setStep("spaces")} />
      </View>
    );
  } else if (step === "join") {
    body = (
      <Page title="Join a space" sub="Scan the invite, or open its link.">
        <View className="w-ring self-center"><Ring seed={6} /></View>
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        <Field label="Invite link" value={link} onChangeText={setLink} placeholder="harlow.vyre.run/join/..." />
        <View className="flex-row gap-s2">
          <Button kind="primary" label="Open invite" disabled={!MOCK && (busy || !link.trim())} onPress={() => {
            if (MOCK) return setStep("invite");
            setBusy(true); setWrong("");
            previewInvite(link.trim()).then((p) => { setInvite(inviteFrom(p, link.trim())); setStep("invite"); }).catch((e) => setWrong(said(e))).finally(() => setBusy(false));
          }} />
          {MOCK ? <Button label="Simulate the scan" onPress={() => setStep("invite")} /> : null}
        </View>
      </Page>
    );
  } else if (step === "invite") {
    body = (
      <Card className="gap-s3">
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        <Row lead={<Avatar of={spaceRef(inv.space)} size={56} />} title={inv.space} sub={inv.address} />
        {inv.from ? <Text tone="muted">{`${inv.from} invited you.`}</Text> : null}
        {external ? <Banner tone="warn">This invitation came from a link outside Vyre. Check that the space name is the one you expect before you join.</Banner> : null}
        <Text mono size="caption" tone="label">{inv.link.replace(/\/join\/.*$/, "/join/…")}</Text>
        {"words" in inv && inv.words ? <View className="gap-s1"><Text size="caption" strong tone="label">Check these words with whoever invited you</Text><Text mono strong>{inv.words}</Text></View> : null}
        <View className="gap-s1"><Text size="caption" strong tone="label">You join as</Text><View className="flex-row"><Chip tone="accent">{inv.role}</Chip></View><Text size="caption" tone="muted">{inv.roleLine}</Text></View>
        <View className="gap-s1"><Text size="caption" strong tone="label">You will see</Text><Text size="caption" tone="muted">{inv.sees}</Text></View>
        <Button kind="primary" icon="faceid" label={`Join ${inv.space}`}
          onPress={() => setFace({ title: `Join ${inv.space}`, body: `Face ID adds this device to ${inv.space}.`, label: "Join with Face ID", onApprove: () => {
            const joined = () => { setMade((m) => [...m, { name: inv.space, look: "amber", addr: inv.address, line: `Joined as ${inv.role}` }]); setStep("joined"); };
            if (MOCK) return joined();
            void acceptInvite(link.trim()).then((r) => (r?.joined === false && !r?.pending ? setWrong("This device could not join yet.") : joined())).catch((e) => setWrong(said(e)));
          } })} />
      </Card>
    );
  } else if (step === "joined") {
    body = (
      <View className="items-center gap-s3">
        <Chip tone="ok" icon="check">Joined</Chip>
        <Text size="page" strong className="text-center">{`You joined ${inv.space}`}</Text>
        <Text tone="muted" className="text-center">{`This device is added to ${inv.space}. Your other spaces are untouched.`}</Text>
        <Button kind="primary" label="Continue" onPress={() => setStep("spaces")} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-bg">
      <View className="flex-row items-center gap-s2 px-s4 py-s3">
        {back ? <Button kind="ghost" size="sm" icon="chevron-left" label="Back" onPress={() => { setWrong(""); setSession(null); setStep(back); }} /> : null}
        <View className="flex-1" />
        {canClose ? <Button kind="ghost" size="sm" label="Close" onPress={finish} /> : null}
      </View>
      <ScrollView contentContainerClassName="p-s4 w-full max-w-read self-center grow justify-center">{body}</ScrollView>
      <FaceIdSheet ask={face} onClose={() => setFace(null)} />
    </View>
  );
}
