import { useCallback, useMemo } from "react";
import { FilePicks, type FileChoice, type FilePick } from "../components/FilePicks";
import type { Draft, Options } from "./logic.js";
import { attList, attText } from "./logic.js";
import { aliasTable, insertList, toAliasText } from "./template.js";

/**
 * Files to attach on an email step: the library's file picks (a pick from Files, or a value an earlier step made, such as a Documents step's document), kept in the step as the paths and tokens
 * the engine reads. The chips say the file's name or the friendly name of the value.
 */
export function AttachmentsField({ value, onChange, draft, stepId, options }: { value: string; onChange: (v: string) => void; draft: Draft; stepId: string; options: Options }) {
  const groups = useMemo(() => insertList(draft, stepId, options), [draft, stepId, options]);
  const table = useMemo(() => aliasTable(groups), [groups]);
  // only a value that is a file's path can stand for a file: a document an earlier step made
  const values = useMemo(() => groups.flatMap((g) => g.items.filter((i) => i.known && /\.path\}$/.test(i.token)).map((i) => ({ value: i.token, label: i.label }))), [groups]);
  const picks: FilePick[] = attList(value).map((v) => (/^\{.+\}$/.test(v) ? { value: v, label: toAliasText(v, table).replace(/^\{|\}$/g, ""), computed: true } : { value: v, label: v.split("/").pop() || v }));
  const load = useCallback(async (q: string): Promise<FileChoice[]> => (options.filesOf ? options.filesOf(q) : []), [options]);
  return (
    <FilePicks label="Files to attach (optional)" picks={picks} onChange={(next) => onChange(attText(next.map((p) => p.value)))} load={load} values={values}
      help="Up to 10 files and 25 MB in all. The file is read when you approve the message, and the message stops if it changed since." />
  );
}
