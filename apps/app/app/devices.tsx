import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { about } from "../src/api/relay";
import { refreshDevices, setTrust, useDevices, useDevicesError, useSelf, useTrust } from "../src/state/devices";
import { expiryText, kindText, pathText, powersText, rowChoice, seenText, type Device, type Trust } from "../src/state/devices-model";
import { useTheme } from "../src/theme/theme";
import { tokens } from "../src/theme/tokens";
import { Button } from "../src/ui/Button";
import { Empty, Screen } from "../src/ui/Screen";

/**
 * The Devices place: every device paired through the relay (relay.devices.list), how it reaches
 * the box now, when it was last seen, and for a browser its trust (the TrustBrowser board, 4).
 */
export default function Devices() {
  const devices = useDevices();
  const error = useDevicesError();
  const trust = useTrust();
  const self = useSelf();
  const { color } = useTheme();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    void refreshDevices();
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  if (!devices) {
    return (
      <Screen title="Devices" back>
        <Empty text={error ? `The box did not answer: ${error}` : " "} />
      </Screen>
    );
  }
  // This device first, then the rest as the box lists them.
  const list = [...devices].sort((a, b) => Number(b.id === self) - Number(a.id === self));
  return (
    <Screen title="Devices" back>
      <ScrollView contentContainerStyle={styles.page}>
        {trust === "untrusted" ? (
          <Text style={[styles.meta, { color: color.text2 }]}>This browser is limited. Trust changes are made from your Mac or phone.</Text>
        ) : null}
        {list.length === 0 ? <Text style={[styles.body, { color: color.label }]}>No devices paired through the relay yet.</Text> : null}
        {list.map((d) => (
          <DeviceRow key={d.id} d={d} self={d.id === self} viewer={trust} now={now} />
        ))}
      </ScrollView>
    </Screen>
  );
}

function DeviceRow({ d, self, viewer, now }: { d: Device; self: boolean; viewer: Trust; now: number }) {
  const { color } = useTheme();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const c = rowChoice(d, viewer);
  const powers = powersText(d);
  const expiry = expiryText(d);
  const mine = self ? (about.kind === "web" ? "This browser" : "This device") : null;
  const onTrust = async () => {
    if (!c.control) return;
    setBusy(true);
    setSaid(await setTrust(d.id, c.control.trusted));
    setBusy(false);
  };
  return (
    <View testID="device-row" style={[styles.row, { borderTopColor: color.rule }]}>
      <View style={styles.line}>
        <Text numberOfLines={1} style={[styles.strong, styles.name, { color: color.text }]}>{d.name}</Text>
        {mine ? <Text style={[styles.meta, { color: color.label }]}>{mine}</Text> : null}
        {c.badge ? (
          <View style={[styles.badge, { borderColor: color.ruleStrong }]}>
            <Text style={[styles.meta, { color: color.text2 }]}>{c.badge}</Text>
          </View>
        ) : null}
      </View>
      {c.warning ? <Text style={[styles.base, { color: color.text }]}>{c.warning}</Text> : null}
      <Text style={[styles.base, { color: color.text2 }]}>{[kindText(d), pathText(d)].join(" · ")}</Text>
      {powers ? <Text style={[styles.base, { color: color.text2 }]}>{powers}</Text> : null}
      <Text style={[styles.meta, { color: color.label }]}>
        {[seenText(d, now), d.kind === "web" ? (d.build === "unknown" ? `Release ${d.release ?? "unknown"} · not in this box's releases` : "Build known") : null, expiry]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {c.control ? (
        <View style={styles.control}>
          <Button kind={c.control.style} label={c.control.label} disabled={busy} onPress={onTrust} testID="device-trust" />
          <Text style={[styles.meta, { color: color.label }]}>{c.control.note}</Text>
        </View>
      ) : null}
      {said ? <Text style={[styles.meta, { color: color.text2 }]}>{said}</Text> : null}
    </View>
  );
}

const phone = tokens.type.phone;
const styles = StyleSheet.create({
  page: { padding: tokens.layout.gutterPhone, gap: tokens.space[4], maxWidth: tokens.layout.content, width: "100%" },
  row: { gap: tokens.space[2], paddingTop: tokens.space[4], borderTopWidth: StyleSheet.hairlineWidth },
  line: { flexDirection: "row", alignItems: "center", gap: tokens.space[3] },
  name: { flexShrink: 1 },
  badge: { borderWidth: 1, borderRadius: tokens.radius.chip, paddingHorizontal: tokens.space[2] },
  control: { flexDirection: "row", alignItems: "center", gap: tokens.space[4], paddingTop: tokens.space[2] },
  strong: { fontSize: phone.read[0], lineHeight: phone.read[1], fontWeight: tokens.font.weight.strong },
  body: { fontSize: phone.read[0], lineHeight: phone.read[1] },
  base: { fontSize: phone.base[0], lineHeight: phone.base[1] },
  meta: { fontSize: phone.meta[0], lineHeight: phone.meta[1] },
});
