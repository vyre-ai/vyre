import { Button } from "./Button";
import { Chip } from "./Chip";
import { type IconName } from "./Icon";
import { IconTile } from "./IconTile";
import { ProviderBadge } from "./ProviderBadge";
import { Row } from "./Row";
import { Stack } from "./Stack";

export type ProviderState = "idle" | "working" | "connected" | "failed";

/**
 * One AI account in a list: the provider's mark (or an icon for an API key), its name, one sentence, and one button that changes with the state. idle: "Sign in" (or `action`);
 * working: the same button busy, "Signing in"; connected: a "Signed in" chip and Test, which sends one tiny prompt; failed: the sentence becomes what went wrong and the button is "Try again".
 * It is a Row, so it sits in a flush Card with Dividers between rows.
 */
export function ProviderRow({ provider, icon, title, sub, state, action = "Sign in", problem, onConnect, onTest }: {
  provider?: string; icon?: IconName; title: string; sub: string; state: ProviderState; action?: string; problem?: string; onConnect: () => void; onTest?: () => void;
}) {
  const end = state === "connected" ? (
    <Stack row gap={2} align="center">
      <Chip tone="ok" icon="ok">Signed in</Chip>
      {onTest ? <Button kind="ghost" size="sm" label="Test" onPress={onTest} /> : null}
    </Stack>
  ) : (
    <Button kind={state === "failed" ? "secondary" : "primary"} size="sm" label={state === "working" ? "Signing in" : state === "failed" ? "Try again" : action} loading={state === "working"} onPress={onConnect} />
  );
  return (
    <Row dense lead={provider ? <ProviderBadge provider={provider} size={32} /> : <IconTile name={icon ?? "key"} />} title={title} sub={state === "failed" && problem ? problem : sub} end={end} />
  );
}
