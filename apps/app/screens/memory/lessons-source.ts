// Lessons' calls on a real vyred, over an injected `call` (the app's box connection, or a fake box in a test): learn.lessons, learn.stats, learn.skills to read;
// learn.accept, learn.retire, learn.relax, learn.edit, learn.skill-install, learn.skill_retire to act. The acts that loosen or start something need the person:
// the app's call answers the presence proof itself, so a refusal that reaches here is a real one.
import { listOf, type Lesson, type Skill } from "./lessons-model.ts";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function lessonsSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    /** Lessons, the verdicts, and the proposed skills. Skills may be absent (no learning module for them): then null. */
    async load(): Promise<{ lessons: Lesson[]; stats: unknown; skills: Skill[] | null }> {
      const [l, s, k] = await Promise.all([ask("learn.lessons", { status: "all" }), ask("learn.stats", {}).catch(() => null), ask("learn.skills", {}).catch(() => null)]);
      return { lessons: listOf<Lesson>(l), stats: s, skills: k === null ? null : listOf<Skill>(k) };
    },
    accept: (id: number | string) => ask("learn.accept", { id }),
    /** Decline a proposal, or retire an active lesson: the same act. */
    retire: (id: number | string) => ask("learn.retire", { id }),
    relax: (id: number | string, level: string) => ask("learn.relax", { id, level }),
    /** Tighten or reword only; a loosening comes back refused. Only the changed fields are sent. */
    edit: (id: number | string, change: { rule?: string; when?: string }) => ask("learn.edit", { id, ...change }),
    skillInstall: (id: number | string) => ask("learn.skill-install", { id }),
    skillDismiss: (id: number | string) => ask("learn.skill_retire", { id }),
  };
}
