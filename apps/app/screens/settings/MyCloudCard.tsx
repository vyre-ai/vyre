import { useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Text, showToast } from "@vyre/ui";
import { call } from "../../src/api/box";
import { said, tool } from "../../src/real/box";
import { loadIdentity } from "../../src/identity/store";
import { proofHeader } from "../../src/real/approvals.js";
import { hashMatches } from "../../src/real/payload-hash.js";
import { yesSigner } from "../../src/personal/signer";
import { createSpace } from "../../src/real/install";
import { MOVE, SET_UP, blockersOf, canMove, cloudState, offerFor, planLines, refusalLine, reportLines, runInput, serversOf, setupInput } from "./my-cloud.js";

type Step = { kind: "idle" } | { kind: "plan"; plan: any } | { kind: "report"; report: ReturnType<typeof reportLines> };

/**
 * Set up My Cloud on the person's paired server, then move Personal into it: the plan first (what moves, what stays), blockers hide the button, one approval bound to that plan, then the report. The words and rules are
 * my-cloud.js; the approval is the same device signature as every yes (Face ID on the phone, the passkey in a browser).
 */
export function MyCloudCard() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const load = () => {
    tool<any[]>("spaces.list").then((d) => setRows(Array.isArray(d) ? d : [])).catch(() => setRows(null));
    tool("spaces.servers").then((d) => setServers(serversOf(d))).catch(() => setServers([]));
  };
  useEffect(load, []);
  const state = cloudState(rows ?? []);
  const offer = offerFor(state, servers.length > 0);
  if (rows === null || offer === "none") return null;
  const guard = async (go: () => Promise<void>) => { setBusy(true); setProblem(""); try { await go(); } catch (e) { setProblem(refusalLine(e) || said(e)); } finally { setBusy(false); } };

  const setUp = () => guard(async () => {
    const made = await createSpace(setupInput(servers[0]));
    if (made.state === "failed") throw new Error(made.say);
    showToast("My Cloud is set up."); load();
  });
  const look = () => guard(async () => { setStep({ kind: "plan", plan: await tool("spaces.upgrade.plan", { to: String(state.cloud?.id) }) }); });
  const move = (plan: any) => guard(async () => {
    const to = String(state.cloud?.id);
    let r: any = await tool("spaces.upgrade.run", runInput(plan, to));
    if (r?.needs_proof && r.request) {
      // One approval, bound to the plan: check the hash is for what was shown, sign it with this device's key, and send the same call again with the proof.
      if (!hashMatches(r.request)) throw new Error("This request does not match what it says. Nothing was approved.");
      const signer = await yesSigner();
      if (!signer) throw Object.assign(new Error("This phone cannot give the yes yet. Update Vyre."), { code: "no_signer" });
      const person = (await loadIdentity())?.id ?? "";
      const proof = await signer.signPresence({ op: r.request.op, space: r.request.space, fields: r.request.fields, payload_hash: r.request.payload_hash, prompt: MOVE.title, person });
      const again = await call<any>("spaces.upgrade.run", runInput(plan, to), { kernelProof: proofHeader(proof) });
      if (again.error) throw Object.assign(new Error(again.error.message), { code: again.error.code });
      r = again.data;
    }
    setStep({ kind: "report", report: reportLines(r) }); load();
  });

  return (
    <Card className="gap-s2">
      {offer === "moved" ? (<><Text strong>Personal now lives in My Cloud</Text><Text tone="muted">Your things were moved. Personal is read-only and points there.</Text></>) : null}
      {offer === "setup" ? (<>
        <Text strong>{SET_UP.title}</Text><Text tone="muted">{SET_UP.body}</Text>
        <View className="flex-row"><Button label={SET_UP.action} loading={busy} onPress={() => void setUp()} /></View>
      </>) : null}
      {offer === "move" && step.kind === "idle" ? (<>
        <Text strong>{MOVE.title}</Text><Text tone="muted">{MOVE.body}</Text>
        <View className="flex-row"><Button label={MOVE.action} loading={busy} onPress={() => void look()} /></View>
      </>) : null}
      {offer === "move" && step.kind === "plan" ? (<>
        <Text strong>What would move</Text>
        {planLines(step.plan).length ? planLines(step.plan).map((l, i) => <Text key={i}>{l}</Text>) : <Text tone="muted">There is nothing in Personal to move yet.</Text>}
        {blockersOf(step.plan).length ? <Banner tone="warn"><View className="gap-s1"><Text strong>{MOVE.blocked}</Text>{blockersOf(step.plan).map((b, i) => <Text key={i}>{b}</Text>)}</View></Banner> : null}
        <View className="flex-row gap-s2">
          {canMove(step.plan) ? <Button label={MOVE.approve} loading={busy} onPress={() => void move(step.plan)} /> : null}
          <Button kind="ghost" label="Not now" disabled={busy} onPress={() => setStep({ kind: "idle" })} />
        </View>
      </>) : null}
      {step.kind === "report" ? (<>
        <Text strong>{step.report.moved.length ? "Moved to My Cloud" : "Nothing moved"}</Text>
        {step.report.moved.map((l, i) => <Text key={i}>{l}</Text>)}
        {step.report.notMoved.length ? <Banner tone="warn"><View className="gap-s1"><Text strong>Did not move</Text>{step.report.notMoved.map((l, i) => <Text key={i}>{l}</Text>)}</View></Banner> : null}
        {step.report.notes.map((l, i) => <Text key={i} tone="muted">{l}</Text>)}
        <Text tone="muted">{step.report.after}</Text>
        <View className="flex-row"><Button kind="ghost" label="Done" onPress={() => setStep({ kind: "idle" })} /></View>
      </>) : null}
      {problem ? <Text tone="err">{problem}</Text> : null}
    </Card>
  );
}
