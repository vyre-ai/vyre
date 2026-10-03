import { useState } from "react";
import { ScrollView, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Chip, Divider, Field, Row, Ring, Segmented, Text, showToast, type IconName } from "@vyre/ui";
import { FaceIdSheet, type FaceAsk } from "../shell/FaceIdSheet";
import { loadInstall } from "./data";
import { NUMBER_CHOICES, RECOVERY_CODE, SERVER_CODE, WHERE_STEP, backOf, homeLine, nameNote, nameStatus, pickNumber, serverLines, slug, startStep } from "./flow.js";

type Made = { name: string; look: string; addr: string; line: string };
const DATA = loadInstall();

function Page({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <View className="gap-s4">
      <View className="gap-s1"><Text size="page" strong>{title}</Text>{sub ? <Text tone="muted">{sub}</Text> : null}</View>
      {children}
    </View>
  );
}

function Choice({ icon, title, sub, onPress }: { icon: IconName; title: string; sub: string; onPress: () => void }) {
  return <Row lead={<Avatar name={title} family="device" icon={icon} />} title={title} sub={sub} onPress={onPress} />;
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
  const [wrong, setWrong] = useState(false);
  const me = nameStatus(name);
  const spaceSlug = addr ?? slug(spaceName);
  const spaceSt = nameStatus(spaceSlug, [name]);
  const sn = spaceName.trim() || DATA.defaultSpaceName;
  const vps = where === "vps";
  const back = backOf(step, { vps });
  const finish = () => router.replace((first ? "/u/now" : "/u/spaces") as never);
  const make = (w: "server" | "vps" | "here") => {
    setMade((m) => [...m, { name: sn, look, addr: `${spaceSt.slug}.vyre.run`, line: homeLine(w) }]);
    setStep("done");
  };
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
      <Page title="Scan from your other device" sub="Open Vyre on a device that has your name and scan this.">
        <View className="w-ring self-center"><Ring seed={4} /></View>
        <Button kind="primary" label="Simulate the scan" onPress={() => { setName("alex"); setStep("spaces"); }} />
      </Page>
    );
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
            <Card flush>{made.map((m, i) => <View key={m.addr + i}>{i ? <Divider /> : null}<Row lead={<Avatar name={m.name} family="space" tint />} title={m.name} sub={m.line} /></View>)}</Card>
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
        <View className="gap-s2">
          <Text size="caption" strong tone="label">Look</Text>
          <View className="flex-row items-center gap-s3">
            <Segmented label="Look" value={look} onChange={setLook} options={DATA.looks.map((l) => [l.id, l.label] as [string, string])} />
          </View>
          <Avatar name={sn} family="space" size="lg" tint />
        </View>
        <Button kind="primary" label="Continue" disabled={spaceSt.state !== "ok"} onPress={() => setStep("where")} />
      </Page>
    );
  } else if (step === "where") {
    const go = (w: "server" | "vps" | "here") => () => { setWhere(w); setStep(WHERE_STEP[w]); };
    body = (
      <Page title="Where will it live?" sub="Every space runs on one machine that stays on.">
        <Card flush>
          <Choice icon="box" title="On a server you have" sub="One command, about two minutes." onPress={go("server")} />
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
        <Card><Row lead={<Avatar name="DigitalOcean" family="device" icon="cable" />} title="DigitalOcean" sub="2 GB, 2 CPUs, 60 GB disk, Frankfurt" end={<Text strong>$12 a month</Text>} /></Card>
        <Text size="caption" tone="label">Billed by DigitalOcean to your account. You can move the space to another server later.</Text>
        <Button kind="primary" icon="faceid" label="Create the server"
          onPress={() => setFace({ title: "Create a server", body: "Face ID approves creating it on your DigitalOcean account.", label: "Create with Face ID", onApprove: () => { setStep("vpsbusy"); setTimeout(() => setStep("srv1"), 1400); } })} />
      </Page>
    );
  } else if (step === "vpsbusy") {
    body = <Page title="Creating your server"><Terminal lines={["Creating northwind on DigitalOcean", "Installing Vyre"]} cursor="" /></Page>;
  } else if (step === "srv1" || step === "srv2") {
    const two = step === "srv2";
    body = (
      <Page title="Pair your server" sub={two ? "The server shows a number. Pick the same one on your phone." : "The server asks for a code. Type the one below on it."}>
        {wrong ? <Banner tone="warn">That is not the number on the server. A new code is showing. Try again.</Banner> : null}
        <View className="gap-s2">
          <Text size="caption" strong tone="label">Your server</Text>
          <Terminal lines={serverLines(vps, sn, two)} cursor={two ? undefined : "Enter the code from your phone or computer: "} />
        </View>
        <View className="gap-s2">
          <Text size="caption" strong tone="label">Your phone</Text>
          {two ? (
            <Card className="gap-s3">
              <Text strong>Is this your server?</Text>
              <Text tone="muted">Pick the number it shows.</Text>
              <View className="flex-row gap-s2">
                {NUMBER_CHOICES.map((n) => <Button key={n} className="flex-1" label={n} onPress={() => { const r = pickNumber(n); setWrong(!r.ok); if (r.ok) make(where); else setStep(r.step); }} />)}
              </View>
            </Card>
          ) : (
            <Card className="gap-s3">
              <Text strong>Type this on your server</Text>
              <Text mono size="title">{SERVER_CODE}</Text>
              <Text size="caption" tone="label">Good for 5 minutes</Text>
              <Button size="sm" label="I typed it" onPress={() => { setWrong(false); setStep("srv2"); }} />
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
  } else if (step === "done") {
    body = (
      <View className="items-center gap-s3">
        <Avatar name={last?.name ?? sn} family="space" size="lg" tint />
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
        <Row lead={<Avatar name={inv.space} family="space" size="lg" tint />} title={inv.space} sub={inv.address} />
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
        {back ? <Button kind="ghost" size="sm" label="Back" onPress={() => { setWrong(false); setStep(back); }} /> : null}
        <View className="flex-1" />
        <Button kind="ghost" size="sm" label="Close" onPress={finish} />
      </View>
      <ScrollView contentContainerClassName="p-s4 w-full max-w-read self-center grow justify-center">{body}</ScrollView>
      <FaceIdSheet ask={face} onClose={() => setFace(null)} />
    </View>
  );
}
