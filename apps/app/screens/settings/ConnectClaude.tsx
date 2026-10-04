// Connect Claude from the owner's device: the home starts the sign-in and gives a link, the person finishes it in the browser and brings the code back, the home keeps the credential in the vault
// (never shown again). Used in space setup and in Settings, AI accounts. The states are the box's: not connected, waiting, connected, blocked with its reason, failed with its reason.
import { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { Button, Card, Chip, Field, LoadingState, Text, showToast } from "@vyre/ui";
import { tool } from "../../src/real/box";
import { claimBlocked } from "../shell/rc";
import { aiRefusal, claudeOf, claudeState, codeInput, keyInput, safeLink, startInput } from "../../src/real/ai-connect.js";

// tool() answers a presence ask the way this build does (the phone's biometric; a browser says to do it on the phone), so onboard.claude, which needs the person's presence, works from here.
const ask = (name: string, input: Record<string, unknown> = {}) => tool<any>(name, input);

export function ConnectClaude({ onConnected }: { onConnected?: () => void }) {
  const [claude, setClaude] = useState<any>(null);
  const [link, setLink] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [key, setKey] = useState("");
  const [mode, setMode] = useState<"sub" | "key">("sub");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const [pairFirst, setPairFirst] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(() => { ask("onboard.status").then((s) => { setClaude(claudeOf(s)); if (s?.owned === false) setPairFirst(true); setLoaded(true); }).catch((e) => { (e as { code?: string }).code === "pair_first" ? setPairFirst(true) : setFailed(aiRefusal((e as { code?: string }).code, (e as Error).message)); setLoaded(true); }); }, []);
  useEffect(load, [load]);
  const st = claudeState(claude, { waiting: !!link, failed, pairFirst, onPhone: claimBlocked() });
  useEffect(() => { if (st.state === "connected") onConnected?.(); }, [st.state]);

  const run = async (input: Record<string, unknown>, then?: (d: any) => void) => {
    setBusy(true); setFailed("");
    try { const d = await ask("onboard.claude", input); then?.(d); load(); }
    catch (e) { (e as { code?: string }).code === "pair_first" ? setPairFirst(true) : setFailed(aiRefusal((e as { code?: string }).code, (e as Error).message)); }
    finally { setBusy(false); }
  };
  const start = () => run(startInput(), (d) => { const l = safeLink(d?.url); if (l) setLink(l); else setFailed("The home did not give a sign-in link."); });
  const finish = () => run(codeInput(code), () => { setLink(null); setCode(""); showToast("Claude is connected."); });
  const useKey = () => run(keyInput(key), () => { setKey(""); showToast("Claude is connected."); });

  return (
    <Card className="gap-s3">
      <View className="flex-row flex-wrap items-center gap-s2"><Text strong>Claude</Text><Chip tone={st.state === "connected" ? "ok" : st.state === "failed" || st.state === "blocked" || st.state === "pair_first" ? "warn" : "plain"}>{{ not_connected: "Not connected", blocked: "Cannot connect yet", waiting: "Waiting for you", connected: "Connected", failed: "Did not connect", pair_first: "Pair first", on_phone: "On your phone" }[st.state]}</Chip></View>
      <Text tone="muted">{st.line}</Text>
      {!loaded ? <LoadingState rows={1} /> : null}
      {loaded && (st.state === "not_connected" || st.state === "waiting" || st.state === "failed") ? (
        <View className="gap-s3">
          {link ? (
            <View className="gap-s2">
              <Text>Open the link, sign in to Claude, and copy the code it shows. Paste the code here.</Text>
              <View className="self-start"><Button size="sm" label="Open the sign-in" onPress={() => void Linking.openURL(link)} /></View>
              <Field label="Code from Claude" value={code} onChangeText={setCode} />
              <View className="flex-row gap-s2"><Button kind="primary" size="sm" label={busy ? "Connecting" : "Connect"} disabled={busy || !code.trim()} onPress={() => void finish()} /><Button kind="ghost" size="sm" label="Start over" onPress={() => { setLink(null); setCode(""); }} /></View>
            </View>
          ) : mode === "sub" ? (
            <View className="gap-s2">
              <View className="self-start"><Button kind="primary" size="sm" label={busy ? "Asking your home" : "Sign in to Claude"} disabled={busy} onPress={() => void start()} /></View>
              <Button kind="ghost" size="sm" label="Use an API key instead" onPress={() => setMode("key")} />
            </View>
          ) : (
            <View className="gap-s2">
              <Field label="Anthropic API key" value={key} onChangeText={setKey} kind="password" help="It goes to your home's vault and is not shown again." />
              <View className="flex-row gap-s2"><Button kind="primary" size="sm" label={busy ? "Connecting" : "Connect"} disabled={busy || !key.trim()} onPress={() => void useKey()} /><Button kind="ghost" size="sm" label="Sign in instead" onPress={() => setMode("sub")} /></View>
            </View>
          )}
        </View>
      ) : null}
    </Card>
  );
}
