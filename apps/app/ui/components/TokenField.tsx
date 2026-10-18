import { Field } from "./Field";
import type { TokenOption } from "./token-field-model.js";

export type TokenFieldProps = {
  label?: string;
  name?: string;
  /** The stored text, with each value as `{token}`. */
  value: string;
  onChange: (value: string) => void;
  /** The values that can be put in: a token and the words its pill shows. A token the field holds that is not here shows as its path. */
  options: TokenOption[];
  placeholder?: string;
  help?: string;
  multiline?: boolean;
  lines?: number;
  disabled?: boolean;
  /** What a phone or any build without pills shows instead: the text in friendly names, and how a change goes back to stored text. */
  plain?: { value: string; onChange: (value: string) => void };
};

/** A field whose values are pills inside the text, never raw braces. This is the build without pills (a phone): a plain field showing the text in friendly names. The web build draws the pills (TokenField.web.tsx). */
export function TokenField({ label, name, value, onChange, placeholder, help, multiline, lines, disabled, plain }: TokenFieldProps) {
  return <Field label={label} name={name} value={plain ? plain.value : value} onChangeText={plain ? plain.onChange : onChange} placeholder={placeholder} help={help} multiline={multiline} lines={lines} disabled={disabled} />;
}
