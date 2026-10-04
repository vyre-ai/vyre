import { useEffect, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { InstallScreen } from "../../../screens/install/InstallScreen";
import { takeJoin } from "../../../src/shell/join-hold.js";

export default function InstallJoin() {
  const { from, link: queryLink } = useLocalSearchParams<{ from?: string; link?: string }>();
  const router = useRouter();
  // Only the in-memory hold fills the field. A `link` in this route's own query is ignored, and the router (which owns the address on the web) drops it.
  const [link] = useState(() => takeJoin() ?? undefined);
  const [external] = useState(() => from === "link" || !!link);
  useEffect(() => {
    if (queryLink === undefined && from === undefined) return;
    const t = setTimeout(() => router.replace("/u/install/join" as never), 0);
    return () => clearTimeout(t);
  }, []);
  return <InstallScreen start="join" link={link} external={external} />;
}
