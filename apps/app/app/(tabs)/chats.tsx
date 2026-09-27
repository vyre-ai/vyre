import { useRouter } from "expo-router";
import { sessionOpening } from "../../src/perf";
import { useTabDrawn } from "../../src/perf/tabs";
import { age } from "../../src/state/needs-model";
import { useThreads, useThreadsFrom, type ThreadRow } from "../../src/state/threads";
import { List } from "../../src/ui/List";
import { Row, ROW_HEIGHT } from "../../src/ui/Row";
import { Empty, Screen } from "../../src/ui/Screen";
import type { Status } from "../../src/ui/StatusMark";

/** A session's mark, most urgent first (tokens.status.order). */
function statusOf(t: ThreadRow): Status {
  if (t.asks > 0) return "needsYou";
  if (t.status === "stopped" && t.stopped_reason && /crash|failed|exited [^0]/.test(t.stopped_reason)) return "failed";
  if (t.status === "working" || t.status === "starting" || t.status === "waiting") return "running";
  return "done";
}

function word(t: ThreadRow): string {
  if (t.asks > 0) return `${t.asks} waiting on you`;
  if (t.status === "stopped" && t.stopped_reason === "idle") return "idle";
  if (t.status === "working") return "running";
  return t.status === "stopped" ? "ended" : t.status;
}

export default function Chats() {
  const threads = useThreads();
  const from = useThreadsFrom();
  const router = useRouter();
  useTabDrawn();
  const now = Date.now();
  return (
    <Screen title="Chats">
      {threads.length === 0 ? (
        <Empty text={from === "none" ? " " : "No chats yet"} />
      ) : (
        <List
          items={threads}
          keyOf={(t) => t.id}
          rowHeight={ROW_HEIGHT}
          render={(t) => (
            <Row
              avatar={t.agent ?? t.name ?? "s"}
              title={t.name ?? "Session"}
              age={t.last ? age(t.last, now) : undefined}
              detail={word(t)}
              meta={[t.agent, t.projectName ?? t.project, t.model].filter(Boolean).join(" · ")}
              status={statusOf(t)}
              testID="chat-row"
              onPress={() => {
                sessionOpening();
                router.push({ pathname: "/session/[id]", params: { id: t.id } });
              }}
            />
          )}
        />
      )}
    </Screen>
  );
}
