import { useEffect, useState } from "react";
import { Text } from "@vyre/ui";
import { tool } from "../../src/real/box";

type Signer = { name: string; email: string; sent: number | null; opened: number | null; signed: number | null; declined: number | null };
type Status = { submission: number; status: string; signers: Signer[]; audit_url: string | null } | null;

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The plain lines for one signer: "Sent to Ava, 9:40 · Opened 9:52 · Signed 10:03". Only what the server reports is shown. */
export function timelineLine(s: Signer): string {
  const who = s.name || s.email || "the signer";
  const parts: string[] = [];
  if (s.sent) parts.push(`Sent to ${who}, ${clock(s.sent)}`);
  if (s.opened) parts.push(`Opened ${clock(s.opened)}`);
  if (s.signed) parts.push(`Signed ${clock(s.signed)}`);
  if (s.declined) parts.push(`Declined ${clock(s.declined)}`);
  return parts.join(" · ");
}

/**
 * One request's timeline on the Signing tab, read from documents.signing.status (what was sent, opened, signed or declined). Nothing is invented: a
 * step the server does not report is not shown.
 */
export function RequestTimeline({ submission }: { submission: number }) {
  const [status, setStatus] = useState<Status | undefined>(undefined);
  useEffect(() => {
    tool<{ status?: Status }>("documents.signing.status", { submission })
      .then((r) => setStatus(r?.status ?? null))
      .catch(() => setStatus(null));
  }, [submission]);
  if (status === undefined) return <Text size="caption" tone="label">Loading the timeline…</Text>;
  if (!status || !status.signers.length) return null;
  return (
    <>
      {status.signers.map((s, i) => {
        const line = timelineLine(s);
        return line ? <Text key={`${s.email}-${i}`} size="caption" tone="muted">{line}</Text> : null;
      })}
    </>
  );
}
