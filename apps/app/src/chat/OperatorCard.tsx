// The operator card (R031-91, R031-88): a computer at work, in the chat. The picture is Glass's live view on every platform (not a still); one tap opens it full viewport with Watching and Take control. Under it, one plain
// sentence of what it is doing now, breathing while it works, and a short track of the last steps. When it is stuck and asked for something (a code), the box to type it is right here; when it is stuck on something
// else, Take over is on the live screen. The screen itself is Glass's (LiveScreen), so every rule Glass has holds.
import { useEffect, useState } from "react";
import { Modal, Pressable, TextInput, View } from "react-native";
import { Banner, Button, Chip, Icon, Pulse, Text, useUiTheme } from "@vyre/ui";
import { tool } from "../real/box";
import { LiveScreen } from "./LiveScreen";
import { asksForCode, dots, runWord, totpLogins } from "./screen-model.js";

type Op = { block: "operator"; run: string; computer: string; title: string; state: "working" | "done" | "stuck" | "paused"; line: string; ask?: string; steps: { line: string; state: string }[] };

/** `sample` is a stand-in picture for the sample world (the shots); a real card asks the box. */
export function OperatorCard({ block, sample }: { block: Op; sample?: string }) {
  const { color } = useUiTheme();
  const [big, setBig] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const track = dots(block.steps);
  const wantsCode = block.state === "stuck" && !!block.ask && asksForCode(block.ask);
  const [seeds, setSeeds] = useState<{ name: string; near: boolean }[]>(sample ? [{ name: "GoHighLevel agency login", near: true }] : []);
  useEffect(() => {
    if (!wantsCode || sample) return;
    let dead = false;
    tool<{ items?: { name: string; kind: string; fields?: string[]; hosts?: string[] }[] }>("vault.list", {}).then((r) => { if (!dead) setSeeds(totpLogins(r.items ?? [], block.steps.map((x) => x.line))); }).catch(() => {});
    return () => { dead = true; };
  }, [wantsCode, sample, block.run]);
  const useSeed = async (name: string) => {
    setBusy(true); setProblem("");
    try { const r = await tool<{ code?: string }>("vault.totp", { name }); if (!r.code) throw new Error("The Vault had no code."); await tool("previews.reply", { run: block.run, text: String(r.code) }); }
    catch (e) { setProblem(e instanceof Error && e.message ? e.message : "The Vault did not give a code."); } finally { setBusy(false); }
  };
  const ink = (s: string) => (s === "done" ? color.ok : s === "stuck" ? color.warn : s === "paused" ? color.label : color.accent);
  const send = async () => {
    setBusy(true); setProblem("");
    try { await tool("previews.reply", { run: block.run, text }); setText(""); } catch (e) { setProblem(e instanceof Error && e.message ? e.message : "That did not go through."); } finally { setBusy(false); }
  };
  return (
    <View style={{ borderWidth: 1, borderColor: block.state === "stuck" ? color["edge-strong"] : color.edge, backgroundColor: block.state === "stuck" ? color["warn-wash"] : color["surface-2"], borderRadius: 14, marginVertical: 4, maxWidth: 560, overflow: "hidden" }}>
      {sample ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Open ${block.title} full screen`} onPress={() => setBig(true)} style={{ aspectRatio: 16 / 10, backgroundColor: color["surface-3"], alignItems: "center", justifyContent: "center" }}>
          <Icon name="globe" size={24} tone="label" />
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={`Open ${block.title} full screen`} onPress={() => setBig(true)} style={{ padding: 10 }}>
          <LiveScreen computer={block.computer} />
        </Pressable>
      )}
      <View style={{ padding: 14, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text strong numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{block.title}</Text>
          <Chip tone={block.state === "done" ? "ok" : block.state === "stuck" ? "warn" : "plain"}>{runWord(block.state)}</Chip>
        </View>
        <Pulse active={block.state === "working"}><Text accessibilityLiveRegion="polite" style={{ flex: 1 }}>{block.line || "Getting started"}</Text></Pulse>
        {track.length ? (
          <View accessibilityLabel={`${track.length} steps`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {track.map((s, i) => <View key={i} accessibilityLabel={s.line} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: i === track.length - 1 && block.state === "working" ? "transparent" : ink(s.state), borderWidth: i === track.length - 1 && block.state === "working" ? 2 : 0, borderColor: ink(s.state) }} />)}
          </View>
        ) : null}
        {wantsCode && seeds.length ? (
          <View style={{ gap: 8 }}>
            {seeds.slice(0, 3).map((x, i) => <View key={x.name} style={{ alignSelf: "flex-start" }}><Button kind={i === 0 ? "primary" : "ghost"} size="sm" icon="key" label={`Use the code from the Vault: ${x.name}`} disabled={busy} onPress={() => useSeed(x.name)} /></View>)}
            <Text size="caption" tone="label">The Vault gives this computer the six digits, never the secret behind them. Or type it below.</Text>
          </View>
        ) : null}
        {block.state === "stuck" && block.ask ? (
          <View style={{ gap: 8 }}>
            <TextInput accessibilityLabel={block.ask} placeholder={block.ask} placeholderTextColor={color.label} value={text} onChangeText={setText} autoCapitalize="none" autoCorrect={false}
              onSubmitEditing={() => { if (text.trim() && !busy) void send(); }}
              style={{ minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: color["edge-strong"], color: color.text, fontSize: 16, backgroundColor: color["surface-3"], outlineStyle: "none" } as never} />
            {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          </View>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {block.state === "stuck" && block.ask ? <Button kind={wantsCode && seeds.length ? "ghost" : "primary"} size="sm" label={busy ? "Sending" : "Send"} disabled={busy || !text.trim()} onPress={send} /> : null}
          {!sample ? <Button kind={block.state === "stuck" && !block.ask ? "primary" : "ghost"} size="sm" icon="globe" label="Open full screen" onPress={() => setBig(true)} /> : null}
        </View>
      </View>
      <Modal visible={big} transparent animationType="fade" onRequestClose={() => setBig(false)}>
        <View style={{ flex: 1, backgroundColor: color.scrim, padding: 16, justifyContent: "center" }}>
          <View style={{ alignSelf: "flex-end", marginBottom: 8 }}>
            <Button kind="ghost" size="sm" label="Close" onPress={() => setBig(false)} />
          </View>
          {sample ? <Text tone="inverse" style={{ textAlign: "center" }}>{block.title}</Text> : (
            <View style={{ flex: 1, maxHeight: "90%", width: "100%", maxWidth: 960, alignSelf: "center" }}>
              <LiveScreen computer={block.computer} />
            </View>
          )}
          <Text tone="inverse" size="caption" style={{ marginTop: 10, textAlign: "center" }}>{block.line}</Text>
        </View>
      </Modal>
    </View>
  );
}
