// Proof page, never linked from the app: the REAL screens and the REAL routing (src/real/box.ts tool, server-route.js, space-servers.ts) driven against two pretend servers, so a browser test can look at what a person
// would see with one identity paired to two servers. `?mode=boxless` is a window that runs on a server with nothing paired (no box, no Personal space). The pretend servers are src/real/peer.ts setPeerFake.
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { ThemeProvider, Text } from "@vyre/ui";
import ServersScreen from "../screens/settings/ServersScreen";
import { MyCloudCard } from "../screens/settings/MyCloudCard";
import { savePairing, loadPairings, removePairingFor } from "../src/api/relay";
import { setPeerFake, usePeer } from "../src/real/peer";
import { setBoxOverride, tool } from "../src/real/box";
import { call } from "../src/api/box";
import { setPorts } from "../src/real/space-servers";
import { useSpaces } from "../screens/shell/state";
import { placeTag } from "../src/state/space-name.js";

const A = "spc_aaaaaaaaaaaa", B = "spc_bbbbbbbbbbbb";
const pairing = (box: string, name: string) => ({ relay: "wss://relay.example.net", route: box.repeat(5), box, name, device: `dev_${box}`, presence: null });

/** The two pretend servers: A is the person's own (My Cloud), B holds a team's Space and one held act. Every call is logged with the server that got it. */
export const log: Array<{ box: string; tool: string; input: any }> = [];
function world() {
  const space = (box: string) => (box === "boxa" ? [{ id: A, label: "personal", tier: "cloud", who: "personal", status: "done" }] : [{ id: B, displayName: "Northwind", tier: "cloud", status: "done" }]);
  return async (name: string, input: Record<string, unknown>, box: string) => {
    log.push({ box, tool: name, input });
    if (name === "spaces.list") return space(box);
    if (name === "approvals.pending") return { approvals: box === "boxb" ? [{ id: "appr_b1", title: "Email to Northwind", payload_hash: "h1", op: "mail.send", space: B, fields: {} }] : [] };
    if (name === "work.chat.list") return { chats: [{ chat: box === "boxa" ? "chat_a" : "chat_b", title: box === "boxa" ? "Personal chat" : "Team chat" }] };
    return { ok: true, answeredBy: box };
  };
}

export default function TwoServersProof() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const [ready, setReady] = useState(false);
  const [out, setOut] = useState("");
  const [rows, setRows] = useState("");
  useEffect(() => {
    void (async () => {
      setPorts(null);
      if (mode === "boxless") {
        // no box and nothing paired: every call fails the way a window with no server does
        for (const p of (await loadPairings()).items ? Object.keys((await loadPairings()).items) : []) await removePairingFor(p);
        usePeer(false);
        setPeerFake(null);
        setBoxOverride(async () => { throw Object.assign(new Error("No server answered."), { code: "unreachable" }); });
      } else {
        setBoxOverride(null);
        for (const p of Object.keys((await loadPairings()).items)) await removePairingFor(p);
        await savePairing(pairing("boxa", "my droplet"));
        await savePairing(pairing("boxb", "team droplet"));
        usePeer(true);
        setPeerFake(world());
        useSpaces.getState().setShowing("all");
      }
      setReady(true);
    })();
  }, [mode]);
  const run = (label: string, f: () => Promise<unknown>) => async () => {
    try { setOut(`${label}: ${JSON.stringify(await f())}`); } catch (e) { setOut(`${label}: REFUSED ${(e as { code?: string }).code}: ${(e as Error).message}`); }
  };
  const showRows = run("rows", async () => {
    const list = (await tool<any[]>("spaces.list")) ?? [];
    setRows(list.map((r) => `${placeTag(r)} on ${r.server}`).join(" | "));
    return list.length;
  });
  if (!ready) return null;
  const Btn = ({ id, label, f }: { id: string; label: string; f: () => void }) => (
    <Pressable testID={id} accessibilityRole="button" onPress={f} style={{ padding: 8, borderWidth: 1, margin: 4 }}><Text>{label}</Text></Pressable>
  );
  return (
    <ThemeProvider>
      <ScrollView style={{ flex: 1, padding: 16 }}>
        {mode === "boxless" ? <MyCloudCard /> : null}
        <ServersScreen />
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          <Btn id="rows" label="List every server's Spaces" f={() => void showRows()} />
          <Btn id="all-create" label="All spaces: create a record" f={() => { useSpaces.getState().setShowing("all"); void run("create", () => tool("records.create", { type: "contact" }))(); }} />
          <Btn id="all-vault" label="All spaces: vault list" f={() => { useSpaces.getState().setShowing("all"); void run("vault", () => tool("vault.list"))(); }} />
          <Btn id="b-vault" label="Team Space showing: vault list" f={() => { useSpaces.getState().setShowing(B); void run("vault", () => tool("vault.list"))(); }} />
          <Btn id="b-record" label="A showing: edit a team record" f={() => { useSpaces.getState().setShowing(A); void run("edit", () => tool("records.update", { urn: `vyre://${B}/contact/01a1`, patch: {} }))(); }} />
          <Btn id="approvals" label="Approvals: list, then answer the team's" f={() => void run("approvals", async () => { const l = await tool<any>("approvals.pending"); const a = await tool("approvals.answer", { id: "appr_b1", approve: true }); return { listed: l.approvals.map((x: any) => `${x.id}@${x.server}`), answered: a }; })()} />
          <Btn id="direct-vault" label="Direct call (as the screens make them), All spaces: vault list" f={() => { useSpaces.getState().setShowing("all"); void run("direct-vault", async () => { const r = await call("vault.list"); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data; })(); }} />
          <Btn id="direct-answer" label="Direct call: answer the team's approval" f={() => void run("direct-answer", async () => { await tool("approvals.pending"); const r = await call("approvals.answer", { id: "appr_b1", approve: true }); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data; })()} />
          <Btn id="log" label="Which server got what" f={() => setOut(`log: ${log.filter((l) => !["spaces.list", "work.chat.list"].includes(l.tool)).map((l) => `${l.tool}@${l.box}`).join(",")}`)} />
        </View>
        <Text testID="out">{out}</Text>
        <Text testID="rows-out">{rows}</Text>
      </ScrollView>
    </ThemeProvider>
  );
}
