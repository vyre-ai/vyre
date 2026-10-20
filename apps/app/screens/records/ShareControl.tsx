import { useState } from "react";
import { Segmented, showToast } from "@vyre/ui";
import { recordsApi } from "./records-api";
import { shareLevels } from "./share-model.js";
import { plainError } from "../../src/real/error-note.js";

/** Who can read a note or an outside-calendar event (records.share). Always shown: only the writer may change it, and the box says so in its own words when someone else tries. */
export function ShareControl({ urn, type, value, record, onDone }: { urn: string; type: string; value: string; /** The record a note is about, kept when its level changes. */ record?: string; onDone: () => void }) {
  const [now, setNow] = useState(value);
  const set = async (v: string) => {
    const was = now;
    setNow(v);
    const r = await recordsApi.share(urn, v as "private" | "record" | "space", { type, ...(record ? { record } : {}) });
    if (r.error) { setNow(was); showToast(plainError(r.error, "That did not change.")); return; }
    onDone();
  };
  return <Segmented<string> label="Who can read it" value={now} onChange={(v) => void set(v)} options={shareLevels(type) as [string, string][]} />;
}
