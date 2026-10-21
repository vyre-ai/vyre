import { useEffect, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";

const KEY = "vyre.home-screen-hint";

function installed(): boolean {
  if (typeof window === "undefined") return true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  const mode = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  return mode || nav.standalone === true;
}

/** On a phone browser, one line about saving Vyre to the home screen. Hidden once dismissed, and hidden when it is already installed. */
export function HomeScreenHint() {
  const { phone } = useUiTheme();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "web" || !phone || installed()) return;
    try { if (localStorage.getItem(KEY) === "1") return; } catch { return; }
    setShow(true);
  }, [phone]);
  if (!show) return null;
  const dismiss = () => {
    try { localStorage.setItem(KEY, "1"); } catch { /* the hint can show again next open */ }
    setShow(false);
  };
  return (
    <View className="mx-s4 mb-s2 gap-s2 rounded-card border border-edge bg-surface px-s3 py-s3">
      <Text medium>Save Vyre to your home screen</Text>
      <Text size="secondary" tone="label">In the browser menu, choose Add to Home Screen. Vyre then opens like an app.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Not now" onPress={dismiss} className="min-h-control self-start justify-center">
        <Text medium tone="muted">Not now</Text>
      </Pressable>
    </View>
  );
}
