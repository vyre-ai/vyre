// Any app with an API (the "Any app" tab): the person's own Connections, made from a key already in the Vault. Pure parts only: the shapes picked from the box's answers, the quick form's
// checks in plain words, and the form sent to connectors.connection.create. The key is never here: the form names the Vault item that holds it.

export type SendHow = "bearer" | "header" | "basic" | "query";
export const SEND_HOWS: { value: SendHow; label: string; help: string }[] = [
  { value: "bearer", label: "Bearer token", help: "Sent as Authorization: Bearer <key>. Most modern APIs, including GoHighLevel." },
  { value: "header", label: "A header", help: "Sent in a header you name, such as X-Api-Key." },
  { value: "basic", label: "Username and password", help: "The Vault item holds a username and a password." },
  { value: "query", label: "In the address", help: "Sent as a query parameter you name, such as api_key." },
];

export type MadeConnection = {
  id: string; label: string; host: string; light: "green" | "red" | "unknown" | "out_of_step"; reason: string; checkedAt: number | null;
  operations: { name: string; label: string; kind: string; relabeled: boolean }[];
};

const LIGHTS = ["green", "red", "unknown", "out_of_step"];
export function pickMade(raw: unknown): MadeConnection[] {
  const l = (raw as { connections?: unknown[] } | null)?.connections;
  if (!Array.isArray(l)) return [];
  return l.flatMap((x) => {
    const c = x as Record<string, unknown> | null;
    if (!c || typeof c.id !== "string" || typeof c.label !== "string") return [];
    const ops = Array.isArray(c.operations) ? (c.operations as Record<string, unknown>[]) : [];
    return [{
      id: c.id, label: c.label, host: String(c.host ?? ""), light: (LIGHTS.includes(String(c.light)) ? c.light : "unknown") as MadeConnection["light"],
      reason: typeof c.reason === "string" ? c.reason : "", checkedAt: typeof c.checked_at === "number" ? c.checked_at : null,
      operations: ops.filter((o) => o && typeof o.name === "string").map((o) => ({ name: String(o.name), label: String(o.label ?? o.name), kind: String(o.kind ?? "read"), relabeled: o.relabeled === true })),
    }];
  });
}

/** What the light says, in words, for a row. */
export const lightWords = (c: Pick<MadeConnection, "light" | "reason">): string =>
  c.light === "green" ? "Working" : c.light === "out_of_step" ? "Needs saving again" : c.light === "red" ? (c.reason || "Not working") : "Not checked yet";

export type FormInput = {
  label: string; baseUrl: string; how: SendHow; name: string; item: string; field: string;
  headers: { name: string; value: string }[]; vars: { name: string; value: string }[]; checkPath: string;
};
export const emptyForm = (): FormInput => ({ label: "", baseUrl: "", how: "bearer", name: "", item: "", field: "", headers: [{ name: "", value: "" }], vars: [{ name: "", value: "" }], checkPath: "" });

/** The first thing wrong with the form, in the person's words, or null. */
export function formProblem(f: FormInput): string | null {
  if (!f.label.trim()) return "Give the connection a name, like GoHighLevel Sales.";
  let u: URL | null = null;
  try { u = new URL(f.baseUrl.trim()); } catch { u = null; }
  if (!u || u.protocol !== "https:" || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return "The address is the app's API address with no path, like https://services.leadconnectorhq.com.";
  if ((f.how === "header" || f.how === "query") && !f.name.trim()) return f.how === "header" ? "Name the header the key goes in." : "Name the query parameter the key goes in.";
  if (!f.item.trim()) return "Pick the Vault item that holds the key.";
  if (!/^\/[^\s?#]*$/.test(f.checkPath.trim())) return "The check is one request that proves the key works: a path like /locations/{locationId}.";
  const names = f.vars.filter((v) => v.name.trim() || v.value.trim());
  if (names.some((v) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name.trim()) || !v.value.trim())) return "Each fixed value needs a name (letters and digits) and a value.";
  for (const m of f.checkPath.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (!names.some((v) => v.name.trim() === m[1])) return `The check path uses {${m[1]}}: add it under Fixed values.`;
  const hs = f.headers.filter((h) => h.name.trim() || h.value.trim());
  if (hs.some((h) => !h.name.trim() || !h.value.trim())) return "Each fixed header needs a name and a value.";
  if (hs.some((h) => /^(authorization|cookie|host|x-api-key|content-length|content-type|proxy-.*)$/i.test(h.name.trim()))) return "The key is added for you; leave authentication headers out.";
  return null;
}

/** The input of connectors.connection.create. */
export function toCreate(f: FormInput) {
  const hs = f.headers.filter((h) => h.name.trim() && h.value.trim());
  const vs = f.vars.filter((v) => v.name.trim() && v.value.trim());
  return {
    label: f.label.trim(), base_url: f.baseUrl.trim().replace(/\/+$/, ""),
    send: { how: f.how, ...(f.how === "header" || f.how === "query" ? { name: f.name.trim() } : {}) },
    credential: { item: f.item.trim(), ...(f.field.trim() ? { field: f.field.trim() } : {}) },
    ...(hs.length ? { headers: Object.fromEntries(hs.map((h) => [h.name.trim(), h.value.trim()])) } : {}),
    ...(vs.length ? { vars: Object.fromEntries(vs.map((v) => [v.name.trim(), v.value.trim()])) } : {}),
    check: { path: f.checkPath.trim() },
  };
}

export type Proposal = { id: string; by: string; why: string; title: string; lines: string[] };
/** The proposals an assistant made, as the cards the person is asked. */
export function pickProposals(raw: unknown): Proposal[] {
  const l = (raw as { proposals?: unknown[] } | null)?.proposals;
  if (!Array.isArray(l)) return [];
  return l.flatMap((x) => {
    const p = x as Record<string, unknown> | null;
    const card = p && (p.card as { title?: unknown; lines?: unknown } | undefined);
    if (!p || typeof p.proposal !== "string" || !card || typeof card.title !== "string" || !Array.isArray(card.lines)) return [];
    return [{ id: p.proposal, by: String(p.by ?? ""), why: typeof p.why === "string" ? p.why : "", title: card.title, lines: (card.lines as unknown[]).map(String) }];
  });
}

export type Connected = { key: string; kind: "api" | "mcp"; label: string; where: string; status: "ok" | "bad" | "idle"; words: string };

/**
 * One list of what is connected over HTTP APIs and MCP servers: the person does not need to know which is which to see that it works. Each row says where to open it (its own tab). MCP servers stay
 * the hub's rows (one mechanism); this only reads them beside the Connections.
 */
export function unifyConnected(made: MadeConnection[], servers: { name: string; state: string; error: string; tools: number | null; url: string; command: string }[]): Connected[] {
  const apis: Connected[] = made.map((c) => ({ key: `api:${c.id}`, kind: "api", label: c.label, where: c.host, status: c.light === "green" ? "ok" : c.light === "unknown" ? "idle" : "bad", words: lightWords(c) }));
  const mcp: Connected[] = servers.map((s) => ({
    key: `mcp:${s.name}`, kind: "mcp", label: s.name, where: s.url ? (() => { try { return new URL(s.url).hostname; } catch { return s.url; } })() : s.command,
    status: s.state === "running" ? "ok" : s.state === "stopped" || s.state === "idle" || !s.state ? "idle" : "bad",
    words: s.state === "running" ? (s.tools != null ? `Running, ${s.tools} ${s.tools === 1 ? "tool" : "tools"}` : "Running") : s.error || (s.state ? s.state[0].toUpperCase() + s.state.slice(1) : "Not started"),
  }));
  return [...apis, ...mcp].sort((a, b) => a.label.localeCompare(b.label));
}
