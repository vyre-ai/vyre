import { Field } from "./Field";

/** A space address. https only, and the error says what to fix. */
export function ServerUrlField({ value, onChangeText, error }: { value: string; onChangeText: (v: string) => void; error?: string }) {
  return <Field label="Space address" name="Space address" kind="url" value={value} onChangeText={onChangeText} placeholder="https://juniper.vyre.run" error={error} help={error ? undefined : "The address of the space this computer should join."} />;
}
