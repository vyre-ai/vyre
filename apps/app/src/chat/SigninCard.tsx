// The sign-in card (R031-88): the assistant needs you signed in somewhere ("Sign in to GoHighLevel"). If the Vault holds a login for that site, it is the first offer: "Fill from the Vault" lends it to this computer
// for an hour, for that one site, and the assistant never sees it. Under it, "Sign in yourself" opens the screen in place with the keyboard yours and the page private: the assistant cannot see it and never gets a
// password. Either way, one tap and the assistant carries on. The words never include anything typed.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Chip, Icon, Text, useUiTheme } from "@vyre/ui";
import { tool } from "../real/box";
import { LiveScreen } from "./LiveScreen";
import { loginsFor, signinWords } from "./screen-model.js";

type Sign = { block: "signin"; id: string; computer: string; site: string; why: string; state: "waiting" | "done" | "cancelled" | "expired" };

export function SigninCard({ block }: { block: Sign }) {
  const { color } = useUiTheme();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [logins, setLogins] = useState<{ name: string; origin: string; exact: boolean }[]>([]);
  const state = done && block.state === "waiting" ? "done" : block.state;
  const w = signinWords({ site: block.site, state });
  useEffect(() => {
    if (state !== "waiting") return;
    let dead = false;
    tool<{ items?: { name: string; kind: string; hosts?: string[] }[] }>("vault.items.names", { q: block.site.split(".").slice(-2, -1)[0] || block.site, kind: "login", limit: 30 })
      .then((r) => { if (!dead) setLogins(loginsFor(r.items ?? [], block.site)); }).catch(() => {});
    return () => { dead = true; };
  }, [block.site, state]);
  const finish = async () => { setProblem(""); try { await tool("previews.signin-done", { id: block.id }); setDone(true); setOpen(false); } catch (e) { setProblem(e instanceof Error && e.message ? e.message : "That did not go through."); } };
  const fill = async (l: { name: string; origin: string }) => {
    setBusy(true); setProblem("");
    try { await tool("vault.agent.grant", { agent: block.computer, item: l.name, origin: l.origin, expires: "1h" }); await finish(); }
    catch (e) { setProblem(e instanceof Error && e.message ? e.message : "The Vault did not lend it."); }
    finally { setBusy(false); }
  };
  return (
    <View style={{ borderWidth: 1, borderColor: state === "waiting" ? color["edge-strong"] : color.edge, backgroundColor: state === "waiting" ? color["accent-wash"] : color["surface-2"], borderRadius: 14, marginVertical: 4, maxWidth: 560, padding: 14, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon name={state === "done" ? "check" : "key"} tone={state === "done" ? "ok" : "text-2"} />
        <Text strong style={{ flex: 1, minWidth: 0 }}>{w.title}</Text>
        {state === "waiting" ? <Chip tone="accent">Needs you</Chip> : null}
      </View>
      {block.why && state === "waiting" ? <Text tone="muted">{block.why}</Text> : null}
      {state === "waiting" && logins.length && !open ? (
        <View style={{ gap: 8 }}>
          <Text size="secondary" tone="muted">{`Your Vault has ${logins.length === 1 ? "a login" : "logins"} for ${block.site}. It is lent to ${block.computer} for one hour, for this site only, and the assistant never sees it.`}</Text>
          {logins.slice(0, 3).map((l, i) => <View key={l.name} style={{ alignSelf: "flex-start" }}><Button kind={i === 0 ? "primary" : "ghost"} size="sm" icon="key" label={`Fill from the Vault: ${l.name}`} disabled={busy} onPress={() => fill(l)} /></View>)}
        </View>
      ) : <Text size="secondary" tone="muted">{w.detail}</Text>}
      {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
      {state === "waiting" && !open ? <View style={{ alignSelf: "flex-start" }}><Button kind={logins.length ? "ghost" : "primary"} size="sm" label="Sign in yourself" disabled={busy} onPress={() => setOpen(true)} /></View> : null}
      {state === "waiting" && open ? <LiveScreen computer={block.computer} private autoTake onHandedBack={finish} /> : null}
    </View>
  );
}
