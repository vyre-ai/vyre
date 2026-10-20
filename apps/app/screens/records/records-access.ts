// What this person may do in Records, so a screen shows only the buttons the server will take (the product map's "Show only what the person may do"): `admin` is an owner or an admin of the Space
// showing (the sidebar's own answer, core/sidebar), `joined` is a team this device joined as a member, whose calls go through the team's door. Filling a sealed value, seeing a record as the assistant and
// deleting for good have no door row (core/work/member-tools.js): they stay on the person's own server, so a joined team never shows them. The sample world shows everything.
import { useEffect, useState } from "react";
import { MOCK } from "../../src/real/box";
import { useSidebar } from "../shell/sidebar";
import { useSpaces } from "../shell/state";

export function useRecordsAccess(): { admin: boolean; joined: boolean; ownServer: boolean } {
  const canSetDefault = useSidebar((s) => s.canSetDefault);
  const space = useSpaces((s) => s.space);
  const [joined, setJoined] = useState(false);
  useEffect(() => {
    let live = true;
    if (MOCK) { setJoined(false); return; }
    void import("../../src/real/team-join").then((m) => m.joinedHere(String(space ?? ""))).then((j) => { if (live) setJoined(j); }).catch(() => { if (live) setJoined(false); });
    return () => { live = false; };
  }, [space]);
  const admin = MOCK || canSetDefault;
  return { admin, joined, ownServer: admin && !joined };
}
