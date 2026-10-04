// Write a Flow in text, on the real box: Check (flows.compile-text), then Save as a draft (flows.define), then the Flow's own page shows its card and the approval.
// The @Engineer chat (an assistant that writes it from plain words) is not here: it needs an assistant and its thread, which is not wired.
import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, Field, Text, showToast } from "@vyre/ui";
import { Block } from "../places/Page";
import { Frame } from "../places/Frame";
import { effectLines, engineerRefusal, flowHref, problemLine, verdict, warnLine, type Checked } from "./engineer-model";
import { checkFlowText, saveFlowText } from "./engineer";

export function RealEngineer() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [res, setRes] = useState<Checked | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const said = (e: unknown) => engineerRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");
  const check = () => { setBusy(true); setErr(""); checkFlowText(text).then(setRes).catch((e) => setErr(said(e))).finally(() => setBusy(false)); };
  const save = () => {
    setBusy(true); setErr("");
    saveFlowText(text).then((d) => { const href = flowHref(d); if (href) { showToast("Saved as a draft. Nothing runs until you approve it."); router.push(href as never); } else setRes({ ok: false, errors: d.errors ?? [{ message: "That did not save." }] }); }).catch((e) => setErr(said(e))).finally(() => setBusy(false));
  };
  const v = res ? verdict(res) : null;
  return (
    <Frame back="/u/flows" title="Write a Flow" sub="A Flow in text. Nothing runs until a person approves a version.">
      <View className="flex-row flex-wrap items-center gap-s2"><Chip>Can change definitions</Chip><Chip>Cannot send, pay or read the vault</Chip></View>
      <Card>
        <View className="gap-s3">
          <Field label="The Flow, as text" multiline lines={12} value={text} onChangeText={(t) => { setText(t); setRes(null); }} placeholder={'import { defineFlow } from "@vyre/sdk";\nexport default defineFlow({ ... });'} />
          <View className="flex-row flex-wrap gap-s2">
            <Button label={busy ? "Working" : "Check"} onPress={busy || !text.trim() ? () => {} : check} />
            <Button kind="primary" label="Save as a draft" onPress={busy || !text.trim() ? () => {} : save} />
          </View>
        </View>
      </Card>
      {err ? <Banner tone="warn"><Text>{err}</Text></Banner> : null}
      {res && v ? (
        <Card>
          <View className="gap-s2">
            <Text strong>{v.title}</Text>
            {res.errors.map((p, i) => <Text key={i} tone="warn">{problemLine(p)}</Text>)}
            {(res.warnings ?? []).map((w, i) => <Text key={i} tone="muted">{warnLine(w)}</Text>)}
            {res.ok && effectLines(res.effects).length ? <Block label="What it would do">{effectLines(res.effects).join("\n")}</Block> : null}
          </View>
        </Card>
      ) : null}
      <Text size="caption" tone="label">The @Engineer assistant, which writes a Flow from plain words, is not connected yet.</Text>
    </Frame>
  );
}
