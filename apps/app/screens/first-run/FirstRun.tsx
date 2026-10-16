import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ChoiceHero, ChoiceList, CodeBlock, Field, FlowStep, InviteShare, PasswordField, ProviderSignInButton,
  RecoveryKeySheet, RolePicker, Segmented, ServerUrlField, Text, passwordStrength,
} from "@vyre/ui";
import { JOIN_COPY, PHASES, afterIdentity, commandOk, entryScreen, passwordOk, phaseOf, usernameOf } from "../../../../lib/first-run-shape.js";
import { takeJoin } from "../../src/shell/join-hold.js";
import { nameFromLogin } from "../onboard/flow-model.js";
import { addComputer, addPhone, createPerson, finishFirstRun, finishGithub, joinSpace, makeInvite, openSpace, pollSpace, readInvite, startGithub } from "./real.js";

type Screen = "id.create" | "id.recovery" | "space.choice" | "join.link" | "join.review" | "create.kind" | "create.wait" | "invite.share" | "computer.add" | "phone.add" | "ready";

type Review = { link: string; role: string; space: string | null };

const ROLES = [
  { id: "admin", name: "Admin", line: "Invites people and looks after the space." },
  { id: "member", name: "Member", line: "Works in the space with everyone else." },
  { id: "guest", name: "Guest", line: "Here for a while. Access ends when the invite does." },
];

const SHOT: Record<string, { screen: Screen; username?: string; recovery?: string; link?: string; command?: string; space?: string }> = {
  "id.create": { screen: "id.create", username: "alex" },
  "id.recovery": { screen: "id.recovery", username: "alex", recovery: "R1-SAMPLE-KEY-SHOWN-ONCE" },
  "space.choice": { screen: "space.choice", username: "alex" },
  "join.link": { screen: "join.link" },
  "join.review": { screen: "join.review", link: "https://vyre.run/i/sampletoken", space: "juniper" },
  "create.kind": { screen: "create.kind" },
  "create.wait": { screen: "create.wait", command: "curl -fsSL vyre.run/i | sh" },
  "invite.share": { screen: "invite.share", link: "https://vyre.run/i/sampletoken", space: "juniper" },
  "computer.add": { screen: "computer.add" },
  "phone.add": { screen: "phone.add", link: "https://vyre.run/i/samplephone" },
  ready: { screen: "ready", username: "alex", space: "juniper" },
};

/** First run: Identity, then a space, then Ready. Every button calls a registry tool. */
export function FirstRun() {
  const router = useRouter();
  const params = useLocalSearchParams<{ path?: string | string[]; shot?: string | string[] }>();
  const path = one(params.path);
  const shot = SHOT[one(params.shot) || ""];
  const [stack, setStack] = useState<Screen[]>([shot?.screen || (path === "computer" || path === "phone" || path === "invite" ? entryScreen(path) : "id.create")]);
  const [username, setUsername] = useState(shot?.username || "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saved, setSaved] = useState(false);
  const [recovery, setRecovery] = useState(shot?.recovery || "");
  const [paste, setPaste] = useState("");
  const [review, setReview] = useState<Review | null>(shot?.screen === "join.review" ? { link: shot.link || "", role: "member", space: shot.space || "juniper" } : null);
  const [kind, setKind] = useState<"linux" | "mac" | "">("");
  const [command, setCommand] = useState(shot?.command || "");
  const [waitId, setWaitId] = useState("");
  const [online, setOnline] = useState(false);
  const [role, setRole] = useState("member");
  const [days, setDays] = useState("7");
  const [invite, setInvite] = useState(shot?.link || "");
  const [url, setUrl] = useState("");
  const [github, setGithub] = useState(false);
  const [phoneLink, setPhoneLink] = useState(shot?.screen === "phone.add" ? shot.link || "" : "");
  const [space, setSpace] = useState(shot?.space || "");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const screen = stack[stack.length - 1];
  const go = (next: Screen) => { setFailure(""); setStack((s) => [...s, next]); };
  const back = stack.length > 1 ? () => { setFailure(""); setStack((s) => s.slice(0, -1)); } : undefined;
  const steps = { labels: [...PHASES], current: phaseOf(screen), kind: "phase" as const };

  useEffect(() => {
    if (shot) return;
    const held = path === "join" ? takeJoin() : null;
    if (!held) return;
    void readInvite(held).then((r) => {
      if (!r.ok) { setFailure(r.message); return; }
      setReview({ link: r.link || held, role: r.role || "member", space: r.space });
      setPaste(held);
    });
  }, [path, shot]);

  useEffect(() => {
    if (screen !== "create.wait" || !waitId || shot) return;
    const tick = () => { void pollSpace(waitId).then((r) => { if (r.ok && r.online) setOnline(true); }); };
    tick();
    const t = setInterval(tick, 4000);
    return () => clearInterval(t);
  }, [screen, waitId, shot]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setFailure("");
    try { await fn(); } catch (e) { setFailure(e instanceof Error ? e.message : "That did not work. Try again."); }
    setBusy(false);
  }, [busy]);

  const strength = passwordStrength(password);
  const nameOk = Boolean(usernameOf(username));
  const passOk = strength.score >= 3 && passwordOk(password) && password === confirm;

  if (screen === "id.create") {
    return (
      <FlowStep steps={steps} title="Create your identity" lead="A username, a master password, and an optional GitHub sign-in. The password unlocks your vault."
        failure={failure} primary={{ label: "Create", disabled: !nameOk || !passOk, loading: busy, onPress: () => void run(async () => {
          const r = await createPerson({ username, password, confirm });
          if (!r.ok) { setFailure(r.message); return; }
          setRecovery(typeof r.recoveryKey === "string" ? r.recoveryKey : "");
          setUsername(r.username || usernameOf(username));
          go("id.recovery");
        }) }}>
        <Field label="Username" value={username} onChangeText={setUsername} help={username && !nameOk ? "Use 3 to 20 lowercase letters, digits or hyphens." : usernameOf(username) ? `Your page is vyre.run/u/${usernameOf(username)}` : "This becomes vyre.run/u/your-name"} />
        <PasswordField label="Master password" meter value={password} onChangeText={setPassword} />
        <PasswordField label="Confirm master password" value={confirm} onChangeText={setConfirm} error={confirm && confirm !== password ? "Type the same master password again." : undefined} />
        <ProviderSignInButton disabled={busy} onPress={() => void run(async () => {
          const r = await startGithub();
          if (!r.ok) { setFailure(r.message); return; }
          const login = r.user && r.user.login ? String(r.user.login) : "";
          if (login) {
            const done = await finishGithub(login);
            if (!done.ok) { setFailure(done.message); return; }
            const suggested = nameFromLogin(login);
            if (suggested && !username) setUsername(suggested);
            setGithub(true);
          }
          if (typeof r.url === "string" && r.url && typeof window !== "undefined") window.open(r.url, "vyre-github", "width=520,height=720");
        })} />
      </FlowStep>
    );
  }

  if (screen === "id.recovery") {
    return (
      <FlowStep steps={steps} onBack={back} title="Save your recovery key" lead="One key for your identity and your vault. It is shown once."
        failure={failure} primary={{ label: "Continue", disabled: recovery ? !saved : false, loading: busy, onPress: () => go(afterIdentity({ path, heldInvite: review?.link })) }}>
        {recovery ? <RecoveryKeySheet secret={recovery} saved={saved} onSaved={setSaved} /> : <Text tone="muted">Your name is saved on this device. The recovery key appears when the vault can be created from here.</Text>}
      </FlowStep>
    );
  }

  if (screen === "space.choice") {
    return (
      <FlowStep steps={steps} onBack={back} hero title="Your space" lead="Join one you were invited to, or create one.">
        <ChoiceHero title="How do you want to start?" options={[
          { value: "join", title: "Join a space", sub: "Use the invite link you were sent.", icon: "link" },
          { value: "create", title: "Create a space", sub: "Set up a Linux server or an always-on Mac.", icon: "server" },
        ]} onChange={(v) => go(v === "join" ? "join.link" : "create.kind")} />
      </FlowStep>
    );
  }

  if (screen === "join.link") {
    return (
      <FlowStep steps={steps} onBack={back} title={JOIN_COPY.title} lead={JOIN_COPY.lead} failure={failure}
        primary={{ label: "Continue", disabled: paste.trim().length < 8, loading: busy, onPress: () => void run(async () => {
          const r = await readInvite(paste.trim());
          if (!r.ok) { setFailure(r.message); return; }
          setReview({ link: r.link || paste.trim(), role: r.role || "member", space: r.space });
          go("join.review");
        }) }}>
        <Field label="Invite link" value={paste} onChangeText={setPaste} placeholder="https://vyre.run/i/…" />
      </FlowStep>
    );
  }

  if (screen === "join.review" && !review) {
    return (
      <FlowStep steps={steps} onBack={back} title={JOIN_COPY.title} lead={JOIN_COPY.bad}
        primary={{ label: "Paste a link", onPress: () => go("join.link") }} />
    );
  }

  if (screen === "join.review" && review) {
    return (
      <FlowStep steps={steps} onBack={back} title={JOIN_COPY.reviewTitle} lead={JOIN_COPY.reviewLead} failure={failure}
        primary={{ label: JOIN_COPY.accept, loading: busy, onPress: () => void run(async () => {
          const r = await joinSpace(review.link);
          if (!r.ok) { setFailure(r.message); return; }
          if (r.space) setSpace(String(r.space));
          go(r.joined ? "ready" : "join.link");
          if (!r.joined) setFailure(r.message || "The space has not confirmed this invite yet.");
        }) }}>
        <Text strong>{review.space || "A space"}</Text>
        <Text tone="muted">{`Role: ${review.role}`}</Text>
      </FlowStep>
    );
  }

  if (screen === "create.kind") {
    return (
      <FlowStep steps={steps} onBack={back} title="Where should it run?" lead="One install command, then this screen waits until it is online." failure={failure}
        primary={{ label: "Show the command", disabled: !kind, loading: busy, onPress: () => void run(async () => {
          const r = await openSpace({ kind: kind || "linux", name: space || undefined });
          if (!r.ok) { setFailure(r.message); return; }
          if (!commandOk(r.command)) { setFailure("The install command is not one this app can show."); return; }
          setCommand(String(r.command));
          setWaitId(String(r.id || ""));
          go("create.wait");
        }) }}>
        <ChoiceList label="Where it runs" value={kind} onChange={setKind} options={[
          { value: "linux", title: "Linux server", sub: "A cloud machine or any computer that stays on.", icon: "server" },
          { value: "mac", title: "Always-on Mac", sub: "A Mac that stays awake.", icon: "laptop" },
        ]} />
      </FlowStep>
    );
  }

  if (screen === "create.wait") {
    return (
      <FlowStep steps={steps} onBack={back} mark={online ? "done" : "working"} title={online ? "Your space is online" : "Waiting for it to come online"}
        lead="Run this one line there. Nothing else. This screen updates when it is up."
        primary={{ label: online ? "Continue" : "Waiting", disabled: !online, onPress: () => go("ready") }}>
        {command ? <CodeBlock code={command} lang="sh" /> : null}
      </FlowStep>
    );
  }

  if (screen === "invite.share") {
    return (
      <FlowStep steps={steps} onBack={back} title="Invite someone" lead="They open the link and they are in. You pick the role and how long it lasts." failure={failure}
        primary={{ label: invite ? "Done" : "Create link", loading: busy, onPress: () => void run(async () => {
          if (invite) { go("ready"); return; }
          const r = await makeInvite({ role, ttlDays: Number(days), space: space || undefined });
          if (!r.ok) { setFailure(r.message); return; }
          setInvite(String(r.link || ""));
        }) }}>
        <RolePicker roles={ROLES} value={role} onChange={setRole} />
        <View className="gap-s2">
          <Text size="caption" strong tone="label">Expires</Text>
          <Segmented label="Expires" fill value={days} onChange={setDays} options={[["1", "1 day"], ["7", "7 days"], ["30", "30 days"]]} />
        </View>
        {invite ? <InviteShare link={invite} /> : null}
      </FlowStep>
    );
  }

  if (screen === "computer.add") {
    const urlOk = /^https:\/\/[^\s]+$/.test(url.trim());
    return (
      <FlowStep steps={steps} onBack={back} title="Add your computer" lead="The space address, and your master password. GitHub can sign you in. The password still unlocks the vault." failure={failure}
        primary={{ label: "Add this computer", disabled: !urlOk || !passwordOk(password) || (!github && !usernameOf(username)), loading: busy, onPress: () => void run(async () => {
          const r = await addComputer({ url: url.trim(), password, ...(github ? { github: true } : { username }) });
          if (!r.ok) { setFailure(r.message); return; }
          go("ready");
        }) }}>
        <ServerUrlField value={url} onChangeText={setUrl} error={url && !urlOk ? "Use a https address, with no password in it." : undefined} />
        {github ? <Text tone="muted">GitHub will sign you in. Type the master password to unlock the vault.</Text> : <Field label="Username" value={username} onChangeText={setUsername} />}
        <PasswordField label="Master password" meter value={password} onChangeText={setPassword} />
        <ProviderSignInButton disabled={busy} onPress={() => void run(async () => {
          const r = await startGithub();
          if (!r.ok) { setFailure(r.message); return; }
          const login = r.user && r.user.login ? String(r.user.login) : "";
          if (login) {
            const done = await finishGithub(login);
            if (!done.ok) { setFailure(done.message); return; }
            setGithub(true);
          }
        })} />
      </FlowStep>
    );
  }

  if (screen === "phone.add") {
    return (
      <FlowStep steps={steps} onBack={back} title="Add your phone" lead="Your phone opens this link and joins the space." failure={failure}
        primary={{ label: phoneLink ? "Done" : "Add your phone", loading: busy, onPress: () => void run(async () => {
          if (phoneLink) { go("ready"); return; }
          const r = await addPhone(space || undefined);
          if (!r.ok) { setFailure(r.message); return; }
          setPhoneLink(String(r.link || ""));
        }) }}>
        {phoneLink ? <InviteShare link={phoneLink} /> : null}
      </FlowStep>
    );
  }

  return (
    <FlowStep steps={steps} hero mark="done" title="You're in" lead={space ? `${space} is ready.` : "Your identity is ready."}
      primary={{ label: "Open Vyre", loading: busy, onPress: () => void run(async () => {
        const r = await finishFirstRun();
        if (!r.ok) { setFailure(r.message); return; }
        router.replace("/u/now" as never);
      }) }}
      secondary={{ label: "Invite someone", onPress: () => go("invite.share") }}>
      <ChoiceList label="Also" onChange={(v) => go(v)} options={[
        { value: "computer.add", title: "Add a computer", sub: "A computer you already use.", icon: "laptop" },
        { value: "phone.add", title: "Add a phone", sub: "The phone opens a link.", icon: "link" },
      ]} />
    </FlowStep>
  );
}

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}
