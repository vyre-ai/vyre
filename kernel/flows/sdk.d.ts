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

export interface Step { readonly id: string; readonly kind: string; readonly [k: string]: unknown }
type Props = { readonly [k: string]: unknown };
export const step: {
  find(id: string, p: { type: string; where?: string; limit?: number; sort?: Value; label?: string }): Step;
  pick(id: string, p: { type: string; where?: string; label?: string }): Step;
  filter(id: string, p: { from: string; where: string; label?: string }): Step;
  create(id: string, p: { type: string; set: { readonly [field: string]: Value }; label?: string }): Step;
  update(id: string, p: { type: string; record: Value; set: { readonly [field: string]: Value }; label?: string }): Step;
  upsert(id: string, p: { type: string; match: { readonly [field: string]: Value }; set: { readonly [field: string]: Value }; label?: string }): Step;
  remove(id: string, p: { type: string; record: Value; label?: string }): Step;
  decide(id: string, p: { if: string; then: readonly Step[]; else?: readonly Step[]; label?: string }): Step;
  repeat(id: string, p: { over: string; as: string; steps: readonly Step[]; max?: number; label?: string }): Step;
  wait(id: string, p: ({ for_ms: number } | { until: Value } | { event: string; where?: string }) & { timeout_ms?: number; on_timeout?: 'continue' | 'fail'; label?: string }): Step;
  ask(id: string, p: { to: string; title: Value; form?: readonly { name: string; [k: string]: unknown }[]; label?: string }): Step;
  assign(id: string, p: { to: string; title: Value; output: { kind: 'fields' | 'note' | 'draft' | 'sent' | 'decision' | 'file'; target?: string | readonly string[] }; how?: 'template' | 'tailor' | 'assistant' | 'person'; template?: string; checker?: string; record?: Value; await?: boolean; label?: string }): Step;
  agent(id: string, p: { assistant: string; title: Value; instructions: Value; output: { kind: string; target?: string | readonly string[] }; record?: Value; await?: boolean; label?: string }): Step;
  call(id: string, p: { action: string; resource: string; input?: Value; label?: string }): Step;
  stage(id: string, p: { type: string; record: Value; to: string; label?: string }): Step;
  classify(id: string, p: { input: Value; labels: readonly string[]; label?: string }): Step;
  http(id: string, p: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; headers?: Value; body?: Value; label?: string }): Step;
  fn(id: string, p: { language: 'js'; source: string; inputs: { readonly [name: string]: Value }; outputs: readonly string[]; needs?: readonly string[]; label?: string }): Step;
};

export interface FlowDefinition {
  name: string; label?: string; description?: string;
  authorship: 'builder' | 'human' | 'model' | 'kit';
  caps?: readonly { action: string; resource: string }[];
  trigger: Trigger;
  steps: readonly Step[];
}
export function defineFlow(def: FlowDefinition): FlowDefinition & { format: 1 };
