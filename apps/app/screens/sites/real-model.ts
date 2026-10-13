// The pure half of Sites on the real box: publish.list, publish.status, publish.plan and the held-act answers (core/publish, lib/publish) as the lines the screens show.
// A site is every deployment of one name; each deployment is one version, in a stage: Draft, Preview, Approved, Production, Retired.

export type Domain = { host: string; status: string };
export type Dep = { id: string; name: string; version: number; stage: string; url: string | null; domains: Domain[] };
export type Status = Dep & { previous: string | null; build_digest: string | null; secrets: { name: string; class: string; use: string[] }[]; ungranted_env: string[]; approved_by: unknown; published_at: number | null; sealed_check?: string };
export type Plan = { action: "approve" | "publish" | "rollback"; goes_public: boolean; deployment: { id: string; name: string; version: number }; urls: string[]; replaces: { id: string; version: number; url: string | null } | null; secrets: { name: string; class: string; use: string[] }[]; ungranted_env: string[]; hash: string };
export type Held = { held: true; task: string; plan: Plan };
export type Site = { name: string; versions: Dep[]; live: Dep | null; current: Dep; status: { label: string; tone: "ok" | "accent" | "plain" } };

export const PIPE = ["Draft", "Preview", "Approved", "Live"];
const STAGE_AT: Record<string, number> = { Draft: 0, Preview: 1, Approved: 2, Production: 3, Retired: 4 };
/** Where a deployment is on the pipeline (an index into PIPE; past the end for retired). */
export const stepOf = (d: Dep): number => STAGE_AT[d.stage] ?? 0;

/** One site per name, newest version first. `current` is the newest version that is not retired (else the newest). */
export function sites(deps: Dep[]): Site[] {
  const by = new Map<string, Dep[]>();
  for (const d of deps) by.set(d.name, [...(by.get(d.name) ?? []), d]);
  return [...by.entries()].map(([name, list]) => {
    const versions = [...list].sort((a, b) => b.version - a.version);
    const live = versions.find((d) => d.stage === "Production") ?? null;
    const current = versions.find((d) => d.stage !== "Retired") ?? versions[0];
    return { name, versions, live, current, status: statusOf(live, current) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** The line under a site in the list: what is live and where, and what waits in preview or approved. */
export const siteLine = (s: Site): string =>
  `${s.live ? `live version ${s.live.version}${s.live.domains[0] ? ` at ${s.live.domains[0].host}` : ""}` : "not live"}${s.current.stage === "Preview" || s.current.stage === "Approved" ? `, version ${s.current.version} in ${s.current.stage.toLowerCase()}` : ""}`;

/** The sites as rows of a list block: the name, the line under it, the site icon and where it stands. */
export const siteRows = (list: Site[]) => list.map((s) => ({ id: s.name, title: s.name, subtitle: siteLine(s), icon: "sites", accessory: s.status.label, tone: s.status.tone }));

function statusOf(live: Dep | null, cur: Dep): Site["status"] {
  if (cur.stage === "Approved") return { label: "Needs you", tone: "accent" };
  if (cur.stage === "Preview") return { label: "Preview", tone: "plain" };
  if (cur.stage === "Draft") return { label: "Draft", tone: "plain" };
  if (live) return { label: "Live", tone: "ok" };
  return { label: "Retired", tone: "plain" };
}

/** The next step for a deployment, as the tool it calls and the button's words. A preview goes live in one yes. A live one can go back one version when it has a previous. */
export function nextStep(d: Status | Dep): { tool: "preview" | "go" | "publish" | "rollback"; label: string } | null {
  if (d.stage === "Draft") return { tool: "preview", label: "Build a preview" };
  // one yes approves the preview and puts it live (publish.go); the held card still shows the public plan
  if (d.stage === "Preview") return { tool: "go", label: "Approve and go live" };
  if (d.stage === "Approved") return { tool: "publish", label: "Go live" };
  if (d.stage === "Production" && "previous" in d && d.previous) return { tool: "rollback", label: "Go back one version" };
  return null;
}

/** A held act's answer, or null when the act completed. */
export const heldOf = (r: unknown): Held | null => { const x = r as Partial<Held> | null; return x && x.held === true && typeof x.task === "string" && x.plan ? (x as Held) : null; };

/** What the person is told before they decide: the plan in words, from its own fields. */
export function planLines(p: Plan): { title: string; lines: string[] } {
  const v = `${p.deployment.name} version ${p.deployment.version}`;
  const title = p.action === "approve" ? `Approve the preview of ${v}?` : p.action === "publish" ? `Put ${v} on the internet?` : `Go back to ${v}?`;
  const lines = [
    p.goes_public ? `It becomes public at ${p.urls.join(", ")}.` : `Nothing goes public. It stays at its private preview, ${p.urls[0] ?? ""}.`,
    ...(p.replaces ? [`It replaces version ${p.replaces.version}${p.replaces.url ? ` at ${p.replaces.url}` : ""}.`] : []),
    p.secrets.length ? `Secrets it can use: ${p.secrets.map((s) => `${s.name} (${s.use.join(" and ")})`).join(", ")}.` : "It uses no secrets.",
    ...(p.ungranted_env.length ? [`Not granted yet, so it will not have: ${p.ungranted_env.join(", ")}.`] : []),
  ];
  return { title, lines };
}

/** The input publish.decide takes: bound to exactly the plan the person read. */
export const decision = (h: Held, approve = true) => ({ task: h.task, approve, plan_hash: h.plan.hash });

export type Draft = { name: string; kind: "repo" | "drive"; ref: string; image: "static" | "node-20" | "node-22"; command: string; private: boolean };
export const BLANK: Draft = { name: "", kind: "repo", ref: "", image: "static", command: "", private: false };
export const SOURCES: { kind: Draft["kind"]; title: string; body: string; hint: string }[] = [
  { kind: "repo", title: "From a repo", body: "Builds the folder you point at.", hint: "github.com/owner/repo, or a path in a project" },
  { kind: "drive", title: "From a Files folder", body: "Publishes the pages in a folder.", hint: "A Files folder path" },
];

/** The input publish.create takes, or the first thing wrong with the draft in words. */
export function build(d: Draft): { input: { name: string; source: { kind: string; ref: string }; build: { image: string; command?: string } } } | { error: string } {
  const name = d.name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return { error: "Name it in lowercase letters, digits and hyphens, up to 40 characters." };
  if (!d.ref.trim()) return { error: "Say where the source is." };
  if (/[\u0000-\u001f]/.test(d.ref)) return { error: "The source has a character that cannot be used." };
  return { input: { name, source: { kind: d.kind, ref: d.ref.trim() }, build: { image: d.image, ...(d.command.trim() ? { command: d.command.trim() } : {}) } } };
}

const REFUSALS: Record<string, string> = {
  illegal_transition: "That step is not available for this version.",
  secret_in_build: "The build was refused: a secret it was given appears in the output.",
  sealed_in_build: "The build was refused: a sealed value appears in the output or logs.",
  build_unverifiable: "The build is too large to check for sealed values, so it was refused.",
  forbidden: "You may not do that in this space.",
  needs_approval: "A person has to decide that first.",
  approval_mismatch: "What would change is different from what you saw. Ask again.",
  model_cannot_approve: "A person decides this, not an agent.",
  already_decided: "That request was already decided.",
  presence_required: "That needs you. Approve on this device, then try again.",
  no_previous: "There is no earlier version to go back to.",
};
export const publishRefusal = (code: string | undefined, message: string): string => (code && REFUSALS[code]) || message || "Publish did not answer.";

/** The grant form's preset for a private repo: the GitHub token, for the build only (lib/publish/repo-source.js TOKEN_ID). Null for a public repo or a folder. */
export const REPO_TOKEN = { name: "GITHUB_TOKEN", use: "build" as const };
export const repoGrant = (d: Pick<Draft, "kind" | "private">): typeof REPO_TOKEN | null => (d.kind === "repo" && d.private ? REPO_TOKEN : null);

/** The grant form's check before it asks: an item, a field and a setting name in capitals. Returns the words to show, or null when it can go. */
export function grantProblem(item: string | null, field: string | null, name: string): string | null {
  if (!item || !field || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) return "Pick an item and a field, and name the setting in capitals, like STRIPE_KEY.";
  return null;
}

/** A domain's state in words. */
export const domainLine = (d: Domain): string => (d.status === "verified" || d.status === "active" ? "Connected" : d.status === "pending" ? "Waiting for the DNS record" : d.status);
/** The DNS record to add as three parts, or null when there is none to add (a vyre.run name, or a challenge this build does not know). */
export function recordOf(c: unknown): { type: string; name: string; value: string } | null {
  const x = c as { type?: unknown; name?: unknown; value?: unknown } | null;
  return x && typeof x === "object" && typeof x.type === "string" && x.type !== "names" && typeof x.name === "string" && typeof x.value === "string" ? { type: x.type, name: x.name, value: x.value } : null;
}

/** What the sheet says about a domain: pending, verified or failed, with the words under it. `reason` is the box's own, from a check that did not pass. */
export type Check = { state: "pending" | "verified" | "failed"; line: string };
export function checkOf(d: Domain | undefined, reason?: string): Check {
  if (d && (d.status === "verified" || d.status === "active")) return { state: "verified", line: "Connected." };
  if (d && d.status === "failed") return { state: "failed", line: reason || "The check failed. Make sure the record matches exactly, then check again." };
  return { state: "pending", line: reason ? `Not connected yet. ${reason}` : "Waiting for the record. DNS can take up to an hour." };
}
/** How often the open sheet checks by itself, in milliseconds. */
export const CHECK_EVERY_MS = 20_000;

export type Canonical = "apex" | "www";
/** The apex or www choice for a typed host: only an apex name (firm.com) has one; a www name or a subdomain stays as typed. */
export function canonicalChoice(host: string): { apex: string; www: string } | null {
  const h = host.trim().toLowerCase();
  const labels = h.split(".");
  if (!h || h.startsWith("www.") || labels.length !== 2 || labels.some((l) => !l) || h.endsWith(".vyre.run")) return null;
  return { apex: h, www: `www.${h}` };
}
/** The extra input domain.add takes for that choice: nothing for a host with no choice. */
export const canonicalInput = (host: string, pick: Canonical): { canonical?: Canonical; www?: boolean } => (canonicalChoice(host) ? { canonical: pick, www: true } : {});

/** The words for a version's row on History. */
export type VersionRow = { id: string; version: number; stage: string; approvedBy: string; wentLive: string; address: string };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A moment as "13 Oct, 06:12" in the viewer's own clock. */
export function whenText(at: number | null | undefined): string {
  if (typeof at !== "number" || !isFinite(at)) return "";
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
/** The History table: one row per version with who approved it, when it went live and where it answers. `who` turns an actor id into a name; `st` is each version's status when it has loaded. */
export function versionRows(versions: Dep[], st: Record<string, Status | undefined>, who: (id: string) => string): VersionRow[] {
  return versions.map((v) => {
    const s = st[v.id];
    const by = s?.approved_by;
    return {
      id: v.id, version: v.version, stage: v.stage,
      approvedBy: typeof by === "string" && by ? who(by) : s ? "Not approved" : "",
      wentLive: s?.published_at ? whenText(s.published_at) : s ? "Never live" : "",
      address: v.stage === "Production" ? (v.domains[0]?.host ?? v.url ?? "") : (v.url ?? "Not built yet"),
    };
  });
}

/** The banner for a public door that is off. `names` is what names.status answered (null when it did not answer: say nothing). Only matters once something is live. */
export function doorBanner(names: { listening?: unknown } | null, anyLive: boolean): string | null {
  return anyLive && names && names.listening !== true ? "Online on your devices only. Other people cannot open your sites until the public door is on." : null;
}
/** The banner when the edge cannot start: this box has no Docker. */
export const NO_DOCKER = "This server has no Docker, so Sites can't go live yet. Install Docker on the server, then try again.";
export const dockerBanner = (code: string | undefined): string | null => (code === "not_available" ? NO_DOCKER : null);

/** The names a site is still waiting on, as one grant row each, in the order the box listed them. */
export const waitingRows = (ungranted: string[] | undefined): { name: string; sub: string }[] => (ungranted ?? []).map((name) => ({ name, sub: "The site is waiting for this. Pick it from the Vault." }));

/** The DNS record to add, from the challenge the box returned (its own words, shown as they came). */
export const challengeText = (c: unknown): string => (typeof c === "string" ? c : c && typeof c === "object" ? Object.entries(c as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`).join("\n") : "");

export type JobRun = { at: number; ok: boolean; code?: number; seconds?: number; message?: string; output?: string };

/** One run of a job as a line: "Ran in 3 s", "Failed (exit 1): the message", with how long ago. */
export function jobLine(r: JobRun, now = Date.now()): string {
  const secs = r.seconds != null ? `${Math.round(r.seconds)} s` : "";
  const ago = (() => { const m = Math.max(0, Math.round((now - r.at) / 60000)); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; })();
  const what = r.ok ? `Ran${secs ? ` in ${secs}` : ""}` : "Failed";
  return `${what}, ${ago}`;
}
