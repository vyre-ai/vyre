import { useMemo, useState } from "react";
import { View } from "react-native";
import { Banner, Card, Select, Text, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { tool } from "../../src/real/box";
import { zoneOptions } from "./zone-model.js";

/** The space's home time zone, for an owner or admin: what its business hours, team meetings and deadlines are read in. Everyone sees their own zone beside it (lib/time does the showing). */
export function ZoneSection({ space, zone, spaceName, onSaved }: { space: string; zone: string | null; spaceName: string; onSaved: (zone: string) => void }) {
  const options = useMemo(() => zoneOptions(zone), [zone]);
  const [problem, setProblem] = useState("");
  const set = async (z: string) => {
    setProblem("");
    try { await tool("spaces.time-zone.set", { space, zone: z }); onSaved(z); showToast(`${spaceName} now keeps ${z}.`); }
    catch (e) { setProblem(e instanceof Error && e.message ? e.message : "That time zone did not save."); }
  };
  return (
    <Sec title="Time zone">
      <Card className="gap-s2">
        <Text tone="muted">{`Times that belong to ${spaceName} (business hours, team meetings, deadlines) are also shown in its zone, beside yours.`}</Text>
        <Select label="Home time zone" value={zone ?? ""} options={options} onChange={(v) => void set(v)} />
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
      </Card>
    </Sec>
  );
}
