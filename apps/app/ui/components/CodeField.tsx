import { Field } from "./Field";
import { formatCode } from "../lib/code.js";

/**
 * A field for a code a person types or pastes: a space code (WINK-4F7K-9QZ2), a recovery code, an invite code. It shows capitals, puts the hyphens in as they type, keeps a fixed
 * first word (`prefix`) in place and ignores case, spaces and hyphens in what is pasted (otp.md). The value the screen holds is the formatted text. The error line names what is wrong and what to do.
 */
export function CodeField({ label, value, onChangeText, prefix, groups = [4, 4], error, help, disabled }: { label: string; value: string; onChangeText: (v: string) => void; prefix?: string; groups?: number[]; error?: string; help?: string; disabled?: boolean }) {
  return (
    <Field label={label} mono value={value} onChangeText={(v) => onChangeText(formatCode(v, { prefix, groups }))} placeholder={[prefix, ...groups.map((n) => "X".repeat(n))].filter(Boolean).join("-")} error={error} help={help} disabled={disabled} />
  );
}
