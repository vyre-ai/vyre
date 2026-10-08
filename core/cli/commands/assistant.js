// @ts-check
// `vyre assistant [name]`: who your assistant is, or make one. The assistant is made at the end of
// onboarding (onboard.finish); a person who skipped that step, or finished before Claude was
// signed in, has none, and `vyre up` used to end on "your assistant  not set up yet" with nothing
// to do about it. This makes it with the same input the Deck's "Create your assistant" card sends
// (the app's assistant setup): the name slugged, kind assistant, every project, the Vault items
// the Claude step stored, the same instructions. On a paired Mac it asks the box.

import { call } from "../../daemon/client.js";
import * as config from "../../config/index.js";
import { out, dim, bold, signal } from "../style.js";
import { json, emit, failTool, usage, fail } from "../kit.js";
import { up } from "./projects.js";
import { callAsPerson } from "../presence.js";

/** core/onboard's slug(): "Juno Two" becomes "juno-two"; too short becomes "assistant". */
export const slug = (/** @type {string} */ s) => {
  const v = String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 31).replace(/-+$/, "");
  return v.length >= 2 ? v : "assistant";
};
/** The credentials onboard.finish gives the assistant, from how Claude was signed in. */
const authFor = via => via === "subscription" ? { vault: "claude-setup-token", fallback: "anthropic-api-key" }
  : via === "api-key" ? { fallback: "anthropic-api-key" } : {};

/**
 * A tool on the machine the assistant lives on: the server. On a device paired with one, through
 * Wink (wink.server.call); otherwise here.
 * @param {(name: string, input?: any) => Promise<any>} [tool]
 */
export function onBox(tool = (n, i = {}) => call(n, i)) {
  const cfg = config.load();
  const remote = cfg.role === "local";
  return remote ? (name, input = {}) => tool("wink.server.call", { tool: name, input }) : tool;
}

/** The assistant agent, or null. @param {(name: string, input?: any) => Promise<any>} t */
export async function findAssistant(t) {
  const r = await t("agents.list");
  if (r.error) return { error: r.error };
  const list = Array.isArray(r.data) ? r.data : (r.data && r.data.agents) || [];
  return { agent: list.find(a => a.kind === "assistant") || null };
}

/** The assistant as a card for --view. @param {any} a */
const card = a => ({ kind: "card", title: "Your assistant", state: a.status || "ready",
  fields: [{ label: "Name", value: a.name }, { label: "Doing", value: a.doing || a.status || "ready" }, { label: "Projects", value: "every project" }] });

export default {
  name: "assistant", order: 34, usage: "vyre assistant [name] [--json]",
  summary: "your assistant, or make one: vyre assistant Juno",
  // No verbs: the one word it takes is a name.
  verbs: [],
  help: "With no name: who your assistant is. With a name: make it, as onboarding does, if there is none yet.\nOn a Mac paired with a box, the assistant lives on the box.",
  /** @param {string[]} args */
  async run(args = []) {
    const words = args.filter(a => !a.startsWith("--"));
    if (!(await up())) return 5;
    const t = onBox();
    const f = await findAssistant(t);
    if (f.error) return failTool(f.error);
    const display = words.join(" ").trim();
    if (f.agent) {
      if (json()) return emit(f.agent, card(f.agent));
      if (display) out(dim(`  you already have an assistant; the Deck's Agents page renames it`));
      out(`  your assistant  ${bold(f.agent.name)} ${dim(`· ${f.agent.doing || f.agent.status || "ready"} · every project`)}`);
      return 0;
    }
    if (!display) {
      if (json()) return emit(null, { kind: "text", lines: ["You have no assistant yet. Give it a name and Vyre makes it: vyre assistant Juno"] });
      out("  You have no assistant yet. Give it a name and Vyre makes it:");
      out(`    ${signal("vyre assistant Juno")}`);
      return 0;
    }
    if (display.length > 40 || /[\u0000-\u001f]/.test(display)) return usage("vyre assistant: the name is one line of up to 40 characters", "vyre assistant Juno");
    const st = await t("onboard.status");
    const person = (st.data && st.data.person) || null;
    const via = (st.data && st.data.detail && st.data.detail.claude && st.data.detail.claude.auth) || null;
    const input = { name: slug(display), kind: "assistant", projects: "*", auth: authFor(via),
      instructions: `Your name is ${display}.${person ? ` You work for ${person}.` : ""} You are their assistant in Vyre: you can see every project and start, drive and stop any session.` };
    // Making an agent needs the person (ADR 0004): here, the code on this terminal or Touch ID.
    // Through the link the box cannot see this terminal, so the Deck at the box's address asks.
    const cfg = config.load();
    const remote = cfg.role === "local" && cfg.network && cfg.network.box;
    const r = remote ? await t("agents.create", input) : await callAsPerson("agents.create", input);
    if (r.error && remote && /presence/.test(String(r.error.code))) {
      return fail("making the assistant needs you on the box", { code: r.error.code, exit: 3, next: `open ${remote} on your phone: Now, Create your assistant` });
    }
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data, card(r.data));
    out(`  made your assistant ${bold(display)} ${dim(`(${input.name}) · every project${via ? "" : " · on this machine's own Claude login until Claude is signed in"}`)}`);
    out(dim("  talk to it: vyre, then pick it under Agents"));
    return 0;
  },
};
