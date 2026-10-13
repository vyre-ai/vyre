// Share a Flow with a person: "Can use" (run it, see it) or "Can edit". A real build calls flows.access.get and flows.access.set (kernel grants on that Flow); the sample build keeps the levels in memory
// and also offers teams and roles, which the engine does not take yet.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Row, Select, Sheet, Text, allowsMock, showToast } from "@vyre/ui";
import type { FlowOptions } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { useSpaces } from "../shell/state";
import { useFlowsState } from "./store";

const LEVELS: [string, string][] = [["", "No access"], ["use", "Can use"], ["edit", "Can edit"]];

type Row = { id: string; label: string };

/** Who a real Flow is shared with, and the people it can be shared with (the Space's members). */
function useRealAccess(id: string, open: boolean) {
  const space = useSpaces((s) => s.space);
  const [people, setPeople] = useState<Row[]>([]);
  const [levels, setLevels] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open || allowsMock()) return;
    let live = true;
    (async () => {
      const [acc, mem] = await Promise.all([callT<{ access?: { subject: string; level: string }[] }>("flows.access.get", { id }), callT<any>("spaces.members.list", { space })]);
      if (!live) return;
      if (acc.error) { setErr(acc.error.message); return; }
      setLevels(Object.fromEntries((acc.data?.access ?? []).map((a) => [a.subject, a.level])));
      const rows: any[] = Array.isArray(mem.data) ? mem.data : Array.isArray(mem.data?.members) ? mem.data.members : [];
      setPeople(rows.filter((m) => m.role !== "owner").map((m) => ({ id: String(m.person), label: String(m.name || m.displayName || m.role_label || m.person) })));
    })();
    return () => { live = false; };
  }, [id, open, space]);
  const set = async (person: string, level: string) => {
    const r = await callT("flows.access.set", { id, kind: "person", subject: person, level: level || null });
    if (r.error) { showToast(r.error.message); return; }
    setLevels((l) => ({ ...l, [person]: level }));
  };
  return { people, levels, err, set };
}

export function ShareFlow({ id, options }: { id: string; options: FlowOptions | null }) {
  const [open, setOpen] = useState(false);
  const { shares, setShare } = useFlowsState();
  const real = useRealAccess(id, open);
  const mock = allowsMock();
  const mine = shares[id] ?? {};
  const who: Row[] = mock ? [...(options?.roles ?? []).map((r) => ({ id: `role:${r.name}`, label: `A team or role: ${r.label}` })), ...(options?.people ?? []).map((p) => ({ id: `person:${p.name}`, label: p.label }))] : real.people;
  const level = (k: string) => (mock ? mine[k] : real.levels[k]) ?? "";
  const pick = (k: string, l: string) => (mock ? setShare(id, k, l) : real.set(k, l));
  return (
    <>
      <View className="self-start"><Button kind="secondary" size="sm" icon="share" label="Share" onPress={() => setOpen(true)} /></View>
      <Sheet open={open} onClose={() => setOpen(false)} title="Share this Flow">
        <View className="gap-s3">
          <Text tone="muted">Can use: run it and see it. Can edit: change its steps too. Only its creator, an owner or an admin shares it.</Text>
          {!mock && real.err ? <Banner tone="warn" icon="info"><Text>{real.err}</Text></Banner> : null}
          {who.map((w) => (
            <Row key={w.id} dense title={w.label} end={<View style={{ width: 150 }}><Select value={level(w.id)} options={LEVELS} onChange={(l) => pick(w.id, l)} /></View>} />
          ))}
          {!mock && !real.err && !who.length ? <Text tone="muted">There is nobody else in this space to share it with yet.</Text> : null}
          {!mock ? <Text size="caption" tone="label">Sharing with a team or role comes later: today a Flow is shared with people.</Text> : null}
          <View className="self-start"><Button kind="primary" label="Done" onPress={() => setOpen(false)} /></View>
        </View>
      </Sheet>
    </>
  );
}
