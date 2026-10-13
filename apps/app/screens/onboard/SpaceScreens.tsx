import { useEffect, useRef, useState } from "react";
import { InviteRolePicker } from "../roles/InviteRolePicker";
import { InviteMade } from "../devices/InviteMade";
import { Banner, Button, Card, ChoiceList, Chip, CodeBlock, CodeDisplay, CodeField, Divider, Field, FlowStep, Icon, MatchWords, Meter, Row, Segmented, Stack, Text, showToast } from "@vyre/ui";
import { DEMO, WORDS, addressOf, afterSpace, inviteStatus, spaceCodeStatus, wordsMatch } from "./flow-model.js";
import { takeJoin } from "../../src/shell/join-hold.js";
import { Linking } from "react-native";
import * as Clipboard from "expo-clipboard";
import { LIVE, beginServerRun, confirmServerWords, inviteEmail, denyServerWords, joinCard, joinSpace, keepMadeInvite, lendThisComputer, linkFromInput, makeInvite, confirmInviteWords, pairByCode, readInvite, setUpSpace, stopServerRun, useActiveSpace, useJoinCard, useMadeInvite, useServerRun, whyNot } from "./real-space";
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
      primary={{ label: "Continue", disabled: !addr, onPress: () => { set({ allowed: false }); go("create.members"); } }}>
      <Field label="Space name" value={ctx.spaceName} onChangeText={(v) => set({ spaceName: v })} placeholder="Harlow Legal" help={addr ? `Address: ${addr}.vyre.run` : "The address is made from the name."} />
    </FlowStep>
  );
}

export function CreateMembers({ ctx, set, go, back, steps }: ScreenProps) {
  return (
    <FlowStep steps={steps} onBack={back} title="Can members use their own computers?" lead="Your AI work can run on this space's server, or on a member's computer while it is on. You decide which people may choose that."
      primary={{ label: "Continue", onPress: () => go("create.server") }}>
      <ChoiceList label="Members' own computers" value={ctx.allowed ? "allow" : "deny"} onChange={(v) => set({ allowed: v === "allow" })} options={[
        { value: "allow", title: "Allow", sub: "Each member can choose to use their own computer when it is available. Their work moves to the server when it sleeps.", icon: "laptop" },
        { value: "deny", title: "Do not allow", sub: "All AI work runs on the space's server. Members' computers only show it.", icon: "server" },
      ]} />
      <Text size="caption" tone="label">You can change this later in the space's settings.</Text>
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

function CreateRunMock({ ctx, go, back, steps }: ScreenProps) {
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

function CreateCodeMock({ go, back, steps }: ScreenProps) {
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

function CreateConfirmMock({ set, go, back, steps }: ScreenProps) {
  const [bad, setBad] = useState(false);
  return (
    <FlowStep steps={steps} onBack={back} title="Do the four words match?" lead="Your server shows four words too. They must be the same, in the same order."
      failure={bad ? "The words do not match, so this is not your server. Do not go on. Run vyre space up on your server for a fresh code, then enter it again." : undefined}
      primary={bad ? { label: "Enter a new code", onPress: () => go("create.code") } : { label: "They match", onPress: () => { set({ created: true }); go("create.setup"); } }}
      secondary={bad ? undefined : { label: "They do not match", onPress: () => setBad(true) }}>
      <MatchWords label="Words on this screen" words={WORDS} note="Check them against the words on your server." />
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

function CreateSetupMock({ ctx, go, back, steps }: ScreenProps) {
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

function JoinCodeMock({ set, go, back, steps }: ScreenProps) {
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

function JoinReviewMock({ ctx, set, go, back, steps }: ScreenProps) {
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

function JoinSealingMock({ ctx, go, back, steps }: ScreenProps) {
  const items = ["Sealing your vault with your master password", `Placing it in ${SPACE}`, "Allowing your sessions there to use your AI accounts"];
  const done = useProgress(items.length, 1000);
  return (
    <FlowStep mark={done >= items.length ? "done" : "working"} steps={steps} onBack={back} title="Placing your vault" lead={`Your vault goes into ${SPACE}, sealed with your master password. The space cannot read it.`}
      primary={{ label: "Continue", disabled: done < items.length, onPress: () => go(afterSpace(ctx)) }}>
      <Checks items={items} done={done} />
    </FlowStep>
  );
}

function ComputeMock({ ctx, set, go, back, steps }: ScreenProps) {
  const space = ctx.spaceName || SPACE;
  return (
    <FlowStep steps={steps} onBack={back} title={`Use this computer for your work in ${space}?`} lead="Your AI sessions are the chats and tasks your AI accounts do for you. You can change this later in Settings."
      primary={{ label: "Continue", onPress: () => go("ready") }}>
      <ChoiceList label="This computer" value={ctx.runHere ? "allow" : "deny"} onChange={(v) => set({ runHere: v === "allow" })} options={[
        { value: "allow", title: "Allow: use this computer when it is available", sub: `Your AI sessions run here while this computer is on, and on ${space}'s server when it is not.`, icon: "laptop" },
        { value: "deny", title: "Do not allow: always use the space's server", sub: `Everything runs on ${space}'s server. This computer only shows it.`, icon: "server" },
      ]} />
    </FlowStep>
  );
}

export function Ready({ ctx, go, back, steps }: ScreenProps) {
  const connected = Object.values(ctx.ai).filter((s) => s === "connected").length;
  const space = ctx.spaceName || SPACE;
  return (
    <FlowStep hero mark="done" steps={steps} onBack={back} title={`You are in ${space}`} lead="A few things are worth doing next."
      primary={{ label: `Open ${space}`, onPress: () => (LIVE ? go("start") : showToast("The app opens on the space here. The prototype ends.")) }} secondary={LIVE ? undefined : { label: "Start the prototype again", onPress: () => go("start") }}>
      <Card flush>
        <Row dense lead={<Icon name="spark" tone="text-2" />} title="AI accounts" end={<Chip tone={connected ? "ok" : "warn"}>{connected ? `${connected} connected` : "Not connected"}</Chip>} sub={connected ? undefined : "Connect one in Settings to start a session."} />
        <Divider inset={60} />
        <Row dense lead={<Icon name="records" tone="text-2" />} title="Records" end={<Chip tone={ctx.created ? "ok" : "plain"}>{ctx.created ? "Ready" : "Already set up"}</Chip>} />
        <Divider inset={60} />
        <Row dense lead={<Icon name="laptop" tone="text-2" />} title="Where your AI work runs" end={<Chip>{ctx.runHere ? "Here when available" : "On the server"}</Chip>} />
        <Divider inset={60} />
        <Row dense lead={<Icon name="users" tone="text-2" />} title="Your team" sub="Invite people with a link." end={<Button kind="secondary" size="sm" label="Invite people" onPress={() => go("invite.who")} />} />
      </Card>
    </FlowStep>
  );
}

function InviteWhoMock({ ctx, set, go, back }: ScreenProps) {
  const [tried, setTried] = useState(false);
  return (
    <FlowStep onBack={back} title="Invite people" lead="Vyre makes a link and a short code. You send them privately."
      primary={{ label: "Make the invite", onPress: () => { setTried(true); if (ctx.inviteName.trim()) go("invite.link"); } }}>
      <Field label="Name" value={ctx.inviteName} onChangeText={(v) => { set({ inviteName: v }); setTried(false); }} placeholder="Name" error={tried && !ctx.inviteName.trim() ? "Add a name so you can tell invites apart." : undefined} />
      <Field label="Email (optional)" kind="email" value="" onChangeText={() => {}} placeholder="name@firm.com" />
      <InviteRolePicker actor="owner" role={ctx.inviteRole} onRole={(r) => set({ inviteRole: r })} projects={ctx.inviteProjects} onProjects={(ids) => set({ inviteProjects: ids })} levels={ctx.inviteLevels} onLevels={(v) => set({ inviteLevels: v })} days={ctx.inviteDays} onDays={(d) => set({ inviteDays: d })} />
      <Text size="caption" tone="label">{ctx.inviteRole === "admin" ? "An admin joins only after you confirm four words with them." : "A member sees the projects they are on and what the space's rules allow."}</Text>
    </FlowStep>
  );
}

function InviteLinkMock({ ctx, go, back }: ScreenProps) {
  return (
    <FlowStep onBack={back} title={`Send ${ctx.inviteName.trim() || "them"} the invite`} lead="Send the link privately. It works once and expires in 7 days."
      primary={{ label: ctx.inviteRole === "admin" ? "They have the link" : "I sent it", onPress: () => go(ctx.inviteRole === "admin" ? "invite.words" : "invite.done") }}>
      <CodeBlock code="https://web.vyre.run/join/7QMK4P2X9TBN" lang="" />
      <CodeDisplay label="Or read them this code" code="INV-7QMK-4P2X" note="Good for 7 days, one use." />
    </FlowStep>
  );
}

function InviteWordsMock({ ctx, go, back }: ScreenProps) {
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

// ---- the real screens: the same flow and the same words, answered by the server instead of pretended ----

const SERVER_WAIT = "Waiting for your server. This screen moves on by itself when it answers.";

function CreateRunLive({ ctx, go, back, steps }: ScreenProps) {
  const st = useServerRun();
  const [failed, setFailed] = useState("");
  useEffect(() => { beginServerRun(ctx.server).catch((e) => setFailed(whyNot(e))); }, []);
  useEffect(() => { if (st?.stage === "found") go("create.confirm"); }, [st?.stage]);
  const stopped = st?.stage === "stopped";
  const failure = failed || (stopped ? st?.error?.message : undefined);
  return (
    <FlowStep mark="working" steps={steps} onBack={() => { stopServerRun(); back?.(); }} title={ctx.server === "mac" ? "Run this in Terminal on that Mac" : "Run this on your server"} lead="One command installs Vyre. It works once, for one hour. It needs at least 4 GB of memory, and 8 GB is recommended. It ends by printing your space code."
      failure={failure}
      primary={failure ? { label: "Start again", onPress: () => { setFailed(""); stopServerRun(); beginServerRun(ctx.server).catch((e) => setFailed(whyNot(e))); } } : { label: "I have the code", onPress: () => go("create.code") }}>
      {st?.installLine ? <CodeBlock lang="sh" code={st.installLine} /> : <Text tone="muted">Making your line.</Text>}
      <Stack gap={2}>
        <Text strong>Lost the code?</Text>
        <CodeBlock lang="sh" code="vyre space up" />
        <Text size="caption" tone="muted">That prints a fresh code at any time. If someone else set up the server, ask them for the code: they run vyre space up. Whoever types the code here and confirms the four words becomes the space's owner.</Text>
      </Stack>
    </FlowStep>
  );
}

function CreateCodeLive({ go, back, steps }: ScreenProps) {
  const st = useServerRun();
  const [code, setCode] = useState("");
  const [ack, setAck] = useState("");
  const [failure, setFailure] = useState("");
  useEffect(() => { if (st?.stage === "found") go("create.confirm"); }, [st?.stage]);
  const connect = async () => {
    setFailure("");
    try { await pairByCode(code, (a) => setAck(a)); go("create.setup"); } catch (e) { setAck(""); setFailure(whyNot(e)); }
  };
  return (
    <FlowStep mark="working" steps={steps} onBack={back} title="Type the space code" lead="It starts with WINK and was printed on your server. If you ran the line from the last screen, this moves on by itself."
      failure={failure || (st?.stage === "stopped" ? st.error?.message : undefined)}
      primary={{ label: ack ? "Waiting for your server" : "Connect to my server", disabled: code.length < 14 || !!ack, loading: !!ack, onPress: () => { void connect(); } }}>
      <CodeField label="Space code" prefix="WINK" value={code} onChangeText={(v) => { setCode(v); setFailure(""); }} />
      {ack ? <CodeDisplay label="Type this on your server" code={ack} /> : <Text tone="muted">{SERVER_WAIT}</Text>}
    </FlowStep>
  );
}

function CreateConfirmLive({ go, back, steps }: ScreenProps) {
  const st = useServerRun();
  const words = st?.box?.words ?? [];
  const [bad, setBad] = useState(false);
  useEffect(() => { if (st?.stage === "done") go("create.setup"); }, [st?.stage]);
  const failure = bad ? "The words do not match, so this is not your server. Do not go on. Run vyre space up on your server for a fresh code, then enter it again." : st?.stage === "stopped" ? st.error?.message : undefined;
  const pairing = st?.stage === "pairing";
  return (
    <FlowStep mark={pairing ? "working" : "static"} steps={steps} onBack={back} title="Do the four words match?" lead="Your server shows four words too. They must be the same, in the same order."
      failure={failure}
      primary={failure ? { label: "Enter a new code", onPress: () => { stopServerRun(); go("create.run"); } } : { label: pairing ? "Connecting to your server" : "They match", disabled: !words.length || pairing, loading: pairing, onPress: () => { void confirmServerWords(); } }}
      secondary={failure || pairing ? undefined : { label: "They do not match", onPress: () => { denyServerWords(); setBad(true); } }}>
      <MatchWords label="Words on this screen" words={words} note="Check them against the words on your server." />
    </FlowStep>
  );
}

function CreateSetupLive({ ctx, go, back, steps }: ScreenProps) {
  const items = ["Creating the space on your server", "Creating the space vault", "Setting the rule for members' computers"];
  const [done, setDone] = useState(0);
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setFailure("");
    setUpSpace({ spaceName: ctx.spaceName, membersOwnComputers: ctx.allowed }, (i) => { if (live) setDone(i); })
      .then(() => { if (live) setDone(items.length); })
      .catch((e) => { if (live) setFailure(`${whyNot(e)} Nothing after this step was made. Try again.`); });
    return () => { live = false; };
  }, [attempt]);
  const finished = done >= items.length;
  return (
    <FlowStep mark={finished ? "done" : failure ? "static" : "working"} steps={steps} onBack={back} title={`Setting up ${ctx.spaceName || SPACE}`} lead="Your server makes the space, then its vault."
      failure={failure || undefined}
      primary={failure ? { label: "Try again", onPress: () => { setDone(0); setAttempt((a) => a + 1); } } : { label: "Continue", disabled: !finished, onPress: () => go(afterSpace(ctx)) }}>
      <Meter value={done / items.length} label="Space setup progress" />
      <Checks items={items} done={done} />
    </FlowStep>
  );
}

function JoinCodeLive({ set, go, back, steps }: ScreenProps) {
  const [text, setText] = useState("");
  const [ack, setAck] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const opened = useRef(false);
  const next = async (held?: string) => {
    setBusy(true); setFailure("");
    try {
      const link = held ?? await linkFromInput(text, (a) => setAck(a));
      const c = await readInvite(link);
      set({ spaceName: c.label, role: c.role });
      go("join.review");
    } catch (e) { setFailure(whyNot(e)); } finally { setBusy(false); setAck(""); }
  };
  // A link the person opened from outside the app is read once here, and skips the typing.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const held = takeJoin();
    if (held) { setText(held); void next(held); }
  }, []);
  return (
    <FlowStep steps={steps} onBack={back} title="Join a space" lead="Paste the invite link, or type the invite code someone read to you."
      failure={failure}
      primary={{ label: "Continue", disabled: !text.trim() || busy, loading: busy, onPress: () => { void next(); } }}>
      <Field label="Invite link or code" value={text} onChangeText={(v) => { setText(v); setFailure(""); }} placeholder="https://web.vyre.run/join/..." />
      {ack ? <CodeDisplay label="Tell your inviter this code" code={ack} /> : null}
    </FlowStep>
  );
}

function JoinReviewLive({ go, back, steps }: ScreenProps) {
  const c = useJoinCard();
  if (!c) return <FlowStep steps={steps} onBack={back} title="Join a space" failure="There is no invite open. Go back and paste the link again." primary={{ label: "Back", onPress: () => back?.() }}><Text tone="muted">Nothing to show.</Text></FlowStep>;
  const admin = c.role === "admin";
  return (
    <FlowStep steps={steps} onBack={back} title={`Join ${c.label}?`} lead="Check the space and the role you will have."
      primary={{ label: `Join ${c.label}`, onPress: () => go("join.sealing") }} secondary={{ label: "Not now", onPress: () => back?.() }}>
      <Card flush>
        <Row dense lead={<Icon name="space" tone="text-2" />} title="Space" end={<Text>{c.label}</Text>} />
        <Divider inset={60} />
        <Row dense lead={<Icon name="key" tone="text-2" />} title="Your role" end={<Chip tone="accent">{c.roleWord.charAt(0).toUpperCase() + c.roleWord.slice(1)}</Chip>} />
      </Card>
      <MatchWords label="The space's four words" words={c.words} note={admin ? "Your inviter types these on their side to confirm it is you." : "These match the words your inviter sees."} />
    </FlowStep>
  );
}

function JoinSealingLive({ ctx, set, go, back, steps }: ScreenProps) {
  const c = joinCard();
  const items = [`Joining ${c?.label ?? "the space"}`];
  const [done, setDone] = useState(0);
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  const allowed = useRef(false);
  useEffect(() => {
    let live = true;
    setFailure("");
    if (!c) { setFailure("There is no invite open. Go back and paste the link again."); return; }
    joinSpace(c.link).then((r) => { allowed.current = r.allowed; if (live) { set({ allowed: r.allowed }); setDone(1); } }).catch((e) => { if (live) setFailure(`${whyNot(e)} You have not joined. Try again, or ask your inviter for a new link.`); });
    return () => { live = false; };
  }, [attempt]);
  const finished = done >= items.length;
  return (
    <FlowStep mark={finished ? "done" : failure ? "static" : "working"} steps={steps} onBack={back} title="Joining the space" lead="Your device asks the space's server to add you. You give the yes on this device."
      failure={failure || undefined}
      primary={failure ? { label: "Try again", onPress: () => setAttempt((a) => a + 1) } : { label: "Continue", disabled: !finished, onPress: () => go(afterSpace({ ...ctx, allowed: allowed.current })) }}>
      <Checks items={items} done={done} />
    </FlowStep>
  );
}

function ComputeLive({ ctx, set, go, back, steps }: ScreenProps) {
  const space = useActiveSpace();
  const name = space?.name || ctx.spaceName || SPACE;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const next = async () => {
    if (!ctx.runHere) { go("ready"); return; }
    if (!space?.id) { setFailure("This device does not know which space this is for. Choose the server for now, then set it in Settings."); return; }
    setBusy(true); setFailure("");
    try { await lendThisComputer(space.id, true); go("ready"); } catch (e) { setFailure(whyNot(e)); } finally { setBusy(false); }
  };
  return (
    <FlowStep steps={steps} onBack={back} title={`Use this computer for your work in ${name}?`} lead="Your AI sessions are the chats and tasks your AI accounts do for you. You can change this later in Settings."
      failure={failure}
      primary={{ label: "Continue", loading: busy, disabled: busy, onPress: () => { void next(); } }}>
      <ChoiceList label="This computer" value={ctx.runHere ? "allow" : "deny"} onChange={(v) => set({ runHere: v === "allow" })} options={[
        { value: "allow", title: "Allow: use this computer when it is available", sub: `Your AI sessions run here while this computer is on, and on ${name}'s server when it is not.`, icon: "laptop" },
        { value: "deny", title: "Do not allow: always use the space's server", sub: `Everything runs on ${name}'s server. This computer only shows it.`, icon: "server" },
      ]} />
    </FlowStep>
  );
}

function InviteWhoLive({ ctx, set, go, back }: ScreenProps) {
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const next = async () => {
    setTried(true);
    if (!ctx.inviteName.trim()) return;
    setBusy(true); setFailure("");
    try { keepMadeInvite(await makeInvite(ctx.inviteRole, ctx.inviteProjects, Number(ctx.inviteDays) || 7, ctx.inviteLevels)); go("invite.link"); } catch (e) { setFailure(whyNot(e)); } finally { setBusy(false); }
  };
  return (
    <FlowStep onBack={back} title="Invite people" lead="Vyre makes a link and a short code. You send them privately."
      failure={failure}
      primary={{ label: "Make the invite", loading: busy, disabled: busy, onPress: () => { void next(); } }}>
      <Field label="Name" value={ctx.inviteName} onChangeText={(v) => { set({ inviteName: v }); setTried(false); }} placeholder="Name" error={tried && !ctx.inviteName.trim() ? "Add a name so you can tell invites apart." : undefined} />
      <InviteRolePicker actor="owner" role={ctx.inviteRole} onRole={(r) => set({ inviteRole: r })} projects={ctx.inviteProjects} onProjects={(ids) => set({ inviteProjects: ids })} levels={ctx.inviteLevels} onLevels={(v) => set({ inviteLevels: v })} days={ctx.inviteDays} onDays={(d) => set({ inviteDays: d })} />
      <Text size="caption" tone="label">{ctx.inviteRole === "admin" ? "An admin joins only after you confirm four words with them." : "A member sees the projects they are on and what the space's rules allow."}</Text>
    </FlowStep>
  );
}

const roleName = (r: string) => (r === "temp" ? "Guest" : r.charAt(0).toUpperCase() + r.slice(1));

function InviteLinkLive({ ctx, go, back }: ScreenProps) {
  const m = useMadeInvite();
  const space = useActiveSpace();
  const admin = ctx.inviteRole === "admin" || !!m?.needsConfirm;
  if (!m) return <FlowStep onBack={back} title="Invite people" failure="No invite was made. Go back and make it again." primary={{ label: "Back", onPress: () => back?.() }}><Text tone="muted">Nothing to send.</Text></FlowStep>;
  return (
    <FlowStep onBack={back} title={`Send ${ctx.inviteName.trim() || "them"} the invite`} lead="Send the link privately. It works once."
      primary={{ label: admin ? "They have the link" : "I sent it", onPress: () => go(admin ? "invite.words" : "invite.done") }}>
      <InviteMade space={{ id: space?.id ?? "", name: space?.name ?? SPACE }} who={ctx.inviteName.trim() || "them"} role={roleName(ctx.inviteRole)} line="Works once" code={m.code ?? ""} link={m.link} />
    </FlowStep>
  );
}

function InviteWordsLive({ go, back }: ScreenProps) {
  const m = useMadeInvite();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const check = async () => {
    if (!m) return;
    setBusy(true); setFailure("");
    try { await confirmInviteWords(m.id, typed); go("invite.done"); } catch (e) { setFailure(`${whyNot(e)} Ask them to read the four words on their screen again.`); } finally { setBusy(false); }
  };
  return (
    <FlowStep onBack={back} title="Confirm four words" lead="When they join, they read you four words. Type them here."
      failure={failure}
      primary={{ label: "Check the words", disabled: !typed.trim() || busy, loading: busy, onPress: () => { void check(); } }}>
      <Field label="Their four words" value={typed} onChangeText={(v) => { setTyped(v); setFailure(""); }} placeholder="word word word word" />
    </FlowStep>
  );
}

export const CreateRun = LIVE ? CreateRunLive : CreateRunMock;
export const CreateCode = LIVE ? CreateCodeLive : CreateCodeMock;
export const CreateConfirm = LIVE ? CreateConfirmLive : CreateConfirmMock;
export const CreateSetup = LIVE ? CreateSetupLive : CreateSetupMock;
export const JoinCode = LIVE ? JoinCodeLive : JoinCodeMock;
export const JoinReview = LIVE ? JoinReviewLive : JoinReviewMock;
export const JoinSealing = LIVE ? JoinSealingLive : JoinSealingMock;
export const Compute = LIVE ? ComputeLive : ComputeMock;
export const InviteWho = LIVE ? InviteWhoLive : InviteWhoMock;
export const InviteLink = LIVE ? InviteLinkLive : InviteLinkMock;
export const InviteWords = LIVE ? InviteWordsLive : InviteWordsMock;
