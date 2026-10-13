import { useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import { Banner, Button, Card, CodeDisplay, IconTile, Row, Divider, Field, FlowStep, PasswordField, ProviderRow, Segmented, Stack, Switch, Text, passwordStrength, showToast } from "@vyre/ui";
import { MOCK } from "../../src/real/box";
import { DEMO } from "./flow-model.js";
import { createVault, holdResetKit, homeHintText, openVault } from "./real-vault";
import { linkGithub } from "./real-github";
import { claudeConnected, finishSignIn, followSignIn, saveKey, startSignIn, type Flow, type Step } from "./real-inference";
import type { AiState, ScreenProps } from "./types";

const HINT = "Prototype hint";

/** Two password fields and the checks every new password passes: Good or better, and the same twice. */
function usePair() {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [tried, setTried] = useState(false);
  const weak = passwordStrength(a).score < 3;
  const differ = a !== b;
  const failure = tried && weak ? "That password is too easy to guess, so Vyre will not accept it. Add a few more words, then try again." : undefined;
  const fields = (
    <Stack gap={4}>
      <PasswordField label="Master password" name="Master password" meter value={a} onChangeText={(v) => { setA(v); setTried(false); }} />
      <PasswordField label="Type it again" name="Master password again" value={b} onChangeText={(v) => { setB(v); setTried(false); }} error={tried && !weak && differ ? "The two passwords do not match. Type the same one in both." : undefined} />
    </Stack>
  );
  return { fields, failure, value: a, check: () => { setTried(true); return !weak && !differ; }, ready: !!a && !!b };
}

export function MasterSet({ ctx, set, go, back, steps }: ScreenProps) {
  const pair = usePair();
  const [kit, setKit] = useState("");
  return (
    <FlowStep steps={steps} onBack={back} title={ctx.reset ? "Create a new master password" : "Create your master password"} lead="Choose something only you would think of. A phrase of four words is easy to remember and hard to guess."
      failure={pair.failure}
      primary={{ label: "Continue", disabled: !pair.ready || (ctx.reset && !MOCK && !kit.trim()), onPress: () => { if (pair.check()) { set({ master: pair.value }); go("master.confirm"); } } }}>
      {ctx.reset && !MOCK ? <Field label="Vault recovery secret" mono value={kit} onChangeText={(v) => { setKit(v); holdResetKit(v); }} placeholder="R1-..." help="It is in the vault block of your recovery kit." /> : null}
      {pair.fields}
      <Banner tone="plain" icon="vault">Touch ID or your device's lock opens your vault day to day. You type this password once on each new device.</Banner>
    </FlowStep>
  );
}

export function VaultIntro({ go, back, steps }: ScreenProps) {
  return (
    <FlowStep steps={steps} onBack={back} title="Let's set up your vault" lead="Your vault holds your AI accounts, passwords and keys, locked so that only you can open it."
      primary={{ label: "Create my master password", onPress: () => go("master.set") }}>
      <Card flush>
        <Row dense lead={<IconTile name="lock" />} title="Only you can open it" sub="One master password. A new device is approved from another device first." />
        <Divider inset={60} />
        <Row dense lead={<IconTile name="devices" />} title="It lives with you" sub="On your devices, and sealed inside each space you join." />
        <Divider inset={60} />
        <Row dense lead={<IconTile name="shield" />} title="Vyre cannot see inside" sub="Not your servers, not your team, not us." />
      </Card>
    </FlowStep>
  );
}

export function MasterConfirm({ ctx, set, go, back, steps }: ScreenProps) {
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  const [made, setMade] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [hint, setHint] = useState("");
  const open = async () => {
    setBusy(true); setSay("");
    const r = await createVault(ctx.master, ctx.reset);
    setBusy(false);
    if (!r.ok) { setSay(r.say); return; }
    // The password is not needed again: the prototype keeps it only to pretend to check it on the next screen.
    if (!MOCK) set({ master: "" });
    // A new person who came in with GitHub: tie it to the name now that the vault has its Secret Key. Linking can wait for Settings if it fails, so it never blocks the flow.
    if (ctx.github && !ctx.reset) {
      const l = await linkGithub(ctx.githubSession ?? null, ctx.github);
      if (!l.ok) showToast(l.say);
    }
    if (r.recoverySecret) { setHint(await homeHintText()); setMade(r.recoverySecret); } else go("inf.pick");
  };
  if (made) {
    return (
      <FlowStep steps={steps} title="Save your vault recovery secret" lead="This page can open your vault and sign in as you. Keep it like a house key: printed or in a safe place, never in email or chat."
        primary={{ label: "Continue", disabled: !saved, onPress: () => { setMade(null); go("inf.pick"); } }}>
        <CodeDisplay label="Vault recovery secret" code={made} note="If you forget your master password, this sets a new one. It is shown once." />
        {hint ? <CodeDisplay label="Home hint" code={hint} note="Not secret. It tells a new device where your vault lives. Keep it with the kit." /> : null}
        <Banner tone="warn" icon="warning">Keep it apart from your identity recovery code if you can. Anyone with both can sign in as you and open your vault. If you lose this and your master password, your vault cannot be opened, and Vyre cannot get it back.</Banner>
        <Stack row gap={3} align="center" justify="between"><Text>I saved my vault recovery secret</Text><Switch label="I saved my vault recovery secret" on={saved} onChange={setSaved} /></Stack>
      </FlowStep>
    );
  }
  return (
    <FlowStep steps={steps} onBack={back} title="Only you know it" lead="If you forget your master password, your recovery kit can set a new one. If you lose both, your vault cannot be opened, and Vyre cannot get it back."
      failure={say || undefined}
      primary={{ label: "Open my vault", disabled: !ok || busy, loading: busy, onPress: () => { void open(); } }}>
      <Card>
        <Stack row gap={3} align="center" justify="between">
          <Text strong>I understand</Text>
          <Switch label="I understand that a forgotten master password cannot be reset" on={ok} onChange={setOk} />
        </Stack>
      </Card>
      <Text size="caption" tone="label">Keep your recovery kit somewhere safe, apart from this password.</Text>
    </FlowStep>
  );
}

export function MasterEnter({ ctx, set, go, back, steps }: ScreenProps) {
  const [pw, setPw] = useState("");
  const [say, setSay] = useState("");
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true); setSay("");
    const r = await openVault(pw, ctx.master);
    setBusy(false);
    if (r.ok) go("inf.pick"); else setSay(r.say);
  };
  return (
    <FlowStep steps={steps} onBack={back} title="Open your vault here" lead="This device is approved. Type your master password to open your vault here. After that, Touch ID, Windows Hello or your phone's lock opens it."
      primary={{ label: "Open my vault", disabled: !pw || busy, loading: busy, onPress: () => { void open(); } }}
      secondary={{ label: "I forgot it: use my recovery kit", onPress: () => { set({ reset: true }); go("id.recover"); } }}>
      <PasswordField label="Master password" name="Master password" value={pw} onChangeText={(v) => { setPw(v); setSay(""); }} error={say || undefined} />
      {MOCK ? <Banner tone="plain" icon="info">{`${HINT}: the master password in this prototype is ${ctx.master || DEMO.master}.`}</Banner> : null}
    </FlowStep>
  );
}

const PROVIDERS = [
  { id: "claude", title: "Claude", sub: "Sign in with your Claude subscription." },
  { id: "codex", title: "Codex (ChatGPT)", sub: "Sign in with your ChatGPT account." },
  { id: "grok", title: "Grok", sub: "Sign in with your Grok account." },
];

export function InfPick({ ctx, set, go, back, steps }: ScreenProps) {
  const ai = ctx.ai;
  const tries = useRef<Record<string, number>>({});
  const alive = useRef(true);
  const [open, setOpen] = useState<Record<string, { flow: Flow; step: Extract<Step, { step: "open" }> }>>({});
  const [says, setSays] = useState<Record<string, string>>({});
  const [pasted, setPasted] = useState<Record<string, string>>({});
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // A Claude account that is already signed in on this home shows as signed in.
  useEffect(() => { void claudeConnected().then((c) => { if (c && alive.current) put("claude", "connected"); }); }, []);
  const put = (id: string, state: AiState) => set((c) => ({ ai: { ...c.ai, [id]: state } }));
  const say = (id: string, text: string) => setSays((m) => ({ ...m, [id]: text }));
  const settle = (id: string, flow: Flow, step: Step) => {
    if (!alive.current) return;
    if (step.step === "done") { put(id, "connected"); setOpen((m) => { const { [id]: _gone, ...rest } = m; return rest; }); say(id, ""); }
    else if (step.step === "failed") { put(id, "failed"); say(id, step.say); setOpen((m) => { const { [id]: _gone, ...rest } = m; return rest; }); }
    else if (step.step === "retry") say(id, step.say);
    else if (step.step === "open") { put(id, "working"); say(id, ""); setOpen((m) => ({ ...m, [id]: { flow, step } })); if (!step.paste) void followSignIn(flow, () => alive.current).then((s) => settle(id, flow, s)); }
    else void followSignIn(flow, () => alive.current).then((s) => settle(id, flow, s));
  };
  const connect = (id: string) => {
    put(id, "working"); say(id, "");
    void startSignIn(id, tries.current[id] ?? 0).then(({ flow, step }) => { tries.current[id] = (tries.current[id] ?? 0) + 1; settle(id, flow, step); });
  };
  const bring = (id: string) => {
    const o = open[id];
    if (o) void finishSignIn(o.flow, pasted[id] ?? "").then((s) => settle(id, o.flow, s));
  };
  const failed = PROVIDERS.find((p) => ai[p.id] === "failed");
  const count = Object.values(ai).filter((s) => s === "connected").length;
  return (
    <FlowStep steps={steps} onBack={back} title="Connect your AI" lead="Pick one or more. Each sign-in is saved to your personal vault, not to any server."
      failure={failed ? says[failed.id] || `${failed.title} did not finish signing in. Check that you are signed in to it in your browser, then try again, or add an API key instead.` : undefined}
      primary={{ label: count ? "Continue" : "Continue without an account", onPress: () => { set({ aiSkipped: !count }); go("space.choice"); } }}
      secondary={count ? undefined : { label: "Skip for now", onPress: () => { set({ aiSkipped: true }); go("space.choice"); } }}>
      <Card flush>
        {PROVIDERS.map((p) => (
          <Stack key={p.id} gap={0}>
            <ProviderRow provider={p.id} title={p.title} sub={p.sub} state={ai[p.id] ?? "idle"} problem={says[p.id] || "Sign-in did not finish."} onConnect={() => connect(p.id)} onTest={MOCK ? () => showToast(`${p.title} answered one small prompt in 2 s.`) : undefined} />
            <Divider inset={60} />
          </Stack>
        ))}
        <ProviderRow icon="key" title="An API key" sub="Anthropic, OpenAI or OpenRouter." state={ai.key === "connected" ? "connected" : "idle"} action="Add a key" onConnect={() => go("inf.key")} onTest={MOCK ? () => showToast("The key answered one small prompt in 2 s.") : undefined} />
      </Card>
      {PROVIDERS.filter((p) => open[p.id]).map((p) => {
        const o = open[p.id];
        return (
          <Card key={p.id}>
            <Stack gap={3}>
              <Text strong>{`Finish signing in to ${p.title}`}</Text>
              <Text tone="muted">{o.step.paste ? "Open the page, sign in, and copy the code it shows. Paste the code here." : "Open the page and approve the sign-in. This screen moves on by itself."}</Text>
              <Stack row gap={2} wrap>
                <Button size="sm" label="Open the sign-in" onPress={() => { void Linking.openURL(o.step.link).catch(() => say(p.id, "The sign-in page did not open. Copy the link from your browser's address bar, or try again.")); }} />
              </Stack>
              {o.step.code ? <CodeDisplay label="Code to type on the page" code={o.step.code} /> : null}
              {o.step.paste ? (
                <Stack gap={2}>
                  <Field label="Code from the page" value={pasted[p.id] ?? ""} onChangeText={(v) => { setPasted((m) => ({ ...m, [p.id]: v })); say(p.id, ""); }} error={says[p.id] || undefined} />
                  <Button size="sm" kind="primary" label="Connect" disabled={!(pasted[p.id] ?? "").trim()} onPress={() => bring(p.id)} />
                </Stack>
              ) : null}
            </Stack>
          </Card>
        );
      })}
      <Text size="caption" tone="label">You can skip this and connect an account later from Settings.</Text>
      {MOCK ? <Banner tone="plain" icon="info">{`${HINT}: Grok fails the first time you try it, so you can see the failure. Try again and it works.`}</Banner> : null}
    </FlowStep>
  );
}

export function InfKey({ set, go, back, steps }: ScreenProps) {
  const [kind, setKind] = useState<"Anthropic" | "OpenAI" | "OpenRouter">("Anthropic");
  const [key, setKey] = useState("");
  const [say, setSay] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setSay("");
    const r = await saveKey(kind, key);
    setBusy(false);
    if (!r.ok) { setSay(r.say); return; }
    set((c) => ({ ai: { ...c.ai, key: "connected" } }));
    go("inf.pick");
  };
  return (
    <FlowStep steps={steps} onBack={back} title="Add an API key" lead="The key is saved to your personal vault. It runs wherever your sessions run."
      primary={{ label: "Save to my vault", disabled: !key || busy, loading: busy, onPress: () => { void save(); } }}>
      <Segmented label="Provider" fill options={[["Anthropic", "Anthropic"], ["OpenAI", "OpenAI"], ["OpenRouter", "OpenRouter"]]} value={kind} onChange={setKind} />
      <Field label="API key" kind="password" mono value={key} onChangeText={(v) => { setKey(v); setSay(""); }} placeholder="sk-..." error={say || undefined} />
      {MOCK ? <Banner tone="plain" icon="info">{`${HINT}: any key that starts with sk- and has 8 or more characters works.`}</Banner> : null}
    </FlowStep>
  );
}

export { usePair };
