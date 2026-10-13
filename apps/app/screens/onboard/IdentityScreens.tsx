import { useEffect, useRef, useState } from "react";
import { Banner, Button, ChoiceList, CodeDisplay, CodeField, Field, FlowStep, MatchWords, Stack, Switch, Text, showToast } from "@vyre/ui";
import { MOCK } from "../../src/real/box";
import { DEMO, SIGNIN_WORDS, afterGithub, nameFromLogin } from "./flow-model.js";
import { continueWithGithub } from "./real-github";
import { claimNewName, dropKit, holdKit, kitText, nameExists, nameState, readKit, recoverWithKit, requestSignIn, saveKit } from "./real-identity";
import type { ScreenProps } from "./types";

const HINT = "Prototype hint";

export function IdChoice({ set, go, back, steps }: ScreenProps) {
  const [pick, setPick] = useState<"signin" | "new" | "">("");
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  // GitHub fills in the name and picture. A person already linked goes on to the master password; a new one picks a name.
  const github = async () => {
    setBusy(true); setSay("");
    const r = await continueWithGithub({ signin: pick === "signin" });
    setBusy(false);
    if (!r.ok) { setSay(r.say); return; }
    const u = r.user;
    set({ github: u, avatar: u.avatarUrl, name: u.linkedName || nameFromLogin(u.login) });
    go(afterGithub(u));
  };
  return (
    <FlowStep hero mark="intro" steps={steps} onBack={back} title="Sign in to Vyre" lead="Your name is how Vyre knows you on every device." failure={say || undefined}
      secondary={{ label: "Continue with GitHub", loading: busy, disabled: busy, onPress: () => { void github(); } }}
      primary={{ label: "Continue", disabled: !pick, onPress: () => go(pick === "signin" ? "id.signin" : "id.new") }}>
      <ChoiceList label="Sign in or start" value={pick || undefined} onChange={setPick} options={[
        { value: "signin", title: "I already have a name", sub: "Sign in on this device. You approve it from a device you already use.", icon: "person" },
        { value: "new", title: "I am new to Vyre", sub: "Pick a name and save your recovery kit.", icon: "plus" },
      ]} />
    </FlowStep>
  );
}

export function IdSignin({ ctx, set, go, back, steps }: ScreenProps) {
  const [unknown, setUnknown] = useState(false);
  const [say, setSay] = useState("");
  const [busy, setBusy] = useState(false);
  const typed = ctx.name.trim();
  const edit = (v: string) => { set({ name: v }); setUnknown(false); setSay(""); };
  const next = async () => {
    setBusy(true); setSay("");
    const r = await nameExists(ctx.name);
    setBusy(false);
    if (!r.ok) setSay(r.say);
    else if (r.exists) go("id.approve");
    else setUnknown(true);
  };
  const failure = unknown ? `No one has the name ${typed || "you typed"}. Check the spelling, or go back and choose "I am new to Vyre" to reserve it.` : say || undefined;
  return (
    <FlowStep steps={steps} onBack={back} title="Your name" lead="Type the name you chose when you joined Vyre."
      failure={failure}
      primary={{ label: "Continue", disabled: !typed || busy, loading: busy, onPress: () => { void next(); } }}
      secondary={unknown ? { label: "I am new to Vyre", onPress: () => go("id.new") } : undefined}>
      <Field label="Name" value={ctx.name} onChangeText={edit} placeholder="name" help={typed ? `${typed.toLowerCase()}.vyre.run` : undefined} />
      {MOCK ? <Banner tone="plain" icon="info">{`${HINT}: alex, jordan and harper are names that exist.`}</Banner> : null}
    </FlowStep>
  );
}

/** The real sign-in: this device asks by name, the other signed-in device shows three words and the person approves there. No code is typed. */
function IdApproveReal({ ctx, set, go, back, steps }: ScreenProps) {
  const [state, setState] = useState<"waiting" | "failed">("waiting");
  const [words, setWords] = useState<string[]>([]);
  const [say, setSay] = useState("");
  const run = useRef<AbortController | null>(null);
  const start = () => {
    run.current?.abort();
    const ctl = new AbortController();
    run.current = ctl;
    setState("waiting"); setSay(""); setWords([]);
    void requestSignIn({ name: ctx.name, onWords: setWords, signal: ctl.signal }).then((r) => {
      if (ctl.signal.aborted) return;
      if (r.ok) { set({ name: r.name, reset: false }); go("master.enter"); } else { setSay(r.say); setState("failed"); }
    });
  };
  useEffect(() => { start(); return () => run.current?.abort(); }, []);
  return (
    <FlowStep mark={state === "waiting" ? "working" : undefined} steps={steps} onBack={back} title="Approve on your other device" lead="On a device where you are already signed in, Vyre asks Sign in on this device. Check the three words match, then tap Approve."
      failure={state === "failed" ? say : undefined}
      primary={state === "failed" ? { label: "Ask again", onPress: start } : { label: "Waiting for approval", disabled: true, loading: true, onPress: () => {} }}
      secondary={{ label: "Use my recovery kit instead", onPress: () => { run.current?.abort(); go("id.recover"); } }}>
      {words.length ? <MatchWords label="Words on both screens" words={words} note="If the words differ, tap Deny on the other device." /> : null}
    </FlowStep>
  );
}

export function IdApprove(props: ScreenProps) {
  return MOCK ? <IdApproveMock {...props} /> : <IdApproveReal {...props} />;
}

function IdApproveMock({ set, go, back, steps }: ScreenProps) {
  const [state, setState] = useState<"waiting" | "denied">("waiting");
  return (
    <FlowStep mark="working" steps={steps} onBack={back} title="Approve on your other device" lead="On a device where you are already signed in, Vyre asks Sign in on this device. Check the three words match, then tap Approve."
      failure={state === "denied" ? "Your other device did not approve this sign-in. Ask again, or use your recovery kit." : undefined}
      primary={state === "denied" ? { label: "Ask again", onPress: () => setState("waiting") } : { label: "Prototype: approve on the other device", onPress: () => { set({ reset: false }); go("master.enter"); } }}
      secondary={{ label: "Use my recovery kit instead", onPress: () => go("id.recover") }}>
      <MatchWords label="Words on both screens" words={SIGNIN_WORDS} note="If the words differ, tap Deny on the other device." />
      {state === "waiting" ? (
        <Stack gap={2} align="start">
          <Text tone="muted">Waiting for approval.</Text>
          <Banner tone="plain" icon="info">{`${HINT}: use the button below to see a refusal instead.`}</Banner>
          <Button kind="secondary" size="sm" label="Prototype: the other device says no" onPress={() => setState("denied")} />
        </Stack>
      ) : null}
    </FlowStep>
  );
}

export function IdRecover({ ctx, set, go, back, steps }: ScreenProps) {
  const [code, setCode] = useState("");
  const [say, setSay] = useState("");
  const [busy, setBusy] = useState(false);
  const use = async () => {
    setBusy(true); setSay("");
    const r = await recoverWithKit({ name: ctx.name, code });
    setBusy(false);
    if (r.ok) { set({ name: r.name }); go(ctx.reset ? "master.set" : "master.enter"); } else setSay(r.say);
  };
  return (
    <FlowStep steps={steps} onBack={back} title="Use your recovery kit" lead="Type the recovery code from the page you saved. This is for when no other device can approve you."
      failure={say || undefined}
      primary={{ label: "Use recovery code", disabled: !code || busy, loading: busy, onPress: () => { void use(); } }}
      secondary={{ label: "Ask another device instead", onPress: () => { set({ reset: false }); go("id.approve"); } }}>
      <CodeField label="Recovery code" prefix="KIT" groups={[4, 4, 4]} value={code} onChangeText={(v) => { setCode(v); setSay(""); }} help="It is on the first line of your recovery kit." />
      {MOCK ? <Banner tone="plain" icon="info">{`${HINT}: ${DEMO.recoveryCode} works. Anything else shows the refusal.`}</Banner> : null}
    </FlowStep>
  );
}

export function IdNew({ ctx, set, go, back, steps }: ScreenProps) {
  const n = ctx.name.trim().toLowerCase();
  const [s, setS] = useState<Awaited<ReturnType<typeof nameState>>>("empty");
  const [say, setSay] = useState("");
  const [busy, setBusy] = useState(false);
  // Checked as you type: the form at once, the directory a moment after the last key.
  useEffect(() => {
    let live = true;
    setSay("");
    const t = setTimeout(() => { void nameState(ctx.name).then((r) => { if (live) setS(r); }); }, MOCK ? 0 : 400);
    return () => { live = false; clearTimeout(t); };
  }, [ctx.name]);
  const reserve = async () => {
    setBusy(true); setSay("");
    const r = await claimNewName(ctx.name);
    setBusy(false);
    if (!r.ok) { setSay(r.say); return; }
    holdKit(r.name, r.recoveryCode);
    set({ name: r.name });
    go("id.kit");
  };
  return (
    <FlowStep steps={steps} onBack={back} title="Pick your name" lead="You get name.vyre.run. Your key is made on this device and stays here."
      failure={say || undefined}
      primary={{ label: "Reserve this name", disabled: s !== "free" || busy, loading: busy, onPress: () => { void reserve(); } }}>
      <Field label="Name" value={ctx.name} onChangeText={(v) => set({ name: v })} placeholder="name"
        error={s === "taken" ? `${n} is taken. Try ${n}2, or add your surname.` : s === "invalid" ? "Use 3 to 20 letters, numbers or hyphens, starting with a letter." : s === "unknown" ? "Vyre could not check this name right now. Wait a moment and keep typing, or try again." : undefined}
        help={s === "free" ? `${n}.vyre.run is free.` : s === "empty" ? "Checked as you type." : undefined} />
      {MOCK ? <Banner tone="plain" icon="info">{`${HINT}: alex, jordan, harper, admin and vyre are taken.`}</Banner> : null}
    </FlowStep>
  );
}

export function IdKit({ go, back, steps }: ScreenProps) {
  const [saved, setSaved] = useState(false);
  const kit = readKit();
  const keep = (how: "file" | "print") => {
    if (MOCK) { showToast(how === "file" ? "Saved vyre-recovery-kit.txt. This is a prototype: nothing was written." : "Printing opens here. This is a prototype."); return; }
    if (!kit) return;
    void saveKit(kitText(kit.name, kit.code), how).then((ok) => showToast(ok ? (how === "file" ? "Saved vyre-recovery-kit.txt." : "The kit page is ready to print.") : "The kit was not saved. Try again, or copy the code by hand."));
  };
  return (
    <FlowStep steps={steps} onBack={back} title="Save your recovery kit" lead="One page with your recovery code. It is shown once, so save it before you go on."
      failure={kit ? undefined : "The recovery code is no longer on this screen, so it cannot be shown again. Go back and sign in with your recovery code if you saved it, or ask another device to approve you."}
      primary={{ label: "Continue", disabled: !saved || !kit, onPress: () => { dropKit(); go("vault.intro"); } }}>
      {kit ? <CodeDisplay label="Recovery code" code={kit.code} note="If you lose access to your devices, this code lets you sign in again." /> : null}
      <Stack row gap={2} wrap>
        <Button kind="secondary" size="sm" icon="download" label="Save as a file" onPress={() => keep("file")} />
        <Button kind="secondary" size="sm" icon="file" label="Print" onPress={() => keep("print")} />
      </Stack>
      <Banner tone="warn" icon="warning">Keep this page somewhere safe. Anyone with it can start to sign in as you, and Vyre cannot send you another copy.</Banner>
      <Stack row gap={3} align="center" justify="between"><Text>I saved my recovery kit</Text><Switch label="I saved my recovery kit" on={saved} onChange={setSaved} /></Stack>
    </FlowStep>
  );
}
