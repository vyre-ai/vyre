import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { InstallScreen } from "../../../screens/install/InstallScreen";
import { cleanAddress, takeJoin } from "../../../src/shell/join-hold.js";

export default function InstallJoin() {
  const { from } = useLocalSearchParams<{ from?: string }>();
  // Only the in-memory hold fills the field: a `link` in this route's own query is ignored and taken out of the address.
  const [link] = useState(() => takeJoin() ?? undefined);
  useEffect(() => { if (Platform.OS === "web" && typeof window !== "undefined" && window.location.search.includes("link=")) { try { window.history.replaceState(null, "", cleanAddress(window.location.href)); } catch { /* nothing to clean */ } } }, []);
  return <InstallScreen start="join" link={link} external={from === "link" || !!link} />;
}
