// Write an email as the person: To, Cc, Bcc, a subject, the words and Files from the Space's Drive. Saying Send holds it at the Gate
// (mail.send); nothing goes until the person says yes there. The form, what it sends and what is wrong with it are in @vyre/ui.
import { useState } from "react";
import { View } from "react-native";
import { Button, MailComposer, blankMail, problemOf, sendInput, showToast, type FileChoice, type MailForm } from "@vyre/ui";
import { tool } from "../../src/real/box";

type Entry = { path: string; size?: number };

/** The Space's files whose name has the words typed, as the composer offers them. */
async function filesNamed(query: string): Promise<FileChoice[]> {
  const r = await tool<{ entries?: Entry[] }>("files.drive.space.list", { prefix: "", limit: 500 });
  const q = query.trim().toLowerCase();
  return (r.entries || [])
    .filter((e) => typeof e.size === "number")
    .map((e) => ({ path: e.path, name: e.path.slice(e.path.lastIndexOf("/") + 1) }))
    .filter((f) => !q || f.name.toLowerCase().includes(q));
}

/** The compose screen. `account` names the mail account to send from when the person has more than one (mail.accounts). */
export default function ComposeMail({ account, onDone, to }: { account?: string; onDone?: () => void; /** An address to start with (Send email on a record). */ to?: string }) {
  const [form, setForm] = useState<MailForm>({ ...blankMail(), ...(to ? { to } : {}) });
  const [busy, setBusy] = useState(false);
  const problem = problemOf(form);
  const send = () => {
    setBusy(true);
    tool<{ held?: string; message?: string }>("mail.send", { ...sendInput(form), ...(account ? { account } : {}) })
      .then((r) => { showToast(r.message || "Held for your yes in Vyre. Nothing was sent."); setForm(blankMail()); onDone?.(); })
      .catch((e) => showToast((e as { message?: string })?.message || "That did not work."))
      .finally(() => setBusy(false));
  };
  return (
    <View className="gap-s4">
      <MailComposer form={form} onChange={setForm} load={filesNamed} />
      <Button kind="primary" label="Hold this email for my yes" disabled={!!problem || busy} onPress={send} />
    </View>
  );
}
