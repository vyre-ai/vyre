import { useCallback, useState } from "react";
import { View } from "react-native";
import { Button, Sheet, Text, editField, showToast, titleOf, viewDefOf } from "@vyre/ui";
import type { FieldEnv } from "../../ui/fields/types";
import { callT } from "../../src/real/call-tool";
import { fieldFor, moveInput, needSentence, readNeeds, readyToGo } from "./move-rule.js";
import { plainError } from "../../src/real/error-note.js";

type Ask = { rec: any; def: any; stage: string; needs: string[]; patch: Record<string, any> };

/**
 * Moving a record to a stage, with the one rule: when the stage needs fields that are still empty, nothing is written and a small sheet asks for them ("To move Northwind phase 2 to Proposal sent, fill in: Value, Close date").
 * Continue moves it with those values; Cancel leaves it where it was. `go` answers true when the record moved. The board, the stage strip on a record and a bulk edit all come through here.
 */
export function useMoveStage(env: FieldEnv, onMoved?: () => void) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const go = useCallback(async (rec: any, def: any, stage: string, patch?: Record<string, any>): Promise<boolean> => {
    const r = await callT<any>("records.move", moveInput(rec.urn, stage, patch));
    if (r.error) { showToast(plainError(r.error, "That did not move.")); return false; }
    const needs = readNeeds(r.data);
    if (needs) { setDraft({}); setAsk({ rec, def, stage, needs, patch: patch ?? {} }); return false; }
    onMoved?.();
    return true;
  }, [onMoved]);
  const close = () => { setAsk(null); setDraft({}); };
  const sheet = (
    <Sheet open={!!ask} onClose={close} title="One more step">
      {ask ? (
        <View className="gap-s3">
          <Text tone="muted">{needSentence(titleOf(ask.def, ask.rec, viewDefOf(ask.def)), ask.stage, ask.needs.map((n) => String(fieldFor(ask.def, n).label ?? n)))}</Text>
          {ask.needs.map((n) => {
            const f = fieldFor(ask.def, n);
            return (
              <View key={n} className="gap-s1">
                <Text size="caption" strong tone="label">{String(f.label ?? n)}</Text>
                {editField({ kind: f.kind, definition: f, value: draft[n], mode: "edit", onChange: (v: any) => setDraft((d) => ({ ...d, [n]: v })) }, env)}
              </View>
            );
          })}
          <View className="flex-row gap-s2">
            <Button kind="primary" label="Continue" loading={busy} disabled={busy || !readyToGo(ask.needs, draft)} onPress={async () => {
              setBusy(true);
              const ok = await go(ask.rec, ask.def, ask.stage, { ...ask.patch, ...draft });
              setBusy(false);
              if (ok) close();
            }} />
            <Button kind="ghost" label="Cancel" onPress={close} />
          </View>
        </View>
      ) : null}
    </Sheet>
  );
  return { go, sheet };
}
