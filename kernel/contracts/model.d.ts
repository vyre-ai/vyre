// kernel/contracts/model.d.ts: the single inference door. Types only, no logic.
// Contract 8.4; invariants 5 and 6. Every call to any model, from any provider, goes through `model.call`.

import type { Chain } from './chain.js';
import type { Uuid } from './common.js';

export type ModelRole = 'system' | 'user' | 'assistant' | 'tool';

/** Text on its way to a model has already had sealed values replaced by placeholders (invariant 6). */
export interface ModelMessage {
  readonly role: ModelRole;
  readonly content: string;
}

export type ModelPurpose =
  | 'session' | 'summary' | 'translate' | 'classify' | 'search' | 'embed' | 'transcribe' | 'autocomplete' | 'flow_agent' | 'memory' | 'other';

export interface ModelCallInput {
  /** The kernel's chain; a model sink gets placeholders even when the chain has no agent hop. */
  readonly chain: Chain;
  readonly purpose: ModelPurpose;
  /** Provider and model are the caller's choice within what the Space's residency policy allows. */
  readonly provider: string;
  readonly model: string;
  readonly session?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly { readonly name: string; readonly description: string; readonly schema: unknown }[];
  readonly max_output_tokens?: number;
}

export interface ModelCallResult {
  readonly id: Uuid;
  readonly provider: string;
  readonly model: string;
  readonly content: string;
  readonly tool_calls?: readonly { readonly name: string; readonly input: unknown }[];
  readonly usage?: { readonly input_tokens: number; readonly output_tokens: number; readonly cost_usd?: number };
}

/** Why the door refused. `ledger_hit` means the prompt contained a value the session resolved (exact or normalised). */
export type ModelRefusal =
  | { readonly code: 'ledger_hit'; readonly class: string }
  | { readonly code: 'residency'; readonly detail: string }
  | { readonly code: 'not_a_sink'; readonly detail: string }
  | { readonly code: 'budget'; readonly meter: string };

export interface ModelApi {
  call(input: ModelCallInput): Promise<ModelCallResult>;
}
