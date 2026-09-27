import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { enablePush, pushStatus, type PushStatus } from "../pwa/pwa";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";

/**
 * "Turn on notifications", on Now in the web app, while they are off on this device. Nothing is
 * asked on load: the browser's prompt comes only from this tap.
 */
export function NotifyBar() {
  const { color } = useTheme();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    let live = true;
    pushStatus().then((s) => live && setStatus(s), () => {});
    return () => {
      live = false;
    };
  }, []);
  if (status !== "off" && !error) return null;
  const turnOn = () => {
    setBusy(true);
    setError(null);
    enablePush().then(
      async () => {
        setBusy(false);
        setStatus(await pushStatus().catch(() => "on" as const));
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <View style={[styles.bar, { backgroundColor: color.panel, borderBottomColor: color.rule }]}>
      <Text style={[styles.text, { color: error ? color.text2 : color.text }]}>{error ?? "Hear from your box when something needs you"}</Text>
      {status === "off" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy }}
          disabled={busy}
          onPress={turnOn}
          style={[styles.btn, { backgroundColor: color.primaryBg, opacity: busy ? 0.6 : 1 }]}
        >
          <Text style={[styles.btnText, { color: color.primaryInk }]}>Turn on notifications</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space[4],
    paddingHorizontal: tokens.layout.gutterPhone,
    paddingVertical: tokens.space[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { flex: 1, fontSize: tokens.type.phone.base[0], lineHeight: tokens.type.phone.base[1] },
  btn: { height: tokens.control.sm, paddingHorizontal: tokens.space[5], borderRadius: tokens.radius.button, justifyContent: "center" },
  btnText: { fontSize: tokens.type.phone.base[0], lineHeight: tokens.type.phone.base[1], fontWeight: tokens.font.weight.strong },
});
