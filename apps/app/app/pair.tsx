import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Linking from "expo-linking";
import { pair } from "@vyre/relay-client/client.js";
import { connect, disconnect } from "../src/api/box";
import { offerFrom, type Pairing } from "../src/api/pairing";
import { about, deviceName, presenceKey, relayCrypto, relayKeyStore, savePairing } from "../src/api/relay";
import { Screen } from "../src/ui/Screen";
import { useTheme } from "../src/theme/theme";
import { tokens } from "../src/theme/tokens";
import { type } from "../src/theme/type";
import { Button } from "../src/ui/Button";

/** Every client waits the same 90 seconds for the person's Confirm on the other screen (the handshake default is 15). */
const PAIR_WAIT_MS = 90_000;

type State = { at: "pairing" } | { at: "paired"; name: string; presence: boolean } | { at: "failed"; message: string };

/**
 * `vyre://pair?offer=<url-encoded offer>` on the phone, `/app/pair?offer=...` on the web: pair with
 * the box through the relay, keep the pairing, and reconnect over it. The offer is used once.
 */
export default function Pair() {
  const params = useLocalSearchParams<{ offer?: string | string[] }>();
  const link = Linking.useURL();
  const router = useRouter();
  const { color } = useTheme();
  const offer = offerFrom(typeof params.offer === "string" ? params.offer : null) ?? offerFrom(link);
  const [state, setState] = useState<State>({ at: "pairing" });
  const tried = useRef<string | null>(null);

  useEffect(() => {
    if (!offer || tried.current === offer) return;
    tried.current = offer;
    setState({ at: "pairing" });
    void (async () => {
      try {
        const r = (await pair(offer, {
          name: deviceName(),
          presenceKey: await presenceKey(),
          keyStore: relayKeyStore(),
          crypto: relayCrypto(),
          about,
          timeout: PAIR_WAIT_MS, // the box holds a redeem until the screen it came from confirms (up to 60 s)
        })) as Pairing;
        await savePairing(r);
        await disconnect();
        connect().catch(() => {});
        setState({ at: "paired", name: r.name || "your box", presence: Boolean(r.presence?.enrolled) });
      } catch (e) {
        setState({ at: "failed", message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, [offer]);

  const line = !offer
    ? "This link has no pairing code. Make a new one on the box with vyre phone add."
    : state.at === "pairing"
      ? "Pairing with your box"
      : state.at === "paired"
        ? `Paired with ${state.name}`
        : state.message;
  return (
    <Screen title="Pair">
      <View style={styles.body}>
        <Text accessibilityRole="alert" style={[type.read, { color: state.at === "failed" || !offer ? color.text2 : color.text }]}>
          {line}
        </Text>
        {state.at === "paired" && !state.presence ? (
          <Text style={[type.base, { color: color.label }]}>Approvals from this device still ask for a passkey.</Text>
        ) : null}
        {state.at !== "pairing" || !offer ? (
          <View style={styles.action}>
            <Button kind="primary" label="Open Now" onPress={() => router.replace("/")} />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: tokens.layout.gutterPhone, gap: tokens.space[4] },
  action: { alignSelf: "flex-start" },
});
