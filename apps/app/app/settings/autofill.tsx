import { useCallback, useEffect, useState } from "react";
import { AppState, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { deviceName } from "../../src/api/relay";
import * as Autofill from "../../src/vault/autofill";
import { useTheme } from "../../src/theme/theme";
import { tokens } from "../../src/theme/tokens";
import { face, type } from "../../src/theme/type";
import { Button } from "../../src/ui/Button";
import { Screen } from "../../src/ui/Screen";

/**
 * Settings, Autofill (Android only): pair this phone with the box's fill listener, then pick Vyre
 * as the phone's autofill service. The code comes from `vyre vault pair --phone` on the box.
 */
export default function AutofillSettings() {
  const { color } = useTheme();
  const [server, setServer] = useState("");
  const [code, setCode] = useState("");
  const [st, setSt] = useState<Autofill.AutofillStatus | null>(null);
  const [enabled, setEnabled] = useState(Autofill.isEnabled());
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!Autofill.supported) return;
    try {
      const s = await Autofill.status();
      setSt(s);
      setEnabled(s.enabled);
      if (s.server) setServer((v) => v || s.server || "");
    } catch (e) {
      setLine(message(e));
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

  // Back from Android's settings: check again each time the app comes to the front, until Vyre is on.
  useEffect(() => {
    if (!Autofill.supported || enabled) return;
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") return;
      const on = Autofill.isEnabled();
      setEnabled(on);
      if (on) void refresh();
    });
    return () => sub.remove();
  }, [enabled, refresh]);

  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setLine(null);
    try {
      await what();
      setLine(done);
      await refresh();
    } catch (e) {
      setLine(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (!Autofill.supported || Platform.OS !== "android") {
    return (
      <Screen title="Autofill" back backTo="Settings">
        <Text style={[type.read, styles.pad, { color: color.text2 }]}>Autofill is Android only.</Text>
      </Screen>
    );
  }

  const paired = !!st?.paired;
  const input = [styles.input, { color: color.text, backgroundColor: color.panel, borderColor: color.rule }];
  return (
    <Screen title="Autofill" back backTo="Settings">
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        <Text style={[type.read, { color: color.text }]}>{describe(st, enabled)}</Text>
        {line ? <Text accessibilityRole="alert" style={[type.meta, { color: color.text2 }]}>{line}</Text> : null}

        {paired ? null : (
          <View style={styles.group}>
            <Text style={[type.meta, { color: color.label }]}>Server address</Text>
            <TextInput
              value={server}
              onChangeText={setServer}
              placeholder="https://vault.harlow.test"
              placeholderTextColor={color.label}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              accessibilityLabel="Server address"
              testID="autofill-server"
              style={input}
            />
            <Text style={[type.meta, { color: color.label }]}>Pairing code</Text>
            <TextInput
              value={code}
              onChangeText={setCode}
              placeholder="From vyre vault pair --phone"
              placeholderTextColor={color.label}
              autoCapitalize="characters"
              autoCorrect={false}
              accessibilityLabel="Pairing code"
              testID="autofill-code"
              style={input}
            />
            <Button
              kind="primary"
              label="Pair"
              testID="autofill-pair"
              disabled={busy || !server.trim() || !code.trim()}
              onPress={() => void run(() => Autofill.pair(server.trim(), code.trim(), deviceName()), "Paired")}
            />
          </View>
        )}

        {paired && !enabled ? (
          <Button kind="primary" label="Turn on in Android settings" testID="autofill-enable" onPress={() => Autofill.openSettings()} />
        ) : null}

        {paired ? (
          <View style={styles.actions}>
            <Button kind="secondary" label="Lock" disabled={busy} onPress={() => void run(Autofill.lock, "Locked")} />
            <Button kind="outline" label="Unpair" disabled={busy} onPress={() => void run(Autofill.unpair, "Unpaired")} />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function describe(s: Autofill.AutofillStatus | null, enabled: boolean): string {
  if (!s) return "Checking this phone";
  if (!s.paired) return "Not paired. Run vyre vault pair --phone on the box, then enter its address and code.";
  const parts = [`Paired as ${s.name ?? "this phone"}`];
  if (s.revoked) parts.push("the box unpaired this phone, so pair again");
  else if (!s.reachable) parts.push("the box is not answering");
  parts.push(enabled ? "Vyre fills on this phone" : "not yet the phone's autofill service");
  parts.push(s.unlocked ? "unlocked" : "locked");
  return parts.join(", ") + ".";
}

function message(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === "ERR_BAD_SERVER") return "The address must start with https://";
  if (code === "ERR_NO_BIOMETRICS") return "Set a screen lock and a fingerprint or face first.";
  if (code === "ERR_NETWORK") return "The box did not answer.";
  return e instanceof Error ? e.message : String(e);
}

const phone = tokens.type.phone;
const styles = StyleSheet.create({
  pad: { padding: tokens.layout.gutterPhone, gap: tokens.space[4], alignItems: "stretch" },
  group: { gap: tokens.space[3] },
  actions: { flexDirection: "row", gap: tokens.space[3] },
  input: {
    height: tokens.control.touch,
    paddingHorizontal: tokens.space[4],
    borderWidth: 1,
    borderRadius: tokens.radius.field,
    // A single-line field takes the read size without its line height (which clips the text on Android).
    ...face.regular,
    fontSize: phone.read[0],
  },
});
