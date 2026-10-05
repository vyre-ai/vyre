import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { answers } from "../../src/state/live";
import { canCommit, type Decision } from "../../src/state/needs-model";
import { needsStore, setNeeds, useNeed, type Need } from "../../src/state/needs";
import { said, tool } from "../../src/real/box";
import { editedOf, fieldsOf, sendOutcome } from "../../src/state/held.js";
import { useTheme } from "../../src/theme/theme";
import { tokens } from "../../src/theme/tokens";
import { face, type } from "../../src/theme/type";
import { BackButton } from "../../src/ui/BackButton";
import { Button } from "../../src/ui/Button";

/**
 * One item waiting, opened by a tap or by a swipe the box would refuse (a send with no proof on
 * this device yet). It says what answering takes instead of failing quietly. Proving presence
 * from the web app is a passkey, and a browser that has none asks the owner's phone: either way the
 * Send here goes straight to the box (tool), which asks for the yes and sends once it has it.
 * A held send shows in full (gate.get) and can be edited before it goes (HeldSend).
 */
export default function NeedDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const n = useNeed(String(id));
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { color } = useTheme();
  const done = (d: Decision) => {
    if (n && answers.commit(n, d)) router.back();
  };
  if (!n) {
    return (
      <View style={[styles.page, { backgroundColor: color.bg, paddingTop: insets.top }]}>
        <Back />
        <Text style={[type.read, { color: color.label, padding: tokens.layout.gutterPhone }]}>Answered, or no longer waiting.</Text>
      </View>
    );
  }
  if (n.source === "gate") return <HeldSend n={n} />;
  const approve = canCommit(n, "approve");
  const reject = canCommit(n, "reject");
  const who = [n.agent, n.project].filter(Boolean).join(" · ");
  return (
    <View style={[styles.page, { backgroundColor: color.bg, paddingTop: insets.top }]}>
      <Back />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[type.title, { color: color.text }]}>{n.title}</Text>
        {who ? <Text style={[type.meta, { color: color.label }]}>{who}</Text> : null}
        {n.to?.length ? <Field label="To" value={n.to.join(", ")} /> : null}
        <Field label={n.source === "gate" ? "What" : "Step"} value={n.detail} mono={n.mono} />
        {n.why ? <Field label="Why" value={n.why} /> : null}
        {n.error ? <Field label="Last try" value={n.error} /> : null}
        <View style={styles.buttons}>
          <Button kind="primary" label="Approve" disabled={!approve.ok} onPress={() => done("approve")} />
          <Button kind="ghost" label="Deny" disabled={!reject.ok} onPress={() => done("reject")} />
        </View>
        {!approve.ok ? (
          <Text style={[type.meta, { color: color.text2 }]}>
            {approve.why}. Answer it in the chat.
          </Text>
        ) : null}
        {n.thread ? (
          <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: "/u/chats/[id]", params: { id: n.thread as string } })} style={styles.link}>
            <Text style={[type.readStrong, { color: color.focus }]}>Open chat</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** A held send in full, with its words editable, and a Send that asks for the person's yes itself. */
function HeldSend({ n }: { n: Need }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { color } = useTheme();
  const [item, setItem] = useState<any>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<"" | "send" | "save" | "discard">("");
  const [line, setLine] = useState("");
  useEffect(() => {
    let live = true;
    tool<any>("gate.get", { id: n.ref }).then((g) => {
      if (!live) return;
      setItem(g);
      setTyped(Object.fromEntries(fieldsOf(g).map((f) => [f.key, f.value])));
      setTo(Array.isArray(g.to) ? g.to.join(", ") : "");
    }).catch((e) => live && setLine(said(e)));
    return () => { live = false; };
  }, [n.ref]);
  const gone = () => { setNeeds(needsStore.get().items.filter((x) => x.id !== n.id), needsStore.get().from === "cache" ? "cache" : "box"); router.back(); };
  const run = async (what: "send" | "save" | "discard") => {
    setBusy(what); setLine("");
    try {
      const edited = item ? editedOf(item, typed, to) : null;
      if (what === "discard") { await tool("gate.reject", { id: n.ref }); gone(); return; }
      if (what === "save") { if (edited) setItem(await tool("gate.revise", { id: n.ref, edited }).then(async () => tool<any>("gate.get", { id: n.ref }))); return; }
      const out = sendOutcome(await tool<any>("gate.approve", { id: n.ref, ...(edited ? { edited } : {}) }));
      if (out.ok) gone(); else setLine(out.reason ?? "It did not send.");
    } catch (e) { setLine(said(e)); } finally { setBusy(""); }
  };
  const fields = item ? fieldsOf(item) : [];
  const changed = Boolean(item && editedOf(item, typed, to));
  return (
    <View style={[styles.page, { backgroundColor: color.bg, paddingTop: insets.top }]}>
      <Back />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[type.title, { color: color.text }]}>{n.title}</Text>
        {n.agent || n.project ? <Text style={[type.meta, { color: color.label }]}>{[n.agent, n.project].filter(Boolean).join(" · ")}</Text> : null}
        {n.why ? <Field label="Why" value={n.why} /> : null}
        {item ? (
          <View style={[styles.field, { borderTopColor: color.rule }]}>
            <Text style={[type.meta, { color: color.label }]}>To</Text>
            <TextInput value={to} onChangeText={setTo} editable={item.kind === "send"} autoCapitalize="none" accessibilityLabel="Who it goes to" style={[type.read, { color: color.text }]} />
          </View>
        ) : null}
        {fields.map((f) => (
          <View key={f.key} style={[styles.field, { borderTopColor: color.rule }]}>
            <Text style={[type.meta, { color: color.label }]}>{f.label}</Text>
            {f.edit ? (
              <TextInput multiline={f.key !== "subject"} value={typed[f.key] ?? f.value} onChangeText={(v) => setTyped((t) => ({ ...t, [f.key]: v }))} accessibilityLabel={f.label} style={[type.read, { color: color.text, minHeight: f.key === "subject" ? undefined : 120 }]} />
            ) : <Text selectable style={[type.read, { color: color.text }]}>{f.value}</Text>}
          </View>
        ))}
        {!item && !line ? <Text style={[type.meta, { color: color.text2 }]}>Opening it…</Text> : null}
        {n.error ? <Field label="Last try" value={n.error} /> : null}
        {line ? <Text accessibilityRole="alert" style={[type.read, { color: color.err }]}>{line}</Text> : null}
        {item && n.presence.required && !n.presence.covered ? <Text style={[type.meta, { color: color.text2 }]}>Sending asks for your yes on this device. Nothing goes until you give it.</Text> : null}
        <View style={styles.buttons}>
          <Button kind="primary" label={busy === "send" ? "Sending" : "Send"} disabled={!item || busy !== ""} onPress={() => void run("send")} />
          {changed ? <Button kind="ghost" label="Save edit" disabled={busy !== ""} onPress={() => void run("save")} /> : null}
          <Button kind="ghost" label="Discard" disabled={busy !== ""} onPress={() => void run("discard")} />
        </View>
        {n.thread ? (
          <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: "/u/chats/[id]", params: { id: n.thread as string } })} style={styles.link}>
            <Text style={[type.readStrong, { color: color.focus }]}>Open chat</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** Opened from Now, the one list of what waits. */
function Back() {
  return (
    <View style={styles.back}>
      <BackButton to="Now" />
    </View>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { color } = useTheme();
  return (
    <View style={[styles.field, { borderTopColor: color.rule }]}>
      <Text style={[type.meta, { color: color.label }]}>{label}</Text>
      <Text selectable style={[type.read, mono && face.mono, { color: color.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  back: { height: tokens.layout.phoneHeader, justifyContent: "center", alignItems: "flex-start", paddingHorizontal: tokens.layout.gutterPhone },
  content: { padding: tokens.layout.gutterPhone, gap: tokens.space[4] },
  field: { gap: tokens.space[1], paddingTop: tokens.space[4], borderTopWidth: StyleSheet.hairlineWidth },
  buttons: { flexDirection: "row", gap: tokens.space[4], paddingTop: tokens.space[4] },
  link: { height: tokens.control.touch, justifyContent: "center" },
});
