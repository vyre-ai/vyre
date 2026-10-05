import { useEffect, useState } from "react";
import { Button, Text, showToast } from "@vyre/ui";
import { said, tool } from "../../src/real/box";
import { loadIdentity } from "../../src/identity/store";
import { grantServer, grantLine, GRANT_BODY, revokeServer } from "../../src/personal/grant.js";
import { pins } from "../../src/personal/pins";
import { yesSigner } from "../../src/personal/signer";

type Status = { id?: string; server?: string; kept?: string; granted?: { fp: string }[] } | null;

/**
 * "Let <space> keep your planner running": the person's one yes for the team server that keeps their private notes, and the way to take it back. Shown only where the box keeps an identity memory sealed.
 * After the yes this phone answers that server's requests by itself (src/personal/answerer.ts); revoking locks it and stops the answers.
 */
export function KeepRunning({ space, name }: { space: string; name: string }) {
  const [st, setSt] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const load = () => { tool("memory.identity.status", {}).then((d) => setSt(d as Status)).catch(() => setSt(null)); };
  useEffect(load, []);
  if (!st || st.kept !== "here" || !st.server) return null;
  const fp = st.server;
  const on = Boolean(st.granted?.some((g) => g.fp === fp));
  const run = async (go: () => Promise<void>, done: string) => {
    setBusy(true); setProblem("");
    try { await go(); showToast(done); load(); } catch (e) { setProblem(said(e)); } finally { setBusy(false); }
  };
  const give = () => run(async () => {
    const person = (await loadIdentity())?.id ?? "";
    await grantServer({ call: (t, i) => tool(t, i ?? {}), signer: await yesSigner(), person, space, name, pins });
  }, `${name} keeps your planner running.`);
  const take = () => run(() => revokeServer({ call: (t, i) => tool(t, i ?? {}), fp, pins }), "Taken back. Your private notes are locked on that server.");
  return (
    <>
      <Text strong>{on ? `${name} keeps your planner running` : grantLine(name)}</Text>
      <Text tone="muted">{on ? "Your reminders and notes ring while your computer is off. Take it back any time." : GRANT_BODY}</Text>
      {on ? <Button kind="ghost" label="Take it back" disabled={busy} onPress={() => void take()} /> : <Button label="Let it" loading={busy} onPress={() => void give()} />}
      {problem ? <Text tone="err">{problem}</Text> : null}
    </>
  );
}
