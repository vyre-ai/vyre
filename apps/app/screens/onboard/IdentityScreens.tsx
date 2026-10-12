import { useState } from "react";
import { Banner, Button, ChoiceList, CodeDisplay, CodeField, Field, FlowStep, MatchWords, Stack, Switch, Text, showToast } from "@vyre/ui";
import { DEMO, SIGNIN_WORDS, knownName, nameStatus, recoveryStatus } from "./flow-model.js";
import type { ScreenProps } from "./types";

const HINT = "Prototype hint";

export function IdChoice({ go, back, steps }: ScreenProps) {
  const [pick, setPick] = useState<"signin" | "new" | "">("");
  return (
    <FlowStep steps={steps} onBack={back} title="Sign in to Vyre" lead="Your name is how Vyre knows you on every device." primary={{ label: "Continue", disabled: !pick, onPress: () => go(pick === "signin" ? "id.signin" : "id.new") }}>
      <ChoiceList label="Sign in or start" value={pick || undefined} onChange={setPick} options={[
        { value: "signin", title: "I already have a name", sub: "Sign in on this device. You approve it from a device you already use.", icon: "person" },
        { value: "new", title: "I am new to Vyre", sub: "Pick a name and save your recovery kit.", icon: "plus" },
      ]} />
    </FlowStep>
  );
}

export function IdSignin({ ctx, set, go, back, steps }: ScreenProps) {
  const [tried, setTried] = useState(false);
  const bad = tried && !knownName(ctx.name);
  return (
    <FlowStep steps={steps} onBack={back} title="Your name" lead="Type the name you chose when you joined Vyre."
      failure={bad ? `No one has the name ${ctx.name.trim() || "you typed"}. Check the spelling, or go back and choose "I am new to Vyre" to reserve it.` : undefined}
      primary={{ label: "Continue", disabled: !ctx.name.trim(), onPress: () => { setTried(true); if (knownName(ctx.name)) go("id.approve"); } }}
      secondary={bad ? { label: "I am new to Vyre", onPress: () => go("id.new") } : undefined}>
      <Field label="Name" value={ctx.name} onChangeText={(v) => { set({ name: v }); setTried(false); }} placeholder="name" help={ctx.name.trim() ? `${ctx.name.trim().toLowerCase()}.vyre.run` : undefined} />
      <Banner tone="plain" icon="info">{`${HINT}: alex, jordan and harper are names that exist.`}</Banner>
    </FlowStep>
  );
}

export function IdApprove({ set, go, back, steps }: ScreenProps) {
  const [state, setState] = useState<"waiting" | "denied">("waiting");
  return (
    <FlowStep steps={steps} onBack={back} title="Approve on your other device" lead="On a device where you are already signed in, Vyre asks Sign in on this device. Check the three words match, then tap Approve."
      failure={state === "denied" ? "Your other device did not approve this sign-in. Ask again, or use your recovery kit." : undefined}
      primary={state === "denied" ? { label: "Ask again", onPress: () => setState("waiting") } : { label: "Prototype: approve on the other device", onPress: () => { set({ reset: false }); go("master.enter"); } }}
      secondary={{ label: "Use my recovery kit instead", onPress: () => go("id.recover") }}>
      <CodeDisplay label="Your sign-in code" code={DEMO.signInCode} note="Good for 10 min. It is only a backup if the prompt does not arrive." />
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
  const [tried, setTried] = useState(false);
  const wrong = tried && recoveryStatus(code) !== "ok";
  return (
    <FlowStep steps={steps} onBack={back} title="Use your recovery kit" lead="Type the recovery code from the page you saved. This is for when no other device can approve you."
      failure={wrong ? "That is not the recovery code for this name. Check the page you saved, or ask another device to approve you instead." : undefined}
      primary={{ label: "Use recovery code", disabled: !code, onPress: () => { setTried(true); if (recoveryStatus(code) === "ok") go(ctx.reset ? "master.set" : "master.enter"); } }}
      secondary={{ label: "Ask another device instead", onPress: () => { set({ reset: false }); go("id.approve"); } }}>
      <CodeField label="Recovery code" prefix="KIT" groups={[4, 4, 4]} value={code} onChangeText={(v) => { setCode(v); setTried(false); }} help="It is on the first line of your recovery kit." />
      <Banner tone="plain" icon="info">{`${HINT}: ${DEMO.recoveryCode} works. Anything else shows the refusal.`}</Banner>
    </FlowStep>
  );
}

export function IdNew({ ctx, set, go, back, steps }: ScreenProps) {
  const s = nameStatus(ctx.name);
  const n = ctx.name.trim().toLowerCase();
  return (
    <FlowStep steps={steps} onBack={back} title="Pick your name" lead="You get name.vyre.run. Your key is made on this device and stays here."
      primary={{ label: "Reserve this name", disabled: s !== "free", onPress: () => go("id.kit") }}>
      <Field label="Name" value={ctx.name} onChangeText={(v) => set({ name: v })} placeholder="name"
        error={s === "taken" ? `${n} is taken. Try ${n}2, or add your surname.` : s === "invalid" ? "Use 3 to 20 letters, numbers or hyphens, starting with a letter." : undefined}
        help={s === "free" ? `${n}.vyre.run is free.` : s === "empty" ? "Checked as you type." : undefined} />
      <Banner tone="plain" icon="info">{`${HINT}: alex, jordan, harper, admin and vyre are taken.`}</Banner>
    </FlowStep>
  );
}

export function IdKit({ go, back, steps }: ScreenProps) {
  const [saved, setSaved] = useState(false);
  return (
    <FlowStep steps={steps} onBack={back} title="Save your recovery kit" lead="One page with your recovery code and your vault's secret key. It is shown once."
      primary={{ label: "Continue", disabled: !saved, onPress: () => go("master.set") }}>
      <CodeDisplay label="Recovery code" code={DEMO.recoveryCode} />
      <CodeDisplay label="Secret key" code={DEMO.secretKey} note="Together with your master password, this opens your vault on a new device." />
      <Stack row gap={2} wrap>
        <Button kind="secondary" size="sm" icon="download" label="Save as a file" onPress={() => showToast("Saved vyre-recovery-kit.txt. This is a prototype: nothing was written.")} />
        <Button kind="secondary" size="sm" icon="file" label="Print" onPress={() => showToast("Printing opens here. This is a prototype.")} />
      </Stack>
      <Banner tone="warn" icon="warning">Without this kit and your master password nobody can open your vault, and Vyre cannot reset either. Keep the page somewhere safe.</Banner>
      <Stack row gap={3} align="center" justify="between"><Text>I saved my recovery kit</Text><Switch label="I saved my recovery kit" on={saved} onChange={setSaved} /></Stack>
    </FlowStep>
  );
}
