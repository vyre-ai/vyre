import { useEffect, useState } from "react";
import { useConnection, useLastSeen } from "../state/connection";
import { offlineNotice } from "../state/offline-model.js";
import { Banner } from "./Banner";
import { allowsMock } from "@vyre/ui";
import { loadPairing } from "../api/relay";

/**
 * "Your server has been offline since 14:02" with what to check, above the page, when the app cannot reach its server for a minute or more (always-online). One fact, no action: the app keeps trying on its own.
 */
export function OfflineBar() {
  const status = useConnection();
  const lastSeen = useLastSeen();
  const [now, setNow] = useState(() => Date.now());
  // Only a server this app is paired to can be offline: asked again on every tick, so a pairing made or forgotten while the app is open is noticed.
  const [paired, setPaired] = useState(false);
  useEffect(() => {
    let live = true;
    const look = () => { void loadPairing().then((p) => { if (live) setPaired(!!p); }).catch(() => { if (live) setPaired(false); }); };
    look();
    const t = setInterval(() => { setNow(Date.now()); look(); }, 15_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const n = offlineNotice({ status, lastSeen, now, paired });
  // the sample world has no server to be offline from
  if (allowsMock()) return null;
  return n ? <Banner live fact={n.fact} detail={n.detail} /> : null;
}
