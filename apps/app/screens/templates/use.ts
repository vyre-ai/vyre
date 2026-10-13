// How a template is used, pure (no React, no calls): what "New project" offers, a copy of a template, the word on a list row, and what a project's page calls its kind. Tested by use.test.js.
import type { Body, Row } from "./model.ts";
// @ts-ignore a plain .js module
import { templateNoun } from "../../ui/tasks/template-stage.js";

export type Choice = { label: string; template: string | null };

/** The "New" menu: each live template by what its projects are called ("New matter"), then a blank project. A template that does not say is called by its own name. */
export function newChoices(rows: Row[]): Choice[] {
  const live = rows.filter((r) => r.live !== null && !r.archived).map((r): Choice => ({ label: `New ${(r.noun?.one || r.name).toLowerCase()}`, template: r.template }));
  return [...live, { label: "New blank project", template: null }];
}

/** A copy of a template under a new name: "Estate plan (copy)", then "(copy 2)". The stages are copied, not shared. */
export function duplicateBody(b: Body): Body {
  const m = /^(.*) \(copy(?: (\d+))?\)$/.exec(b.name);
  const name = m ? `${m[1]} (copy ${(m[2] ? Number(m[2]) : 1) + 1})` : `${b.name} (copy)`;
  return { ...JSON.parse(JSON.stringify(b)), name };
}

/** The word on a template's list row. */
export const rowState = (r: Row): string => (r.archived ? "Archived" : r.live !== null ? "Live" : "Draft");

/** What a project's page calls its kind: the noun of the template it started with, that template's name when it has none, else "Project". */
export const projectNoun = (data: Record<string, unknown> | null | undefined): string => templateNoun(data) || "Project";

/** Whether this role makes templates: the owner and an admin do; a member, a manager and a guest use the live ones. The box refuses anyone else in words; this only keeps the button from showing. */
export const mayMakeTemplates = (role: string | null | undefined): boolean => role === "owner" || role === "admin";
