// The audit: who changed what on a record, with the values before and after, from the signed event log. Owners and admins only (the box refuses anyone else). Built from the library's rows and cards; filters by
// person, project, record type and record. A sealed value is only ever shown as "sealed".
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Card, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Text } from "@vyre/ui";
import { Footnote, Frame } from "../places/Frame";
import { auditReal } from "./real";
import { fieldLines, line, refusal, type Change } from "./model";

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export default function AuditScreen() {
  const [rows, setRows] = useState<Change[] | null>(null);
  const [more, setMore] = useState(false);
  const [cut, setCut] = useState(false);
  const [err, setErr] = useState("");
  const [f, setF] = useState({ person: "", project: "", type: "", record: "" });
  const load = useCallback(() => {
    setErr("");
    auditReal(f).then((r) => { setRows(r.changes); setMore(r.more); setCut(r.truncated); }).catch((e) => setErr(refusal((e as { code?: string }).code, e instanceof Error ? e.message : "")));
  }, [f]);
  useEffect(load, [load]);
  return (
    <Frame title="Audit" sub="Who changed what, with the value before and after.">
      <Footnote icon="sealed">Sealed values are never shown here, only that they changed.</Footnote>
      <Card className="gap-s3">
        <Field label="Person" value={f.person} onChangeText={(person) => setF({ ...f, person })} placeholder="A person's id" />
        <Field label="Project" value={f.project} onChangeText={(project) => setF({ ...f, project })} placeholder="A project's id" />
        <Field label="Record type" value={f.type} onChangeText={(type) => setF({ ...f, type })} placeholder="For example contact" />
        <Field label="Record" value={f.record} onChangeText={(record) => setF({ ...f, record })} placeholder="A record's address" />
      </Card>
      {err ? <Card flush><ErrorState title="The audit did not load" reason={err} retry={load} /></Card> : null}
      {!err && rows === null ? <LoadingState rows={4} /> : null}
      {!err && rows && !rows.length ? <EmptyState title="Nothing changed that matches" body="Change a filter, or come back after someone edits a record." /> : null}
      {!err && rows && rows.length ? (
        <Card flush>
          {rows.map((c, i) => (
            <View key={c.seq}>{i ? <Divider /> : null}
              <Row title={line(c)} sub={`${when(c.time)} · ${fieldLines(c).join(" · ") || "no field values"}`} />
            </View>
          ))}
        </Card>
      ) : null}
      {cut ? <Text size="caption" tone="muted">Only the most recent part of the log was searched. Changes older than that are not shown here.</Text> : null}
      {more ? <Text size="caption" tone="muted">There are older changes. Narrow the filters to reach them.</Text> : null}
    </Frame>
  );
}
