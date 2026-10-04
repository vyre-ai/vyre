// "See as code" on a Flow: the version as text, editable. Check says what would change (flows.compile-text against this Flow), Save as a new version stores a draft
// (flows.define with the Flow's id) that waits for approval above. Nothing runs until a person approves a version.
import { useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Field, Text, showToast } from "@vyre/ui";
import { Block } from "../places/Page";
import { effectLines, engineerRefusal, problemLine, verdict, warnLine, type Checked } from "./engineer-model";
import { checkFlowText, flowCode, saveFlowText } from "./engineer";

export function FlowCode({ id, version, onSaved }: { id: string; version: number; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [orig, setOrig] = useState("");
  const [res, setRes] = useState<(Checked & { changes?: string[] }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const said = (e: unknown) => engineerRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");
  const show = () => {
    setOpen(!open);
    if (!open && text === null) flowCode(id, version).then((c) => { setText(c.text); setOrig(c.text); }).catch((e) => setErr(said(e)));
  };
  const check = () => { setBusy(true); setErr(""); checkFlowText(text ?? "", id).then(setRes).catch((e) => setErr(said(e))).finally(() => setBusy(false)); };
  const save = () => {
    setBusy(true); setErr("");
    saveFlowText(text ?? "", id).then((d) => { if (d.ok) { showToast("Saved as a new version. It waits for your approval."); setOrig(text ?? ""); setRes(null); onSaved(); } else setRes({ ok: false, errors: d.errors ?? [{ message: "That did not save." }] }); }).catch((e) => setErr(said(e))).finally(() => setBusy(false));
  };
  const changed = text !== null && text !== orig;
  return (
    <View className="gap-s2">
      <View className="self-start"><Button kind="ghost" size="sm" icon={open ? "chev-d" : "chev-r"} label="See as code" onPress={show} /></View>
      {open ? (
        <Card>
          <View className="gap-s3">
            {text === null && !err ? <Text tone="muted">Loading.</Text> : null}
            {text !== null ? <Field label="The Flow, as text" multiline lines={12} value={text} onChangeText={(t) => { setText(t); setRes(null); }} /> : null}
            {text !== null ? (
              <View className="flex-row flex-wrap gap-s2">
                <Button label={busy ? "Working" : "Check"} onPress={busy || !changed ? () => {} : check} />
                <Button kind="primary" label="Save as a new version" onPress={busy || !changed ? () => {} : save} />
              </View>
            ) : null}
            {err ? <Banner tone="warn"><Text>{err}</Text></Banner> : null}
            {res ? (
              <View className="gap-s2">
                <Text strong>{verdict(res).title}</Text>
                {res.errors.map((p, i) => <Text key={i} tone="warn">{problemLine(p)}</Text>)}
                {(res.warnings ?? []).map((w, i) => <Text key={i} tone="muted">{warnLine(w)}</Text>)}
                {res.ok && (res.changes ?? []).length ? <Block label="What changes">{(res.changes ?? []).join("\n")}</Block> : null}
                {res.ok && effectLines(res.effects).length ? <Block label="What it would do">{effectLines(res.effects).join("\n")}</Block> : null}
              </View>
            ) : null}
          </View>
        </Card>
      ) : null}
    </View>
  );
}
