// The four parts of an agent's page: its instructions, the context it keeps, the models it runs on, and where it is used. Each reads and writes through config.ts; nothing here holds a credential.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, IconButton, LoadingState, Row, Segmented, Sheet, SortableList, Text, markRef, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { pickFile } from "../vault/pick-file";
import { dayOf } from "../../src/time/show.js";
import { config, agentDocs } from "./config";
import { DocsEditor } from "../folderdocs/FolderDocs";
import { LEVELS, LEVEL_NOTE, ACK_WORDS, DOCS, NOT_USED, add, authorLine, accessRow, addable, workRows, NO_WORK, contextName, docInput, drop, kindLine, moveTo, linkLine, move, needsAck, sizeLine, usedRows, type Doc, type Entry } from "./config-model.ts";

const say = (e: unknown, f = "That did not go through.") => (e instanceof Error && e.message ? e.message : f);
type Load<T> = { data: T | null; err: string; reload: () => void };
function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Load<T> {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const reload = useCallback(() => { setErr(""); fn().then(setData).catch((e) => setErr(say(e, "That did not load."))); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(reload, [reload]);
  return { data, err, reload };
}

/** 1. Instructions: AGENTS.md and CLAUDE.md, in the same Markdown viewer and editor as Files (the shared DocsEditor), under the line that says who made the agent. */
export function Instructions({ name }: { name: string }) {
  const q = useLoad(() => config.docs(name), [name]);
  const names = useLoad(() => config.access(name).then((a) => a.people).catch(() => []), [name]);
  const api = useMemo(() => agentDocs(name), [name]);
  const who = (id: string) => (names.data || []).find((p) => p.id === id)?.name || "someone";
  const author = q.data ? authorLine(q.data.madeBy ? { name: who(q.data.madeBy.id), staff: q.data.madeBy.staff } : null, q.data.editedBy ? { name: who(q.data.editedBy) } : null) : "";
  return (
    <>
      {author ? <Text size="caption" tone={q.data?.madeBy && !q.data.madeBy.staff ? "warn" : "label"}>{author}</Text> : null}
      <DocsEditor api={api} who={name} />
    </>
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
  const rows = plan.map((e) => ({ e, a: accounts.find((x) => x.id === e.account) }));
  const ack = needsAck(plan);
  const save = () => { setBusy(true); config.savePlan(name, plan, ack).then(() => { showToast("Saved. It applies from the next turn."); q.reload(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  return (
    <>
      <Sec title="Which AI account it runs on">
        <Banner>{`In chats: each person's own AI account. In flows: the sign-ins below, in order.`}</Banner>
        {rows.length ? (
          <Card flush>
            <SortableList items={rows} keyOf={({ e }) => `${e.provider}:${e.account ?? ""}`} rowHeight={92} onMove={(from, to) => setPlan(moveTo(plan, from, to))}
              render={({ e, a }, i) => (
                <View>
                  <Row
                    title={a ? a.label : e.account ? "An account that was removed" : e.provider}
                    sub={kindLine(a)}
                    lead={<Chip>{String(i + 1)}</Chip>}
                    end={<View className="flex-row"><IconButton icon="chevron-up" label="Move up" onPress={() => setPlan(move(plan, i, -1))} /><IconButton icon="chevron-down" label="Move down" onPress={() => setPlan(move(plan, i, 1))} /><IconButton icon="x" label="Take off the plan" onPress={() => setPlan(drop(plan, i))} /></View>}
                  />
                  <View className="px-s3 pb-s2"><Text size="caption" tone="label">{i === 0 ? "First choice." : "Used when the one above runs out or fails."}</Text></View>
                </View>
              )} />
          </Card>
        ) : <Card><Text tone="muted">{`No order of its own. In flows, ${name} runs on the Space's default. Add a sign-in to choose.`}</Text></Card>}
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
  const v = useLoad(async () => { const [mine, all, lent] = await Promise.all([config.vault(name), config.vaultItems().catch(() => []), config.lent(name).catch(() => [])]); return { assigned: mine.assigned, all, lent }; }, [name]);
  const w = useLoad(() => config.work(name), [name]);
  const work = w.data ? workRows(w.data) : [];
  const [picking, setPicking] = useState<"login" | "note" | null>(null);
  const rows = u.data ? usedRows(u.data, name) : [];
  const open = (r: { kind: string; id: string }) => router.push((r.kind === "chat" ? `/u/chats/${encodeURIComponent(r.id)}` : `/u/flows/${encodeURIComponent(r.id)}`) as never);
  const sites = (v.data?.all ?? []).filter((x) => x.kind === "login").flatMap((x) => x.hosts.map((h) => ({ item: x.name, origin: /^https?:\/\//.test(h) ? h : `https://${h}` }))).filter((s) => !(v.data?.lent ?? []).some((g) => g.item === s.item && g.origin === s.origin));
  const noteable = (v.data?.all ?? []).filter((x) => !v.data!.assigned.includes(x.name));
  const lend = (item: string, origin: string) => config.lend(name, item, origin).then((r) => { showToast(r?.grant?.status === "pending" ? "Waiting for your yes." : `${name} can sign in to ${origin}.`); v.reload(); }).catch((e) => showToast(say(e)));
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
      <Sec title="Its work now">
        {w.err ? <Card><Text tone="muted">{`${name}'s tasks could not be read. ${w.err}`}</Text></Card> : null}
        {w.data && !work.length ? <Card><Text tone="muted">{NO_WORK(name)}</Text></Card> : null}
        {work.length ? <Card flush>{work.map((r, i) => <View key={`${r.kind}:${r.id}`}>{i ? <Divider /> : null}<Row title={r.title} sub={r.sub} onPress={() => router.push(`/u/task/${encodeURIComponent(r.id)}` as never)} /></View>)}</Card> : null}
      </Sec>
      <Sec title="Logins it can sign in with">
        {v.err ? <Card flush><ErrorState title="The Vault list did not load" reason={v.err} retry={v.reload} /></Card> : null}
        {v.data && !v.data.lent.length ? <Card><Text tone="muted">{`None. Lend ${name} a login and it signs in to that one site as you, on its own computer. You can take it back at any time.`}</Text></Card> : null}
        {v.data && v.data.lent.length ? (
          <Card flush>
            {v.data.lent.map((g, i) => <View key={g.id}>{i ? <Divider /> : null}<Row title={g.item} sub={`${g.origin}${g.expires ? `, until ${dayOf(g.expires)}` : ""}`} end={<IconButton icon="x" label={`Take ${g.item} back`} onPress={() => config.takeBack(g.id).then(v.reload).catch((e) => showToast(say(e)))} />} /></View>)}
          </Card>
        ) : null}
        <View className="flex-row"><Button size="sm" kind="secondary" label="Lend a login" onPress={() => setPicking("login")} /></View>
      </Sec>
      <Sec title="Other Vault items, noted for it">
        {v.data && !v.data.assigned.length ? <Card><Text tone="muted">{`None. A note tells ${name} an item exists. It gives no access: using an API key or a secret still goes through you.`}</Text></Card> : null}
        {v.data && v.data.assigned.length ? (
          <Card flush>
            {v.data.assigned.map((it, i) => <View key={it}>{i ? <Divider /> : null}<Row title={it} sub="Noted for the agent. No access." end={<IconButton icon="x" label={`Remove the note for ${it}`} onPress={() => void flip(it, false)} />} /></View>)}
          </Card>
        ) : null}
        <View className="flex-row"><Button size="sm" kind="ghost" label="Note an item" onPress={() => setPicking("note")} /></View>
      </Sec>
      <Sheet open={picking !== null} onClose={() => setPicking(null)} title={picking === "login" ? "Lend a login" : "Note an item"}>
        {picking === "login" ? (
          sites.length ? (
            <Card flush>{sites.map((s, i) => <View key={`${s.item}:${s.origin}`}>{i ? <Divider /> : null}<Row title={s.item} sub={s.origin} onPress={() => { setPicking(null); void lend(s.item, s.origin); }} /></View>)}</Card>
          ) : <Text tone="muted">No login in the Vault is for a site yet. Give a login its site in the Vault first.</Text>
        ) : (
          noteable.length ? <Card flush>{noteable.map((x, i) => <View key={x.name}>{i ? <Divider /> : null}<Row title={x.name} sub={x.kind} onPress={() => { setPicking(null); void flip(x.name, true); }} /></View>)}</Card> : <Text tone="muted">Nothing left in the Vault to note.</Text>
        )}
      </Sheet>
    </>
  );
}

/** Who may use or edit the agent: people and roles, at Can use or Can edit. Shown to those who may edit it. */
export function Sharing({ name }: { name: string }) {
  const q = useLoad(() => config.access(name), [name]);
  const [adding, setAdding] = useState(false);
  if (q.err) return null;
  if (!q.data) return null;
  const { access, people, roles } = q.data;
  const set = (kind: "person" | "role", subject: string, level: "use" | "edit" | null) => config.setAccess(name, kind, subject, level).then(q.reload).catch((e) => showToast(say(e)));
  const open = [...people.filter((p) => !access.some((a) => a.kind === "person" && a.subject === p.id)).map((p) => ({ kind: "person" as const, id: p.id, title: p.name, sub: p.role ? `Person, ${p.role}` : "Person" })) ];
  return (
    <>
      <Sec title="Who can use it">
        <Card><Text size="caption" tone="label">{LEVEL_NOTE}</Text></Card>
        {access.length ? (
          <Card flush>
            {access.map((a, i) => {
              const r = accessRow(a, people, roles);
              return (
                <View key={`${a.kind}:${a.subject}`}>{i ? <Divider /> : null}
                  <Row title={r.title} sub={r.sub} end={<IconButton icon="x" label={`Take ${r.title}'s access away`} onPress={() => void set(a.kind, a.subject, null)} />} />
                  <View className="px-s3 pb-s2"><Segmented label={`${r.title}'s access`} value={a.level} options={LEVELS as [string, string][]} onChange={(v) => void set(a.kind, a.subject, v as "use" | "edit")} /></View>
                </View>
              );
            })}
          </Card>
        ) : <Card><Text tone="muted">{`Only you, the owner and the admins can use ${name}. Add people.`}</Text></Card>}
        <View className="flex-row"><Button size="sm" kind="secondary" label="Add people" onPress={() => setAdding(true)} /></View>
      </Sec>
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add people">
        {open.length ? <Card flush>{open.map((o, i) => <View key={`${o.kind}:${o.id}`}>{i ? <Divider /> : null}<Row title={o.title} sub={o.sub} onPress={() => { setAdding(false); void set(o.kind, o.id, "use"); }} /></View>)}</Card> : <Text tone="muted">Everyone is already on the list.</Text>}
      </Sheet>
    </>
  );
}
