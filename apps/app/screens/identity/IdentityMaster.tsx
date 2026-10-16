import { useState } from "react";
import { Banner, CodeDisplay, Field, FlowStep, PasswordField, Stack, Switch, Text } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import type { ScreenProps } from "../onboard/types";
import { SAY, createCall, migrateCall, recoveryCall, unlockCall } from "./model.js";

type Answer = { data?: { recoveryKey?: string; needsConfirm?: boolean; unlocked?: boolean; username?: string }; error?: { message?: string } };

function sayOf(code: string | undefined) {
  return (code && SAY[code as keyof typeof SAY]) || "Check what you typed and try again.";
}

function ready(call: { tool?: string; input?: Record<string, unknown>; error?: string }): call is { tool: string; input: Record<string, unknown> } {
  return typeof call.tool === "string" && call.input !== undefined;
}

function usePair() {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [tried, setTried] = useState(false);
  return {
    a, b, tried, setTried,
    fields: (
      <Stack gap={4}>
        <PasswordField label="Master password" name="Master password" meter value={a} onChangeText={(v: string) => { setA(v); setTried(false); }} />
        <PasswordField label="Type it again" name="Master password again" value={b} onChangeText={(v: string) => { setB(v); setTried(false); }} error={tried && a !== b ? SAY.differ : undefined} />
      </Stack>
    ),
  };
}

/** Username, master password, then the recovery key once. Calls identity.create, the same tool onboard.person.create calls. */
export function CreateIdentity({ ctx, set, go, back, steps }: ScreenProps) {
  const pair = usePair();
  const [name, setName] = useState(ctx.name || "");
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);
  const submit = async () => {
    const call = createCall({ username: name, password: pair.a, confirm: pair.b });
    if (!ready(call)) { pair.setTried(true); setSay(sayOf(call.error)); return; }
    setBusy(true); setSay("");
    const r = await callT<Answer["data"]>(call.tool, call.input) as Answer;
    setBusy(false);
    if (r.error) { setSay(r.error.message || "The name could not be created. Try again."); return; }
    set({ name: r.data?.username || name.trim().toLowerCase(), master: "" });
    setKey(r.data?.recoveryKey || "");
  };
  if (key) {
    return (
      <FlowStep steps={steps} title="Save your recovery key" lead="This key can unlock your identity on a device you still have. It does not open your vault. It is shown once."
        primary={{ label: "Continue", disabled: !saved, onPress: () => { setKey(""); go("vault.intro"); } }}>
        <CodeDisplay label="Recovery key" code={key} note="Keep it like a house key. Vyre cannot show it again." />
        <Banner tone="warn" icon="warning">Anyone with this key can start to unlock your identity after a confirmation on a device. Keep it out of email and chat.</Banner>
        <Stack row gap={3} align="center" justify="between"><Text>I saved my recovery key</Text><Switch label="I saved my recovery key" on={saved} onChange={setSaved} /></Stack>
      </FlowStep>
    );
  }
  return (
    <FlowStep steps={steps} onBack={back} title="Create your identity" lead="Pick the name people use to reach you, and a master password only you know."
      failure={say || undefined}
      primary={{ label: "Create", disabled: !name.trim() || !pair.a || !pair.b || busy, loading: busy, onPress: () => { void submit(); } }}>
      <Field label="Name" value={name} onChangeText={(v: string) => { setName(v); setSay(""); }} placeholder="alex" help={name.trim() ? `https://vyre.run/u/${name.trim().toLowerCase()}` : undefined} />
      {pair.fields}
    </FlowStep>
  );
}

/** Master password, or a recovery key that waits for a confirmation on this device and then unlocks the identity only. */
export function UnlockIdentity({ go, back, steps }: ScreenProps) {
  const [pw, setPw] = useState("");
  const [recovery, setRecovery] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  const submit = async () => {
    const call = useRecovery ? recoveryCall({ recovery, confirmed: confirming }) : unlockCall({ password: pw });
    if (!ready(call)) { setSay(sayOf(call.error)); return; }
    setBusy(true); setSay("");
    const r = await callT<Answer["data"]>(call.tool, call.input) as Answer;
    setBusy(false);
    if (r.error) { setSay(r.error.message || "That did not unlock this device. Try again."); return; }
    if (r.data?.needsConfirm) { setConfirming(true); return; }
    setPw(""); setRecovery("");
    go("inf.pick");
  };
  if (confirming) {
    return (
      <FlowStep steps={steps} onBack={() => { setConfirming(false); setSay(""); }} title="Confirm on this device" lead="This recovery key unlocks your identity here. It does not open your vault."
        failure={say || undefined}
        primary={{ label: "Unlock my identity", disabled: busy, loading: busy, onPress: () => { void submit(); } }}>
        <Banner tone="plain" icon="info">You are on this device, and this tap is the confirmation. An agent cannot make it for you.</Banner>
      </FlowStep>
    );
  }
  return (
    <FlowStep steps={steps} onBack={back} title="Unlock this device" lead="Type your master password. Your vault opens with it. A recovery key is the other way, and it unlocks your identity only."
      failure={say || undefined}
      primary={{ label: "Unlock", disabled: busy || (useRecovery ? !recovery.trim() : !pw), loading: busy, onPress: () => { void submit(); } }}
      secondary={{ label: useRecovery ? "Use my master password" : "Use my recovery key", onPress: () => { setUseRecovery(!useRecovery); setSay(""); setConfirming(false); } }}>
      {useRecovery
        ? <Field label="Recovery key" value={recovery} onChangeText={(v: string) => { setRecovery(v); setSay(""); }} help="Enter it here, then confirm on this device." />
        : <PasswordField label="Master password" name="Master password" value={pw} onChangeText={(v: string) => { setPw(v); setSay(""); }} />}
    </FlowStep>
  );
}

/** Wrap this device's existing keys. Calls identity.migrate, then shows the new recovery key once. */
export function MigrateIdentity({ set, go, back, steps }: ScreenProps) {
  const pair = usePair();
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);
  const submit = async () => {
    const call = migrateCall({ password: pair.a, confirm: pair.b });
    if (!ready(call)) { pair.setTried(true); setSay(sayOf(call.error)); return; }
    setBusy(true); setSay("");
    const r = await callT<Answer["data"]>(call.tool, call.input) as Answer;
    setBusy(false);
    if (r.error) { setSay(r.error.message || "This device could not be wrapped. Try again."); return; }
    set({ master: "" });
    setKey(r.data?.recoveryKey || "");
  };
  if (key) {
    return (
      <FlowStep steps={steps} title="Save your new recovery key" lead="Your existing keys are now under this master password. The new recovery key is shown once. It unlocks your identity only, after you confirm it on a device."
        primary={{ label: "Continue", disabled: !saved, onPress: () => { setKey(""); go("vault.intro"); } }}>
        <CodeDisplay label="Recovery key" code={key} note="The previous recovery code for the directory stays as it was. This key is the one for this device." />
        <Stack row gap={3} align="center" justify="between"><Text>I saved my recovery key</Text><Switch label="I saved my recovery key" on={saved} onChange={setSaved} /></Stack>
      </FlowStep>
    );
  }
  return (
    <FlowStep steps={steps} onBack={back} title="Wrap this device" lead="Choose the master password that will unlock your identity and your personal vault on this device."
      failure={say || undefined}
      primary={{ label: "Wrap my keys", disabled: !pair.a || !pair.b || busy, loading: busy, onPress: () => { void submit(); } }}>
      {pair.fields}
    </FlowStep>
  );
}
