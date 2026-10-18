import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { Button, Text } from "@vyre/ui";
import { tool } from "../../src/real/box";
import { FileViewerSheet } from "../drive/FileViewerSheet";

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
  const router = useRouter();
  const [status, setStatus] = useState<Status | undefined>(undefined);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [problem, setProblem] = useState("");
  /** Download audit: the server fetches the file and saves it to Files > Signed; the button opens the saved file there. */
  const downloadAudit = () => {
    setBusy(true); setProblem("");
    tool<{ path?: string }>("documents.signing.audit", { submission })
      .then((r) => setSaved(r?.path ?? null))
      .catch((e) => setProblem(e instanceof Error ? e.message : "The audit file could not be saved."))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    tool<{ status?: Status }>("documents.signing.status", { submission })
      .then((r) => setStatus(r?.status ?? null))
      .catch(() => setStatus(null));
  }, [submission]);
  if (status === undefined) return <Text size="caption" tone="label">Loading the timeline…</Text>;
  if (!status || !status.signers.length) return null;
  const signed = status.signers.some((s) => s.signed);
  return (
    <>
      {status.signers.map((s, i) => {
        const line = timelineLine(s);
        return line ? <Text key={`${s.email}-${i}`} size="caption" tone="muted">{line}</Text> : null;
      })}
      {signed ? (
        saved ? (
          <>
            <Button kind="secondary" size="sm" label="Open the audit file" onPress={() => setPreview(true)} />
            <FileViewerSheet path={preview ? saved : null} onClose={() => setPreview(false)} />
          </>
        ) : (
          <Button kind="secondary" size="sm" label={busy ? "Saving the audit file…" : "Download audit"} disabled={busy} onPress={downloadAudit} />
        )
      ) : null}
      {problem ? <Text size="caption" tone="label">{problem}</Text> : null}
    </>
  );
}
