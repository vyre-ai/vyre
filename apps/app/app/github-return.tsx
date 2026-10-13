// The page GitHub's sign-in sends the browser back to: the relay puts a one-use ticket in the URL fragment. This page hands it to the window that opened it and closes, and clears the fragment from history.
import { useEffect } from "react";
import { Stack, Text } from "@vyre/ui";

export default function GithubReturn() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    try { window.history.replaceState(null, "", window.location.pathname); } catch { /* none */ }
    try { localStorage.setItem("vyre.gh.return", hash); } catch { /* no storage: the opener times out and says so */ }
    setTimeout(() => { try { window.close(); } catch { /* the person closes it */ } }, 150);
  }, []);
  return <Stack><Text>You can close this window and go back to Vyre.</Text></Stack>;
}
