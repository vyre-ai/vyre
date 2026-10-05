import type { FieldDefinition, Who } from "../../src/store-core/contracts.js";

export type FieldMode = "view" | "edit" | "compact";

/** What the kernel's props leave out and a screen knows (deck/ui/fields.js Env): who the actors are, what a link points at, the clock, where a link goes, the stage menu a rule narrows. */
export type FieldEnv = {
  actors?: Who[];
  links?: Record<string, { title: string; type?: string }>;
  now?: number;
  open?: (urn: string) => void;
  space?: string;
  allowed?: string[];
};

/** FieldRendererProps (kernel/contracts/fields.d.ts), as the Deck had them. `reveal` asks the store for a sealed value after the person's proof. */
export type FieldProps = {
  kind: string;
  definition: FieldDefinition;
  value: any;
  mode: FieldMode;
  read_only?: boolean;
  error?: string;
  onChange?: (v: any) => void;
  reveal?: (purpose: string) => Promise<string>;
};

export type ViewProps = { p: FieldProps; env: FieldEnv };
export type EditProps = { p: FieldProps; env: FieldEnv; emit: (v: any) => void };
