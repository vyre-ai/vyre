// An agent's standing permissions, in the chat panel's Details: what it may do by itself, with a Take back button on each. Giving one is done where the act is held, not here.
import { useCallback, useEffect, useState } from "react";
import { Button, Row, Text, showToast } from "@vyre/ui";
import { callT } from "../real/call-tool";
import { standingRows, type StandingRow } from "../../screens/chat-tools/standing-model.js";

export function StandingRows({ agent }: { agent: string }) {
  const [rows, setRows] = useState<StandingRow[] | null>(null);
  const load = useCallback(() => { void callT("gate.standing.list", { agent }).then((r) => setRows(r.error ? [] : standingRows(r.data))); }, [agent]);
  useEffect(load, [load]);
  const take = async (id: string) => { const r = await callT("gate.standing.revoke", { id }); if (r.error) showToast(r.error.message || "That did not go through."); else { showToast("Taken back."); load(); } };
  if (rows === null) return null;
  if (!rows.length) return <Text tone="muted" size="caption">{`${agent} asks before it sends, posts or pays.`}</Text>;
  return <>{rows.map((r) => <Row key={r.id} dense title={r.title} sub={r.sub} end={<Button size="sm" kind="secondary" label="Take back" onPress={() => void take(r.id)} />} />)}</>;
}
