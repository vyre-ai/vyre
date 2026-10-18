import { useEffect, useState } from "react";
import { Card, Row, Text } from "@vyre/ui";
import { recordsApi, type BusyBlock } from "./records-api";
import { busyWords } from "./share-model.js";

/** Other people's private events, as time taken and nothing else (records.busy): a title, a place or a guest never reaches this screen. Draws nothing when there are none or the box lacks the tool. */
export function BusyBlocks() {
  const [rows, setRows] = useState<BusyBlock[]>([]);
  useEffect(() => { let live = true; void recordsApi.busy().then((r) => { if (live) setRows(r.data?.busy ?? []); }); return () => { live = false; }; }, []);
  if (!rows.length) return null;
  return <Card title="Busy">{rows.slice(0, 20).map((b, i) => <Row key={i} dense title={<Text size="body">{busyWords(b)}</Text>} />)}</Card>;
}
