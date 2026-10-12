import { useEffect, useRef, useState } from "react";
import { Banner, Card, IconTile, Row, Divider, Field, FlowStep, PasswordField, ProviderRow, Segmented, Stack, Switch, Text, passwordStrength, showToast } from "@vyre/ui";
import { DEMO, apiKeyStatus, masterStatus } from "./flow-model.js";
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
  return (
    <FlowStep steps={steps} onBack={back} title={ctx.reset ? "Create a new master password" : "Create your master password"} lead="Choose something only you would think of. A phrase of four words is easy to remember and hard to guess."
      failure={pair.failure}
      primary={{ label: "Continue", disabled: !pair.ready, onPress: () => { if (pair.check()) { set({ master: pair.value }); go("master.confirm"); } } }}>
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
        <Row dense lead={<IconTile name="lock" />} title="Only you can open it" sub="One master password, typed once on each device." />
        <Divider inset={60} />
        <Row dense lead={<IconTile name="devices" />} title="It lives with you" sub="On your devices, and sealed inside each space you join." />
        <Divider inset={60} />
        <Row dense lead={<IconTile name="shield" />} title="Vyre cannot see inside" sub="Not your servers, not your team, not us." />
      </Card>
    </FlowStep>
  );
}

export function MasterConfirm({ go, back, steps }: ScreenProps) {
  const [ok, setOk] = useState(false);
  return (
    <FlowStep steps={steps} onBack={back} title="Only you know it" lead="If you forget your master password, your vault cannot be opened, and Vyre cannot reset it."
      primary={{ label: "Open my vault", disabled: !ok, onPress: () => go("inf.pick") }}>
      <Card>
        <Stack row gap={3} align="center" justify="between">
          <Text strong>I understand</Text>
          <Switch label="I understand that a forgotten master password cannot be reset" on={ok} onChange={setOk} />
        </Stack>
      </Card>
      <Text size="caption" tone="label">Write it down and keep it with your recovery code, or use a password manager you trust.</Text>
    </FlowStep>
  );
}

export function MasterEnter({ ctx, set, go, back, steps }: ScreenProps) {
  const [pw, setPw] = useState("");
  const [tried, setTried] = useState(false);
  const wrong = tried && masterStatus(pw, ctx.master) !== "ok";
  return (
    <FlowStep steps={steps} onBack={back} title="Open your vault here" lead="Type your master password once on this device. After that, Touch ID, Windows Hello or your phone's lock opens it."
      primary={{ label: "Open my vault", disabled: !pw, onPress: () => { setTried(true); if (masterStatus(pw, ctx.master) === "ok") go("inf.pick"); } }}
      secondary={{ label: "I forgot it: use my recovery kit", onPress: () => { set({ reset: true }); go("id.recover"); } }}>
      <PasswordField label="Master password" name="Master password" value={pw} onChangeText={(v) => { setPw(v); setTried(false); }} error={wrong ? "That is not your master password. Try again, or use your recovery kit to set a new one." : undefined} />
      <Banner tone="plain" icon="info">{`${HINT}: the master password in this prototype is ${ctx.master || DEMO.master}.`}</Banner>
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
  const grokTries = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const put = (id: string, state: AiState) => set((c) => ({ ai: { ...c.ai, [id]: state } }));
  const connect = (id: string) => {
    put(id, "working");
    timers.current.push(setTimeout(() => {
      put(id, id === "grok" && grokTries.current++ === 0 ? "failed" : "connected");
    }, 900));
  };
  const failed = PROVIDERS.find((p) => ai[p.id] === "failed");
  const count = Object.values(ai).filter((s) => s === "connected").length;
  return (
    <FlowStep steps={steps} onBack={back} title="Connect your AI" lead="Pick one or more. Each sign-in is saved to your personal vault, not to any server."
      failure={failed ? `${failed.title} did not finish signing in. Check that you are signed in to it in your browser, then try again, or add an API key instead.` : undefined}
      primary={{ label: count ? "Continue" : "Continue without an account", onPress: () => { set({ aiSkipped: !count }); go("space.choice"); } }}
      secondary={count ? undefined : { label: "Skip for now", onPress: () => { set({ aiSkipped: true }); go("space.choice"); } }}>
      <Card flush>
        {PROVIDERS.map((p) => (
          <Stack key={p.id} gap={0}>
            <ProviderRow provider={p.id} title={p.title} sub={p.sub} state={ai[p.id] ?? "idle"} problem="Sign-in did not finish." onConnect={() => connect(p.id)} onTest={() => showToast(`${p.title} answered one small prompt in 2 s.`)} />
            <Divider inset={60} />
          </Stack>
        ))}
        <ProviderRow icon="key" title="An API key" sub="Anthropic, OpenAI or OpenRouter." state={ai.key === "connected" ? "connected" : "idle"} action="Add a key" onConnect={() => go("inf.key")} onTest={() => showToast("The key answered one small prompt in 2 s.")} />
      </Card>
      <Text size="caption" tone="label">You can skip this and connect an account later from Settings.</Text>
      <Banner tone="plain" icon="info">{`${HINT}: Grok fails the first time you try it, so you can see the failure. Try again and it works.`}</Banner>
    </FlowStep>
  );
}

export function InfKey({ ctx, set, go, back, steps }: ScreenProps) {
  const [kind, setKind] = useState<"Anthropic" | "OpenAI" | "OpenRouter">("Anthropic");
  const [key, setKey] = useState("");
  const [tried, setTried] = useState(false);
  const bad = tried && apiKeyStatus(key) !== "ok";
  return (
    <FlowStep steps={steps} onBack={back} title="Add an API key" lead="The key is saved to your personal vault. It runs wherever your sessions run."
      primary={{ label: "Save to my vault", disabled: !key, onPress: () => { setTried(true); if (apiKeyStatus(key) === "ok") { set((c) => ({ ai: { ...c.ai, key: "connected" } })); go("inf.pick"); } } }}>
      <Segmented label="Provider" fill options={[["Anthropic", "Anthropic"], ["OpenAI", "OpenAI"], ["OpenRouter", "OpenRouter"]]} value={kind} onChange={setKind} />
      <Field label="API key" kind="password" mono value={key} onChangeText={(v) => { setKey(v); setTried(false); }} placeholder="sk-..."
        error={bad ? `That does not look like a ${kind} key. Keys start with sk-. Copy it again from the provider's page, or go back and sign in instead.` : undefined} />
      <Banner tone="plain" icon="info">{`${HINT}: any key that starts with sk- and has 8 or more characters works.`}</Banner>
    </FlowStep>
  );
}

export { usePair };
