import { useEffect, useRef, useState } from "react";
import { Banner, Button, Card, ChoiceList, Chip, CodeBlock, CodeDisplay, CodeField, Divider, Field, FlowStep, Icon, MatchWords, Meter, Row, Segmented, Stack, Text, showToast } from "@vyre/ui";
import { DEMO, WORDS, addressOf, afterSpace, inviteStatus, spaceCodeStatus, wordsMatch } from "./flow-model.js";
import { usePair } from "./VaultInferenceScreens";
import type { ScreenProps } from "./types";

const HINT = "Prototype hint";
const SPACE = "Harlow Legal";

export function SpaceChoice({ go, back, steps }: ScreenProps) {
  const [pick, setPick] = useState<"create" | "join" | "">("");
  return (
    <FlowStep steps={steps} onBack={back} title="Create a space or join one" lead="A space is where your team, your agents and your work live. One server holds one space."
      primary={{ label: "Continue", disabled: !pick, onPress: () => go(pick === "create" ? "create.name" : "join.code") }}>
      <ChoiceList label="Create or join" value={pick || undefined} onChange={setPick} options={[
        { value: "create", title: "Create a space", sub: "You need a server: a Linux machine in the cloud, or a Mac that stays on.", icon: "space" },
        { value: "join", title: "Join a space", sub: "Someone invited you. Paste their link or type their code.", icon: "users" },
      ]} />
    </FlowStep>
  );
}

export function CreateName({ ctx, set, go, back, steps }: ScreenProps) {
  const addr = addressOf(ctx.spaceName);
  return (
    <FlowStep steps={steps} onBack={back} title="Name your space" lead="Your team sees this name. You can use your own domain later."
      primary={{ label: "Continue", disabled: !addr, onPress: () => go("create.server") }}>
      <Field label="Space name" value={ctx.spaceName} onChangeText={(v) => set({ spaceName: v })} placeholder="Harlow Legal" help={addr ? `Address: ${addr}.vyre.run` : "The address is made from the name."} />
    </FlowStep>
  );
}

export function CreateServer({ ctx, set, go, back, steps }: ScreenProps) {
  const [help, setHelp] = useState(false);
  return (
    <FlowStep steps={steps} onBack={back} title="Get a server" lead="The space runs on a server you own. Recommended size: 8 GB of memory."
      primary={{ label: "I have a server", onPress: () => go("create.run") }}
      secondary={{ label: help ? "Hide the steps" : "I do not have one", onPress: () => setHelp(!help) }}>
      <ChoiceList label="Server" value={ctx.server} onChange={(v) => set({ server: v })} options={[
        { value: "cloud", title: "A Linux server", sub: "DigitalOcean or any cloud. Ubuntu 22.04 or newer.", icon: "server" },
        { value: "mac", title: "A Mac that stays on", sub: "You start it from Terminal on that Mac, then join it here like anyone else.", icon: "laptop" },
      ]} />
      {help ? (
        <Card title="How to get a server">
          <Stack gap={2}>
            <Text>1. Open an account with a cloud provider, such as DigitalOcean.</Text>
            <Text>2. Create a droplet or instance: Ubuntu, 8 GB of memory, the region closest to your team.</Text>
            <Text>3. Copy its address and log in with the provider's console or SSH.</Text>
            <Text tone="muted">Then come back here and choose I have a server.</Text>
          </Stack>
        </Card>
      ) : null}
    </FlowStep>
  );
}

export function CreateRun({ ctx, go, back, steps }: ScreenProps) {
  return (
    <FlowStep steps={steps} onBack={back} title={ctx.server === "mac" ? "Run this in Terminal on that Mac" : "Run this on your server"} lead="One command installs Vyre. It ends by printing your space code."
      primary={{ label: "I have the code", onPress: () => go("create.code") }}>
      <CodeBlock lang="sh" code="curl -fsSL https://vyre.run/install | sh" />
      <Banner tone="plain" icon="info">{`It ends with: Your space code: ${DEMO.spaceCode.replace("7QMK-4P2X", "XXXX-XXXX")}`}</Banner>
      <Stack gap={2}>
        <Text strong>Lost the code?</Text>
        <CodeBlock lang="sh" code="vyre space up" />
        <Text size="caption" tone="muted">That prints a fresh code at any time. vyre space shows the space's details.</Text>
      </Stack>
    </FlowStep>
  );
}

export function CreateCode({ go, back, steps }: ScreenProps) {
  const [code, setCode] = useState("");
  const [tried, setTried] = useState(false);
  const st = spaceCodeStatus(code);
  const failure = tried && st === "wrong" ? "That code is not from a space that is waiting. Run vyre space up on your server for a fresh one, then type it here." : tried && st === "expired" ? "That code has expired. Run vyre space up on your server for a fresh one." : undefined;
  return (
    <FlowStep steps={steps} onBack={back} title="Type the space code" lead="It starts with WINK and was printed on your server."
      failure={failure}
      primary={{ label: "Connect to my server", disabled: code.length < 14, onPress: () => { setTried(true); if (st === "ok") go("create.confirm"); } }}>
      <CodeField label="Space code" prefix="WINK" value={code} onChangeText={(v) => { setCode(v); setTried(false); }} />
      <Banner tone="plain" icon="info">{`${HINT}: ${DEMO.spaceCode} works. WINK-0000-0000 is expired. Anything else is refused.`}</Banner>
    </FlowStep>
  );
}

export function CreateConfirm({ go, back, steps }: ScreenProps) {
  const [bad, setBad] = useState(false);
  return (
    <FlowStep steps={steps} onBack={back} title="Do the four words match?" lead="Your server shows four words too. They must be the same, in the same order."
      failure={bad ? "The words do not match, so this is not your server. Do not go on. Run vyre space up on your server for a fresh code, then enter it again." : undefined}
      primary={bad ? { label: "Enter a new code", onPress: () => go("create.code") } : { label: "They match", onPress: () => go("create.vault") }}
      secondary={bad ? undefined : { label: "They do not match", onPress: () => setBad(true) }}>
      <MatchWords label="Words on this screen" words={WORDS} note="Check them against the words on your server." />
    </FlowStep>
  );
}

export function CreateVault({ ctx, set, go, back, steps }: ScreenProps) {
  const pair = usePair();
  return (
    <FlowStep steps={steps} onBack={back} title="Set the space's master password" lead="This locks the space's shared passwords and accounts. You are the owner, and you can hand ownership to another member later."
      failure={pair.failure}
      primary={{ label: "Create the space", disabled: !pair.ready, onPress: () => { if (pair.check()) { set({ created: true }); go("create.setup"); } } }}>
      {pair.fields}
    </FlowStep>
  );
}

/** A list of things being done, one after another, with the time they take pretended. */
function useProgress(total: number, ms: number) {
  const [done, setDone] = useState(0);
  const t = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    t.current = setInterval(() => setDone((d) => (d >= total ? d : d + 1)), ms);
    return () => { if (t.current) clearInterval(t.current); };
  }, []);
  return done;
}

function Checks({ items, done }: { items: string[]; done: number }) {
  return (
    <Card flush>
      {items.map((label, i) => (
        <Stack key={label} gap={0}>
          <Row dense lead={<Icon name={i < done ? "ok" : "clock"} tone={i < done ? "ok" : "label"} />} title={label} end={<Chip tone={i < done ? "ok" : "plain"}>{i < done ? "Done" : i === done ? "Working" : "Waiting"}</Chip>} />
          {i < items.length - 1 ? <Divider inset={60} /> : null}
        </Stack>
      ))}
    </Card>
  );
}

export function CreateSetup({ ctx, go, back, steps }: ScreenProps) {
  const items = ["Reaching your server", "Creating the space vault", "Setting up Records"];
  const done = useProgress(items.length, 1100);
  return (
    <FlowStep mark={done >= items.length ? "done" : "working"} steps={steps} onBack={back} title={`Setting up ${ctx.spaceName || SPACE}`} lead="You can carry on while Records finishes in the background."
      primary={{ label: done >= items.length ? "Continue" : "Continue while it finishes", onPress: () => go(afterSpace(ctx)) }}>
      <Meter value={done / items.length} label="Space setup progress" />
      <Checks items={items} done={done} />
    </FlowStep>
  );
}

export function JoinCode({ set, go, back, steps }: ScreenProps) {
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const st = inviteStatus(text);
  const failure = tried && st === "short" ? "That does not look like an invite. Paste the whole link, or type the code your inviter read to you." : tried && st === "expired" ? "That invite has expired or was already used. Ask the person who invited you for a new one." : undefined;
  return (
    <FlowStep steps={steps} onBack={back} title="Join a space" lead="Paste the invite link, or type the invite code someone read to you."
      failure={failure}
      primary={{ label: "Continue", disabled: !text.trim(), onPress: () => { setTried(true); if (st === "ok") { set({ spaceName: SPACE }); go("join.review"); } } }}>
      <Field label="Invite link or code" value={text} onChangeText={(v) => { setText(v); setTried(false); }} placeholder="https://web.vyre.run/join/..." />
      <Banner tone="plain" icon="info">{`${HINT}: paste any link. Write the word expired in it to see an expired invite.`}</Banner>
    </FlowStep>
  );
}

export function JoinReview({ ctx, set, go, back, steps }: ScreenProps) {
  const admin = ctx.role === "admin";
  return (
    <FlowStep steps={steps} onBack={back} title={`Join ${SPACE}?`} lead="Check who invited you and the role you will have."
      primary={{ label: `Join ${SPACE}`, onPress: () => go("join.sealing") }} secondary={{ label: "Not now", onPress: () => back?.() }}>
      <Card flush>
        <Row dense lead={<Icon name="space" tone="text-2" />} title="Space" end={<Text>{SPACE}</Text>} />
        <Divider inset={60} />
        <Row dense lead={<Icon name="person" tone="text-2" />} title="Invited by" end={<Text>Dana Lee</Text>} />
        <Divider inset={60} />
        <Row dense lead={<Icon name="key" tone="text-2" />} title="Your role" end={<Chip tone="accent">{admin ? "Admin" : "Member"}</Chip>} />
      </Card>
      <MatchWords label="The space's four words" words={WORDS} note={admin ? "Your inviter types these on their side to confirm it is you." : "These match the words your inviter sees."} />
      <Stack gap={2}>
        <Text size="caption" tone="label">Prototype: invited as</Text>
        <Segmented label="Invited as" options={[["member", "Member"], ["admin", "Admin"]]} value={ctx.role} onChange={(r) => set({ role: r })} />
      </Stack>
    </FlowStep>
  );
}

export function JoinSealing({ ctx, go, back, steps }: ScreenProps) {
  const items = ["Sealing your vault with your master password", `Placing it in ${SPACE}`, "Allowing your sessions there to use your AI accounts"];
  const done = useProgress(items.length, 1000);
  return (
    <FlowStep mark={done >= items.length ? "done" : "working"} steps={steps} onBack={back} title="Placing your vault" lead={`Your vault goes into ${SPACE}, sealed with your master password. The space cannot read it.`}
      primary={{ label: "Continue", disabled: done < items.length, onPress: () => go(afterSpace(ctx)) }}>
      <Checks items={items} done={done} />
    </FlowStep>
  );
}

export function Compute({ ctx, set, go, back, steps }: ScreenProps) {
  return (
    <FlowStep steps={steps} onBack={back} title="Run sessions on this computer?" lead={`This applies to ${ctx.spaceName || SPACE}. You can change it later in Settings.`}
      primary={{ label: "Continue", onPress: () => go("ready") }}>
      <ChoiceList label="Where sessions run" value={ctx.runHere ? "here" : "server"} onChange={(v) => set({ runHere: v === "here" })} options={[
        { value: "here", title: "Yes, run them here", sub: "Sessions run on this computer while it is on, and move to the server when it sleeps.", icon: "laptop" },
        { value: "server", title: "No, use the server", sub: "Sessions run on the space's server.", icon: "server" },
      ]} />
    </FlowStep>
  );
}

export function Ready({ ctx, go, back, steps }: ScreenProps) {
  const connected = Object.values(ctx.ai).filter((s) => s === "connected").length;
  const space = ctx.spaceName || SPACE;
  return (
    <FlowStep hero mark="done" steps={steps} onBack={back} title={`You are in ${space}`} lead="A few things are worth doing next."
      primary={{ label: `Open ${space}`, onPress: () => showToast("The app opens on the space here. The prototype ends.") }} secondary={{ label: "Start the prototype again", onPress: () => go("start") }}>
      <Card flush>
        <Row dense lead={<Icon name="spark" tone="text-2" />} title="AI accounts" end={<Chip tone={connected ? "ok" : "warn"}>{connected ? `${connected} connected` : "Not connected"}</Chip>} sub={connected ? undefined : "Connect one in Settings to start a session."} />
        <Divider inset={60} />
        <Row dense lead={<Icon name="records" tone="text-2" />} title="Records" end={<Chip tone={ctx.created ? "ok" : "plain"}>{ctx.created ? "Ready" : "Already set up"}</Chip>} />
        <Divider inset={60} />
        <Row dense lead={<Icon name="laptop" tone="text-2" />} title="Sessions run" end={<Chip>{ctx.runHere ? "On this computer" : "On the server"}</Chip>} />
        <Divider inset={60} />
        <Row dense lead={<Icon name="users" tone="text-2" />} title="Your team" sub="Invite people with a link." end={<Button kind="secondary" size="sm" label="Invite people" onPress={() => go("invite.who")} />} />
      </Card>
    </FlowStep>
  );
}

export function InviteWho({ ctx, set, go, back }: ScreenProps) {
  const [tried, setTried] = useState(false);
  return (
    <FlowStep onBack={back} title="Invite people" lead="Vyre makes a link and a short code. You send them privately."
      primary={{ label: "Make the invite", onPress: () => { setTried(true); if (ctx.inviteName.trim()) go("invite.link"); } }}>
      <Field label="Name" value={ctx.inviteName} onChangeText={(v) => { set({ inviteName: v }); setTried(false); }} placeholder="Name" error={tried && !ctx.inviteName.trim() ? "Add a name so you can tell invites apart." : undefined} />
      <Field label="Email (optional)" kind="email" value="" onChangeText={() => {}} placeholder="name@firm.com" />
      <Segmented label="Role" options={[["member", "Member"], ["admin", "Admin"]]} value={ctx.inviteRole} onChange={(r) => set({ inviteRole: r })} />
      <Text size="caption" tone="label">{ctx.inviteRole === "admin" ? "An admin joins only after you confirm four words with them." : "A member sees the matters they are seated on and what the space's rules allow."}</Text>
    </FlowStep>
  );
}

export function InviteLink({ ctx, go, back }: ScreenProps) {
  return (
    <FlowStep onBack={back} title={`Send ${ctx.inviteName.trim() || "them"} the invite`} lead="Send the link privately. It works once and expires in 7 days."
      primary={{ label: ctx.inviteRole === "admin" ? "They have the link" : "I sent it", onPress: () => go(ctx.inviteRole === "admin" ? "invite.words" : "invite.done") }}>
      <CodeBlock code="https://web.vyre.run/join/7QMK4P2X9TBN" lang="" />
      <CodeDisplay label="Or read them this code" code="INV-7QMK-4P2X" note="Good for 7 days, one use." />
    </FlowStep>
  );
}

export function InviteWords({ ctx, go, back }: ScreenProps) {
  const [typed, setTyped] = useState("");
  const [tried, setTried] = useState(false);
  const name = ctx.inviteName.trim() || "They";
  return (
    <FlowStep onBack={back} title="Confirm four words" lead={`When ${name} joins, they read you four words. Type them here.`}
      failure={tried && !wordsMatch(typed) ? `Those words do not match your space's words. Ask ${name} to read the four words on their screen again.` : undefined}
      primary={{ label: "Check the words", disabled: !typed.trim(), onPress: () => { setTried(true); if (wordsMatch(typed)) go("invite.done"); } }}>
      <Field label="Their four words" value={typed} onChangeText={(v) => { setTyped(v); setTried(false); }} placeholder="word word word word" />
      <Banner tone="plain" icon="info">{`${HINT}: the words are ${WORDS.join(" ")}.`}</Banner>
    </FlowStep>
  );
}

export function InviteDone({ ctx, go, back }: ScreenProps) {
  const name = ctx.inviteName.trim() || "They";
  return (
    <FlowStep onBack={back} title={ctx.inviteRole === "admin" ? `${name} is an admin` : `${name} is invited`} lead="They appear in Members. Their access follows the space's rules."
      primary={{ label: "Back to the space", onPress: () => go("ready") }} secondary={{ label: "Invite someone else", onPress: () => go("invite.who") }}>
      <Card flush>
        <Row dense lead={<Icon name="person" tone="text-2" />} title={name} sub={ctx.inviteRole === "admin" ? "Confirmed with four words." : "Waiting for them to open the link."} end={<Chip tone={ctx.inviteRole === "admin" ? "ok" : "plain"}>{ctx.inviteRole === "admin" ? "Admin" : "Member"}</Chip>} />
      </Card>
    </FlowStep>
  );
}
