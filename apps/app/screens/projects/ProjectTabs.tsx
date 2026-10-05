// The project page's Brief, Files and Memory tabs (Deck parity): the brief built from the project's threads, the repos with Add a repo, the files its threads touched, and the facts Memory learned in its folders.
import { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Divider, EmptyState, ErrorState, LoadingState, Row, Text, showToast } from "@vyre/ui";
import { RepoPicker } from "../connections/RealGithub";
import { connections } from "../connections/source-real";
import type { GithubAccount } from "../connections/model";
import { projectTabs } from "./tabs-source-real";
import { briefLines, splitPath, type BriefLine, type Fact, type ProjectInfo, type Repo, type Touched } from "./tabs-model";

const say = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
function useLoad<T>(f: () => Promise<T>, deps: unknown[]) {
  const [d, setD] = useState<{ data?: T; error?: string } | null>(null);
  const load = useCallback(() => { setD(null); f().then((data) => setD({ data })).catch((e) => setD({ error: say(e, "That did not load.") })); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  return { d, reload: load };
}

export function BriefTab({ slug, onNewChat }: { slug: string; onNewChat: () => void }) {
  const { d, reload } = useLoad(() => projectTabs.brief(slug), [slug]);
  if (!d) return <LoadingState rows={3} />;
  if (d.error) return <ErrorState title="The brief is not available" reason={d.error} retry={reload} />;
  const lines = briefLines(d.data!.text);
  const p = d.data!.project;
  return (
    <View className="gap-s3">
      <Text size="caption" tone="label">Built from this project's threads</Text>
      {lines.length ? <Card><View className="gap-s2">{lines.map((l: BriefLine, i) => <Text key={i} strong={l.heading} mono={l.mono} size={l.heading ? "secondary" : "body"} tone={l.heading ? "label" : undefined}>{l.text}</Text>)}</View></Card>
        : <Card><EmptyState title="Nothing in the brief yet" body="It fills in as threads run." action={{ label: "Start a chat", onPress: onNewChat }} /></Card>}
      {p ? <View className="gap-s1"><Text size="secondary" mono tone="label">{`Home  ${p.home}`}</Text>{p.workspaces.filter((w) => w !== p.home).map((w) => <Text key={w} size="secondary" mono tone="label">{`Also  ${w}`}</Text>)}</View> : null}
      <Repos slug={slug} name={p?.name ?? slug} />
    </View>
  );
}

function Repos({ slug, name }: { slug: string; name: string }) {
  const { d, reload } = useLoad(() => projectTabs.repos(slug), [slug]);
  const [picking, setPicking] = useState<GithubAccount[] | null>(null);
  if (!d || d.data === null || d.error) return null;
  const rows: Repo[] = d.data ?? [];
  return (
    <View className="gap-s2">
      <Text strong size="secondary">Repos</Text>
      {rows.length ? <Card flush>{rows.map((r, i) => <View key={r.folder + i}>{i ? <Divider /> : null}<Row dense title={<Text mono>{r.folder}</Text>} sub={r.status} onPress={r.link ? () => void Linking.openURL(r.link!) : undefined} /></View>)}</Card> : <Text tone="muted" size="secondary">No folders yet.</Text>}
      <View className="self-start"><Button kind="ghost" size="sm" icon="plus" label="Add a repo" onPress={() => connections.githubAccounts().then(setPicking).catch(() => setPicking([]))} /></View>
      <RepoPicker open={picking !== null} accounts={picking ?? []} onClose={() => setPicking(null)} onPick={(repo, account) => {
        setPicking(null);
        projectTabs.addRepo(slug, repo.full, account).then(() => { showToast(`Added ${repo.full}`); reload(); }).catch((e) => showToast(`Could not add ${repo.full} to ${name}: ${say(e, "it did not work")}`));
      }} />
    </View>
  );
}

export function FilesTab({ slug }: { slug: string }) {
  const router = useRouter();
  const { d, reload } = useLoad(() => projectTabs.touched(slug), [slug]);
  if (!d) return <LoadingState rows={3} />;
  if (d.error) return <ErrorState title="Files are not available" reason={d.error} retry={reload} />;
  const { rows, error } = d.data!;
  return (
    <View className="gap-s2">
      <Text size="caption" tone="label">Touched by this project's threads</Text>
      {rows.length ? (
        <Card flush>
          {rows.map((f: Touched, i) => { const s = splitPath(f.path); return (
            <View key={f.path + f.thread + i}>{i ? <Divider /> : null}
              <Row dense title={<View className="flex-row items-baseline gap-s1"><Text size="caption" tone="faint" numberOfLines={1}>{s.dir}</Text><Text mono numberOfLines={1}>{s.base}</Text></View>}
                sub={[f.tool, f.threadName].filter(Boolean).join(", ")} onPress={f.thread ? () => router.push(`/u/chats/${encodeURIComponent(f.thread)}` as never) : undefined} />
            </View>); })}
        </Card>
      ) : <Card><EmptyState title={error ? "Files are not available" : "No files yet"} body={error || "No thread in this project has changed a file yet."} /></Card>}
      <Text size="caption" tone="faint">File contents are not shown here. Open the file on the machine that ran the thread.</Text>
    </View>
  );
}

export function MemoryTab({ slug }: { slug: string }) {
  const router = useRouter();
  const { d, reload } = useLoad(() => projectTabs.facts(slug), [slug]);
  if (!d) return <LoadingState rows={3} />;
  if (d.error) return <ErrorState title="Memory is not available" reason={d.error} retry={reload} />;
  const facts: Fact[] = d.data!;
  return (
    <View className="gap-s2">
      <View className="flex-row items-center justify-between"><Text size="caption" tone="label">Learned from this project's threads</Text><Button kind="ghost" size="sm" label="Open Memory" onPress={() => router.push("/u/memory" as never)} /></View>
      {facts.length ? <Card flush>{facts.map((f, i) => <View key={f.id}>{i ? <Divider /> : null}<Row dense title={f.text} sub={`from ${f.from}`} /></View>)}</Card>
        : <Card><EmptyState title="Nothing learned yet" body="Nothing learned from this project's threads yet. Memory learns from threads once they are indexed." /></Card>}
    </View>
  );
}

export type { ProjectInfo };
