// Editor typings for the Flow part of @vyre/sdk. The stored form is the source of truth; these describe how to write it as text.
export interface ExprValue { expr: string }
export type Value = string | number | boolean | null | ExprValue | readonly Value[] | { readonly [k: string]: Value };
export function expr(source: string): ExprValue;

export type Trigger =
  | { on: 'event'; event: string; where?: string }
  | { on: 'time'; cron?: string; every_ms?: number; at?: number }
  | { on: 'web'; path: string }
  | { on: 'manual'; input?: Value }
  | { on: 'stage'; type: string; stage: string };

/** How a step runs and how it is checked. A step may omit all of it. */
export interface Policy {
  /** milliseconds one attempt may take */ timeout_ms?: number;
  /** false, or how many attempts (the first counts), the waits between them, and which faults are worth another try */
  retry?: false | { attempts?: number; backoff_ms?: number | readonly number[]; on?: readonly ('timeout' | 'unavailable' | 'rate_limited' | 'upstream_5xx' | 'connection_reset' | 'busy')[] };
  /** what to do if the step still fails: the steps to run (they read `error`), then `stop` (the run fails afterwards, the default) or `continue` */
  on_fail?: { steps: readonly Step[]; then?: 'stop' | 'continue' };
  /** a check of what the step did, an expression over `output`; essential unless essential: false. readback: true re-reads a record that was written */
  verify?: { check?: string; essential?: boolean; say?: string; readback?: true };
}
export interface Step { readonly id: string; readonly kind: string; readonly [k: string]: unknown }
type Props = { readonly [k: string]: unknown };
export const step: Policy & {
  find(id: string, p: Policy & { type: string; where?: string; limit?: number; sort?: Value; label?: string }): Step;
  pick(id: string, p: Policy & { type: string; where?: string; label?: string }): Step;
  filter(id: string, p: Policy & { from: string; where: string; label?: string }): Step;
  create(id: string, p: Policy & { type: string; set: { readonly [field: string]: Value }; label?: string }): Step;
  update(id: string, p: Policy & { type: string; record: Value; set: { readonly [field: string]: Value }; label?: string }): Step;
  upsert(id: string, p: Policy & { type: string; match: { readonly [field: string]: Value }; set: { readonly [field: string]: Value }; label?: string }): Step;
  remove(id: string, p: Policy & { type: string; record: Value; label?: string }): Step;
  decide(id: string, p: Policy & { if: string; then: readonly Step[]; else?: readonly Step[]; label?: string }): Step;
  repeat(id: string, p: Policy & { over: string; as: string; steps: readonly Step[]; max?: number; label?: string }): Step;
  wait(id: string, p: ({ for_ms: number } | { until: Value } | { event: string; where?: string }) & Omit<Policy, 'timeout_ms'> & { timeout_ms?: number; on_timeout?: 'continue' | 'fail'; label?: string }): Step;
  ask(id: string, p: Policy & { to: string; title: Value; form?: readonly { name: string; [k: string]: unknown }[]; label?: string }): Step;
  assign(id: string, p: Policy & { to: string; title: Value; output: { kind: 'fields' | 'note' | 'draft' | 'sent' | 'decision' | 'file'; target?: string | readonly string[] }; how?: 'template' | 'tailor' | 'assistant' | 'person'; template?: string; checker?: string; record?: Value; await?: boolean; label?: string }): Step;
  agent(id: string, p: Policy & { assistant: string; title: Value; instructions: Value; output: { kind: string; target?: string | readonly string[] }; record?: Value; await?: boolean; label?: string }): Step;
  call(id: string, p: Policy & { action: string; resource: string; input?: Value; label?: string }): Step;
  stage(id: string, p: Policy & { type: string; record: Value; to: string; label?: string }): Step;
  extract(id: string, p: Policy & { input: Value; fields: readonly { name: string; kind?: "text" | "number" | "date" | "boolean"; description?: string }[]; label?: string }): Step;
  classify(id: string, p: Policy & { input: Value; labels: readonly string[]; label?: string }): Step;
  service(id: string, p: Policy & { connector: string; method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; query?: { readonly [name: string]: Value }; headers?: Value; body?: Value; drive?: { upload?: { path: string; version?: string; contentType?: string } } | { saveTo: string }; label?: string }): Step;
  fn(id: string, p: Policy & { language: 'js'; source: string; inputs: { readonly [name: string]: Value }; outputs: readonly string[]; needs?: readonly string[]; label?: string }): Step;
};

export interface FlowDefinition {
  name: string; label?: string; description?: string;
  authorship: 'builder' | 'human' | 'model' | 'kit';
  caps?: readonly { action: string; resource: string }[];
  trigger: Trigger;
  steps: readonly Step[];
  /** steps to run once when the run is about to fail; they read `error` */ on_failure?: readonly Step[];
  /** at most this many runs of the Flow at once (1 to 32) */ concurrency?: number;
  /** an expression giving a key; runs with the same key never run at the same moment */ lock?: string;
  /** a run that has not moved for this long is flagged stuck */ stuck_after_ms?: number;
}
export function defineFlow(def: FlowDefinition): FlowDefinition & { format: 1 };
