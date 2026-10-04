import { useEffect, useState, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Banner, Text } from "@vyre/ui";
import { sessionNotice, snapshot, subscribe } from "../../src/auth/notice.js";

/** What the person is told about their sign-in on this device (a browser that will not keep it, a session ending soon or ended). Web only; a phone keeps its key in the Keychain. */
export function SessionNotice() {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  if (Platform.OS !== "web") return null;
  const n = sessionNotice(s, now);
  return n ? <Banner tone={n.tone === "warn" ? "warn" : undefined}><Text>{n.text}</Text></Banner> : null;
}
