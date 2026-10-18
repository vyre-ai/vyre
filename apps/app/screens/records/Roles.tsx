import { useEffect, useState } from "react";
import { View } from "react-native";
import { Chip } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { roleChips, summaryChips } from "./roles-model.js";

const NAMED: Record<string, "warn" | "ok" | "accent" | "err"> = { lead: "warn", client: "ok", partner: "accent", vendor: "err" };
const toneFor = (c: { ended: boolean; tone: string }) => (c.ended ? "plain" : ((NAMED[c.tone] ?? c.tone) as "plain"));

/** What a contact or organization is to the Space (records.roles): "Lead · Talking", "Client · Active", ended ones last and quiet. A role opens its own record, where its stage and fields live. */
export function Roles({ urn, onOpen }: { urn: string; onOpen: (urn: string) => void }) {
  const [chips, setRows] = useState<{ key: string; label: string; urn: string; ended: boolean; tone: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    setRows(null);
    // the summary has each role's label and colour; a box without it answers records.roles, which has the role and its stage
    void callT<{ roles: any[] }>("records.roles.summary", { urn }).then((r) => {
      if (r.data) { if (live) setRows(summaryChips(r.data.roles)); return; }
      return callT<{ roles: any[] }>("records.roles", { urn }).then((q) => { if (live) setRows(roleChips(q.data?.roles ?? [])); });
    });
    return () => { live = false; };
  }, [urn]);
  if (!chips || !chips.length) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-s2">
      {chips.map((c) => <Chip key={c.key} tone={toneFor(c)} onPress={c.urn ? () => onOpen(c.urn) : undefined}>{c.ended ? `${c.label} (ended)` : c.label}</Chip>)}
    </View>
  );
}
