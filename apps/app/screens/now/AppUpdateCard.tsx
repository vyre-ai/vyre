import { useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Text } from "@vyre/ui";
import { shell } from "../../src/shell/shell";
import { DOWNLOADING, latestAppRelease, runAppUpdate } from "../../src/shell/app-update.js";

type Step = { busy: boolean; line: string; ok?: boolean };

/**
 * The Mac app's own update, on Now and in Settings, Updates (src/shell/app-update.js): a newer stable Vyre for this Mac, and one button that has the browser download its dmg and then says the
 * two steps that finish it, or a plain error. The button always shows "Downloading…" and then a result. `hint` is the version the server says is out, used when GitHub cannot be read. Nothing
 * outside the Mac app.
 */
export function AppUpdateCard({ hint }: { hint?: string | null }) {
  const s = shell();
  const [rel, setRel] = useState<{ version: string; url: string } | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  useEffect(() => {
    if (!s) return;
    let live = true;
    void latestAppRelease({ current: s.version, arch: s.arch ?? null, hint: hint ?? null }).then((r) => { if (live) setRel(r); }).catch(() => {});
    return () => { live = false; };
  }, [s, hint]);
  if (!s || !rel) return null;
  const press = () => { void runAppUpdate({ open: (u) => s.open(u), release: rel, onStep: setStep }); };
  return (
    <Banner>
      <View className="gap-s2">
        <Text strong>{`This Mac app: version ${rel.version} is out`}</Text>
        <Text>{`You are on ${s.version || "an older version"}. Update downloads the new app. Your data, vault and sign-ins stay.`}</Text>
        {step && !step.busy ? <Text tone={step.ok ? "default" : "warn"}>{step.line}</Text> : null}
        <View className="flex-row">
          <Button size="sm" label={step?.busy ? DOWNLOADING : step?.ok ? "Download again" : "Update"} disabled={Boolean(step?.busy)} onPress={press} />
        </View>
      </View>
    </Banner>
  );
}
