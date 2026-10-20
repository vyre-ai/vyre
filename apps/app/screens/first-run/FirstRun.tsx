import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  Button, ChoiceHero, ChoiceList, CodeBlock, Field, FlowStep, InviteShare, PasswordField, ProviderSignInButton,
  Avatar, FlowOver, Icon, ModelPicker, ProviderBadge, RecoveryKeySheet, RolePicker, Segmented, SpaceSwitcherTitle, Text, markRef, passwordStrength, useUiTheme,
} from "@vyre/ui";
import { ANOTHER_COPY, AI_SIGNIN_COPY, INVITE_ROLES, JOIN_COPY, PHASES, SIGNIN_COPY, SPACE_NAME_SAY, afterAi, afterRecovery, commandOk, entryScreen, displayNameOf, isAnother, passwordOk, phaseOf, spaceAddressOf, spaceNameSuggestions, usernameOf } from "../../../../lib/first-run-shape.js";
import { MOCK } from "../../src/real/box";
import { checkName } from "../../src/real/install";
import { takeJoin } from "../../src/shell/join-hold.js";
import { HalftoneField, measureCalm } from "./HalftoneField";
import { ripple, setWelcome } from "./field-state.js";
import { Welcome } from "./Welcome";
import { AgentLookPicker } from "../../ui/chat/NewAgentDialog";
import { PARTS, lookOf, lookSeed, partsOf, setPart, withParts } from "../../ui/chat/agent-look.js";
import { ASK_COPY, askAddressOf, entryWords, nextForAsk } from "../spaces/join-requests-model.js";
import { ACCOUNTS_COPY, copyWords, defaultLabel, keyKindOf, keyShapeOk, labelProblem, NO_SIGNIN, pasteOk, signinInput, signinMode } from "./ai-accounts-model.js";
import { ASSISTANT_COPY, MODEL_COPY, NAME_COPY, lastSpace, modelStep, pickedModel, rememberSpace, welcomeGroups } from "./welcome-model.js";
import { useSpaces } from "../shell/state";
import { effortFor } from "../../src/models/model-choice.js";
import { clearAfter, readAfter, returnWaiting, saveAfter } from "../../src/identity/github-return.js";
import { linkGithub, signInWithGithub, type GithubSession } from "../../src/real/github";
import type { GithubUser } from "../../src/real/github-types";
import { nameFromLogin, SHOT_TABLE } from "./mock.js";
import { openExternal } from "../../src/shell/open-external";
import {
  chooseSpace, createPerson, finishFirstRun, joinSpace, listAgentProviders, listSpaces,
  loadProgress, makeInvite, openSpace, pageHasNoDaemon, addAgentKey, askJoin, askJoinStatus, copyAccounts, currentAssistant, listCopyable, listAssistantModels, removeSpace, renameSpace, setAssistant, setAssistantModel, personStatus, pollSpace, readInvite, saveProgress, signInAgent, signInGithub, signInPassword, unlockGithub,
} from "./real.js";

export type Screen = "id.choice" | "id.signin" | "id.signin.spaces" | "id.create" | "id.name" | "id.password" | "id.recovery" | "id.ai" | "space.choice" | "join.link" | "join.review" | "create.kind" | "create.wait" | "join.ask" | "setup.assistant" | "setup.model" | "invite.share" | "ready";

type Review = { link: string; role: string; space: string | null };
type Membership = { id: string; name: string; role: string; server: string | null };

const shotOf = (key: string) => (MOCK ? (SHOT_TABLE as Record<string, any>)[key] as ({ screen: Screen; username?: string; recovery?: string; link?: string; command?: string; space?: string; [k: string]: any } | undefined) : undefined);

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
  const shot = shotOf(one(params.shot) || "");   // declared before it is read: `path` below reads it, and a const read first is a ReferenceError the moment this screen renders
  const path = one(params.path) || (shot?.another ? "create" : undefined);
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
  // Continue with GitHub on the new-person flow: who GitHub says this is, held until the identity exists, then linked through the relay (the same path as Settings > Account).
  const [github, setGithub] = useState<{ session: GithubSession | null; user: GithubUser } | null>(null);
  const [space, setSpace] = useState(shot?.space || "");
  const [suggest, setSuggest] = useState("");
  const [taken, setTaken] = useState(false);
  const [spaces, setSpaces] = useState<Membership[]>([]);
  const [current, setCurrent] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [asName, setAsName] = useState<string>(shot?.asName || "");
  const [models, setModels] = useState<{ id: string; label: string; provider: string; kind?: string; models: unknown[] }[] | null>(shot?.models || null);
  const [modelPick, setModelPick] = useState<{ account: string; provider: string; model: string; effort: string } | null>(null);
  const [holdOpen, setHoldOpen] = useState(false);
  const [askAddr, setAskAddr] = useState<string>(shot?.askAddr || "");
  const [askNote, setAskNote] = useState("");
  const [askSaid, setAskSaid] = useState("");
  const [askWords, setAskWords] = useState<string>(shot?.askWords || "");
  const [asDone, setAsDone] = useState<boolean>(Boolean(shot?.asDone));
  const [copyable, setCopyable] = useState<{ from: string; accounts: { id: string; label: string; provider: string; copy: boolean; why?: string }[] } | null>(shot?.copyable || null);
  const [copyPick, setCopyPick] = useState<string[]>(shot?.copyPick || []);
  const [copyDone, setCopyDone] = useState<{ id: string; label: string; ok: boolean; why?: string }[] | null>(shot?.copyDone || null);
  const [carried, setCarried] = useState<{ name: string; look: string } | null>(shot?.carried || null);
  const [changing, setChanging] = useState(false);
  const [asLookSeed, setAsLookSeed] = useState("");
  const [signedIn, setSignedIn] = useState<boolean>(Boolean(shot?.another));
  const [first, setFirst] = useState(shot?.first || "");
  const [last, setLast] = useState(shot?.last || "");
  const [asLook, setAsLook] = useState({ shape: 0, color: 0, seed: "" });
  const [expiresAt, setExpiresAt] = useState("");
  const [agents, setAgents] = useState<{ id: string; label: string }[]>([]);
  const [agentFlow, setAgentFlow] = useState("");
  const [agentCode, setAgentCode] = useState("");
  const [agentUrl, setAgentUrl] = useState("");
  const [agentStep, setAgentStep] = useState("");
  const [agentPaste, setAgentPaste] = useState(false);
  const [pasted, setPasted] = useState("");
  const [accounts, setAccounts] = useState<{ provider: string; label: string; item?: string }[]>([]);
  const [pick, setPick] = useState("");
  const [acctLabel, setAcctLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyPassword, setKeyPassword] = useState("");
  const [needPw, setNeedPw] = useState(false);
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
  // Opened from the app's Space menu (already signed in), the first step has a way out too: Cancel goes back to the app, and Escape does the same on every step.
  const fromApp = isAnother(path, signedIn);
  const leave = () => { if (router.canGoBack()) router.back(); else router.replace("/u/now" as never); };
  const back = stack.length > 1 ? () => { setFailure(""); setStack((s) => s.slice(0, -1)); } : fromApp ? leave : undefined;
  const backLabel = stack.length === 1 && fromApp ? "Cancel" : "Back";
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
      setSignedIn(true);
      // already signed in and adding a Space: no identity, no recovery key and no AI step before the Space (a server is what the AI signs in on, and this one is new): straight to the make or join screen
      setStack((s) => (s[s.length - 1] === "id.create" ? [afterRecovery({ path, skipAi: noDaemon || isAnother(path, true) })] : s));
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

  // Waiting to be let in: ask the home where the ask stands every few seconds. Approved brings the link to join by, and the join is the ordinary invite review; anything else is said in the home's own fixed words.
  useEffect(() => {
    if (shot || screen !== "join.ask" || !askAddr) return;
    let live = true;
    const tick = () => void askJoinStatus({ address: askAddr }).then((r) => {
      if (!live) return;
      if (!r.ok) return;
      const next = nextForAsk(r);
      if (next.kind === "join") {
        void readInvite(String(next.link || "")).then((v) => {
          if (!live) return;
          if (!v.ok) { setAskSaid(v.message); return; }
          setReview({ link: v.link || next.link, role: v.role || "member", space: v.space });
          setStack((s) => [...s.slice(0, -1), "join.review"]);
        });
      } else if (next.kind === "said") setAskSaid(String(next.words || ""));
    });
    tick();
    const t = setInterval(tick, 5000);
    return () => { live = false; clearInterval(t); };
  }, [shot, screen, askAddr]);

  // Adding another Space: the AI accounts of the Space already there, offered for copying (the sheet below says the count of confirmations first)
  useEffect(() => {
    if (shot || screen !== "id.ai" || !isAnother(path, signedIn) || copyable) return;
    let live = true;
    void listCopyable().then((r) => {
      if (!live || !r.ok) return;
      const list = Array.isArray(r.accounts) ? r.accounts : [];
      setCopyable({ from: String(r.from || "your other Space"), accounts: list });
    });
    return () => { live = false; };
  }, [shot, screen, path, signedIn, copyable]);

  // Adding another Space: the Assistant of the Space already there comes along (its name and look), kept with one press or changed
  useEffect(() => {
    if (shot || screen !== "setup.assistant" || !isAnother(path, signedIn) || carried) return;
    let live = true;
    void currentAssistant().then((r) => {
      if (!live || !r.ok || !r.assistant || !r.assistant.name) return;
      setCarried({ name: String(r.assistant.name), look: String(r.assistant.look || "") });
    });
    return () => { live = false; };
  }, [shot, screen, path, signedIn, carried]);

  useEffect(() => {
    if (shot || screen !== "setup.model") return;
    let live = true;
    void listAssistantModels().then((r) => {
      if (!live) return;
      if (!r.ok) { setModels([]); return; }
      const list = Array.isArray(r.accounts) ? r.accounts : [];
      setModels(list);
      const first = welcomeGroups(list).find((g) => g.models.length);
      if (first) setModelPick((cur) => cur || { account: first.account.id, provider: first.models[0].provider, model: first.models[0].id, effort: effortFor(first.models[0], null) });
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

  // Sign in with GitHub. In a browser the tab goes to GitHub and comes back to this page (src/identity/github-return.js), so the space typed on the sign-in screen is kept for the
  // way back; while the tab leaves, the answer is "redirect" and nothing is shown as a failure.
  const page = () => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
  const githubSignIn = (typed?: string) => run(async () => {
    clearAfter(page());
    if (typed) rememberSpace(page(), typed);
    const r = await signInGithub(typed);
    if (!r.ok) { if (r.code !== "redirect") setFailure(r.message); return; }
    const list = Array.isArray(r.spaces) ? r.spaces : [];
    if (!list.length) { setFailure(SIGNIN_COPY.none); return; }
    setFound(list.map((x: any) => ({ id: x.id, name: String(x.name), role: String(x.role || "member") })));
    setPassword("");
    go("id.signin.spaces");
  });

  // Continue with GitHub while making a new identity: the same relay sign-in as above (a same-tab redirect in a browser, the person's browser and a claim in the Mac app), never a
  // popup and never a callback other than the relay's. The names typed so far are kept for the way back (never the password); the link itself is made once the identity exists.
  const continueWithGithub = async (suggestName: boolean) => {
    saveAfter(page(), { kind: "create", first, last, username });
    const r = await signInWithGithub({ signin: false });
    if (!r.ok) {
      if ((r as { code?: string }).code !== "redirect") { clearAfter(page()); setFailure(r.say); }
      return;
    }
    clearAfter(page());
    if (r.user.linkedName) { setFailure(`This GitHub account already belongs to ${r.user.linkedName}. Go back and sign in with it instead.`); return; }
    if (suggestName) {
      const suggested = nameFromLogin(r.user.login);
      if (suggested && !username) setUsername(suggested);
    }
    setGithub({ session: r.session, user: r.user });
  };

  // Back from GitHub: what this tab started carries on by itself, once. Sign in goes on to the spaces it found; the new-person flow comes back to its password step with the names kept.
  const githubResumed = useRef(false);
  useEffect(() => {
    if (shot || MOCK || githubResumed.current || (screen !== "id.choice" && screen !== "id.signin")) return;
    if (!returnWaiting(page(), Date.now())) return;
    githubResumed.current = true;
    const after = readAfter(page());
    if (after && after.kind === "create") {
      setFirst(after.first); setLast(after.last); setUsername(after.username);
      setStack(["id.choice", "id.name", "id.create", "id.password"]);
      void run(() => continueWithGithub(!after.username));
      return;
    }
    void githubSignIn(lastSpace(page()) || undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot, screen]);

  const strength = passwordStrength(password);
  const nameOk = Boolean(usernameOf(username));
  const passOk = strength.score >= 3 && passwordOk(password) && password === confirm;

  if (screen === "id.choice") {
    return (
      <Welcome phone={phone} failure={failure}
        onSignIn={(sp) => { setSignSpace(`${sp}.vyre.run`); setFailure(""); go("id.signin"); }}
        onStart={() => { setFailure(""); go("id.name"); }}
        onGithub={() => void githubSignIn(undefined)} />
    );
  }

  if (screen === "id.name") {
    const person = displayNameOf(first, last);
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={NAME_COPY.title} lead={NAME_COPY.lead}
        primary={{ label: "Continue", disabled: !person, onPress: () => go("id.create") }}>
        <Field label={NAME_COPY.first} value={first} onChangeText={setFirst} />
        <Field label={NAME_COPY.last} value={last} onChangeText={setLast} error={(first || last) && !person ? NAME_COPY.bad : undefined} />
      </FlowStep>
    );
  }

  if (screen === "id.signin") {
    const addr = spaceAddressOf(signSpace);
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={SIGNIN_COPY.title} lead={SIGNIN_COPY.lead} failure={failure}
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
        <ProviderSignInButton disabled={busy} onPress={() => void githubSignIn(addr ? addr.space : undefined)} />
      </FlowStep>
    );
  }

  if (screen === "id.signin.spaces") {
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={SIGNIN_COPY.spacesTitle} lead={SIGNIN_COPY.spacesLead} failure={failure}
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
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title="Pick a username." lead="It's how people find and add you, in any Space."
        failure={failure} primary={{ label: "Continue", disabled: !nameOk, onPress: () => go("id.password") }}>
        <Field label="Username" value={username} onChangeText={setUsername} help={username && !nameOk ? "Use 3 to 20 lowercase letters, digits or hyphens." : usernameOf(username) ? `Your page is vyre.run/u/${usernameOf(username)}` : "This becomes vyre.run/u/your-name"} />
      </FlowStep>
    );
  }

  if (screen === "id.password") {
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title="Make your password." lead="It locks your account and your vault. Nobody can reset it for you, not even us, so pick one you'll remember."
        failure={failure} primary={{ label: busy ? "Creating..." : "Create", disabled: !nameOk || !passOk || busy, loading: busy, onPress: () => void run(async () => {
          const r = await createPerson({ username, password, confirm, display: displayNameOf(first, last) });
          if (!r.ok) { setFailure(r.message); return; }
          if (r.already) { setUsername(r.username || usernameOf(username)); go(afterRecovery({ path, heldInvite: review?.link, skipAi: noDaemon })); return; }
          setRecovery(typeof r.recoveryKey === "string" ? r.recoveryKey : "");
          setUsername(r.username || usernameOf(username));
          go("id.recovery");
          if (github) {
            const l = await linkGithub(github.session, github.user);
            setGithub(null);
            if (!l.ok) setFailure(`GitHub is not linked yet: ${l.say} You can link it later in Settings, Account.`);
          }
        }) }}>
        <PasswordField label="Password" meter value={password} onChangeText={setPassword} />
        <PasswordField label="Confirm password" value={confirm} onChangeText={setConfirm} error={confirm && confirm !== password ? "Type the same password again." : undefined} />
        <ProviderSignInButton disabled={busy} onPress={() => void run(() => continueWithGithub(true))} />
      </FlowStep>
    );
  }

  if (screen === "id.recovery") {
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title="Save your recovery key" lead="One key for your identity and your vault. It is shown once."
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
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={ACCOUNTS_COPY.title} lead={ACCOUNTS_COPY.lead} failure={failure} enterSubmits={false}
        secondary={{ label: AI_SIGNIN_COPY.skip, onPress: onward }}
        primary={{ label: "Continue", loading: busy, onPress: () => {
          // Nothing added is not "connected": the person goes on only by choosing to skip, never by a Continue that did nothing.
          if (!accounts.length) { setFailure(ACCOUNTS_COPY.empty); return; }
          onward();
        } }}>
        {isAnother(path, signedIn) && copyable && copyable.accounts.length ? (() => {
          const w = copyWords({ from: copyable.from, to: space || "this Space", count: copyPick.length });
          return (
            <View style={{ gap: 8, padding: 14, borderRadius: 16, backgroundColor: color["surface-2"] }} accessibilityLabel="Copy your AI accounts">
              <Text strong>{w.title}</Text>
              <Text tone="muted">{w.lead}</Text>
              {copyable.accounts.map((a) => {
                const on = copyPick.includes(a.id), done1 = copyDone?.find((x) => x.id === a.id);
                return (
                  <Pressable key={a.id} accessibilityRole="checkbox" accessibilityLabel={a.label} accessibilityState={{ checked: on, disabled: !a.copy }} disabled={!a.copy || Boolean(copyDone)}
                    onPress={() => setCopyPick((p) => (p.includes(a.id) ? p.filter((x) => x !== a.id) : [...p, a.id]))} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, opacity: a.copy ? 1 : 0.6 }}>
                    <ProviderBadge provider={a.provider} size={20} />
                    <Text>{a.label}</Text>
                    <Text tone="muted" size="caption">{done1 ? (done1.ok ? "Copied" : done1.why || "Not copied") : !a.copy ? (a.why || w.again) : on ? "Selected" : ""}</Text>
                  </Pressable>
                );
              })}
              {copyPick.length && !copyDone ? <Text tone="muted" size="caption">{w.confirm}</Text> : null}
              {!copyDone ? <Button kind="secondary" size="lg" label={w.button(copyPick.length)} loading={busy} disabled={!copyPick.length || busy} onPress={() => void run(async () => {
                const r = await copyAccounts({ ids: copyPick, ...(keyPassword ? { password: keyPassword } : {}) });
                setKeyPassword("");
                if (!r.ok && r.code === "need_password") { setNeedPw(true); setFailure(""); return; }
                if (!r.ok) { setFailure(r.message); return; }
                const list = Array.isArray(r.copied) ? r.copied : [];
                setCopyDone(list);
                setAccounts((x) => [...x, ...list.filter((c: { ok: boolean }) => c.ok).map((c: { label: string }) => ({ provider: "", label: c.label }))]);
              })} /> : null}
              {needPw && !copyDone ? <PasswordField label={ACCOUNTS_COPY.keyPassword} value={keyPassword} onChangeText={setKeyPassword} /> : null}
            </View>
          );
        })() : null}
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
          onPress={() => { setFailure(""); setPick("key"); setApiKey(""); setKeyPassword(""); setNeedPw(false); setAcctLabel(""); }}
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
              <Field label={ACCOUNTS_COPY.keyLabel} kind="password" value={apiKey} onChangeText={setApiKey} help={seen ? (seen.kind === "opencode" ? "Sign in to the OpenCode Console, add billing, and copy the API key." : `Looks like ${seen.label.replace(" key", "")}.`) : ACCOUNTS_COPY.keyHelp} error={apiKey.trim() && !seen ? ACCOUNTS_COPY.keyUnknown : undefined} />
              <Field label={ACCOUNTS_COPY.nameLabel} value={name} onChangeText={setAcctLabel} error={name && prob ? prob : undefined} />
              {needPw ? <PasswordField label={ACCOUNTS_COPY.keyPassword} value={keyPassword} onChangeText={setKeyPassword} /> : null}
              <Button kind="secondary" size="lg" label={ACCOUNTS_COPY.add} loading={busy} disabled={!seen || !keyShapeOk(apiKey) || Boolean(prob) || busy || (needPw && !keyPassword)} onPress={() => void run(async () => {
                if (!seen) return;
                const r = await addAgentKey({ kind: seen.kind, key: apiKey.trim(), label: name.trim(), ...(seen.base_url ? { base_url: seen.base_url } : {}), ...(needPw && keyPassword ? { password: keyPassword } : {}) });
                setKeyPassword("");
                if (!r.ok && r.code === "need_password") { setNeedPw(true); setFailure(""); return; }
                setApiKey("");
                if (!r.ok) { setFailure(r.message); return; }
                setAccounts((x) => [...x, { provider: seen.provider, label: name.trim(), ...(typeof r.item === "string" && r.item ? { item: r.item } : {}) }]);
                setPick(""); setAcctLabel(""); setNeedPw(false);
              })} />
            </View>
          );
        })() : null}
        {pick && pick !== "key" ? (
          <View style={{ gap: 12 }}>
            <Field label={ACCOUNTS_COPY.nameLabel} value={acctLabel} onChangeText={setAcctLabel} error={acctLabel && problem ? problem : undefined} disabled={Boolean(agentFlow)} />
            {agentUrl ? <CodeBlock code={agentCode ? `${agentUrl}\n\n${agentCode}` : agentUrl} lang="txt" /> : null}
            {signinMode(agentFlow, agentStep, agentPaste) === "paste" ? (
              <Field label={ACCOUNTS_COPY.pasteLabel} value={pasted} onChangeText={setPasted} help={ACCOUNTS_COPY.pasteHelp} />
            ) : agentFlow ? <Text tone="muted">{ACCOUNTS_COPY.signing}</Text> : null}
            <Button kind="secondary" size="lg" label={signinMode(agentFlow, agentStep, agentPaste) === "paste" ? ACCOUNTS_COPY.paste : agentFlow ? ACCOUNTS_COPY.check : ACCOUNTS_COPY.add} loading={busy}
              disabled={Boolean(problem) || busy || (signinMode(agentFlow, agentStep, agentPaste) === "paste" && !pasteOk(pasted))} onPress={() => void run(async () => {
              const r = await signInAgent(signinInput({ provider: pick, label: acctLabel, flow: agentFlow, step: agentStep, pasted, paste: agentPaste }));
              if (!r.ok) { setFailure(r.message); return; }
              if (r.flow && r.step !== "done") {
                setAgentFlow(String(r.flow));
                setAgentStep(typeof r.step === "string" ? r.step : "");
                setAgentPaste(r.paste === true);
                if (!agentFlow && typeof r.url === "string" && r.url) void openExternal(r.url, { name: `vyre-ai-${pick}`, features: "width=520,height=720" }).then((o) => { if (!o.opened) setFailure("The sign-in window did not open. Copy the link below and open it in your browser."); });
                if (typeof r.url === "string") setAgentUrl(r.url);
                if (typeof r.code === "string") setAgentCode(r.code);
                setPasted("");
                return;
              }
              setAccounts((x) => [...x, { provider: pick, label: acctLabel.trim() }]);
              setPick(""); setAcctLabel(""); setAgentFlow(""); setAgentCode(""); setAgentUrl(""); setAgentStep(""); setAgentPaste(false); setPasted("");
            })} />
            {agentFlow ? <Button kind="ghost" size="lg" label={ACCOUNTS_COPY.cancel} disabled={busy} onPress={() => { setAgentFlow(NO_SIGNIN.flow); setAgentUrl(NO_SIGNIN.url); setAgentCode(NO_SIGNIN.code); setAgentStep(NO_SIGNIN.step); setAgentPaste(NO_SIGNIN.paste); setPasted(NO_SIGNIN.pasted); setFailure(""); }} /> : null}
          </View>
        ) : null}
        {accounts.length ? (
          <View style={{ gap: 6 }} accessibilityLabel="Your AI accounts">
            {accounts.map((x) => (
              <View key={x.label} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <ProviderBadge provider={x.provider} size={20} />
                <Text>{x.item ? `${x.label} is added. Saved in your Vault as ${x.item}.` : `${x.label} is signed in`}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </FlowStep>
    );
  }

  if (screen === "space.choice") {
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} hero title="Your space" lead="Join one you were invited to, or create one. The same identity can be in more than one.">
        <ChoiceHero title="How do you want to start?" options={[
          { value: "join", title: "Join a space", sub: "Use the invite link you were sent.", icon: "link" },
          { value: "create", title: "Create a space", sub: "Set up a Linux server or an always-on Mac.", icon: "server" },
        ]} onChange={(v) => go(v === "join" ? "join.link" : "create.kind")} />
      </FlowStep>
    );
  }

  if (screen === "join.ask") {
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} mark="working" title={ASK_COPY.waitingTitle} lead={ASK_COPY.waitingLead} failure={askSaid || failure}>
        {askWords ? (<View style={{ gap: 4, alignItems: "center" }} accessibilityLabel="Your check words"><Text size="caption" tone="label">{ASK_COPY.yourWords}</Text><Text strong size="page">{askWords}</Text></View>) : null}
        <Text tone="muted">{`Asking ${askAddr}.vyre.run`}</Text>
      </FlowStep>
    );
  }

  if (screen === "join.link") {
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={isAnother(path, signedIn) ? ANOTHER_COPY.joinTitle : JOIN_COPY.title} lead={isAnother(path, signedIn) ? ANOTHER_COPY.joinLead : JOIN_COPY.lead} failure={failure}
        primary={{ label: "Continue", disabled: paste.trim().length < 3, loading: busy, onPress: () => void run(async () => {
          // a Space's address (not a link) asks to join it: no invite, the Space's owner is asked
          const addr = askAddressOf(paste);
          if (addr) {
            const a = await askJoin({ address: addr, ...(askNote.trim() ? { note: askNote.trim() } : {}) });
            if (!a.ok) { setFailure(a.message); return; }
            const next = nextForAsk(a);
            if (next.kind === "said") { setFailure(String(next.words || "")); return; }
            setAskAddr(addr); setAskSaid("");
            try { const { WORDS } = await import("@vyre/relay-client/words.js"); setAskWords(entryWords(WORDS as unknown as string[], String(a.eid || "")) || ""); } catch { setAskWords(""); }
            go("join.ask");
            return;
          }
          const r = await readInvite(paste.trim());
          if (!r.ok) { setFailure(r.message); return; }
          setReview({ link: r.link || paste.trim(), role: r.role || "member", space: r.space });
          go("join.review");
        }) }}>
        <Field label="Invite link" value={paste} onChangeText={setPaste} placeholder="https://vyre.run/i/…" help={ASK_COPY.addressHelp} />
        {askAddressOf(paste) ? <Field label="A note for the people there (optional)" value={askNote} onChangeText={setAskNote} /> : null}
      </FlowStep>
    );
  }

  if (screen === "join.review" && !review) {
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={JOIN_COPY.title} lead={JOIN_COPY.bad}
        primary={{ label: "Paste a link", onPress: () => go("join.link") }} />
    );
  }

  if (screen === "join.review" && review) {
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={JOIN_COPY.reviewTitle} lead={JOIN_COPY.reviewLead} failure={failure}
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
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={isAnother(path, signedIn) ? ANOTHER_COPY.makeTitle : "Connect your server."} lead={isAnother(path, signedIn) ? ANOTHER_COPY.makeLead : "Name your space, say what the server runs, then paste the line into it. This screen waits until it is online."} failure={failure}
        primary={{ label: "Continue", disabled: !command || !waitId || busy, loading: busy, onPress: () => go("create.wait") }}>
        <Field label="Space name" name="Space name" value={space} onChangeText={(v) => { setSpace(v); setFailure(""); }} help={wanted ? `Its address will be ${wanted}.vyre.run` : SPACE_NAME_SAY.required} />
        <Segmented label="Your server runs" fill value={kind || "linux"} onChange={(v) => setKind(v as "linux" | "mac")} options={[["linux", "Linux"], ["mac", "macOS"]]} />
        {wanted && command ? <CodeBlock code={command} lang="sh" /> : wanted ? <Text tone="muted">Making the command...</Text> : null}
      </FlowStep>
    );
  }

  if (screen === "create.wait") {
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} mark={online ? "done" : "working"} title={online ? "Your space is online" : "Waiting for it to come online"}
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
        {online ? <Text tone="muted">Records keep setting up in the background, so you do not have to wait for them.</Text> : null}
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
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title="Invite someone" lead="They open the link and they are in. You pick the role and how long it lasts." failure={failure}
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
    const name = (carried && !changing ? carried!.name : asName.trim()) || ASSISTANT_COPY.suggestion;
    // the character a look names: shape and colour from the picker, the parts from a hash of the name until a tap changes one (every part is always written, so a tap keeps the rest)
    const seed = asLook.seed || lookSeed(asLook.shape, asLook.color);
    const keep = carried && !changing;
    const full = keep && carried!.look ? carried!.look : withParts(seed, name.toLowerCase());
    const parts = partsOf(full);
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={ASSISTANT_COPY.title} lead={ASSISTANT_COPY.lead} failure={failure}
        primary={{ label: busy ? "Saving..." : keep ? `Keep ${name}` : "Continue", disabled: busy || asName.length > 40, loading: busy, onPress: () => void run(async () => {
          const r = await setAssistant({ name, look: full, person: displayNameOf(first, last) });
          if (!r.ok) { setFailure(r.message); return; }
          setAsName(String(r.display || name));
          setAsLookSeed(full); setAsDone(true);
          go("setup.model");
        }) }}>
        <View style={{ alignItems: "center" }}><Avatar of={markRef("agent", name, undefined, full)} size={56} /></View>
        {keep ? <Button kind="ghost" label="Change its name or look" onPress={() => { setAsName(carried!.name); if (carried!.look) { const lk = lookOf(carried!.look); if (lk) setAsLook({ shape: lk.shape, color: lk.color, seed: carried!.look }); } setChanging(true); }} /> : (<>
        <Field label={ASSISTANT_COPY.nameLabel} value={asName} onChangeText={setAsName} placeholder={ASSISTANT_COPY.suggestion} error={asName.length > 40 ? ASSISTANT_COPY.tooLong : undefined} />
        <AgentLookPicker shape={asLook.shape} color={asLook.color} parts={parts}
          onChange={(p) => setAsLook((x) => { const n = { ...x, ...p }; return { ...n, seed: lookSeed(n.shape, n.color) + PARTS.map((q) => `~${q.key}${parts[q.key]}`).join("") }; })}
          onPart={(key, value) => setAsLook((x) => ({ ...x, seed: setPart(full, name.toLowerCase(), key, value) }))} />
        </>)}
      </FlowStep>
    );
  }

  if (screen === "setup.model") {
    const who = asName.trim() || ASSISTANT_COPY.suggestion;
    // the one model picker: each AI account the person just connected, with the models it can run and their details, and the effort control when the chosen model takes one
    const groups = models === null ? null : welcomeGroups(models);
    const now = groups && modelPick ? pickedModel(groups, modelPick) : null;
    const stepNow = modelStep(models, Boolean(now));
    return (
      <FlowStep steps={steps} onBack={back} backLabel={backLabel} title={MODEL_COPY.title(who)} lead={stepNow.lead} failure={failure}
        secondary={{ label: "Keep the default", onPress: () => go("ready") }}
        primary={{ label: "Continue", loading: busy, disabled: busy || !stepNow.canContinue, onPress: () => void run(async () => {
          if (now && modelPick) { const r = await setAssistantModel(now.model.id, now.model.provider, effortFor(now.model, modelPick.effort)); if (!r.ok) { setFailure(r.message); return; } }
          go("ready");
        }) }}>
        {models === null ? <Text tone="muted">Looking at your AI accounts...</Text> : null}
        {groups && groups.some((g) => g.models.length) ? (
          <ModelPicker label={`${who}'s model`} groups={groups} value={modelPick || {}} effort={modelPick?.effort || null}
            onChange={({ account, model }) => setModelPick({ account: account.id, provider: model.provider, model: model.id, effort: effortFor(model, modelPick?.effort) })}
            onEffort={(effort) => setModelPick((x) => (x ? { ...x, effort } : x))} />
        ) : null}
      </FlowStep>
    );
  }

  // The last screen is what the prototype shows and nothing more: "You're all set." and the Assistant and Engineer waiting in Chats. Adding another Space lives in the Spaces menu.
  return (
    <FlowStep steps={steps} mark="done" title="You're all set."
      lead={asDone ? `${asName.trim() || ASSISTANT_COPY.suggestion} and Engineer are waiting in Chats. Say hi.` : "Your identity is ready."}
      failure={failure}
      primary={{ label: "Open now", loading: busy, onPress: () => void run(async () => {
        const r = await finishFirstRun();
        if (!r.ok) { setFailure(r.message); return; }
        // The Space just made is the one showing when the app opens (its row is kept, with its pairing, by the last step).
        if (path === "create" && paired?.id) useSpaces.getState().setShowing(paired.id);
        router.replace("/u/now" as never);
      }) }}>
      {asDone ? (
        <View style={{ flexDirection: "row", justifyContent: "center", gap: 28 }} accessibilityLabel="Waiting in Chats">
          <View style={{ alignItems: "center", gap: 6 }}><Avatar of={markRef("agent", asName.trim() || ASSISTANT_COPY.suggestion, undefined, asLookSeed)} size={56} /><Text size="caption" tone="muted">{asName.trim() || ASSISTANT_COPY.suggestion}</Text></View>
          <View style={{ alignItems: "center", gap: 6 }}><Avatar of={markRef("agent", "Engineer")} size={56} /><Text size="caption" tone="muted">Engineer</Text></View>
        </View>
      ) : null}
    </FlowStep>
  );
}

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}
