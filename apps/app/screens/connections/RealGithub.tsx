// GitHub accounts. "Sign in with GitHub" is a device code: the box returns a short code and GitHub's own page, the person types the code there (or opens the link that fills it in),
// and Vyre waits on its own. Or paste a token made at GitHub (a password field, sent once, never shown). Removing an account removes Vyre's copy only; it never revokes the token at GitHub.
// RepoPicker is the shared "pick a repo" sheet (search, paging, a private badge) for Projects to use.
import { dayOf } from "../../src/time/show.js";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Sheet, Text, showToast } from "@vyre/ui";
import { connections } from "./source-real";
import { words, type DeviceFlow, type GithubAccount, type Repo } from "./model";
import { openUrl, usePoll } from "./shared";

export default function RealGithub() {
  const [list, setList] = useState<GithubAccount[] | null>(null);
  const [problem, setProblem] = useState("");
  const [confirm, setConfirm] = useState("");
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const load = useCallback(() => { connections.githubAccounts().then((x) => { setList(x); setProblem(""); }).catch((e) => setProblem(words(e))); }, []);
  useEffect(load, [load]);
  if (problem && !list) return <ErrorState title="GitHub accounts did not load" reason={problem} retry={load} />;
  if (!list) return <LoadingState rows={2} />;
  return (
    <View className="gap-s3 pt-s2">
      <Text tone="muted" size="secondary">Connect an account and agents can open issues and pull requests in the repos it reaches.</Text>
      {list.length ? (
        <Card flush>
          {list.map((a, i) => (
            <View key={a.name}>{i ? <Divider /> : null}
              <Row title={<View className="flex-row items-center gap-s2"><Text mono>{a.name}</Text>{a.login ? <Text tone="muted">{a.login}</Text> : null}</View>} sub={
                confirm === a.name ? (
                  <View className="gap-s2 pt-s1">
                    <Text size="secondary">{`Disconnect ${a.name}? This removes Vyre's copy. It does not revoke the token at GitHub; do that in your GitHub settings.`}</Text>
                    <View className="flex-row gap-s2"><Button size="sm" label="Disconnect" onPress={() => connections.githubRemove(a.name).then(() => { setConfirm(""); load(); }).catch((e) => showToast(words(e)))} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setConfirm("")} /></View>
                  </View>
                ) : <View className="pt-s1 self-start"><Button kind="ghost" size="sm" label="Disconnect" onPress={() => setConfirm(a.name)} /></View>} />
            </View>
          ))}
        </Card>
      ) : <Card><EmptyState title="No GitHub account yet" body="Connect one to pick repos for a project." /></Card>}
      <View className="flex-row flex-wrap gap-s2">
        <Button kind={list.length ? "ghost" : "primary"} size="sm" icon="plus" label="Add a GitHub account" onPress={() => setAdding(true)} />
        {list.length ? <Button kind="ghost" size="sm" label="Browse repos" onPress={() => setPicking(true)} /> : null}
      </View>
      <AddGithub open={adding} known={list.map((a) => a.name)} onClose={() => setAdding(false)} onDone={load} />
      <RepoPicker open={picking} accounts={list} onClose={() => setPicking(false)} onPick={(r) => { setPicking(false); showToast(`Picked ${r.full}.`); }} />
    </View>
  );
}

function AddGithub({ open, known, onClose, onDone }: { open: boolean; known: string[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<(DeviceFlow & { name: string }) | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (open) { setName(""); setToken(""); setProblem(""); setFlow(null); setCopied(false); } }, [open]);
  // GitHub's own expiry ends the flow; Vyre waits on its own. This notices the account arriving.
  usePoll(!!flow, () => connections.githubAccounts().then((l) => { if (flow && l.some((a) => a.name === flow.name) && !known.includes(flow.name)) { setFlow(null); onClose(); onDone(); } }).catch(() => {}));
  const nm = () => { const n = name.trim(); if (!n) setProblem("Give the account a name, like work or personal."); return n; };
  const start = () => {
    const n = nm(); if (!n) return;
    setBusy(true); setProblem("");
    connections.githubDevice(n).then((f) => setFlow({ ...f, name: n })).catch((e) => setProblem(words(e))).finally(() => setBusy(false));
  };
  const withToken = () => {
    const n = nm(); const t = token.trim();
    if (!n) return;
    if (!t) { setProblem("Paste the token first."); return; }
    setBusy(true); setProblem("");
    connections.githubToken(n, t).then((r) => { setToken(""); showToast(r.login ? `Connected ${r.login}${r.repos != null ? `, reaches ${r.repos} ${r.repos === 1 ? "repo" : "repos"}` : ""}` : "Connected the GitHub account."); onClose(); onDone(); })
      .catch((e) => { setToken(""); setProblem(words(e, [t])); }).finally(() => setBusy(false));
  };
  const cancel = () => { const f = flow; setFlow(null); if (f) connections.githubCancel(f.id).catch(() => {}); onClose(); };
  return (
    <Sheet open={open} onClose={flow ? cancel : onClose} title="Add a GitHub account">
      {flow ? (
        <View className="gap-s3">
          <Text>Enter this code at github.com/login/device:</Text>
          <Text mono selectable size="title" strong>{flow.code}</Text>
          <View className="flex-row gap-s2">
            <Button size="sm" label={copied ? "Copied" : "Copy"} onPress={() => { void Clipboard.setStringAsync(flow.code).then(() => setCopied(true)).catch(() => {}); }} />
            <Button kind="primary" size="sm" label="Open GitHub" onPress={() => openUrl(flow.open)} />
          </View>
          <Text size="secondary" tone="muted">{`Good for about ${flow.minutes} ${flow.minutes === 1 ? "minute" : "minutes"}.`}</Text>
          <Button kind="ghost" size="sm" label="Cancel" onPress={cancel} />
        </View>
      ) : (
        <View className="gap-s3">
          <Field label="Name" value={name} onChangeText={setName} placeholder="work" help="What the assistant calls it, like work or personal." />
          <Text size="caption" tone="label">GitHub asks for repo access, full read and write on every repo the account can reach. Its device sign-in has no narrower option; a later release narrows this to the repos you pick.</Text>
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <Button kind="primary" label={busy ? "Starting" : "Sign in with GitHub"} disabled={busy} onPress={start} />
          <Text size="caption" strong tone="label">Or paste a token</Text>
          <Field label="Token" kind="password" value={token} onChangeText={setToken} help="A token you made at GitHub. A fine-grained token can reach fewer repos than signing in does." />
          <View className="self-start"><Button size="sm" label="Connect with this token" disabled={busy} onPress={withToken} /></View>
        </View>
      )}
    </Sheet>
  );
}

/** Pick a GitHub repo: search, paging, a private badge. Shared by Connections and by Projects. */
export function RepoPicker({ open, accounts, onClose, onPick }: { open: boolean; accounts: GithubAccount[]; onClose: () => void; onPick: (r: Repo, account: string) => void }) {
  const [account, setAccount] = useState("");
  const [q, setQ] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [more, setMore] = useState(false);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [say, setSay] = useState("");
  const run = useCallback((acct: string, query: string, p: number, append: boolean) => {
    setState("loading");
    connections.githubRepos({ account: acct || undefined, q: query || undefined, page: p }).then((r) => { setRepos((x) => (append ? [...x, ...r.repos] : r.repos)); setMore(r.more); setPage(p); setState("idle"); }).catch((e) => { setSay(words(e)); setState("error"); });
  }, []);
  useEffect(() => { if (open) { const a = accounts[0]?.name ?? ""; setAccount(a); setQ(""); setRepos([]); if (accounts.length) run(a, "", 1, false); } }, [open]);
  useEffect(() => { if (!open || !accounts.length) return; const t = setTimeout(() => run(account, q.trim(), 1, false), 300); return () => clearTimeout(t); }, [q, account]);
  return (
    <Sheet open={open} onClose={onClose} title="Choose a GitHub repo">
      {!accounts.length ? <Text tone="muted">No GitHub account connected yet. Connect one in Connections.</Text> : (
        <View className="gap-s3">
          {accounts.length > 1 ? <View className="flex-row flex-wrap gap-s2">{accounts.map((a) => <Chip key={a.name} selected={account === a.name} onPress={() => setAccount(a.name)}>{a.name}</Chip>)}</View> : null}
          <Field label="Search your repos" value={q} onChangeText={setQ} />
          {state === "error" ? <Text tone="muted">{say}</Text> : null}
          {state === "loading" && !repos.length ? <LoadingState rows={3} /> : null}
          {state !== "loading" && !repos.length && state !== "error" ? <Text tone="muted">{q ? "No repos match that search." : "No repos found."}</Text> : null}
          {repos.length ? <Card flush>{repos.map((r, i) => (
            <View key={r.full}>{i ? <Divider /> : null}
              <Row dense title={r.full} sub={[r.private ? "Private" : "", r.description, r.updated ? `Updated ${dayOf(new Date(r.updated).getTime())}` : ""].filter(Boolean).join(". ")} onPress={() => onPick(r, account)} />
            </View>))}</Card> : null}
          {more ? <View className="self-start"><Button kind="ghost" size="sm" label="Show more" disabled={state === "loading"} onPress={() => run(account, q.trim(), page + 1, true)} /></View> : null}
        </View>
      )}
    </Sheet>
  );
}
