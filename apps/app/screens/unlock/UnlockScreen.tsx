import { useState } from "react";
import { Field, FlowStep, PasswordField, RecoveryKeySheet, Text, passwordStrength } from "@vyre/ui";
import { passwordOk } from "../../../../lib/first-run-shape.js";
import { unlockInput } from "../../src/shell/lock-gate.js";
import { migrateIdentity, unlockIdentity } from "./real.js";

/**
 * Coming back to the app: the master password unlocks this identity on this device, or the recovery key does. A legacy identity with no master password asks for a new one and shows its
 * recovery key once. Every control is a registry tool through ./real.js; `onDone` runs when the device is unlocked.
 */
export function UnlockScreen({ view, username, onDone }: { view: "unlock" | "migrate"; username?: string | null; onDone: () => void }) {
  const [mode, setMode] = useState<"password" | "recovery">("password");
  const [text, setText] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recovery, setRecovery] = useState("");
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setFailure("");
    try { await fn(); } finally { setBusy(false); }
  };

  if (view === "migrate" && recovery) {
    return (
      <FlowStep title="Save your recovery key" lead="One key for your identity and your vault. It is shown once." primary={{ label: "Continue", disabled: !saved, onPress: onDone }}>
        <RecoveryKeySheet secret={recovery} saved={saved} onSaved={setSaved} />
      </FlowStep>
    );
  }

  if (view === "migrate") {
    const ok = passwordOk(text) && passwordStrength(text).score >= 3 && confirm === text;
    return (
      <FlowStep title="Set your master password" lead={`${username ? `${username}, your` : "Your"} identity has no master password yet. The password unlocks it and your vault on this device.`} failure={failure}
        primary={{ label: busy ? "Setting up..." : "Set password", disabled: !ok || busy, loading: busy, onPress: () => void run(async () => {
          const r = await migrateIdentity(text);
          if (!r.ok) { setFailure(r.message); return; }
          if (typeof r.recoveryKey === "string" && r.recoveryKey) { setRecovery(r.recoveryKey); return; }
          onDone();
        }) }}>
        <PasswordField label="Master password" meter value={text} onChangeText={setText} />
        <PasswordField label="Confirm master password" value={confirm} onChangeText={setConfirm} error={confirm && confirm !== text ? "Type the same master password again." : undefined} />
      </FlowStep>
    );
  }

  const recoveryMode = mode === "recovery";
  const submit = () => void run(async () => {
    const r = await unlockIdentity(unlockInput({ mode, text }));
    if (!r.ok) { setFailure(r.message); return; }
    setText("");
    onDone();
  });
  return (
    <FlowStep title={username ? `Welcome back, ${username}` : "Welcome back"} lead={recoveryMode ? "Type your recovery key to unlock this device." : "Type your master password to unlock this device."} failure={failure}
      primary={{ label: busy ? "Unlocking..." : "Unlock", disabled: !text.trim() || busy, loading: busy, onPress: submit }}
      secondary={{ label: recoveryMode ? "Use my master password" : "Use my recovery key", onPress: () => { setMode(recoveryMode ? "password" : "recovery"); setText(""); setFailure(""); } }}>
      {recoveryMode
        ? <Field label="Recovery key" value={text} onChangeText={setText} mono autoFocus onSubmit={submit} />
        : <PasswordField label="Master password" value={text} onChangeText={setText} name="Master password" />}
      <Text tone="muted">Vyre locks itself after a quiet spell. You can change how long in Settings, under Account.</Text>
    </FlowStep>
  );
}
