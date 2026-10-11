import { useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Card, Switch, Text } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { tool } from "../../src/real/box";
import { COMPUTERS_TITLE, allowedOf, refusal, switchLine } from "./computers-model.js";

/** For an owner or admin: whether members may run their sessions on their own computers (spaces.members.computers). Off, every session in the Space runs on the server. */
export function ComputersView({ space, allowed, busy, problem, onChange }: { space: string; allowed: boolean | null; busy: boolean; problem: string; onChange: (on: boolean) => void }) {
  return (
    <Sec title="Where sessions run">
      <Card className="gap-s2">
        <View className="flex-row items-center gap-s3">
          <View className="min-w-0 flex-1"><Text strong>{COMPUTERS_TITLE}</Text><Text size="secondary" tone="label">{switchLine(allowed, space)}</Text></View>
          <Switch on={allowed === true} disabled={busy || allowed === null} onChange={onChange} label={COMPUTERS_TITLE} />
        </View>
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
      </Card>
    </Sec>
  );
}

export function ComputersSection({ space, spaceName }: { space: string; spaceName: string }) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => { let live = true; tool<any>("spaces.members.computers", { space }).then((d) => { if (live) setAllowed(allowedOf(d)); }).catch(() => { if (live) setAllowed(null); }); return () => { live = false; }; }, [space]);
  if (allowed === null) return null;
  const set = async (on: boolean) => {
    setBusy(true); setProblem("");
    try { setAllowed(allowedOf(await tool<any>("spaces.members.computers", { space, allow: on })) ?? allowed); }
    catch (e) { setProblem(refusal((e as { code?: string }).code, e instanceof Error ? e.message : "")); }
    finally { setBusy(false); }
  };
  return <ComputersView space={spaceName} allowed={allowed} busy={busy} problem={problem} onChange={(on) => void set(on)} />;
}
