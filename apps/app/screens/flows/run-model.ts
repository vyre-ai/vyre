// The pure half of a run's record: the canvas nodes the kernel painted for one run (kernel/flows/canvas.js paintRun) as the lines of what it did.
import { nameIsSecret } from "../../src/store-core/secret-keys.js";
export type PaintedNode = { id: string; kind?: string; label: string; state?: string; note?: string; count?: number };

const WORD: Record<string, string> = { done: "Done", failed: "Failed", waiting: "Waiting", running: "Running", paused: "Paused", pending: "Not reached" };

/** One line per step, in the Flow's order: its words, what happened, and how many turns a loop took. */
export function recordLines(nodes: PaintedNode[]): { id: string; title: string; sub: string; state: string }[] {
  return nodes.map((n) => {
    const state = n.state ?? "pending";
    const bits = [WORD[state] ?? state, n.count ? `${n.count} times` : "", n.note ?? ""].filter(Boolean);
    return { id: n.id, title: n.label, sub: bits.join(", "), state };
  });
}

/** Only a failed or paused run can be retried (flows.retry puts it back to work after its cause was fixed). */
export const canRetry = (state: string): boolean => state === "failed" || state === "paused";

/** A run that is paused, failed, waiting or held can be stopped (flows.cancel); one that is running or finished cannot. */
export const canStop = (state: string): boolean => state === "paused" || state === "failed" || state === "waiting" || state === "queued";

/** The words for a refused start, from the box's code. */
export function startRefusal(code: string | undefined, message: string): string {
  if (code === "not_active") return "That Flow is paused or has no approved version, so it cannot run.";
  if (code === "not_found") return "That Flow is not yours to run.";
  return message || "That did not start.";
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A run read step by step: the run's ledger (flows.run, run.steps) laid over the painted steps, in the Flow's order. Pure; the screen supplies the clock's words.

export type Tone = "accent" | "ok" | "warn" | "err" | "plain";
export type Ledger = { status?: string; input?: unknown; output?: unknown; error?: { code?: string; message?: string }; tries?: number; started_at?: number; finished_at?: number; wait?: { kind?: string; until?: number; deadline?: number; task?: string }; verify?: { ok?: boolean; say?: string }; skipped_by?: string; substitute?: unknown; answered?: { by?: string }; attempts_log?: { at?: number; code?: string }[]; chosen?: { doer?: string; why?: string }; task?: string };
export type StepRow = { key: string; title: string; status: string; tone: Tone; took: string; inputs: [string, string][]; outputs: [string, string][]; error: string; wakes: string; by: string; tries: string[]; task: string };

const PLACEHOLDER = /^\{\{[^}]+\}\}$/;
export const SEALED = "Sealed value";

/** One value as a person sees it: a sealed value is its placeholder, never what it holds. */
export function shownValue(v: unknown, key = ""): string {
  if (v === null || v === undefined) return "Nothing";
  if (typeof v === "object" && !Array.isArray(v) && Object.hasOwn(v as object, "sealed")) return SEALED;
  if (typeof v === "string" && PLACEHOLDER.test(v.trim())) return SEALED;
  if (key && nameIsSecret(key) && typeof v !== "object") return "Hidden";
  const t = typeof v === "string" ? v : JSON.stringify(v, (k, x) => (k && nameIsSecret(k) && typeof x !== "object" ? "Hidden" : x && typeof x === "object" && !Array.isArray(x) && Object.hasOwn(x, "sealed") ? SEALED : x));
  return t.length > 140 ? `${t.slice(0, 139)}...` : t;
}

/** An input or an output as name and value pairs, one level deep. */
export function pairs(v: unknown): [string, string][] {
  if (v === null || v === undefined) return [];
  if (typeof v === "object" && !Array.isArray(v) && !Object.hasOwn(v as object, "sealed")) return Object.entries(v as Record<string, unknown>).slice(0, 12).map(([k, x]) => [k, shownValue(x, k)]);
  return [["Value", shownValue(v)]];
}

const took = (ms: number): string => (ms < 1000 ? "under a second" : ms < 60_000 ? `${Math.round(ms / 1000)} seconds` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} minutes` : `${(ms / 3_600_000).toFixed(1)} hours`);

const NEXT: Record<string, string> = {
  timeout: "Retry the run; if it keeps happening, check the service the step calls.",
  connection_reset: "Retry the run.",
};
/** The error in plain words, with what to do next when the code says so. */
export function errorWords(e: Ledger["error"]): string {
  if (!e) return "";
  const msg = (e.message || "").trim();
  const next = e.code ? NEXT[e.code] : undefined;
  return msg ? (next ? `${msg} ${next}` : msg) : next ? `The step stopped. ${next}` : "This step stopped. Retry the run, or ask whoever set the Flow up.";
}

/**
 * One row per step of the run, in the Flow's order: its name, where it stands, how long it took, what went in and came out, the error, and when a wait wakes. `fmt` writes a time the way the app does.
 * `max` is the retry limit of a step when the Flow states one (the ledger keeps only the tries so far). A step the run never reached says so.
 */
export function stepRows(painted: PaintedNode[], steps: Record<string, Ledger> | undefined, fmt: (ms: number) => string, max: Record<string, number> = {}): StepRow[] {
  const led = Object.entries(steps ?? {}).filter(([k, e]) => e && !k.includes("?retry"));
  const rows: StepRow[] = [];
  for (const n of painted) {
    if (n.kind === "trigger") continue;
    const mine = led.filter(([k]) => k.replace(/\?ask$/, "").replace(/[@!].*$/, "") === n.id);
    if (!mine.length) { rows.push({ key: n.id, title: n.label, status: "Not reached", tone: "plain", took: "", inputs: [], outputs: [], error: "", wakes: "", by: "", tries: [], task: "" }); continue; }
    mine.forEach(([k, e], i) => {
      const ask = k.endsWith("?ask");
      const turn = k.includes("@") ? ` (turn ${mine.slice(0, i + 1).filter(([x]) => x.includes("@")).length})` : "";
      const title = `${n.label}${ask ? ", asking first" : ""}${k.includes("!") ? ", failure path" : ""}${turn}`;
      let status = "Running", tone: Tone = "plain", wakes = "";
      const w = e.wait;
      switch (e.status) {
        case "done": status = ask ? "Approved" : "Done"; tone = "ok"; if ((e.output as any)?.cut) { status = `Done, cut at ${(e.output as any).count} of ${(e.output as any).total}`; tone = "warn"; } break;
        case "failed_handled": status = "Failed, handled"; tone = "warn"; break;
        case "skipped": status = e.substitute ? `Skipped, value given by ${e.skipped_by || "a person"}` : "Skipped"; break;
        case "failed": status = ask ? "Refused" : "Failed"; tone = "err"; break;
        case "waiting":
          if (w?.kind === "time" && w.until) { status = "Waiting"; wakes = `Wakes ${fmt(w.until)}`; }
          else if (w?.kind === "task" || ask) { status = "Waiting for a person"; tone = "accent"; if (w?.deadline) wakes = `Gives up ${fmt(w.deadline)}`; }
          else { status = "Waiting for something to happen"; if (w?.deadline) wakes = `Gives up ${fmt(w.deadline)}`; }
          break;
        default: if (e.tries) { const m = max[n.id]; status = `Retrying, try ${e.tries + 1}${m ? ` of ${m}` : ""}`; tone = "warn"; }
      }
      rows.push({ key: k, title, status, tone, took: typeof e.started_at === "number" && typeof e.finished_at === "number" ? `Took ${took(e.finished_at - e.started_at)}` : "", inputs: pairs(e.input), outputs: e.status === "done" || e.status === "failed_handled" ? pairs(e.output) : [], error: e.status === "failed" || e.status === "failed_handled" ? errorWords(e.error ?? (e.output as { error?: Ledger["error"] } | undefined)?.error) : "", wakes, by: e.answered?.by || e.chosen?.doer || "", task: e.task || e.wait?.task || "", tries: (e.attempts_log ?? []).map((a, j) => `Try ${j + 1}${a.at ? ` at ${fmt(a.at)}` : ""} did not work${a.code ? ` (${a.code.replace(/_/g, " ")})` : ""}`) });
    });
  }
  return rows;
}

/** Retry limits the Flow itself states (step.retry.attempts), by step id, walking nested steps. */
export function retryLimits(flow: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (list: unknown) => { for (const s of Array.isArray(list) ? list : []) { const r = s?.retry; if (s?.id && r && typeof r === "object" && Number.isInteger(r.attempts)) out[s.id] = r.attempts; for (const b of ["then", "else", "steps"]) walk(s?.[b]); walk(s?.on_fail?.steps); } };
  walk((flow as { steps?: unknown })?.steps);
  return out;
}

const RUN_STATE: Record<string, { say: string; tone: Tone }> = {
  waiting: { say: "Waiting", tone: "plain" }, running: { say: "Running", tone: "plain" }, done: { say: "Done", tone: "ok" }, failed: { say: "Failed", tone: "err" },
  paused: { say: "Paused", tone: "warn" }, cancelled: { say: "Stopped", tone: "plain" }, queued: { say: "Held", tone: "warn" },
};

/** The page header of a run: its words, where it stands, who approved the version, and the record it is about (the last part of the record's address). */
export function runHeader(run: any, o: { fmt: (ms: number) => string; title: string; number: number | null; approver: string; record?: string }) {
  const st = RUN_STATE[run?.state] ?? { say: String(run?.state ?? "Unknown"), tone: "plain" as Tone };
  const waitsForPerson = run?.waiting?.kind === "task" || run?.waiting?.kind === "gate";
  return {
    title: `Run of ${run?.started_at ? o.fmt(run.started_at) : "an unknown time"}`,
    sub: `${o.title}${o.number ? `, run ${o.number}` : ""}${run?.version ? `, version ${run.version}` : ""}`,
    status: waitsForPerson ? "Waiting for a person" : st.say,
    tone: (waitsForPerson ? "accent" : st.tone) as Tone,
    started: run?.finished_at ? `Finished ${o.fmt(run.finished_at)}` : "",
    approver: o.approver ? `Version approved by ${o.approver}` : "",
    recordId: typeof o.record === "string" && o.record ? o.record.split("/").pop() || "" : "",
  };
}

/** The agent's thread out of what tasks.get answered (the task's form.thread, written by agent-wake), or "". */
export const threadOf = (t: any): string => { const x = t?.task ?? t; return typeof x?.form?.thread === "string" ? x.form.thread : ""; };
