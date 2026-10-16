import { useCallback, useEffect, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ChoiceHero, ChoiceList, CodeBlock, Field, FlowStep, InviteShare, PasswordField, ProviderSignInButton,
  RecoveryKeySheet, RolePicker, Segmented, ServerUrlField, SpaceSwitcherTitle, Text, passwordStrength,
} from "@vyre/ui";
import { AI_SIGNIN_COPY, INVITE_ROLES, JOIN_COPY, PHASES, SIGNIN_COPY, afterAi, afterRecovery, commandOk, entryScreen, passwordOk, phaseOf, spaceAddressOf, usernameOf } from "../../../../lib/first-run-shape.js";
import { MOCK } from "../../src/real/box";
import { takeJoin } from "../../src/shell/join-hold.js";
import { nameFromLogin, SHOT_TABLE } from "./mock.js";
import {
  addComputer, addPhone, chooseSpace, createPerson, finishFirstRun, finishGithub, joinSpace, listAgentProviders, listSpaces,
  loadProgress, makeInvite, openSpace, personStatus, pollSpace, readInvite, saveProgress, signInAgent, signInGithub, signInPassword, startGithub, unlockGithub,
} from "./real.js";

export type Screen = "id.choice" | "id.signin" | "id.signin.spaces" | "id.create" | "id.recovery" | "id.ai" | "space.choice" | "join.link" | "join.review" | "create.kind" | "create.wait" | "invite.share" | "computer.add" | "phone.add" | "ready";

type Review = { link: string; role: string; space: string | null };
type Membership = { id: string; name: string; role: string; server: string | null };

const shotOf = (key: string) => (MOCK ? (SHOT_TABLE as Record<string, { screen: Screen; username?: string; recovery?: string; link?: string; command?: string; space?: string }>)[key] : undefined);

/** First run: Identity, then a space, then Ready. Every button calls a registry tool. */
export function FirstRun() {
  const router = useRouter();
  const params = useLocalSearchParams<{ path?: string | string[]; shot?: string | string[] }>();
  const path = one(params.path);
  const shot = shotOf(one(params.shot) || "");
  const [stack, setStack] = useState<Screen[]>([shot?.screen || entryScreen(path)]);
  const [username, setUsername] = useState(shot?.username || "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saved, setSaved] = useState(false);
  const [signSpace, setSignSpace] = useState("");
  const [found, setFound] = useState<{ id?: string; name: string; role: string }[]>([]);
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
  const [spaces, setSpaces] = useState<Membership[]>([]);
  const [current, setCurrent] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [agents, setAgents] = useState<{ id: string; label: string }[]>([]);
  const [agentFlow, setAgentFlow] = useState("");
  const [agentCode, setAgentCode] = useState("");
  const [agentUrl, setAgentUrl] = useState("");
  const [signedAgents, setSignedAgents] = useState<string[]>([]);
  const screen = stack[stack.length - 1];
  const go = (next: Screen) => {
    setFailure("");
    setStack((s) => {
      const nextStack = [...s, next];
      if (!shot) void saveProgress({ screen: next, stack: nextStack }).catch(() => {});
      return nextStack;
    });
  };
  const back = stack.length > 1 ? () => { setFailure(""); setStack((s) => s.slice(0, -1)); } : undefined;
  const steps = { labels: [...PHASES], current: phaseOf(screen), kind: "phase" as const };

  useEffect(() => {
    if (shot) return;
    let live = true;
    void loadProgress().then((r) => {
      if (!live || !r.ok || !Array.isArray(r.stack) || !r.stack.length) return;
      const resume = r.stack.map(String).filter(Boolean) as Screen[];
      if (resume.length) setStack(resume);
    }).catch(() => {});
    return () => { live = false; };
  }, [shot]);

  useEffect(() => {
    if (shot || screen !== "id.create") return;
    let live = true;
    void personStatus().then((r) => {
      if (!live || !r.ok || !r.exists) return;
      setUsername(r.username || "");
      setStack((s) => (s[s.length - 1] === "id.create" ? [afterRecovery({ path })] : s));
    });
    return () => { live = false; };
  }, [shot, screen, path]);

  useEffect(() => {
    if (shot || screen !== "id.ai") return;
    let live = true;
    void listAgentProviders().then((r) => {
      if (!live || !r.ok || !Array.isArray(r.providers)) return;
      setAgents(r.providers.map((p: { id: string; label?: string }) => ({ id: String(p.id), label: String(p.label || p.id) })));
    });
    return () => { live = false; };
  }, [shot, screen]);

  useEffect(() => {
    if (shot || (screen !== "ready" && screen !== "space.choice" && screen !== "computer.add")) return;
    let live = true;
    void listSpaces().then((r) => {
      if (!live || !r.ok || !Array.isArray(r.spaces)) return;
      setSpaces(r.spaces);
      if (typeof r.current === "string") setCurrent(r.current);
    });
    return () => { live = false; };
  }, [shot, screen]);

  useEffect(() => {
    if (shot) return;
    const held = path === "join" ? takeJoin() : null;
    if (!held) return;
    void readInvite(held).then((r) => {
      if (!r.ok) { setFailure(r.message || JOIN_COPY.bad); setStack(["id.create", "join.link"]); return; }
      setReview({ link: r.link || held, role: r.role || "member", space: r.space });
      setPaste(held);
      setStack(["id.create", "join.review"]);
    });
  }, [path, shot]);

  useEffect(() => {
    if (screen !== "create.wait" || !waitId || shot) return;
    const tick = () => {
      void pollSpace(waitId).then((r) => {
        if (!r.ok) { setFailure(r.message || "Could not check whether the space is online yet."); return; }
        if (r.expired) { setFailure(typeof r.message === "string" ? r.message : "The install window ended. Go back and show a new command."); setOnline(false); return; }
        if (typeof r.expiresAt === "string") setExpiresAt(r.expiresAt);
        if (r.online) setOnline(true);
      });
    };
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

  if (screen === "id.choice") {
    return (
      <FlowStep steps={steps} hero title={SIGNIN_COPY.choiceTitle} lead={SIGNIN_COPY.choiceLead}>
        <ChoiceHero title="How do you want to start?" options={[
          { value: "create", title: "Create an identity", sub: "A username and a master password. About a minute.", icon: "plus" },
          { value: "signin", title: "Sign in", sub: "You already have one. Use a space address, or GitHub.", icon: "link" },
        ]} onChange={(v) => go(v === "signin" ? "id.signin" : "id.create")} />
      </FlowStep>
    );
  }

  if (screen === "id.signin") {
    const addr = spaceAddressOf(signSpace);
    return (
      <FlowStep steps={steps} onBack={back} title={SIGNIN_COPY.title} lead={SIGNIN_COPY.lead} failure={failure}
        primary={{ label: busy ? "Unlocking..." : "Sign in", disabled: !addr || !usernameOf(username) || !password || busy, loading: busy, onPress: () => void run(async () => {
          const r = await signInPassword({ space: addr ? addr.space : "", username: usernameOf(username), password });
          if (!r.ok) { setFailure(r.message); return; }
          setPassword("");
          setUsername(r.username || usernameOf(username));
          go("ready");
        }) }}>
        <Field label="Space address" name="Space address" value={signSpace} onChangeText={setSignSpace} placeholder="juniper.vyre.run" error={signSpace && !addr ? "Use the address of a space, like juniper.vyre.run." : undefined} />
        <Field label="Username" value={username} onChangeText={setUsername} />
        <PasswordField label="Master password" value={password} onChangeText={setPassword} />
        <ProviderSignInButton disabled={busy} onPress={() => void run(async () => {
          const r = await signInGithub(addr ? addr.space : undefined);
          if (!r.ok) { setFailure(r.message); return; }
          const list = Array.isArray(r.spaces) ? r.spaces : [];
          if (!list.length) { setFailure(SIGNIN_COPY.none); return; }
          setFound(list.map((x: any) => ({ id: x.id, name: String(x.name), role: String(x.role || "member") })));
          setPassword("");
          go("id.signin.spaces");
        })} />
      </FlowStep>
    );
  }

  if (screen === "id.signin.spaces") {
    return (
      <FlowStep steps={steps} onBack={back} title={SIGNIN_COPY.spacesTitle} lead={SIGNIN_COPY.spacesLead} failure={failure}
        primary={{ label: busy ? "Unlocking..." : "Unlock", disabled: !password || busy, loading: busy, onPress: () => void run(async () => {
          const r = await unlockGithub(password);
          if (!r.ok) { setFailure(r.message); return; }
          setPassword("");
          go("ready");
        }) }}>
        {found.map((x) => <Text key={x.id || x.name}>{`${x.name}, ${x.role}`}</Text>)}
        <PasswordField label="Master password" value={password} onChangeText={setPassword} />
      </FlowStep>
    );
  }

  if (screen === "id.create") {
    return (
      <FlowStep steps={steps} title="Create your identity" lead="A username, a master password, and an optional GitHub sign-in. The password unlocks your vault."
        failure={failure} primary={{ label: busy ? "Creating..." : "Create", disabled: !nameOk || !passOk || busy, loading: busy, onPress: () => void run(async () => {
          const r = await createPerson({ username, password, confirm });
          if (!r.ok) { setFailure(r.message); return; }
          if (r.already) { setUsername(r.username || usernameOf(username)); go(afterRecovery({ path, heldInvite: review?.link })); return; }
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
          if (typeof r.url === "string" && r.url && typeof window !== "undefined" && !(r.user && r.user.login)) window.open(r.url, "vyre-github", "width=520,height=720");
          const login = r.user && r.user.login ? String(r.user.login) : "";
          if (login) {
            const done = await finishGithub(login);
            if (!done.ok) { setFailure(done.message); return; }
            const suggested = nameFromLogin(login);
            if (suggested && !username) setUsername(suggested);
            setGithub(true);
          }
        })} />
      </FlowStep>
    );
  }

  if (screen === "id.recovery") {
    return (
      <FlowStep steps={steps} onBack={back} title="Save your recovery key" lead="One key for your identity and your vault. It is shown once."
        failure={failure} primary={{ label: "Continue", disabled: recovery ? !saved : false, loading: busy, onPress: () => go(afterRecovery({ path, heldInvite: review?.link })) }}>
        {recovery ? <RecoveryKeySheet secret={recovery} saved={saved} onSaved={setSaved} /> : <Text tone="muted">Your name is saved on this device. The recovery key appears when the vault can be created from here.</Text>}
      </FlowStep>
    );
  }

  if (screen === "id.ai") {
    return (
      <FlowStep steps={steps} onBack={back} title={AI_SIGNIN_COPY.title} lead={AI_SIGNIN_COPY.lead} failure={failure}
        secondary={{ label: AI_SIGNIN_COPY.skip, onPress: () => go(afterAi({ path, heldInvite: review?.link })) }}
        primary={{ label: agentFlow ? "Done" : "Continue", loading: busy, onPress: () => void run(async () => {
          if (signedAgents.length === agents.length && agents.length) { go(afterAi({ path, heldInvite: review?.link })); return; }
          const pick = agents.find((a) => !signedAgents.includes(a.id));
          if (!pick) { go(afterAi({ path, heldInvite: review?.link })); return; }
          const r = await signInAgent({ provider: pick.id, label: pick.label, ...(agentFlow ? { flow: agentFlow } : {}), ...(agentCode ? { code: agentCode } : {}) });
          if (!r.ok) { setFailure(r.message); return; }
          if (r.flow && r.step !== "done") {
            setAgentFlow(String(r.flow));
            if (typeof r.url === "string" && r.url && typeof window !== "undefined") window.open(r.url, `vyre-ai-${pick.id}`, "width=520,height=720");
            if (typeof r.url === "string") setAgentUrl(r.url);
            if (typeof r.code === "string") setAgentCode(r.code);
            return;
          }
          setSignedAgents((s) => [...s, pick.id]);
          setAgentFlow(""); setAgentCode(""); setAgentUrl("");
        }) }}>
        {agents.map((a) => <Text key={a.id} tone={signedAgents.includes(a.id) ? "default" : "muted"}>{signedAgents.includes(a.id) ? `${a.label} is signed in` : a.label}</Text>)}
        {agentUrl ? <CodeBlock code={agentCode ? `${agentUrl}\n\n${agentCode}` : agentUrl} lang="txt" /> : null}
      </FlowStep>
    );
  }

  if (screen === "space.choice") {
    return (
      <FlowStep steps={steps} onBack={back} hero title="Your space" lead="Join one you were invited to, or create one. The same identity can be in more than one.">
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
          if (typeof r.expiresAt === "string") setExpiresAt(r.expiresAt);
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
        failure={failure}
        secondary={back ? { label: "Cancel", onPress: back } : undefined}
        primary={{ label: online ? "Continue" : "Waiting", disabled: !online, onPress: () => go("ready") }}>
        {command ? <CodeBlock code={command} lang="sh" /> : null}
        {expiresAt && !online ? <Text tone="muted">{`Install link expires ${new Date(expiresAt).toLocaleString()}`}</Text> : null}
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
        <RolePicker roles={[...INVITE_ROLES]} value={role} onChange={setRole} />
        <Text size="caption" strong tone="label">Expires</Text>
        <Segmented label="Expires" fill value={days} onChange={setDays} options={[["1", "1 day"], ["7", "7 days"], ["30", "30 days"]]} />
        {invite ? <InviteShare link={invite} /> : null}
      </FlowStep>
    );
  }

  if (screen === "computer.add") {
    const urlOk = /^https:\/\/[^\s]+$/.test(url.trim());
    return (
      <FlowStep steps={steps} onBack={back} title="Add your computer" lead="This computer connects to every space you belong to. Each space has its own address. The master password unlocks the vault." failure={failure}
        primary={{ label: "Add this computer", disabled: !urlOk || !passwordOk(password) || (!github && !usernameOf(username)), loading: busy, onPress: () => void run(async () => {
          const r = await addComputer({ url: url.trim(), password, ...(github ? { github: true } : { username }) });
          if (!r.ok) { setFailure(r.message); return; }
          go("ready");
        }) }}>
        {spaces.length ? spaces.map((s) => <Text key={s.id} tone="muted">{`${s.name}, ${s.role}${s.server ? `, ${s.server}` : ""}`}</Text>) : null}
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

  const showing = spaces.find((s) => s.id === current) || spaces[0];
  return (
    <FlowStep steps={steps} hero mark="done" title="You're in"
      lead={spaces.length > 1 ? "One identity, in every space below. Each space has its own server." : space ? `${space} is ready. You can join or create another with this identity.` : "Your identity is ready."}
      primary={{ label: "Open Vyre", loading: busy, onPress: () => void run(async () => {
        const r = await finishFirstRun();
        if (!r.ok) { setFailure(r.message); return; }
        router.replace("/u/now" as never);
      }) }}
      secondary={{ label: "Invite someone", onPress: () => go("invite.share") }}>
      {spaces.length > 1 ? (
        <SpaceSwitcherTitle spaces={spaces.map((s) => ({ id: s.id, name: s.name }))} space={showing?.id || spaces[0].id} onSpace={(id) => void run(async () => {
          const r = await chooseSpace(id);
          if (!r.ok) { setFailure(r.message); return; }
          setCurrent(String(r.current || id));
          if (r.name) setSpace(String(r.name));
        })} />
      ) : null}
      {spaces.map((s) => <Text key={s.id}>{`${s.name}, ${s.role}`}</Text>)}
      <ChoiceList label="Also" onChange={(v) => { if (v === "join.link") { setPaste(""); setReview(null); } go(v); }} options={[
        { value: "join.link", title: "Join another space", sub: "Use another invite. Your identity stays the same.", icon: "link" },
        { value: "create.kind", title: "Create another space", sub: "A Linux server or an always-on Mac.", icon: "server" },
        { value: "computer.add", title: "Add a computer", sub: "It connects to every space you belong to.", icon: "laptop" },
        { value: "phone.add", title: "Add a phone", sub: "The phone opens a link.", icon: "link" },
      ]} />
    </FlowStep>
  );
}

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}
