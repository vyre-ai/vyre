import { useEffect } from "react";
import { Platform } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { joinLink } from "../src/shell/join-link.js";
import { cleanAddress, holdJoin, linkFromHash } from "../src/shell/join-hold.js";

/**
 * `vyre://join?link=<link>` on the phone, `/app/join?link=...` on the web (JL-1, JL-2). The token is read once, kept in memory, and taken out of the address at once
 * (history.replaceState on the web, a replace to the plain Join route everywhere); the page asks for no referrer. A link that comes from outside is untrusted:
 * only an https join path goes on, and the invite card it opens names the space and asks the person to confirm before anything is joined.
 */
export default function Join() {
  const { link } = useLocalSearchParams<{ link?: string | string[] }>();
  const router = useRouter();
  useEffect(() => {
    // The fragment form never leaves the browser; the query form is still read (an older page) and removed at once.
    const fromHash = Platform.OS === "web" && typeof window !== "undefined" ? linkFromHash(window.location.hash) : null;
    const good = joinLink(fromHash ?? link);
    if (good) holdJoin(good);
    if (Platform.OS === "web" && typeof document !== "undefined") {
      const m = document.createElement("meta"); m.name = "referrer"; m.content = "no-referrer"; document.head.appendChild(m);
      try { window.history.replaceState(null, "", cleanAddress(window.location.href)); } catch { /* the replace below still drops the query */ }
    }
    router.replace((good ? "/u/install/join?from=link" : "/u/install/join") as never);
  }, []);
  return null;
}
