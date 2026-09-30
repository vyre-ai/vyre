import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { answers } from "../../src/state/live";
import { canCommit, type Decision } from "../../src/state/needs-model";
import { useNeed } from "../../src/state/needs";
import { useTheme } from "../../src/theme/theme";
import { tokens } from "../../src/theme/tokens";
import { face, type } from "../../src/theme/type";
import { BackButton } from "../../src/ui/BackButton";
import { Button } from "../../src/ui/Button";

/**
 * One item waiting, opened by a tap or by a swipe the box would refuse (a send with no proof on
 * this device yet). It says what answering takes instead of failing quietly. Proving presence
 * from the web app (a passkey) is not in the spike: an item that needs it is approved from the
 * Deck or the Capsule for now.
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
          <Button kind="primary" label={n.source === "gate" && n.kind === "send" ? "Send" : "Approve"} disabled={!approve.ok} onPress={() => done("approve")} />
          <Button kind="ghost" label={n.source === "gate" ? "Discard" : "Deny"} disabled={!reject.ok} onPress={() => done("reject")} />
        </View>
        {!approve.ok ? (
          <Text style={[type.meta, { color: color.text2 }]}>
            {approve.why}. {n.source === "gate" ? "Approve it from the Deck or Lumen for now." : "Answer it in the session."}
          </Text>
        ) : null}
        {n.thread ? (
          <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: "/session/[id]", params: { id: n.thread as string } })} style={styles.link}>
            <Text style={[type.readStrong, { color: color.focus }]}>Open session</Text>
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
