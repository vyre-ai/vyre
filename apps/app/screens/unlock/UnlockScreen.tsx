import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Appear, FlowStep, Icon, PasswordField, RecoveryKeySheet, Text, passwordStrength, useUiTheme } from "@vyre/ui";
import { passwordOk } from "../../../../lib/first-run-shape.js";
import { UNREACHABLE, unlockInput } from "../../src/shell/lock-gate.js";
import { migrateIdentity, unlockIdentity } from "./real.js";
import { HalftoneField, measureCalm } from "../first-run/HalftoneField";
import { CONTENT_ID, setWelcome } from "../first-run/field-state.js";
import { PillField, ThemeToggle, WelcomeBrand, WelcomeGreeting, useGreeting } from "../first-run/Welcome";
import { UNLOCK_COPY, WELCOME_TONES as T } from "../first-run/welcome-model.js";

/**
 * Coming back to the app: the password unlocks this identity on this device, or the recovery key does. A legacy identity with no password asks for a new one and shows its
 * recovery key once. Every control is a registry tool through ./real.js; `onDone` runs when the device is unlocked.
 * The unlock itself wears the welcome's look: the dotted field, the mark and wordmark, a greeting with a muted line, the round-arrow field (focused on load, Enter unlocks), the theme switch.
 */
export function UnlockScreen({ view, username, onDone, onRetry }: { view: "unlock" | "migrate" | "unreachable"; username?: string | null; onDone: () => void; onRetry?: () => void }) {
  const [mode, setMode] = useState<"password" | "recovery">("password");
  const [text, setText] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recovery, setRecovery] = useState("");
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const { phone } = useUiTheme();
  const [greeting] = useGreeting();
  // The dots at full strength behind the unlock, kept calm around its column once it lays out.
  useEffect(() => { setWelcome(true); const t = setTimeout(measureCalm, 60); return () => clearTimeout(t); }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setFailure("");
    try { await fn(); } finally { setBusy(false); }
  };

  if (view === "unreachable") {
    return <FlowStep title={UNREACHABLE.title} lead={UNREACHABLE.lead} primary={{ label: "Try again", onPress: () => onRetry?.() }} />;
  }

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
      <FlowStep title="Set your password" lead={`${username ? `${username}, your` : "Your"} identity has no password yet. The password unlocks it and your vault on this device.`} failure={failure}
        primary={{ label: busy ? "Setting up..." : "Set password", disabled: !ok || busy, loading: busy, onPress: () => void run(async () => {
          const r = await migrateIdentity(text);
          if (!r.ok) { setFailure(r.message); return; }
          if (typeof r.recoveryKey === "string" && r.recoveryKey) { setRecovery(r.recoveryKey); return; }
          onDone();
        }) }}>
        <PasswordField label="Password" meter value={text} onChangeText={setText} />
        <PasswordField label="Confirm password" value={confirm} onChangeText={setConfirm} error={confirm && confirm !== text ? "Type the same password again." : undefined} />
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
  const blocked = !text.trim() || busy;
  const flip = () => { setMode(recoveryMode ? "password" : "recovery"); setText(""); setFailure(""); setShown(false); };
  const eye = shown ? UNLOCK_COPY.hide : UNLOCK_COPY.show;
  return (
    <View style={{ flex: 1 }}>
      <HalftoneField phone={phone} />
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 }}>
        <View id={CONTENT_ID} style={{ alignItems: "center", width: "100%", maxWidth: 720 }}>
          <Appear index={0}><WelcomeBrand /></Appear>
          <WelcomeGreeting phone={phone} greeting={greeting} line={UNLOCK_COPY.line} />
          <Appear index={6} style={{ width: "100%", alignItems: "center" }}>
            <PillField key={mode} value={text} onChangeText={setText} onGo={() => { if (!blocked) submit(); }} disabled={blocked}
              goLabel={busy ? UNLOCK_COPY.unlocking : UNLOCK_COPY.unlock}
              input={{
                autoFocus: true, editable: !busy, secureTextEntry: !recoveryMode && !shown,
                placeholder: recoveryMode ? UNLOCK_COPY.recoveryHint : UNLOCK_COPY.passwordHint,
                accessibilityLabel: recoveryMode ? UNLOCK_COPY.recoveryKey : UNLOCK_COPY.password,
                autoComplete: recoveryMode ? "off" : "current-password", textContentType: recoveryMode ? "none" : "password",
              }}
              extra={recoveryMode ? null : (
                <Pressable accessibilityRole="button" accessibilityLabel={eye} onPress={() => setShown(!shown)} hitSlop={8}
                  style={{ width: 36, height: 36, marginRight: 4, alignItems: "center", justifyContent: "center" }} {...({ title: eye } as object)}>
                  <Icon name={shown ? "eye-off" : "eye"} size={18} tone={T.link} />
                </Pressable>
              )} />
            {failure ? <Text size="secondary" tone="err" style={{ marginTop: 10, textAlign: "center" }} accessibilityLiveRegion="polite">{failure}</Text> : null}
          </Appear>
          <Appear index={7} style={{ alignItems: "center", gap: 12, marginTop: 20, maxWidth: 440 }}>
            <Pressable accessibilityRole="button" onPress={flip}><Text size="secondary" tone="label">{recoveryMode ? UNLOCK_COPY.usePassword : UNLOCK_COPY.useRecovery}</Text></Pressable>
            <Text size="caption" tone="label" style={{ textAlign: "center" }}>{UNLOCK_COPY.note}</Text>
          </Appear>
        </View>
      </View>
      <ThemeToggle />
    </View>
  );
}
