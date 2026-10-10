// What happened to this space's lent computers (R031-95): when a chat borrowed one, when one was given its key, when one was refused. One quiet list, shown to the people who may manage the space, and nothing at all when
// nothing has happened. The lines are link's (lease.* on the space's log); the words are lease-model.js.
import { useEffect, useState } from "react";
import { BlockScreen, type BlockScreenData } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { tool } from "../../src/real/box";
import { leaseRows } from "./lease-model.js";

export function ComputersLately({ space }: { space: string }) {
  const [rows, setRows] = useState<ReturnType<typeof leaseRows>>([]);
  useEffect(() => {
    let live = true;
    Promise.all([tool<unknown>("records.events", { record: `vyre://${space}/lease/`, limit: 50 }).catch(() => null), tool<{ devices?: { id: string; name: string }[] }>("relay.devices.all", {}).catch(() => null)]).then(([ev, devs]) => {
      if (!live) return;
      const names = new Map((devs?.devices ?? []).map((d) => [d.id, d.name]));
      setRows(leaseRows(ev, (id) => names.get(id) ?? "", Date.now()));
    });
    return () => { live = false; };
  }, [space]);
  if (!rows.length) return null;
  const screen: BlockScreenData = { v: 2, id: "computers-lately", layout: { block: "l" }, blocks: { l: { type: "list", content: { rows } } } };
  return <Sec title="Your computers, lately"><BlockScreen screen={screen} handlers={{}} /></Sec>;
}
