import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { answers } from "../../src/state/live";
import { canCommit, type Decision } from "../../src/state/needs-model";
import { useNeed } from "../../src/state/needs";
import { MONO } from "../../src/theme/fonts";
import { useTheme } from "../../src/theme/theme";
import { tokens } from "../../src/theme/tokens";

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
        <Back onPress={() => router.back()} />
        <Text style={[styles.body, { color: color.label, padding: tokens.layout.gutterPhone }]}>Answered, or no longer waiting.</Text>
      </View>
    );
  }
  const approve = canCommit(n, "approve");
  const reject = canCommit(n, "reject");
  const who = [n.agent, n.project].filter(Boolean).join(" · ");
  return (
    <View style={[styles.page, { backgroundColor: color.bg, paddingTop: insets.top }]}>
      <Back onPress={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: color.text }]}>{n.title}</Text>
        {who ? <Text style={[styles.meta, { color: color.label }]}>{who}</Text> : null}
        {n.to?.length ? <Field label="To" value={n.to.join(", ")} /> : null}
        <Field label={n.source === "gate" ? "What" : "Step"} value={n.detail} mono={n.mono} />
        {n.why ? <Field label="Why" value={n.why} /> : null}
        {n.error ? <Field label="Last try" value={n.error} /> : null}
        <View style={styles.buttons}>
          <Pressable
            accessibilityRole="button"
            disabled={!approve.ok}
            onPress={() => done("approve")}
            style={[styles.btn, { backgroundColor: approve.ok ? color.primaryBg : color.hover }]}
          >
            <Text style={[styles.btnText, { color: approve.ok ? color.primaryInk : color.label }]}>{n.source === "gate" && n.kind === "send" ? "Send" : "Approve"}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={!reject.ok} onPress={() => done("reject")} style={styles.btn}>
            <Text style={[styles.btnText, { color: color.text }]}>{n.source === "gate" ? "Discard" : "Deny"}</Text>
          </Pressable>
        </View>
        {!approve.ok ? (
          <Text style={[styles.meta, { color: color.text2 }]}>
            {approve.why}. {n.source === "gate" ? "Approve it from the Deck or the Capsule for now." : "Answer it in the session."}
          </Text>
        ) : null}
        {n.thread ? (
          <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: "/session/[id]", params: { id: n.thread as string } })} style={styles.link}>
            <Text style={[styles.btnText, { color: color.focus }]}>Open session</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Back({ onPress }: { onPress: () => void }) {
  const { color } = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.back}>
      <Text style={[styles.btnText, { color: color.text2 }]}>Back</Text>
    </Pressable>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { color } = useTheme();
  return (
    <View style={[styles.field, { borderTopColor: color.rule }]}>
      <Text style={[styles.meta, { color: color.label }]}>{label}</Text>
      <Text selectable style={[styles.body, mono && { fontFamily: MONO }, { color: color.text }]}>{value}</Text>
    </View>
  );
}

const phone = tokens.type.phone;
const styles = StyleSheet.create({
  page: { flex: 1 },
  back: { height: tokens.layout.phoneHeader, justifyContent: "center", paddingHorizontal: tokens.layout.gutterPhone },
  content: { padding: tokens.layout.gutterPhone, gap: tokens.space[4] },
  title: { fontSize: phone.title[0], lineHeight: phone.title[1], fontWeight: tokens.font.weight.strong },
  meta: { fontSize: phone.meta[0], lineHeight: phone.meta[1] },
  body: { fontSize: phone.read[0], lineHeight: phone.read[1] },
  field: { gap: tokens.space[1], paddingTop: tokens.space[4], borderTopWidth: StyleSheet.hairlineWidth },
  buttons: { flexDirection: "row", gap: tokens.space[4], paddingTop: tokens.space[4] },
  btn: { height: tokens.control.touch, paddingHorizontal: tokens.space[5], borderRadius: tokens.radius.buttonTouch, justifyContent: "center" },
  btnText: { fontSize: phone.read[0], lineHeight: phone.read[1], fontWeight: tokens.font.weight.strong },
  link: { height: tokens.control.touch, justifyContent: "center" },
});
