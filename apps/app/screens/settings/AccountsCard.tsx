// AI accounts: one list of providers (Claude, Codex, Grok, OpenRouter, OpenAI-compatible), every one drawn the same way with its own mark, from one source (sessions.accounts.list). Each row says
// who it is connected as, or that it is not connected, and how to connect: the provider's own sign-in where one exists, an API key where keys are supported. Each connected account sits under its
// provider with Make default, Remove and, for a key, Replace key. The sign-in is the provider's: Vyre shows its link and code and never sees a password or token. A key goes once to the server's
// key tool and is not shown again. On a computer that runs Claude on its own login, Claude's sign-in is the setup token the computer keeps (onboard.claude), in the same panel as every other.
import { useSpaces } from "../shell/state";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { openExternal } from "../../src/shell/open-external";
import { Button, Card, Chip, CodeBlock, Divider, ErrorState, Field, LoadingState, ProviderLogo, Switch, Text, showToast, useUiTheme } from "@vyre/ui";
import { accountTitle, canMakeDefault, canReplaceKey, canSignIn, keepFollowing, providerBlocks, providerName, safeUrl, serverCannotWords, stateWord, usable, usesMachineLogin, assistantAccount, withFirst, type Account, type Flow, type ProviderBlock, type RouteEntry } from "./accounts-model";
import { accounts as realAccounts } from "./accounts";
import { ACCOUNTS_COPY } from "../first-run/ai-accounts-model.js";
import { showingJoined } from "../../src/real/team-join";
import { tool } from "../../src/real/box";
import { DISCONNECT_NOTE, WRONG_FLOW, aiRefusal, codeInput, codeMatchesFlow, disconnectInput, safeLink, startInput } from "../../src/real/ai-connect.js";

export type AccountsApi = typeof realAccounts;

/** The flow id of a sign-in this computer keeps itself (onboard.claude's setup token), not one of sessions.accounts.signin's. */
const MACHINE = "machine";
const surfaceNow = (): "browser" | "mac" | "phone" => (Platform.OS !== "web" ? "phone" : typeof window !== "undefined" && (window as any).__vyreShell ? "mac" : "browser");
const say = (e: unknown, f = "That did not go through.") => ((e as { code?: string })?.code === "not_found" ? "This computer has no AI accounts yet." : e instanceof Error && e.message ? (serverCannotWords(e.message) ?? e.message) : f);
const machineSay = (e: unknown) => aiRefusal((e as { code?: string })?.code, (e as Error)?.message || "", surfaceNow());

/** The last list each source answered, kept for this run of the app only (names and states, never a key). */
/** The last list read, per Space: AI accounts are the Space's, so one Space's list never shows in another. */
const LAST = new Map<string, Account[]>();

/** What is open under one provider: a sign-in, a key to add, or a key to replace. */
type Open = { provider: string; mode: "key" } | { provider: string; mode: "replace"; account: Account } | null;

export function AiAccountsList({ source = realAccounts }: { source?: AccountsApi }) {
  const { color } = useUiTheme();
  // the last list read draws at once on a return visit; the read below refreshes it
  const space = useSpaces((s) => s.space);
  const lastKey = `${space}`;
  const [rows, setRows] = useState<Account[] | null>(() => LAST.get(lastKey) ?? null);
  const [err, setErr] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState("");
  const [member, setMember] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const [label, setLabel] = useState("");
  const [base, setBase] = useState("");
  const [flow, setFlow] = useState<Flow | null>(null);
  const [code, setCode] = useState("");
  // "Use an API key": the key typed here goes once to the server's key tool and is cleared; it is never kept or shown again
  const [key, setKey] = useState("");
  // a member's key goes to her own Vault: its password is asked for only when her Vault is locked or new (need_password)
  const [pw, setPw] = useState("");
  const [needPw, setNeedPw] = useState(false);
  const [assistant, setAssistant] = useState<{ name: string; entries: RouteEntry[] } | null>(null);
  const [picking, setPicking] = useState(false);
  const run = useRef(0);
  const load = useCallback(() => {
    setErr("");
    source.list().then((r) => { LAST.set(lastKey, r); setRows(r); })
      .catch((e) => { const had = LAST.get(lastKey); if (had) { setRows(had); setProblem(`This is the last list read. ${say(e, "It could not be refreshed.")}`); } else { setRows([]); setErr(say(e, "Your AI accounts could not be read.")); } });
    source.assistant().then(setAssistant).catch(() => setAssistant(null));
  }, [source, lastKey]);
  useEffect(() => { setRows(LAST.get(lastKey) ?? null); load(); return () => { run.current++; }; }, [load]);
  useEffect(() => { void showingJoined().then(setMember).catch(() => setMember(false)); }, []);

  const clear = () => { setOpen(null); setPw(""); setNeedPw(false); setKey(""); setLabel(""); setBase(""); setCode(""); };
  const act = async (id: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(id); setProblem("");
    try { await fn(); setConfirming(""); if (done) showToast(done); load(); } catch (e) { setProblem(say(e)); } finally { setBusy(""); }
  };
  /** Follow a sign-in until it ends. The box holds each status call open for a while, so this is not a tight loop; it ends with the list, a Cancel, or an end state. */
  const follow = async (id: string, prov: string, mine: number) => {
    while (run.current === mine) {
      let f: Flow;
      try { f = await source.follow(id, prov); } catch (e) { if (run.current === mine) { setFlow(null); setProblem(say(e)); } return; }
      if (run.current !== mine) return;
      setFlow(f);
      if (f.step === "done") { setFlow(null); showToast(`${providerName(prov)} is connected.`); load(); return; }
      if (!keepFollowing(f)) return;
    }
  };
  const start = async (prov: string, account = "") => {
    setProblem(""); clear(); const mine = ++run.current;
    setFlow({ id: "", step: "waiting", provider: prov });
    try {
      const f = await source.start(prov, "", account);
      if (run.current !== mine) return;
      setFlow(f);
      if (f.id && keepFollowing(f)) void follow(f.id, prov, mine);
    } catch (e) {
      if (run.current !== mine) return;
      // the owner's own computer runs Claude on the login already on it: its sign-in is the setup token the computer keeps, the same link-and-code panel
      if (!member && usesMachineLogin((e as Error)?.message || "")) {
        try {
          const d = await tool<{ url?: string }>("onboard.claude", startInput());
          const link = safeLink(d?.url);
          if (run.current !== mine) return;
          if (link) { setFlow({ id: MACHINE, step: "url", url: link, provider: prov }); return; }
          setFlow(null); setProblem("This computer did not give a sign-in link. Try again.");
        } catch (m) { if (run.current === mine) { setFlow(null); setProblem(machineSay(m)); } }
        return;
      }
      setFlow(null); setProblem(say(e));
    }
  };
  const cancel = () => { run.current++; setFlow(null); clear(); setProblem(""); load(); };
  const submit = async (f: Flow) => {
    if (f.id === MACHINE) {
      if (!codeMatchesFlow(code, f.url)) { setProblem(WRONG_FLOW); return; }
      setBusy("code");
      try { await tool("onboard.claude", codeInput(code)); setProblem(""); setCode(""); setFlow(null); showToast(`${providerName(f.provider)} is connected.`); load(); }
      catch (e) { setProblem(machineSay(e)); } finally { setBusy(""); }
      return;
    }
    try { await source.paste(f.id, code); setProblem(""); setCode(""); setFlow({ ...f, step: "waiting" }); void follow(f.id, f.provider, run.current); }
    catch (e) { setProblem(say(e, "That did not look like the code.")); }
  };

  const blocks = providerBlocks(rows ?? [], member);
  const connected = (rows ?? []).filter(usable);
  const uses = assistant ? assistantAccount(assistant.entries, rows ?? []) : null;
  const drawn = (p: ProviderBlock, i: number) => {
    const here = flow && flow.provider === p.id ? flow : null;
    const keyOpen = open && open.provider === p.id ? open : null;
    return (
      <View key={p.id}>
        {i ? <Divider /> : null}
        <View className="gap-s2 p-s3" accessibilityLabel={`${p.name}, ${p.status}`}>
          <View className="flex-row items-center gap-s3">
            <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: color["surface-2"] ?? color.hover }}><ProviderLogo provider={p.id} size={22} /></View>
            <View className="min-w-0 flex-1 gap-s1">
              <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{p.name}</Text>{p.vendor && p.vendor !== p.name ? <Text size="caption" tone="label">{p.vendor}</Text> : null}<Chip tone={p.connected ? "ok" : "plain"}>{p.connected ? "Connected" : "Not connected"}</Chip></View>
              <Text size="caption" tone="label">{p.status}</Text>
            </View>
          </View>
          {p.accounts.map((a) => (
            <View key={a.id} className="gap-s2 pl-s3" style={{ borderLeftWidth: 2, borderLeftColor: color["edge-strong"] ?? color.hover }}>
              <View className="flex-row flex-wrap items-center gap-s2"><Text>{a.synthetic ? "This computer's sign-in" : a.label}</Text>{a.isDefault && p.accounts.length > 1 ? <Chip>Default</Chip> : null}</View>
              <Text size="caption" tone="label">{stateWord(a)}</Text>
              {a.provider === "grok" && a.privacyLabel ? <Text size="caption" tone="muted">{`${a.privacyLabel} ${a.privacyNote}`.trim()}</Text> : null}
              {a.provider === "opencode" ? (<View className="gap-s1"><Switch on={Boolean(a.goOnly)} disabled={(!a.goOk && !a.goOnly) || busy === a.id} label="Only use OpenCode Go" onChange={(on) => void act(a.id, () => source.setGo(a.id, on))} /><Text size="caption" tone="muted">{a.goOk ? "For coding agents, per OpenCode's terms." : "OpenCode Go is not on this key."}</Text></View>) : null}
              {confirming === a.id ? (
                <View className="gap-s2">
                  <Text size="caption">{a.synthetic ? `Remove the ${p.name} sign-in this computer keeps? ${DISCONNECT_NOTE}` : `Remove ${a.label}? Sessions already on it keep running; the next one asks for another account.`}</Text>
                  <View className="flex-row flex-wrap gap-s2">
                    <Button size="sm" label="Remove" disabled={busy === a.id} onPress={() => void act(a.id, () => (a.synthetic ? tool("onboard.claude", disconnectInput()) : source.remove(a.id)), `${a.synthetic ? p.name : a.label} is removed.`)} />
                    <Button kind="ghost" size="sm" label="Keep" onPress={() => setConfirming("")} />
                  </View>
                </View>
              ) : (
                <View className="flex-row flex-wrap gap-s2">
                  {canSignIn(a) ? <Button size="sm" label="Sign in again" disabled={Boolean(flow)} onPress={() => void start(a.provider, a.id)} /> : null}
                  {canMakeDefault(a, p.accounts) ? <Button kind="ghost" size="sm" label="Make default" disabled={busy === a.id} onPress={() => void act(a.id, () => source.makeDefault(a.id), `${a.label} is the default for ${p.name}.`)} /> : null}
                  {canReplaceKey(a) && !member ? <Button kind="ghost" size="sm" label="Replace key" onPress={() => { setProblem(""); setKey(""); setOpen({ provider: p.id, mode: "replace", account: a }); }} /> : null}
                  {a.provider === "grok" && a.privacy !== null ? <Button kind="ghost" size="sm" label={a.privacy ? "I turned privacy mode off" : "I turned privacy mode on"} disabled={busy === a.id} onPress={() => void act(a.id, () => source.setPrivacy(a.id, !a.privacy))} /> : null}
                  {!a.synthetic || (a.provider === "claude" && !member) ? <Button kind="ghost" size="sm" label="Remove" onPress={() => setConfirming(a.id)} /> : null}
                </View>
              )}
            </View>
          ))}
          {here ? (
            here.step === "failed" ? (
              <View className="gap-s2">
                <Text size="caption" tone="warn">{`Signing in to ${p.name} did not finish. ${here.message || ""}`.trim()}</Text>
                <View className="self-start"><Button kind="ghost" size="sm" label="Close" onPress={cancel} /></View>
              </View>
            ) : (
              <View className="gap-s2">
                <Text>{here.url ? `Open this page, sign in to ${p.name}, and approve.` : `Starting the ${p.name} sign-in.`}</Text>
                {here.url && safeUrl(here.url) ? <View className="self-start"><Button size="sm" label="Open the sign-in" onPress={() => void openExternal(here.url as string).then((o) => { if (!o.opened) setProblem("The sign-in did not open. Copy the link below and open it in your browser."); })} /></View> : null}
                {here.url && safeUrl(here.url) ? <CodeBlock code={here.url} /> : null}
                {here.code ? <Text mono>{`Code: ${here.code}`}</Text> : null}
                {here.step === "url" ? (
                  <View className="gap-s2">
                    <Field name="The code the page showed" value={code} onChangeText={setCode} placeholder="Paste the code here" autoFocus onSubmit={() => { if (code.trim() && busy !== "code") void submit(here); }} onKey={(k) => { if (k === "Escape") cancel(); }} />
                    <View className="self-start"><Button size="sm" label={busy === "code" ? "Connecting" : "Continue"} disabled={!code.trim() || busy === "code"} onPress={() => void submit(here)} /></View>
                  </View>
                ) : <Text size="caption" tone="muted">Waiting for you to approve it.</Text>}
                <View className="self-start"><Button kind="ghost" size="sm" label="Cancel" onPress={cancel} /></View>
              </View>
            )
          ) : keyOpen ? (() => {
            const saveKey = () => void act("key", () => (keyOpen.mode === "replace" ? source.replaceKey(keyOpen.account, key) : source.addKey(p.id, key, label, base, member ? { password: pw } : null)).then(clear).catch((e) => { if ((e as { code?: string })?.code === "need_password") setNeedPw(true); throw e; }), keyOpen.mode === "replace" ? "The key is replaced." : `${p.name} is connected.`);
            return (
            <View className="gap-s2">
              <Field label={p.id === "opencode" ? "Paste your OpenCode API key" : (keyOpen.mode === "replace" ? `New key for ${keyOpen.account.label}` : `${p.name} API key`)} value={key} onChangeText={setKey} kind="password" help={p.id === "opencode" ? "Sign in to the OpenCode Console, add billing, and copy the API key." : ACCOUNTS_COPY.keyHelp} autoFocus onSubmit={() => { if (key.trim() && busy !== "key") saveKey(); }} onKey={(k) => { if (k === "Escape") cancel(); }} />
              {keyOpen.mode === "key" ? <Field name="A name for it" value={label} onChangeText={setLabel} placeholder="A name, like work (optional)" /> : null}
              {member && needPw ? <Field label="Your Vault password" value={pw} onChangeText={setPw} kind="password" help="The key goes to your own Vault, and only your own chats and Flows use it." /> : null}
              {keyOpen.mode === "key" && p.key === "openai-compatible" ? <Field name="Address (optional)" value={base} onChangeText={setBase} placeholder="https://api.openai.com/v1" help="Where the key is sent. Leave it empty for OpenAI. An xAI key goes to xAI by itself." /> : null}
              <View className="flex-row flex-wrap gap-s2">
                <Button size="sm" label={busy === "key" ? "Checking" : keyOpen.mode === "replace" ? "Replace key" : "Add key"} disabled={busy === "key" || !key.trim()}
                  onPress={saveKey} />
                <Button kind="ghost" size="sm" label="Cancel" onPress={cancel} />
              </View>
            </View>
            );
          })() : p.signIn || p.key ? (
            <View className="flex-row flex-wrap gap-s2">
              {p.signIn ? <Button size="sm" kind={p.connected ? "ghost" : "primary"} label={p.connected ? "Sign in to another account" : "Sign in"} disabled={Boolean(flow)} onPress={() => void start(p.id)} /> : null}
              {p.key ? <Button size="sm" kind={p.connected || p.signIn ? "ghost" : "primary"} label={p.connected && !p.signIn ? "Add another key" : "Use an API key"} disabled={Boolean(flow)} onPress={() => { setProblem(""); clear(); setOpen({ provider: p.id, mode: "key" }); }} /> : null}
            </View>
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <>
      {assistant && !member ? (
        <Card className="gap-s2">
          <View className="flex-row flex-wrap items-center gap-s2">
            {uses ? <ProviderLogo provider={uses.provider} size={16} /> : null}
            <Text>{uses ? `Your Assistant uses: ${providerName(uses.provider)}, ${accountTitle(uses)}` : "Your Assistant uses: no account chosen yet"}</Text>
            {connected.length ? <Button kind="ghost" size="sm" label={picking ? "Done" : "Change"} onPress={() => setPicking(!picking)} /> : null}
          </View>
          {picking ? (
            <View className="flex-row flex-wrap gap-s2">
              {connected.map((a) => (
                <Button key={a.id} size="sm" kind={uses?.id === a.id ? "secondary" : "ghost"} label={`${providerName(a.provider)}, ${accountTitle(a)}`} disabled={busy === "assistant"}
                  onPress={() => void act("assistant", () => source.setAssistant(assistant.name, withFirst(assistant.entries, a)).then(() => setPicking(false)), `Your Assistant uses ${providerName(a.provider)} from its next turn.`)} />
              ))}
            </View>
          ) : null}
        </Card>
      ) : null}
      <Card flush>
        <View className="gap-s1 px-s3 pt-s3">
          <Text size="caption" tone="label">Every AI account your chats and agents can run on. Each provider signs you in on its own page, and Vyre never sees the password or token. An API key goes to your Vault and is not shown again.</Text>
          {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
        </View>
        {rows === null && !err ? <LoadingState rows={3} /> : null}
        {err ? <ErrorState title="AI accounts did not load" reason={err} retry={load} /> : null}
        {rows && !err ? blocks.map(drawn) : null}
      </Card>
    </>
  );
}
