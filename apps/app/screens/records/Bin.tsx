import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, LoadingState, Row, Sheet, Text, showToast, titleOf } from "@vyre/ui";
import { tool } from "../../src/real/box";
import { plainError } from "../../src/real/error-note.js";
import { recordsApi } from "./records-api";
import { binLine } from "./bin-model.js";

/**
 * The Bin of one type: the records this person deleted (an owner or an admin sees everyone's), each with Restore, and, on the person's own server for an owner or an admin, Delete for good. Nothing is
 * purged on a timer, so it says they stay until someone acts. Delete for good is records.forget: permanent, approved on the phone.
 */
export function Bin({ def, plural, canForget, onChanged }: { def: any; plural: string; canForget: boolean; onChanged: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [problem, setProblem] = useState("");
  const [forgetting, setForgetting] = useState<null | { rec: any; busy: boolean; problem: string }>(null);
  const load = useCallback(() => {
    setProblem("");
    void recordsApi.bin(def.name).then((r) => { if (r.error) { setRows([]); setProblem(plainError(r.error, "The bin did not load.")); } else setRows(r.data?.rows ?? []); });
  }, [def.name]);
  useEffect(() => { setRows(null); load(); }, [load]);
  const restore = async (rec: any) => {
    const r = await recordsApi.restore(rec.urn);
    if (r.error) { showToast(plainError(r.error, "That did not come back.")); return; }
    showToast(`${titleOf(def, rec)} is back.`);
    load(); onChanged();
  };
  const forget = () => {
    if (!forgetting) return;
    const rec = forgetting.rec;
    setForgetting({ ...forgetting, busy: true, problem: "" });
    tool("records.forget", { urn: rec.urn }).then(() => { setForgetting(null); showToast(`${titleOf(def, rec)} is deleted for good.`); load(); }).catch((e) => setForgetting({ rec, busy: false, problem: plainError(e, "That did not work.") }));
  };
  if (!rows) return <LoadingState rows={3} />;
  return (
    <View className="gap-s3">
      <Text size="caption" tone="label">{`Deleted ${plural.toLowerCase()} stay here until someone brings them back or deletes them for good.`}</Text>
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      {rows.length ? (
        <Card flush>
          {rows.map((rec, i) => (
            <View key={rec.urn ?? rec.id}>
              {i ? <Divider /> : null}
              <Row title={titleOf(def, rec)} sub={binLine(rec.deleted_at, Date.now())} end={
                <View className="flex-row items-center gap-s2">
                  <Button kind="secondary" size="sm" label="Restore" onPress={() => void restore(rec)} />
                  {canForget ? <Button kind="ghost" size="sm" label="Delete for good..." onPress={() => setForgetting({ rec, busy: false, problem: "" })} /> : null}
                </View>
              } />
            </View>
          ))}
        </Card>
      ) : <Card><EmptyState title="The bin is empty" body={`Deleted ${plural.toLowerCase()} show here.`} /></Card>}
      <Sheet open={!!forgetting} onClose={() => setForgetting(null)} title={forgetting ? `Delete ${titleOf(def, forgetting.rec)} for good?` : undefined}>
        {forgetting ? (
          <View className="gap-s3">
            <Text tone="muted">It cannot be undone. The text of every task about it is emptied, the record and its history are destroyed, its events lose their data and any sealed values are destroyed. Files linked to it stay in Files.</Text>
            <Text tone="muted">You approve it with your phone. An agent can only propose it.</Text>
            {forgetting.problem ? <Banner tone="warn">{forgetting.problem}</Banner> : null}
            <View className="flex-row gap-s2">
              <Button kind="primary" label="Delete for good" loading={forgetting.busy} disabled={forgetting.busy} onPress={forget} />
              <Button kind="ghost" label="Cancel" onPress={() => setForgetting(null)} />
            </View>
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}
