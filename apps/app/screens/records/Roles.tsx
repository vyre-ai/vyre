import { useEffect, useState } from "react";
import { View } from "react-native";
import { Chip } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { roleChips } from "./roles-model.js";

/** What a contact or organization is to the Space (records.roles): "Lead · Talking", "Client · Active", ended ones last and quiet. A role opens its own record, where its stage and fields live. */
export function Roles({ urn, onOpen }: { urn: string; onOpen: (urn: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    let live = true;
    setRows(null);
    void callT<{ roles: any[] }>("records.roles", { urn }).then((r) => { if (live) setRows(r.data?.roles ?? []); });
    return () => { live = false; };
  }, [urn]);
  const chips = roleChips(rows ?? []);
  if (!chips.length) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-s2">
      {chips.map((c) => <Chip key={c.key} tone={c.ended ? "plain" : c.tone === "lead" ? "warn" : c.tone === "client" ? "ok" : "plain"} onPress={c.urn ? () => onOpen(c.urn) : undefined}>{c.ended ? `${c.label} (ended)` : c.label}</Chip>)}
    </View>
  );
}
