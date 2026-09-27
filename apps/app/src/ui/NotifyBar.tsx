import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { enablePush, pushStatus, type PushStatus } from "../pwa/pwa";
import { Banner } from "./Banner";
import { Button } from "./Button";

/**
 * "Turn on notifications", on Now in the web app, while they are off on this device. Nothing is
 * asked on load: the browser's prompt comes only from this tap.
 */
export function NotifyBar() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    let live = true;
    pushStatus().then((s) => live && setStatus(s), () => {});
    return () => {
      live = false;
    };
  }, []);
  if (status !== "off" && !error) return null;
  const turnOn = () => {
    setBusy(true);
    setError(null);
    enablePush().then(
      async () => {
        setBusy(false);
        setStatus(await pushStatus().catch(() => "on" as const));
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <Banner
      fact="Hear from your box when something needs you"
      detail={error}
      live={!!error}
      action={status === "off" ? <Button kind="outline" label="Turn on notifications" busy={busy} busyLabel="Turning on" onPress={turnOn} /> : null}
    />
  );
}
