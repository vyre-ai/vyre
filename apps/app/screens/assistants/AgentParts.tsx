// The four parts of an agent's page: its instructions, the context it keeps, the models it runs on, and where it is used. Each reads and writes through config.ts; nothing here holds a credential.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, IconButton, LoadingState, Row, Segmented, Sheet, Text, markRef, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { pickFile } from "../vault/pick-file";
import { config } from "./config";
import { ACK_WORDS, DOCS, NOT_USED, add, addable, contextName, docInput, drop, entriesOf, linkLine, move, needsAck, sizeLine, usedRows, type Doc, type Entry } from "./config-model.ts";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);
type Load<T> = { data: T | null; err: string; reload: () => void };
function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Load<T> {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const reload = useCallback(() => { setErr(""); fn().then(setData).catch((e) => setErr(say(e, "That did not load."))); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(reload, [reload]);
  return { data, err, reload };
}

/** 1. Instructions: AGENTS.md and CLAUDE.md, edited in place. */
export function Instructions({ name }: { name: string }) {
  const q = useLoad(() => config.docs(name), [name]);
  const [file, setFile] = useState<Doc>("AGENTS.md");
  const [text, setText] = useState<Record<Doc, string>>({ "AGENTS.md": "", "CLAUDE.md": "" });
  const [saved, setSaved] = useState<Record<Doc, string>>({ "AGENTS.md": "", "CLAUDE.md": "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) { setText(q.data); setSaved(q.data); } }, [q.data]);
  const dirty = text[file] !== saved[file];
  const save = () => { setBusy(true); const i = docInput(name, file, text[file]); config.saveDoc(name, file, i.text).then(() => { setSaved((s) => ({ ...s, [file]: i.text })); setText((t) => ({ ...t, [file]: i.text })); showToast("Saved. It applies from the next turn."); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  if (q.err) return <Card flush><ErrorState title="Instructions did not load" reason={q.err} retry={q.reload} /></Card>;
  if (!q.data) return <LoadingState rows={4} />;
  return (
    <Sec title="Instructions">
      <Segmented label="Instruction file" value={file} onChange={setFile} options={DOCS.map(([id, label]) => [id, label] as [Doc, string])} />
      <Card className="gap-s2">
        <Text size="caption" tone="label">{DOCS.find((d) => d[0] === file)![2]}</Text>
        <Field name={`${name}'s ${file}`} value={text[file]} onChangeText={(v) => setText((t) => ({ ...t, [file]: v }))} multiline lines={12} placeholder={file === "AGENTS.md" ? "What does this agent do, and how should it do it?" : "Anything Claude should know before it starts."} />
        <View className="flex-row items-center gap-s2">
          <Button size="sm" label="Save" disabled={busy || !dirty} onPress={save} />
          {dirty ? <Button size="sm" kind="ghost" label="Revert" onPress={() => setText((t) => ({ ...t, [file]: saved[file] }))} /> : <Text size="caption" tone="label">Saved</Text>}
        </View>
      </Card>
    </Sec>
  );
}

/** 2. Context: files uploaded to the agent, and folders linked from Files. */
export function Context({ name }: { name: string }) {
  const q = useLoad(() => config.context(name), [name]);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<{ name: string; path: string }[] | null>(null);
  const [problem, setProblem] = useState("");
  const upload = async () => {
    setBusy(true);
    try {
      const f = await pickFile("");
      if (!f) return;
      const n = contextName(f.name);
      await config.addContext(name, n, f.base64);
      showToast(`${n} added.`);
      q.reload();
    } catch (e) { showToast(say(e)); } finally { setBusy(false); }
  };
  const find = () => { setProblem(""); config.folders(search).then(setFound).catch((e) => setProblem(say(e))); };
  const link = (p: string) => config.link(name, p).then(() => { setLinking(false); setFound(null); setSearch(""); q.reload(); showToast("Folder linked."); }).catch((e) => setProblem(say(e)));
  if (q.err) return <Card flush><ErrorState title="Context did not load" reason={q.err} retry={q.reload} /></Card>;
  if (!q.data) return <LoadingState rows={3} />;
  const { files, links } = q.data;
  return (
    <>
      <Sec title="Files">
        {files.length ? (
          <Card flush>
            {files.map((f, i) => (
              <View key={f.name}>{i ? <Divider /> : null}
                <Row title={f.name} sub={sizeLine(f.size)} end={<IconButton icon="trash" label={`Remove ${f.name}`} onPress={() => config.removeContext(name, f.name).then(q.reload).catch((e) => showToast(say(e)))} />} />
              </View>
            ))}
          </Card>
        ) : <Card><Text tone="muted">{`Nothing kept for ${name} yet. Add the files it should know before it works: a style guide, a price list, a template.`}</Text></Card>}
        <View className="flex-row"><Button size="sm" label="Add a file" disabled={busy} onPress={upload} /></View>
      </Sec>
      <Sec title="Folders from Files">
        {links.length ? (
          <Card flush>
            {links.map((p, i) => {
              const l = linkLine(p);
              return <View key={p}>{i ? <Divider /> : null}<Row title={l.title} sub={l.sub} end={<IconButton icon="x" label={`Unlink ${l.title}`} onPress={() => config.unlink(name, p).then(q.reload).catch((e) => showToast(say(e)))} />} /></View>;
            })}
          </Card>
        ) : <Card><Text tone="muted">No folders linked. A linked folder must lie inside one of the projects the agent works in, so linking never gives it more reach.</Text></Card>}
        <View className="flex-row"><Button size="sm" kind="secondary" label="Link a folder" onPress={() => setLinking(true)} /></View>
      </Sec>
      <Sheet open={linking} onClose={() => setLinking(false)} title="Link a folder">
        <View className="gap-s2">
          <Field name="Folder name" value={search} onChangeText={setSearch} placeholder="Part of the folder's name" />
          <View className="flex-row"><Button size="sm" label="Find" disabled={!search.trim()} onPress={find} /></View>
          {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
          {found && !found.length ? <Text tone="muted">No folder with that name in Files.</Text> : null}
          {found && found.length ? (
            <Card flush>{found.map((d, i) => <View key={d.path}>{i ? <Divider /> : null}<Row title={d.name} sub={d.path} onPress={() => void link(d.path)} /></View>)}</Card>
          ) : null}
        </View>
      </Sheet>
    </>
  );
}

/** 3. Models: the sign-ins this agent runs on, in the order they are tried. */
export function Models({ name }: { name: string }) {
  const router = useRouter();
  const q = useLoad(() => config.plan(name), [name]);
  const [plan, setPlan] = useState<Entry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (q.data) setPlan(q.data.entries); }, [q.data]);
  if (q.err) return <Card flush><ErrorState title="Models did not load" reason={q.err} retry={q.reload} /></Card>;
  if (!q.data || !plan) return <LoadingState rows={3} />;
  const { accounts } = q.data;
  const saved = JSON.stringify(q.data.entries);
  const dirty = JSON.stringify(plan) !== saved;
  const rows = plan.map((e) => { const a = accounts.find((x) => x.id === e.account); return { e, a }; });
  const ack = needsAck(plan);
  const save = () => { setBusy(true); config.savePlan(name, plan, ack).then(() => { showToast("Saved. It applies from the next turn."); q.reload(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  return (
    <>
      <Sec title="Runs on, in this order">
        {rows.length ? (
          <Card flush>
            {rows.map(({ e, a }, i) => (
              <View key={`${e.provider}:${e.account ?? i}`}>{i ? <Divider /> : null}
                <Row
                  title={a ? a.label : e.account ? "An account that was removed" : e.provider}
                  sub={`${i === 0 ? "First" : `Then, if the one above runs out or fails`}. ${a ? (a.kind === "login" ? "Your sign-in" : a.kind === "setup-token" ? "Setup token" : "API token") : "Not available"}`}
                  lead={<Chip>{String(i + 1)}</Chip>}
                  end={<View className="flex-row"><IconButton icon="chevron-up" label="Move up" onPress={() => setPlan(move(plan, i, -1))} /><IconButton icon="chevron-down" label="Move down" onPress={() => setPlan(move(plan, i, 1))} /><IconButton icon="x" label="Take off the plan" onPress={() => setPlan(drop(plan, i))} /></View>}
                />
              </View>
            ))}
          </Card>
        ) : <Card><Text tone="muted">{`No plan of its own. ${name} runs on the Space's default model. Add a sign-in to choose.`}</Text></Card>}
        {ack ? <Banner>{ACK_WORDS}</Banner> : null}
        <View className="flex-row flex-wrap gap-s2">
          <Button size="sm" kind="secondary" label="Add a sign-in" onPress={() => setAdding(true)} />
          <Button size="sm" label="Save the plan" disabled={busy || !dirty} onPress={save} />
          {dirty ? <Button size="sm" kind="ghost" label="Revert" onPress={() => setPlan(q.data!.entries)} /> : null}
        </View>
      </Sec>
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add a sign-in">
        <View className="gap-s2">
          {addable(plan, accounts).length ? (
            <Card flush>
              {addable(plan, accounts).map((a, i) => (
                <View key={a.id}>{i ? <Divider /> : null}<Row title={a.label} sub={a.kind === "login" ? "Your sign-in" : a.kind === "setup-token" ? "Setup token" : "API token"} onPress={() => { setPlan(add(plan, { provider: a.provider, account: a.id })); setAdding(false); }} /></View>
              ))}
            </Card>
          ) : <Text tone="muted">Every account you have is already on the plan.</Text>}
          <Text size="caption" tone="label">A setup token, your own login or an API token (Anthropic, OpenAI, OpenRouter) is added once under AI accounts, kept in the Vault, and then picked here.</Text>
          <View className="flex-row"><Button size="sm" kind="secondary" label="Open AI accounts" onPress={() => { setAdding(false); router.push("/u/settings/ai" as never); }} /></View>
        </View>
      </Sheet>
    </>
  );
}

/** 4. Where it is used: chats and flows, and the Vault items put at its disposal. */
export function Used({ name }: { name: string }) {
  const router = useRouter();
  const u = useLoad(() => config.used(name), [name]);
  const v = useLoad(async () => { const [mine, all] = await Promise.all([config.vault(name), config.vaultItems().catch(() => [])]); return { assigned: mine.assigned, all }; }, [name]);
  const [picking, setPicking] = useState(false);
  const rows = u.data ? usedRows(u.data, name) : [];
  const open = (r: { kind: string; id: string }) => router.push((r.kind === "chat" ? `/u/chats/${encodeURIComponent(r.id)}` : `/u/flows/${encodeURIComponent(r.id)}`) as never);
  const flip = (item: string, on: boolean) => (on ? config.assign(name, item) : config.unassign(name, item)).then(v.reload).catch((e) => showToast(say(e)));
  return (
    <>
      <Sec title="Chats and flows">
        {u.err ? <Card flush><ErrorState title="This did not load" reason={u.err} retry={u.reload} /></Card> : null}
        {!u.data && !u.err ? <LoadingState rows={2} /> : null}
        {u.data && !rows.length ? <Card><EmptyState title="Not used yet" body={NOT_USED(name)} /></Card> : null}
        {rows.length ? (
          <Card flush>
            {rows.map((r, i) => <View key={`${r.kind}:${r.id}`}>{i ? <Divider /> : null}<Row title={r.title} sub={r.sub} lead={<Avatar of={markRef("assistant", name)} size={32} />} onPress={() => open(r)} /></View>)}
          </Card>
        ) : null}
      </Sec>
      <Sec title="Vault items it can use">
        {v.err ? <Card flush><ErrorState title="The Vault list did not load" reason={v.err} retry={v.reload} /></Card> : null}
        {v.data && !v.data.assigned.length ? <Card><Text tone="muted">{`None. Put an item here and ${name} is told it exists. Using it still needs your yes, the same as for you.`}</Text></Card> : null}
        {v.data && v.data.assigned.length ? (
          <Card flush>
            {v.data.assigned.map((it, i) => <View key={it}>{i ? <Divider /> : null}<Row title={it} sub="Vault item" end={<IconButton icon="x" label={`Take ${it} away`} onPress={() => void flip(it, false)} />} /></View>)}
          </Card>
        ) : null}
        <View className="flex-row"><Button size="sm" kind="secondary" label="Put a Vault item here" onPress={() => setPicking(true)} /></View>
      </Sec>
      <Sheet open={picking} onClose={() => setPicking(false)} title="Put a Vault item here">
        {v.data && v.data.all.filter((x) => !v.data!.assigned.includes(x.name)).length ? (
          <Card flush>
            {v.data.all.filter((x) => !v.data!.assigned.includes(x.name)).map((x, i) => <View key={x.name}>{i ? <Divider /> : null}<Row title={x.name} sub={x.kind} onPress={() => { setPicking(false); void flip(x.name, true); }} /></View>)}
          </Card>
        ) : <Text tone="muted">Nothing left in the Vault to add.</Text>}
      </Sheet>
    </>
  );
}
