import { useRouter } from "expo-router";
import { connect } from "../api/box";
import { useConnection } from "../state/connection";
import { refresh } from "../state/live";
import { useGap } from "../state/setup-gap";
import { EMPTY, WAITING, type EmptyCopy } from "../../screens/install/first-run.js";
import { Empty } from "./Screen";

/**
 * A landing screen with nothing to show: one line and one action, never blank. What is missing on this device comes first (no Vyre to talk to, or no phone to
 * approve), then a box that has not answered, then the screen's own empty line.
 */
export function EmptyHere({ kind, loading }: { kind: keyof typeof EMPTY; loading?: boolean }) {
  const router = useRouter();
  const gap = useGap();
  const status = useConnection();
  const act = (c: EmptyCopy) => () => {
    if (c.route === "refresh") { void connect().catch(() => {}); refresh(); } else router.push(c.route as never);
  };
  // Waiting on the box with nothing cached: say so, and let the person ask again.
  const c = gap ?? (loading ? (status === "live" ? null : WAITING) : EMPTY[kind]);
  if (!c) return <Empty text="Asking your Vyre" />;
  return <Empty text={c.title} line={c.line} action={{ label: c.action, onPress: act(c) }} />;
}
