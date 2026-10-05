// The Sites tab in Memory on a real vyred: what Vyre for Chrome learned about each website. Forget never asks first (a family and Forget all ask once, they touch many):
// every Forget can be undone for a day, from any device. Nothing polls: it loads on open and after each act.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, LoadingState, Row, Text, showToast } from "@vyre/ui";
import { chromeSites } from "./chrome-sites";
import { countsLine, errWords, forgottenLine, hostOf, itemMeta, partsOf, plural, tokenOf, ago, type Detail, type Forgotten, type SiteRow } from "./chrome-sites-model";

const say = (e: unknown) => errWords(e as { code?: string; message?: string });

function Detailed({ s, onForgot }: { s: SiteRow; onForgot: () => void }) {
  const [d, setD] = useState<Detail | { error: string } | null>(null);
  const load = useCallback(() => { chromeSites.detail(s.key).then(setD).catch((e) => setD({ error: say(e) })); }, [s.key]);
  useEffect(load, [load]);
  if (!d) return <Text tone="faint" size="secondary">Reading.</Text>;
  if ("error" in d) return <Text tone="muted" size="secondary">{d.error}</Text>;
  if (d.found === false) return <Text tone="muted" size="secondary">Vyre no longer has this site.</Text>;
  const parts = partsOf(d);
  if (!parts.length) return <Text tone="muted" size="secondary">Nothing is kept for this site yet.</Text>;
  return (
    <View className="gap-s2">
      {parts.map((p) => (
        <View key={p.part} className="gap-s1">
          <View className="flex-row items-baseline gap-s2"><Text strong size="secondary">{p.label}</Text><Text size="caption" tone="faint">{String(p.items.length)}</Text></View>
          {p.items.map((it) => (
            <View key={String(it.id)} className="flex-row items-center gap-s2">
              <View className="min-w-0 flex-1"><Text mono={p.part === "api"} numberOfLines={1}>{String(it.label || it.id)}</Text>{itemMeta(p.part, it) ? <Text size="caption" tone={it.quarantined ? "err" : "faint"}>{itemMeta(p.part, it)}</Text> : null}</View>
              <Button kind="ghost" size="sm" label="Wrong?" onPress={() => chromeSites.forgetRow(s.key, p.part, String(it.id)).then(() => { showToast(`Forgot ${it.label || it.id}. You can undo it for a day.`); load(); onForgot(); }).catch((e) => showToast(say(e)))} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export default function RealChromeSites() {
  const [data, setData] = useState<{ sites: SiteRow[]; forgotten: Forgotten[] } | null>(null);
  const [problem, setProblem] = useState("");
  const [open, setOpen] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recent, setRecent] = useState(false);
  const [loadError, setLoadError] = useState("");
  const load = useCallback(() => { chromeSites.list().then((x) => { setData(x); setLoadError(""); }).catch((e) => setLoadError(say(e))); }, []);
  useEffect(load, [load]);

  const act = (f: () => Promise<unknown>, done: string) => { setProblem(""); f().then(() => { showToast(done); setConfirm(""); setOpen(""); load(); }).catch((e) => setProblem(say(e))); };
  const undo = (f: Forgotten) => { setProblem(""); chromeSites.restore(f).then((ok) => { if (!ok) setProblem(`${forgottenLine(f)} can no longer be brought back.`); else showToast("Brought back."); load(); }).catch((e) => setProblem(say(e))); };

  if (loadError && !data) return <ErrorState title="Sites could not be read" reason={loadError} />;
  if (!data) return <LoadingState rows={3} />;
  const familyCount = (s: SiteRow) => data.sites.filter((x) => x.kind === "origin" && x.family && x.family === s.family).length;
  return (
    <View className="gap-s2 pt-s2">
      <Text tone="muted" size="secondary">What Vyre for Chrome learned about each site: its layout, how to find its buttons, what its pages do. Never what you typed or what a page said. Forget anything and you can bring it back for a day.</Text>
      {problem ? <Banner><Text>{problem}</Text></Banner> : null}
      <View className="flex-row items-center gap-s2 pt-s2">
        <Text strong size="secondary" className="min-w-0 flex-1">{plural(data.sites.length, "site")}</Text>
        {data.sites.length > 1 ? (confirm === "*"
          ? <><Text tone="muted" size="secondary">{`Forget all ${data.sites.length}?`}</Text><Button size="sm" label="Forget all" onPress={() => act(() => chromeSites.forgetAll(), "Forgot every site. You can undo it for a day.")} /><Button kind="ghost" size="sm" label="Keep" onPress={() => setConfirm("")} /></>
          : <Button kind="ghost" size="sm" label="Forget all" onPress={() => setConfirm("*")} />) : null}
      </View>
      {data.sites.length ? (
        <Card flush>
          {data.sites.map((s, i) => {
            const fam = s.kind === "family";
            return (
              <View key={s.key}>{i ? <Divider /> : null}
                {confirm === s.key ? (
                  <View className="gap-s2 p-s4">
                    <Text>{`Forget the ${s.name}?`}</Text>
                    <Text tone="muted" size="secondary">{`This forgets what is shared across ${familyCount(s) ? plural(familyCount(s), "site") : "its sites"}. You can undo it for a day.`}</Text>
                    <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Forget" onPress={() => act(() => chromeSites.forgetSite(s.key), `Forgot ${s.name}. You can undo it for a day.`)} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setConfirm("")} /></View>
                  </View>
                ) : (
                  <Row title={<Text>{s.name}</Text>}
                    sub={<View className="gap-s1 pt-s1">
                      {fam ? <Text size="secondary" tone="label">{`Family of ${plural(familyCount(s), "site")}`}</Text> : <Text size="secondary" tone="label" mono>{hostOf(s.key)}</Text>}
                      <Text size="secondary" tone="label">{[countsLine(s.counts), s.usedToWork ? `${s.usedToWork} used to work` : "", s.verified ? `checked ${ago(s.verified)}` : ""].filter(Boolean).join(", ")}</Text>
                      {open === s.key ? <Detailed s={s} onForgot={load} /> : null}
                      <View className="flex-row gap-s2"><Button kind="ghost" size="sm" label={open === s.key ? "Hide" : "What Vyre knows"} onPress={() => setOpen(open === s.key ? "" : s.key)} /><Button kind="ghost" size="sm" label="Forget" onPress={() => (fam ? setConfirm(s.key) : act(() => chromeSites.forgetSite(s.key), `Forgot ${s.name}. You can undo it for a day.`))} /></View>
                    </View>} />
                )}
              </View>
            );
          })}
        </Card>
      ) : <Card><EmptyState title="No sites yet" body="Vyre for Chrome learns a site as you and your agents use it. Nothing is learned from pages you have not opened with Vyre." /></Card>}
      {data.forgotten.length ? (
        <View className="gap-s2 pt-s2">
          <Button kind="ghost" size="sm" label={`${recent ? "Hide" : "Show"} recently forgotten (${data.forgotten.length})`} onPress={() => setRecent((v) => !v)} />
          {recent ? <Card flush>{data.forgotten.map((f, i) => <View key={tokenOf(f)}>{i ? <Divider /> : null}<Row dense title={forgottenLine(f)} end={<Button kind="ghost" size="sm" label="Undo" onPress={() => undo(f)} />} /></View>)}</Card> : null}
        </View>
      ) : null}
    </View>
  );
}
