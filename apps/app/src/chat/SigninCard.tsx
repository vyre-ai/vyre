// The sign-in card (R031-88): the assistant needs you to sign in somewhere ("Sign in to GoHighLevel"). One button opens the screen in place with the keyboard yours and the page private: the assistant cannot see it
// and never gets the password. When you are signed in, one tap hands back and the assistant carries on. The words never include anything typed.
import { useState } from "react";
import { View } from "react-native";
import { Banner, Button, Chip, Icon, Text, useUiTheme } from "@vyre/ui";
import { tool } from "../real/box";
import { LiveScreen } from "./LiveScreen";
import { signinWords } from "./screen-model.js";

type Sign = { block: "signin"; id: string; computer: string; site: string; why: string; state: "waiting" | "done" | "cancelled" | "expired" };

export function SigninCard({ block }: { block: Sign }) {
  const { color } = useUiTheme();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState("");
  const state = done && block.state === "waiting" ? "done" : block.state;
  const w = signinWords({ site: block.site, state });
  const finish = async () => { setProblem(""); try { await tool("previews.signin-done", { id: block.id }); setDone(true); setOpen(false); } catch (e) { setProblem(e instanceof Error && e.message ? e.message : "That did not go through."); } };
  return (
    <View style={{ borderWidth: 1, borderColor: state === "waiting" ? color["edge-strong"] : color.edge, backgroundColor: state === "waiting" ? color["accent-wash"] : color["surface-2"], borderRadius: 14, marginVertical: 4, maxWidth: 560, padding: 14, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon name={state === "done" ? "check" : "key"} tone={state === "done" ? "ok" : "text-2"} />
        <Text strong style={{ flex: 1, minWidth: 0 }}>{w.title}</Text>
        {state === "waiting" ? <Chip tone="accent">Needs you</Chip> : null}
      </View>
      {block.why && state === "waiting" ? <Text tone="muted">{block.why}</Text> : null}
      <Text size="secondary" tone="muted">{w.detail}</Text>
      {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
      {state === "waiting" && !open ? <View style={{ alignSelf: "flex-start" }}><Button kind="primary" size="sm" label={`Sign in to ${block.site}`} onPress={() => setOpen(true)} /></View> : null}
      {state === "waiting" && open ? <LiveScreen computer={block.computer} private autoTake onHandedBack={finish} /> : null}
    </View>
  );
}
