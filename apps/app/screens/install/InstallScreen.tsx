import { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Chip, Divider, Field, Row, Ring, Segmented, Text, showToast, type IconName, spaceRef, IconTile } from "@vyre/ui";
import { FaceIdSheet, type FaceAsk } from "../shell/FaceIdSheet";
import { loadInstall } from "./data";
import { AFTER_HOME, RECOVERY_CODE, SERVER_LONG_CODE, WHERE_STEP, backOf, connectedLine, isResumable, nextSetup, packProgress, unpackProgress, homeLine, nameNote, nameStatus, pairToOptions, serverLines, slug, startStep } from "./flow.js";
import { PairEntry, PairWords, openPairing, type LongCode } from "../devices/PairParts";
import { COPY } from "../devices/wink.js";
import { parseWinkCode } from "../../src/api/wink-code";
import { readProgress, writeProgress } from "../../src/state/setup-progress";
import { wordsLine, type PairingSession } from "../../src/api/pairing-session";

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

function NameField({ value, onChange, label, also, space }: { value: string; onChange: (v: string) => void; label: string; also?: string[]; space?: boolean }) {
  const st = nameStatus(value, also);
  return (
    <View className="gap-s2">
      <Field label={label} value={value} onChangeText={onChange} placeholder="name" help=".vyre.run goes after it" />
      <View className="min-h-s6">{st.state === "empty" ? null : <Chip tone={st.state === "ok" ? "ok" : st.state === "taken" ? "warn" : "plain"} icon={st.state === "ok" ? "check" : undefined}>{nameNote(st, !!space)}</Chip>}</View>
    </View>
  );
}

/** The install flow, one thing per screen. `start` is the route: first run, create a space, or join one. */
export function InstallScreen({ start }: { start?: "create" | "join" }) {
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
  const [inviteLine, setInviteLine] = useState("");
  const [loaded, setLoaded] = useState(false);
  const device = Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "phone" : "computer";
  const me = nameStatus(name);
  const spaceSlug = addr ?? slug(spaceName);
  const spaceSt = nameStatus(spaceSlug, [name]);
  const sn = spaceName.trim() || DATA.defaultSpaceName;
  const vps = where === "vps";
  const back = backOf(step, { vps });
  const finish = () => router.replace((first ? "/u/now" : "/u/spaces") as never);
  // The space has its home (the server is paired, or it lives here): setup carries on by itself on this device, with no refresh and no second sign-in.
  const make = (w: "server" | "vps" | "here") => {
    setMade((m) => [...m, { name: sn, look, addr: `${spaceSt.slug}.vyre.run`, line: homeLine(w) }]);
    setStep(AFTER_HOME);
  };
  const advance = (from: string) => setStep(nextSetup(from));

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
  const lastKept = useRef("");
  useEffect(() => {
    if (!loaded) return;
    const raw = isResumable(step) ? packProgress({ step, name, spaceName, addr, look, where, pairTo, device, picks: { connectors: pickConnectors, kit: pickKit } }) : null;
    if (raw === lastKept.current) return;
    lastKept.current = raw ?? "";
    // A step that is not resumable (done, spaces, join) means setup is over or not begun: forget it.
    if (raw !== null || step === "done" || step === "spaces") writeProgress(raw);
  }, [loaded, step, name, spaceName, addr, look, where, pairTo, device, pickConnectors, pickKit]);
  const last = made[made.length - 1];
  const inv = DATA.invite;

  let body: React.ReactNode = null;
  if (step === "name") {
    body = (
      <Page title="Choose your Vyre name" sub="It is how people find you. You can add your own domain later.">
        <NameField label="Your Vyre name" value={name} onChange={setName} />
        <Button kind="primary" icon="faceid" label="Continue with Face ID" disabled={me.state !== "ok"}
          onPress={() => setFace({ title: "Create your identity", body: "Face ID creates it on this device. It stays here.", label: "Create with Face ID", onApprove: () => setStep("recovery") })} />
        <Button kind="ghost" label="I already have a name, scan instead" onPress={() => setStep("scan")} />
      </Page>
    );
  } else if (step === "scan") {
    body = (
      <Page title="Scan from your other device" sub="Open Vyre on a device that has your name and scan this, or paste the long code on it.">
        <View className="w-ring self-center"><Ring seed={4} /></View>
        <Button kind="primary" label="Simulate the scan" onPress={() => { setSession(openPairing(parseSample())); setStep("scanwords"); }} />
      </Page>
    );
  } else if (step === "scanwords") {
    body = session ? (
      <Page title="Check the three words" sub="Your other device shows the same three words.">
        <PairWords session={session} who="Your other device" onConfirmed={() => { setName("alex"); setStep("spaces"); }} onRejected={() => { setSession(null); setWrong(COPY.rejected); setStep("scan"); }} />
      </Page>
    ) : null;
  } else if (step === "recovery") {
    body = (
      <Page title="Save your recovery code" sub="It is the only way back in if you lose every device.">
        <CopyLine text={RECOVERY_CODE} big />
        <Banner>You can add a PIN you memorise later, so the paper alone is useless.</Banner>
        <Button kind="primary" label="I saved it" onPress={() => setStep("spaces")} />
      </Page>
    );
  } else if (step === "spaces") {
    body = (
      <Page title="Your spaces" sub="A space is where a team or a part of your life keeps its work.">
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
        <NameField label="Claim its name" value={spaceSlug} onChange={(v) => setAddr(v)} also={[name]} space />
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
          <Choice icon="cable" title="On a new server" sub="We set one up for you, about $12 a month." onPress={go("vps")} />
          <Divider />
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
      <Page title="Pair your server" sub={two ? "The server shows who is asking and the same three words. Confirm only if they match." : "The server printed a QR code and a long code. Scan the QR, or paste the long code."}>
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        <View className="gap-s2">
          <Text size="caption" strong tone="label">Your server</Text>
          <Terminal lines={serverLines(vps, sn, two ? "words" : "code", { to, who: "Your phone", words: two ? wordsLine(session.words()) : "" })} />
        </View>
        <View className="gap-s2">
          <Text size="caption" strong tone="label">Your phone</Text>
          {two ? (
            <PairWords session={session} who="Your server" onConfirmed={() => { setSession(null); make(where); }} onRejected={() => { setSession(null); setWrong(COPY.rejected); setStep("srv1"); }} />
          ) : (
            <Card className="gap-s3">
              <View className="gap-s1"><Text size="caption" strong tone="label">Pair to:</Text><Segmented label="Pair to" value={pairTo} onChange={setPairTo} options={pairToOptions(name, `${spaceSt.slug}.vyre.run`)} /></View>
              <PairEntry onCode={(c: LongCode) => { setWrong(""); setSession(openPairing(c)); setStep("srv2"); }} sample={SERVER_LONG_CODE} />
            </Card>
          )}
        </View>
      </Page>
    );
  } else if (step === "here") {
    body = (
      <Page title="On this computer">
        <Banner tone="warn">{`${sn} is unreachable while this computer sleeps or is off. Moving it to a server later is one action. Nothing is lost.`}</Banner>
        <Button kind="primary" label="Create it here" onPress={() => make("here")} />
        <Button kind="ghost" label="Choose a server instead" onPress={() => setStep("where")} />
      </Page>
    );
  } else if (step === "look") {
    body = (
      <Page title={`Give ${sn} a look`} sub="This is how its mark shows on every screen. You can change it later.">
        <Terminal lines={[connectedLine(sn, device)]} />
        <View className="items-center gap-s3"><Avatar of={spaceRef(sn)} size={56} /></View>
        <Segmented label="Look" value={look} onChange={setLook} options={DATA.looks.map((l) => [l.id, l.label] as [string, string])} />
        <Button kind="primary" label="Continue" onPress={() => advance("look")} />
      </Page>
    );
  } else if (step === "members") {
    body = (
      <Page title="Who is in it?" sub="Invite people now, or later from Spaces and members. You are the owner.">
        <Row lead={<Avatar of={{ kind: "person", id: "me", name: name || "alex" }} size={40} />} title={name || "alex"} sub="Owner, this device" />
        <Field label="Invite someone" value={inviteLine} onChangeText={setInviteLine} placeholder="Their email" />
        <View className="flex-row gap-s2">
          <Button kind="primary" label={inviteLine.trim() ? "Send the invite and continue" : "Continue"} onPress={() => { if (inviteLine.trim()) showToast(`Invite sent to ${inviteLine.trim()}.`); setInviteLine(""); advance("members"); }} />
          <Button kind="ghost" label="Later" onPress={() => advance("members")} />
        </View>
      </Page>
    );
  } else if (step === "connectors") {
    const on = (id: string) => pickConnectors.includes(id);
    body = (
      <Page title="Connect your tools" sub="Each one asks for its own sign-in, and only what you pick is connected.">
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
          {DATA.kits.map((k) => (
            <Row key={k.id} dense lead={<IconTile name="box" />} title={k.label} sub={k.sub} end={<Chip tone={pickKit === k.id ? "ok" : "plain"} icon={pickKit === k.id ? "check" : undefined}>{pickKit === k.id ? "Chosen" : "Choose"}</Chip>} onPress={() => setPickKit(pickKit === k.id ? null : k.id)} />
          ))}
        </Card>
        <View className="flex-row gap-s2">
          <Button kind="primary" label="Finish setup" onPress={() => advance("kit")} />
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
        <Button kind="primary" label="Continue" onPress={() => setStep("spaces")} />
      </View>
    );
  } else if (step === "join") {
    body = (
      <Page title="Join a space" sub="Scan the invite, or open its link.">
        <View className="w-ring self-center"><Ring seed={6} /></View>
        <Field label="Invite link" value="" placeholder="harlow.vyre.run/join/..." />
        <View className="flex-row gap-s2"><Button kind="primary" label="Open invite" onPress={() => setStep("invite")} /><Button label="Simulate the scan" onPress={() => setStep("invite")} /></View>
      </Page>
    );
  } else if (step === "invite") {
    body = (
      <Card className="gap-s3">
        <Row lead={<Avatar of={spaceRef(inv.space)} size={56} />} title={inv.space} sub={inv.address} />
        <Text tone="muted">{`${inv.from} invited you.`}</Text>
        <Text mono size="caption" tone="label">{inv.link}</Text>
        <View className="gap-s1"><Text size="caption" strong tone="label">You join as</Text><View className="flex-row"><Chip tone="accent">{inv.role}</Chip></View><Text size="caption" tone="muted">{inv.roleLine}</Text></View>
        <View className="gap-s1"><Text size="caption" strong tone="label">You will see</Text><Text size="caption" tone="muted">{inv.sees}</Text></View>
        <Button kind="primary" icon="faceid" label={`Join ${inv.space}`}
          onPress={() => setFace({ title: `Join ${inv.space}`, body: `Face ID adds this device to ${inv.space}.`, label: "Join with Face ID", onApprove: () => { setMade((m) => [...m, { name: inv.space, look: "amber", addr: inv.address, line: `Joined as ${inv.role}` }]); setStep("joined"); } })} />
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
        <Button kind="ghost" size="sm" label="Close" onPress={finish} />
      </View>
      <ScrollView contentContainerClassName="p-s4 w-full max-w-read self-center grow justify-center">{body}</ScrollView>
      <FaceIdSheet ask={face} onClose={() => setFace(null)} />
    </View>
  );
}
