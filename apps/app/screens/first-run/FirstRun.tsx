import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  Button, ChoiceHero, ChoiceList, CodeBlock, Field, FlowStep, InviteShare, PasswordField, ProviderSignInButton,
  Avatar, FlowOver, Icon, ProviderBadge, RecoveryKeySheet, RolePicker, Segmented, SpaceSwitcherTitle, Text, markRef, passwordStrength, useUiTheme,
} from "@vyre/ui";
import { AI_SIGNIN_COPY, INVITE_ROLES, JOIN_COPY, PHASES, SIGNIN_COPY, SPACE_NAME_SAY, afterAi, afterRecovery, commandOk, entryScreen, displayNameOf, passwordOk, phaseOf, spaceAddressOf, spaceNameSuggestions, usernameOf } from "../../../../lib/first-run-shape.js";
import { MOCK } from "../../src/real/box";
import { checkName } from "../../src/real/install";
import { takeJoin } from "../../src/shell/join-hold.js";
import { HalftoneField, measureCalm } from "./HalftoneField";
import { ripple, setWelcome } from "./field-state.js";
import { Welcome } from "./Welcome";
import { AgentLookPicker } from "../../ui/chat/NewAgentDialog";
import { PARTS, lookSeed, partsOf, setPart, withParts } from "../../ui/chat/agent-look.js";
import { ACCOUNTS_COPY, defaultLabel, keyKindOf, keyShapeOk, labelProblem } from "./ai-accounts-model.js";
import { ASSISTANT_COPY, MODEL_COPY, NAME_COPY, rememberSpace } from "./welcome-model.js";
import { nameFromLogin, SHOT_TABLE } from "./mock.js";
import {
  chooseSpace, createPerson, finishFirstRun, finishGithub, joinSpace, listAgentProviders, listSpaces,
  loadProgress, makeInvite, openSpace, pageHasNoDaemon, addAgentKey, listAssistantModels, removeSpace, renameSpace, setAssistant, setAssistantModel, personStatus, pollSpace, readInvite, saveProgress, signInAgent, signInGithub, signInPassword, startGithub, unlockGithub,
} from "./real.js";

export type Screen = "id.choice" | "id.signin" | "id.signin.spaces" | "id.create" | "id.name" | "id.recovery" | "id.ai" | "space.choice" | "join.link" | "join.review" | "create.kind" | "create.wait" | "setup.assistant" | "setup.model" | "invite.share" | "ready";

type Review = { link: string; role: string; space: string | null };
type Membership = { id: string; name: string; role: string; server: string | null };

const shotOf = (key: string) => (MOCK ? (SHOT_TABLE as Record<string, { screen: Screen; username?: string; recovery?: string; link?: string; command?: string; space?: string }>)[key] : undefined);

/**
 * First run: Identity, then a space, then Ready. Every button calls a registry tool. One halftone field sits behind the whole flow, mounted here once so it lives through every
 * step: full strength on the welcome screen, calmer on the forms, a faint ripple at each step change.
 */
export function FirstRun() {
  const [screen, setScreen] = useState("");
  const { phone } = useUiTheme();
  useEffect(() => {
    if (!screen) return;
    setWelcome(screen === "id.choice");
    const t = setTimeout(measureCalm, 60);
    if (typeof document !== "undefined") { const c = document.getElementById("onboard-field"); if (c) ripple(c.clientWidth / 2, c.clientHeight * 0.48, 0.28); }
    return () => clearTimeout(t);
  }, [screen]);
  return (
    <View style={{ flex: 1 }}>
      <HalftoneField phone={phone} />
      <FlowOver.Provider value><FirstRunScreens onScreen={setScreen} /></FlowOver.Provider>
    </View>
  );
}

function FirstRunScreens({ onScreen }: { onScreen: (s: Screen) => void }) {
  const router = useRouter();
  const { phone, color } = useUiTheme();
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
  const [kind, setKind] = useState<"linux" | "mac" | "">("linux");
  const [command, setCommand] = useState(shot?.command || "");
  const [waitId, setWaitId] = useState("");
  const [online, setOnline] = useState(false);
  // A page with no daemon has no server to sign an AI in on until its space is online: its AI step comes then, and goes on to Ready.
  const noDaemon = pageHasNoDaemon();
  const [aiThen, setAiThen] = useState<string>("");
  const [paired, setPaired] = useState<{ id: string; name: string; address: string } | null>(null);
  const [noFingerprint, setNoFingerprint] = useState(false);
  const [role, setRole] = useState("member");
  const [days, setDays] = useState("7");
  const [invite, setInvite] = useState(shot?.link || "");
  const [github, setGithub] = useState(false);
  const [space, setSpace] = useState(shot?.space || "");
  const [suggest, setSuggest] = useState("");
  const [taken, setTaken] = useState(false);
  const [spaces, setSpaces] = useState<Membership[]>([]);
  const [current, setCurrent] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [asName, setAsName] = useState("");
  const [models, setModels] = useState<{ id: string; label: string; provider: string; models: { id: string; label: string }[] }[] | null>(null);
  const [modelPick, setModelPick] = useState("");
  const [holdOpen, setHoldOpen] = useState(false);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [asLook, setAsLook] = useState({ shape: 0, color: 0, seed: "" });
  const [expiresAt, setExpiresAt] = useState("");
  const [agents, setAgents] = useState<{ id: string; label: string }[]>([]);
  const [agentFlow, setAgentFlow] = useState("");
  const [agentCode, setAgentCode] = useState("");
  const [agentUrl, setAgentUrl] = useState("");
  const [accounts, setAccounts] = useState<{ provider: string; label: string }[]>([]);
  const [pick, setPick] = useState("");
  const [acctLabel, setAcctLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const screen = stack[stack.length - 1];
  useEffect(() => { onScreen(screen); }, [screen, onScreen]);
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
      setStack((s) => (s[s.length - 1] === "id.create" ? [afterRecovery({ path, skipAi: noDaemon })] : s));
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

  // "You're all set." is the last word: with one space and nothing the person is doing on it, the space opens by itself a moment after its list shows.
  useEffect(() => {
    if (shot || screen !== "ready" || holdOpen || failure || spaces.length !== 1) return;
    const t = setTimeout(() => {
      void finishFirstRun().then((r) => { if (r.ok) router.replace("/u/now" as never); else setFailure(r.message); });
    }, 2500);
    return () => clearTimeout(t);
  }, [shot, screen, holdOpen, failure, spaces.length, router]);

  useEffect(() => {
    if (shot || screen !== "setup.model") return;
    let live = true;
    void listAssistantModels().then((r) => {
      if (!live) return;
      if (!r.ok) { setModels([]); return; }
      const list = Array.isArray(r.accounts) ? r.accounts : [];
      setModels(list);
      const firstWith = list.find((a: { models: unknown[] }) => a.models.length);
      if (firstWith) setModelPick((cur) => cur || `${firstWith.id}:${firstWith.models[0].id}`);
    });
    return () => { live = false; };
  }, [shot, screen]);

  useEffect(() => {
    if (shot || (screen !== "ready" && screen !== "space.choice")) return;
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

  // A space needs a name from the person. Offer one built from the username that the directory says is free; nothing is offered unchecked.
  useEffect(() => {
    if (screen !== "create.kind" || space || shot) return;
    let live = true;
    void (async () => {
      for (const s of spaceNameSuggestions(username, 6)) {
        if (!live) return;
        if (MOCK || (await checkName(s)) === "free") { setSuggest(s); setSpace((cur) => cur || s); return; }
      }
    })();
    return () => { live = false; };
  }, [screen, username, space, shot]);

  // The install command follows the name and the Linux / macOS switch: a valid, free name issues one (a fresh one-time code) a moment after the person stops typing, and flipping the switch issues the other kind's.
  useEffect(() => {
    if (screen !== "create.kind" || shot) return;
    const wanted = usernameOf(space);
    setCommand(""); setWaitId("");
    if (!wanted) return;
    let live = true;
    const t = setTimeout(() => {
      void (async () => {
        if (!MOCK && (await checkName(wanted)) === "taken") {
          const alt = (await Promise.all(spaceNameSuggestions(username || wanted, 6).map(async (c) => ((await checkName(c)) === "free" ? c : "")))).find(Boolean) || "";
          if (!live) return;
          if (alt) setSuggest(alt);
          setFailure(SPACE_NAME_SAY.taken(alt));
          return;
        }
        const r = await openSpace({ kind: kind || "linux", name: wanted });
        if (!live) return;
        if (!r.ok) { setFailure(r.message); return; }
        if (!commandOk(r.command)) { setFailure("The install command is not one this app can show."); return; }
        setFailure("");
        setCommand(String(r.command));
        setWaitId(String(r.id || ""));
        if (typeof r.expiresAt === "string") setExpiresAt(r.expiresAt);
      })();
    }, 700);
    return () => { live = false; clearTimeout(t); };
  }, [screen, space, kind, shot, username]);

  useEffect(() => {
    if (screen !== "create.wait" || !waitId || shot) return;
    const tick = () => {
      void pollSpace(waitId).then((r) => {
        if (!r.ok) { setFailure(r.message || "Could not check whether the space is online yet."); return; }
        if (r.failed && r.canRename) { setTaken(true); setFailure(SPACE_NAME_SAY.taken(suggest)); return; }
        if (r.failed) { setFailure(typeof r.message === "string" ? r.message : "The space could not be made."); return; }
        if (r.expired) { setFailure(typeof r.message === "string" ? r.message : "The install window ended. Go back and show a new command."); setOnline(false); return; }
        if (typeof r.expiresAt === "string") setExpiresAt(r.expiresAt);
        if (r.online) { setOnline(true); setNoFingerprint(Boolean(r.noFingerprintYet)); if (r.server) setPaired({ id: String(r.space || ""), name: String(r.server.name || r.server.hostname || "Your server"), address: String(r.server.address || "") }); }
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

  const continueWithGithub = async (suggestName: boolean) => {
    const r = await startGithub();
    if (!r.ok) { setFailure(r.message); return; }
    const login = r.user && r.user.login ? String(r.user.login) : "";
    if (typeof r.url === "string" && r.url && typeof window !== "undefined") window.open(r.url, "vyre-github", "width=520,height=720");
    if (!login && !r.exchange) return;
    const done = await finishGithub(login);
    if (!done.ok) { setFailure(done.message); return; }
    if (!done.linked) { setFailure("Approve GitHub in the window, then press Continue with GitHub again."); return; }
    const who = String(done.login || login);
    if (suggestName) {
      const suggested = nameFromLogin(who);
      if (suggested && !username) setUsername(suggested);
    }
    setGithub(true);
  };

  const strength = passwordStrength(password);
  const nameOk = Boolean(usernameOf(username));
  const passOk = strength.score >= 3 && passwordOk(password) && password === confirm;

  if (screen === "id.choice") {
    return (
      <Welcome phone={phone} failure={failure}
        onSignIn={(sp) => { setSignSpace(`${sp}.vyre.run`); setFailure(""); go("id.signin"); }}
        onStart={() => { setFailure(""); go("id.name"); }}
        onGithub={() => void run(async () => {
          const r = await signInGithub(undefined);
          if (!r.ok) { setFailure(r.message); return; }
          const list = Array.isArray(r.spaces) ? r.spaces : [];
          if (!list.length) { setFailure(SIGNIN_COPY.none); return; }
          setFound(list.map((x: any) => ({ id: x.id, name: String(x.name), role: String(x.role || "member") })));
          setPassword("");
          go("id.signin.spaces");
        })} />
    );
  }

  if (screen === "id.name") {
    const person = displayNameOf(first, last);
    return (
      <FlowStep steps={steps} onBack={back} title={NAME_COPY.title} lead={NAME_COPY.lead}
        primary={{ label: "Continue", disabled: !person, onPress: () => go("id.create") }}>
        <Field label={NAME_COPY.first} value={first} onChangeText={setFirst} />
        <Field label={NAME_COPY.last} value={last} onChangeText={setLast} error={(first || last) && !person ? NAME_COPY.bad : undefined} />
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
          if (addr) try { rememberSpace(typeof localStorage === "undefined" ? null : localStorage, addr.space); } catch { /* nothing remembered */ }
          go("ready");
        }) }}>
        <Field label="Space address" name="Space address" value={signSpace} onChangeText={setSignSpace} placeholder="juniper.vyre.run" error={signSpace && !addr ? "Use the address of a space, like juniper.vyre.run." : undefined} />
        <Field label="Username" value={username} onChangeText={setUsername} />
        <PasswordField label="Password" value={password} onChangeText={setPassword} />
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
        <PasswordField label="Password" value={password} onChangeText={setPassword} />
      </FlowStep>
    );
  }

  if (screen === "id.create") {
    return (
      <FlowStep steps={steps} onBack={back} title="Create your identity" lead="A username, a password, and an optional GitHub sign-in. The password unlocks your vault."
        failure={failure} primary={{ label: busy ? "Creating..." : "Create", disabled: !nameOk || !passOk || busy, loading: busy, onPress: () => void run(async () => {
          const r = await createPerson({ username, password, confirm });
          if (!r.ok) { setFailure(r.message); return; }
          if (r.already) { setUsername(r.username || usernameOf(username)); go(afterRecovery({ path, heldInvite: review?.link, skipAi: noDaemon })); return; }
          setRecovery(typeof r.recoveryKey === "string" ? r.recoveryKey : "");
          setUsername(r.username || usernameOf(username));
          go("id.recovery");
        }) }}>
        <Field label="Username" value={username} onChangeText={setUsername} help={username && !nameOk ? "Use 3 to 20 lowercase letters, digits or hyphens." : usernameOf(username) ? `Your page is vyre.run/u/${usernameOf(username)}` : "This becomes vyre.run/u/your-name"} />
        <PasswordField label="Password" meter value={password} onChangeText={setPassword} />
        <PasswordField label="Confirm password" value={confirm} onChangeText={setConfirm} error={confirm && confirm !== password ? "Type the same password again." : undefined} />
        <ProviderSignInButton disabled={busy} onPress={() => void run(() => continueWithGithub(true))} />
      </FlowStep>
    );
  }

  if (screen === "id.recovery") {
    return (
      <FlowStep steps={steps} onBack={back} title="Save your recovery key" lead="One key for your identity and your vault. It is shown once."
        failure={failure} primary={{ label: "Continue", disabled: recovery ? !saved : false, loading: busy, onPress: () => go(afterRecovery({ path, heldInvite: review?.link, skipAi: noDaemon })) }}>
        {recovery ? <RecoveryKeySheet secret={recovery} saved={saved} onSaved={setSaved} /> : <Text tone="muted">Your name is saved on this device. The recovery key appears when the vault can be created from here.</Text>}
      </FlowStep>
    );
  }

  if (screen === "id.ai") {
    const onward = () => go(afterAi({ path, heldInvite: review?.link, ...(aiThen ? { then: aiThen } : {}) }));
    const taken = accounts.map((x) => x.label);
    const labelOf = (id: string) => agents.find((x) => x.id === id)?.label || id;
    const problem = pick ? labelProblem(acctLabel, taken) : "";
    return (
      <FlowStep steps={steps} onBack={back} title={ACCOUNTS_COPY.title} lead={ACCOUNTS_COPY.lead} failure={failure}
        secondary={{ label: AI_SIGNIN_COPY.skip, onPress: onward }}
        primary={{ label: "Continue", loading: busy, onPress: () => {
          // Nothing added is not "connected": the person goes on only by choosing to skip, never by a Continue that did nothing.
          if (!accounts.length) { setFailure(ACCOUNTS_COPY.empty); return; }
          onward();
        } }}>
        <View style={{ gap: 8 }} accessibilityLabel="AI providers">
          {agents.map((a) => (
            <Pressable key={a.id} accessibilityRole="button" accessibilityLabel={`Add ${a.label}`} disabled={busy || Boolean(agentFlow)}
              onPress={() => { setFailure(""); setPick(a.id); setAcctLabel(defaultLabel(a.label, taken)); }}
              style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 14, borderWidth: pick === a.id ? 2 : 0.5, borderColor: pick === a.id ? color.primary : color["edge-strong"], backgroundColor: color["surface-2"] }}>
              <ProviderBadge provider={a.id} size={28} />
              <Text>{a.label}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Add ${ACCOUNTS_COPY.keyTile}`} disabled={busy || Boolean(agentFlow)}
          onPress={() => { setFailure(""); setPick("key"); setApiKey(""); setAcctLabel(""); }}
          style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 14, borderWidth: pick === "key" ? 2 : 0.5, borderColor: pick === "key" ? color.primary : color["edge-strong"], backgroundColor: color["surface-2"] }}>
          <Icon name="key" size={24} tone="text" />
          <Text>{ACCOUNTS_COPY.keyTile}</Text>
        </Pressable>
        {pick === "key" ? (() => {
          const seen = keyKindOf(apiKey);
          const name = acctLabel || (seen ? defaultLabel(seen.label, taken) : "");
          const prob = labelProblem(name, taken);
          return (
            <View style={{ gap: 12 }}>
              <Field label={ACCOUNTS_COPY.keyLabel} kind="password" value={apiKey} onChangeText={setApiKey} help={seen ? `Looks like ${seen.label.replace(" key", "")}.` : ACCOUNTS_COPY.keyHelp} error={apiKey.trim() && !seen ? ACCOUNTS_COPY.keyUnknown : undefined} />
              <Field label={ACCOUNTS_COPY.nameLabel} value={name} onChangeText={setAcctLabel} error={name && prob ? prob : undefined} />
              <Button kind="secondary" size="lg" label={ACCOUNTS_COPY.add} loading={busy} disabled={!seen || !keyShapeOk(apiKey) || Boolean(prob) || busy} onPress={() => void run(async () => {
                if (!seen) return;
                const r = await addAgentKey({ kind: seen.kind, key: apiKey.trim(), label: name.trim(), ...(seen.base_url ? { base_url: seen.base_url } : {}) });
                setApiKey("");
                if (!r.ok) { setFailure(r.message); return; }
                setAccounts((x) => [...x, { provider: seen.provider, label: name.trim() }]);
                setPick(""); setAcctLabel("");
              })} />
            </View>
          );
        })() : null}
        {pick && pick !== "key" ? (
          <View style={{ gap: 12 }}>
            <Field label={ACCOUNTS_COPY.nameLabel} value={acctLabel} onChangeText={setAcctLabel} error={acctLabel && problem ? problem : undefined} disabled={Boolean(agentFlow)} />
            {agentUrl ? <CodeBlock code={agentCode ? `${agentUrl}\n\n${agentCode}` : agentUrl} lang="txt" /> : null}
            {agentFlow ? <Text tone="muted">{ACCOUNTS_COPY.signing}</Text> : null}
            <Button kind="secondary" size="lg" label={agentFlow ? ACCOUNTS_COPY.check : ACCOUNTS_COPY.add} loading={busy} disabled={Boolean(problem) || busy} onPress={() => void run(async () => {
              const r = await signInAgent({ provider: pick, label: acctLabel.trim(), ...(agentFlow ? { flow: agentFlow } : {}), ...(agentCode ? { code: agentCode } : {}) });
              if (!r.ok) { setFailure(r.message); return; }
              if (r.flow && r.step !== "done") {
                setAgentFlow(String(r.flow));
                if (typeof r.url === "string" && r.url && typeof window !== "undefined") window.open(r.url, `vyre-ai-${pick}`, "width=520,height=720");
                if (typeof r.url === "string") setAgentUrl(r.url);
                if (typeof r.code === "string") setAgentCode(r.code);
                return;
              }
              setAccounts((x) => [...x, { provider: pick, label: acctLabel.trim() }]);
              setPick(""); setAcctLabel(""); setAgentFlow(""); setAgentCode(""); setAgentUrl("");
            })} />
          </View>
        ) : null}
        {accounts.length ? (
          <View style={{ gap: 6 }} accessibilityLabel="Your AI accounts">
            {accounts.map((x) => (
              <View key={x.label} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <ProviderBadge provider={x.provider} size={20} />
                <Text>{`${x.label} is signed in`}</Text>
              </View>
            ))}
          </View>
        ) : null}
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
          if (r.joined && noDaemon) { setAiThen("ready"); go("id.ai"); } else go(r.joined ? "ready" : "join.link");
          if (!r.joined) setFailure(r.message || "The space has not confirmed this invite yet.");
        }) }}>
        <Text strong>{review.space || "A space"}</Text>
        <Text tone="muted">{`Role: ${review.role}`}</Text>
      </FlowStep>
    );
  }

  if (screen === "create.kind") {
    const wanted = usernameOf(space);
    return (
      <FlowStep steps={steps} onBack={back} title="Connect your server." lead="Name your space, say what the server runs, then paste the line into it. This screen waits until it is online." failure={failure}
        primary={{ label: "Continue", disabled: !command || !waitId || busy, loading: busy, onPress: () => go("create.wait") }}>
        <Field label="Space name" name="Space name" value={space} onChangeText={(v) => { setSpace(v); setFailure(""); }} help={wanted ? `Its address will be ${wanted}.vyre.run` : SPACE_NAME_SAY.required} />
        <Segmented label="Your server runs" fill value={kind || "linux"} onChange={(v) => setKind(v as "linux" | "mac")} options={[["linux", "Linux"], ["mac", "macOS"]]} />
        {wanted && command ? <CodeBlock code={command} lang="sh" /> : wanted ? <Text tone="muted">Making the command...</Text> : null}
      </FlowStep>
    );
  }

  if (screen === "create.wait") {
    return (
      <FlowStep steps={steps} onBack={back} mark={online ? "done" : "working"} title={online ? "Your space is online" : "Waiting for it to come online"}
        lead={online ? "Your server is paired and your space has its address." : "Run this one line there. Nothing else. This screen updates when it is up."}
        failure={failure}
        secondary={back ? { label: "Cancel", onPress: back } : undefined}
        primary={{ label: online ? "Continue" : "Waiting", disabled: !online, onPress: () => { if (noDaemon) { setAiThen("setup.assistant"); go("id.ai"); } else go("setup.assistant"); } }}>
        {taken ? (
          <>
            <Field label="Space name" name="Space name" value={space} onChangeText={setSpace} help={suggest ? `${suggest} is free.` : undefined} />
            <Button label="Use this name" onPress={() => void run(async () => {
              const wanted = usernameOf(space);
              if (!wanted) { setFailure(SPACE_NAME_SAY.required); return; }
              if (!MOCK && (await checkName(wanted)) === "taken") { setFailure(SPACE_NAME_SAY.taken(suggest)); return; }
              const r = await renameSpace(waitId, wanted);
              if (!r.ok) { setFailure(r.message); return; }
              setTaken(false); setFailure("");
            })} />
          </>
        ) : null}
        {online && noFingerprint ? <Text tone="muted">Approvals that need your fingerprint are not available on this Mac yet.</Text> : null}
        {online && paired ? (
          <>
            <Text strong>{paired.name}</Text>
            {paired.address ? <Text tone="muted">{paired.address}</Text> : null}
            <Button kind="ghost" label="Not your server? Remove it" onPress={() => void run(async () => {
              const r = await removeSpace(paired.id);
              if (!r.ok) { setFailure(r.message || "That server could not be removed. Try again."); return; }
              setOnline(false); setPaired(null); setCommand(""); back?.();
            })} />
          </>
        ) : null}
        {command && !online ? <CodeBlock code={command} lang="sh" /> : null}
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

  if (screen === "setup.assistant") {
    const name = asName.trim() || ASSISTANT_COPY.suggestion;
    // the character a look names: shape and colour from the picker, the parts from a hash of the name until a tap changes one (every part is always written, so a tap keeps the rest)
    const seed = asLook.seed || lookSeed(asLook.shape, asLook.color);
    const full = withParts(seed, name.toLowerCase());
    const parts = partsOf(full);
    return (
      <FlowStep steps={steps} onBack={back} title={ASSISTANT_COPY.title} lead={ASSISTANT_COPY.lead} failure={failure}
        primary={{ label: busy ? "Saving..." : "Continue", disabled: busy || asName.length > 40, loading: busy, onPress: () => void run(async () => {
          const r = await setAssistant({ name, look: full, person: displayNameOf(first, last) });
          if (!r.ok) { setFailure(r.message); return; }
          setAsName(String(r.display || name));
          go("setup.model");
        }) }}>
        <View style={{ alignItems: "center" }}><Avatar of={markRef("agent", name, undefined, full)} size={56} /></View>
        <Field label={ASSISTANT_COPY.nameLabel} value={asName} onChangeText={setAsName} placeholder={ASSISTANT_COPY.suggestion} error={asName.length > 40 ? ASSISTANT_COPY.tooLong : undefined} />
        <AgentLookPicker shape={asLook.shape} color={asLook.color} parts={parts}
          onChange={(p) => setAsLook((x) => { const n = { ...x, ...p }; return { ...n, seed: lookSeed(n.shape, n.color) + PARTS.map((q) => `~${q.key}${parts[q.key]}`).join("") }; })}
          onPart={(key, value) => setAsLook((x) => ({ ...x, seed: setPart(full, name.toLowerCase(), key, value) }))} />
      </FlowStep>
    );
  }

  if (screen === "setup.model") {
    const who = asName.trim() || ASSISTANT_COPY.suggestion;
    const picked = (models || []).flatMap((a) => a.models.map((m) => ({ key: `${a.id}:${m.id}`, model: m.id })));
    const chosen = picked.find((p) => p.key === modelPick);
    return (
      <FlowStep steps={steps} onBack={back} title={MODEL_COPY.title(who)} lead={models && !models.length ? MODEL_COPY.none : MODEL_COPY.lead} failure={failure}
        secondary={{ label: "Keep the default", onPress: () => go("ready") }}
        primary={{ label: "Continue", loading: busy, disabled: busy || (models !== null && models.length > 0 && !chosen), onPress: () => void run(async () => {
          if (chosen) { const r = await setAssistantModel(chosen.model); if (!r.ok) { setFailure(r.message); return; } }
          go("ready");
        }) }}>
        {models === null ? <Text tone="muted">Looking at your AI accounts...</Text> : null}
        {(models || []).map((a) => (
          <View key={a.id} style={{ gap: 6 }} accessibilityLabel={a.label}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><ProviderBadge provider={a.provider} size={20} /><Text tone="label">{a.label}</Text></View>
            {a.models.map((m) => {
              const k = `${a.id}:${m.id}`;
              return (
                <Pressable key={k} accessibilityRole="radio" accessibilityLabel={`${a.label}, ${m.label}`} accessibilityState={{ selected: modelPick === k }} onPress={() => setModelPick(k)}
                  style={{ padding: 12, borderRadius: 12, borderWidth: modelPick === k ? 2 : 0.5, borderColor: modelPick === k ? color.primary : color["edge-strong"], backgroundColor: color["surface-2"] }}>
                  <Text>{m.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </FlowStep>
    );
  }

  const showing = spaces.find((s) => s.id === current) || spaces[0];
  return (
    <FlowStep steps={steps} hero mark="done" title="You're all set."
      lead={spaces.length > 1 ? "One identity, in every space below. Each space has its own server." : space ? `${space} is ready. You can join or create another with this identity.` : "Your identity is ready."}
      primary={{ label: "Open now", loading: busy, onPress: () => void run(async () => {
        const r = await finishFirstRun();
        if (!r.ok) { setFailure(r.message); return; }
        router.replace("/u/now" as never);
      }) }}
      secondary={{ label: "Invite someone", onPress: () => { setHoldOpen(true); go("invite.share"); } }}>
      {spaces.length > 1 ? (
        <SpaceSwitcherTitle spaces={spaces.map((s) => ({ id: s.id, name: s.name }))} space={showing?.id || spaces[0].id} onSpace={(id) => void run(async () => {
          setHoldOpen(true);
          const r = await chooseSpace(id);
          if (!r.ok) { setFailure(r.message); return; }
          setCurrent(String(r.current || id));
          if (r.name) setSpace(String(r.name));
        })} />
      ) : null}
      {spaces.map((s) => <Text key={s.id}>{`${s.name}, ${s.role}`}</Text>)}
      <Text tone="muted">{`On your phone or another computer, open Vyre and sign in with ${showing?.server ? String(showing.server).replace(/^https?:\/\//, "") : "your space address"}, your username and your password.`}</Text>
      <ChoiceList label="Also" onChange={(v) => { if (v === "join.link") { setPaste(""); setReview(null); } go(v); }} options={[
        { value: "join.link", title: "Join another space", sub: "Use another invite. Your identity stays the same.", icon: "link" },
        { value: "create.kind", title: "Create another space", sub: "A Linux server or an always-on Mac.", icon: "server" },
      ]} />
    </FlowStep>
  );
}

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}
