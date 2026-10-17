import { View } from "react-native";
import { Field } from "./Field";
import { FilePicks, type FilePick, type FileChoice } from "./FilePicks";
import { type MailForm, type FileRef, MAX_FILES, problemOf } from "./mail-composer-model";
import { Text } from "./Text";

/**
 * A mail to send as the person: To, Cc and Bcc, a subject and the words, and the Files it carries. The form is the caller's;
 * `load` answers the Files to offer for a search. A held mail shows what is wrong before the person says yes.
 */
export function MailComposer({ form, onChange, load }: {
  form: MailForm; onChange: (next: MailForm) => void; load: (query: string) => Promise<FileChoice[]>;
}) {
  const set = (patch: Partial<MailForm>) => onChange({ ...form, ...patch });
  const picks: FilePick[] = form.files.map((f: FileRef) => ({ value: f.path, label: f.name }));
  const onFiles = (next: FilePick[]) => set({ files: next.map((p) => ({ path: p.value, name: p.label })) });
  const problem = problemOf(form);
  return (
    <View className="gap-s3">
      <Field label="To" name="To" value={form.to} onChangeText={(to) => set({ to })} placeholder="dana@northwind-bakery.example, another@example.com" kind="email" />
      <Field label="Cc" name="Cc" value={form.cc} onChangeText={(cc) => set({ cc })} placeholder="Optional" kind="email" />
      <Field label="Bcc" name="Bcc" value={form.bcc} onChangeText={(bcc) => set({ bcc })} placeholder="Optional, hidden from the others" kind="email" />
      <Field label="Subject" name="Subject" value={form.subject} onChangeText={(subject) => set({ subject })} placeholder="What the email is about" />
      <Field label="Message" name="Message" value={form.body} onChangeText={(body) => set({ body })} multiline lines={6} />
      <FilePicks label="Files" picks={picks} onChange={onFiles} load={load} max={MAX_FILES}
        help="Each file goes as it is in your Files when you say yes. Nothing is sent until you do." />
      {problem ? <Text size="caption" tone="label">{problem}</Text> : null}
    </View>
  );
}
