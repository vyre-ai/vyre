// Shared: what the assistants made (artifacts), with its versions and a public link. A link is posting as the person: the box asks their yes.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, LoadingState, Row, SectionLabel, Text, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { chatTools } from "./instance";
import type { Shared, Version } from "./model.ts";

const say = (e: unknown, f: string) => (e instanceof Error && e.message ? e.message : f);

export function SharedScreen() {
  const [rows, setRows] = useState<Shared[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState("");
  const load = useCallback(() => { setErr(""); chatTools.shared().then(setRows).catch((e) => setErr(say(e, "Shared could not be read."))); }, []);
  useEffect(load, [load]);
  return (
    <Page title="Shared" back="/u">
      {err ? <Card flush><ErrorState title="Shared did not load" reason={err} retry={load} /></Card> : null}
      {!rows && !err ? <LoadingState rows={4} /> : null}
      {rows && !rows.length ? <Card><EmptyState title="Nothing made yet" body="Pages, images and files an assistant makes for you show here." /></Card> : null}
      {rows && rows.length ? (
        <Card flush>
          {rows.map((a, i) => (
            <View key={a.id}>
              {i ? <Divider /> : null}
              <Row title={a.title} sub={a.kind} state={a.shared ? "Link on" : undefined} chevron onPress={() => setOpen(open === a.id ? "" : a.id)} />
              {open === a.id ? <Detail id={a.id} onShared={load} /> : null}
            </View>
          ))}
        </Card>
      ) : null}
    </Page>
  );
}

function Detail({ id, onShared }: { id: string; onShared: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { chatTools.versions(id).then(setVersions).catch(() => setVersions([])); }, [id]);
  const share = () => { setBusy(true); setProblem(""); chatTools.share(id, "7d").then((r) => { if (r.ok) { setLink(r.url); onShared(); showToast("The link is ready."); } else setProblem(r.reason); }).finally(() => setBusy(false)); };
  return (
    <View className="gap-s2 p-s3">
      <SectionLabel first>Versions</SectionLabel>
      {!versions ? <LoadingState rows={1} /> : <Text tone="muted">{versions.length ? `${versions.length} ${versions.length === 1 ? "version" : "versions"}, latest v${Math.max(...versions.map((v) => v.v))}` : "One version"}</Text>}
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      {link ? <Text selectable>{link}</Text> : null}
      <View className="self-start"><Button size="sm" label={link ? "Make another link" : "Create a link (7 days)"} disabled={busy} onPress={share} /></View>
    </View>
  );
}
