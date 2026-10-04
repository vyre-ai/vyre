import { useEffect, useState } from "react";
import { boxOrigin } from "../api/box";
import { loadPairing } from "../api/relay";
import { deviceKindHere } from "../real/pair-say";
import { gapOf, type EmptyCopy } from "../../screens/install/first-run.js";
import { useDevices } from "./devices";

/**
 * What is missing on this device, or null (first-run.js gapOf): a phone or browser with no Vyre to talk to, or a Mac with no phone to approve.
 * Read once from the stored pairing and then from the box's own device list, so a landing screen can say what to do instead of showing nothing.
 */
export function useGap(): EmptyCopy | null {
  const [paired, setPaired] = useState<boolean | null>(null);
  const devices = useDevices();
  useEffect(() => { let live = true; void loadPairing().then((p) => { if (live) setPaired(!!p); }).catch(() => { if (live) setPaired(false); }); return () => { live = false; }; }, []);
  if (paired === null) return null;
  return gapOf({ kind: deviceKindHere(), paired, hasBox: boxOrigin() !== "", devices: (devices ?? null) as { device?: string; kind?: string }[] | null });
}
