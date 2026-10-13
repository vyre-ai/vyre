import { useEffect, useState } from "react";
import { Text } from "@vyre/ui";
import { peerWanted } from "../../src/real/peer";
import { useSpaces } from "../shell/state";
import { serverLine } from "./server-line.js";

/** Says which server a screen acts on, when this device is paired to several. Draws nothing with one server, or where the device has no server of its own. */
export function ServerLine() {
  const showing = useSpaces((s) => s.space);
  const [line, setLine] = useState("");
  useEffect(() => {
    let live = true;
    if (!peerWanted()) { setLine(""); return; }
    void (async () => {
      const { listPairings, loadPairing } = await import("../../src/api/relay");
      const { refreshSpaceServers } = await import("../../src/real/space-servers");
      const [pairings, active, map] = await Promise.all([listPairings(), loadPairing(), refreshSpaceServers()]);
      if (live) setLine(serverLine({ pairings, spaceServers: map, showing, active: active?.box ?? null }));
    })().catch(() => { if (live) setLine(""); });
    return () => { live = false; };
  }, [showing]);
  return line ? <Text tone="muted" size="caption">{line}</Text> : null;
}
