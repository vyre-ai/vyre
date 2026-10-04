import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Banner, Text } from "@vyre/ui";
import { sessionNotice, snapshot, subscribe } from "../../src/auth/notice.js";

/** What the person is told about their sign-in on this device (a browser that will not keep it, or a renewal that failed). Web only; a phone keeps its key in the Keychain. */
export function SessionNotice() {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (Platform.OS !== "web") return null;
  const n = sessionNotice(s);
  return n ? <Banner tone={n.tone === "warn" ? "warn" : undefined}><Text>{n.text}</Text></Banner> : null;
}
