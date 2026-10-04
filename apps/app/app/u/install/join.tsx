import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { InstallScreen } from "../../../screens/install/InstallScreen";
import { takeJoin } from "../../../src/shell/join-hold.js";

export default function InstallJoin() {
  const { from } = useLocalSearchParams<{ from?: string }>();
  const [link] = useState(() => takeJoin() ?? undefined);
  return <InstallScreen start="join" link={link} external={from === "link" || !!link} />;
}
