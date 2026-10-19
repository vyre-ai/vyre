// The page GitHub's sign-in sends the browser back to: the relay puts a one-use ticket in the URL fragment. This page keeps it, clears the fragment from history, and sends the tab back
// to the page the sign-in started on, which finishes it (src/identity/github-return.js). A window this browser did not start a sign-in in (an older popup) just closes.
import { useEffect } from "react";
import { Stack, Text } from "@vyre/ui";
import { landReturn } from "../src/identity/github-return.js";

export default function GithubReturn() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    try { window.history.replaceState(null, "", window.location.pathname); } catch { /* none */ }
    let store: Storage | null = null;
    try { store = localStorage; } catch { /* no storage: the sign-in cannot finish here */ }
    const back = landReturn(store, hash, Date.now());
    if (back) { window.location.replace(back); return; }
    setTimeout(() => { try { window.close(); } catch { /* the person closes it */ } }, 150);
  }, []);
  return <Stack><Text>Back from GitHub. Taking you to Vyre.</Text></Stack>;
}
