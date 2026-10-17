// @ts-check
// The Connect apps screen over the real tools: how the box's catalog and connections become the library's app rows, what one tap asks of the box next, what a sheet shows for each step the box
// answers with (a token, the vendor's own app, a sign-in page to approve), what goes back, and how a share at the library's levels becomes the Vault's. It draws nothing and calls nothing: RealConnectApps.tsx
// holds the state and the calls. Plain data in, plain data out, so it runs under the test runner with no box.

/** The library's levels (Fill in, Read, Edit and rotate) and the kernel's names for them (vault.access.set). */
const TO_KERNEL = /** @type {Record<string, string>} */ ({ fill: "use", read: "reveal", edit: "edit" });
const FROM_KERNEL = /** @type {Record<string, string>} */ ({ use: "fill", reveal: "read", edit: "edit" });
export const levelToKernel = (/** @type {string} */ l) => TO_KERNEL[l] || "use";
export const levelFromKernel = (/** @type {string} */ k) => FROM_KERNEL[k] || "fill";

/** The vault item a connection keeps its sign-in in: the box names it `<connection>-auth` (a connection made for Flows and watchers keeps its own name). @param {{ name: string, mode?: string }} c */
export const itemOfConnection = (c) => `${c.name}-auth`;

/**
 * The catalog as the library's rows. A preset another module signs in to (via) has no connect of its own, so it shows only once connected. One a person can add with no setup is one tap; one that needs a
 * token or the vendor's own app is setup, with what it needs.
 * @param {{ group: string, presets: { id: string, label: string, group: string, who: string, note: string, setup: string, via: string, connected: { name: string, mode?: string, label?: string }[] }[] }[]} groups
 * @param {Record<string, { who: string, kind: "person" | "agent", level: string }[]>} [shares] by connection name
 */
export function appsOf(groups, shares = {}) {
  const out = [];
  for (const g of groups) for (const p of g.presets) {
    const conn = p.connected[0] || null;
    if (!conn && p.via) continue;
    out.push({
      id: p.id, name: p.label, vendor: p.label, blurb: p.note || p.who || "", category: p.group,
      state: conn ? "connected" : p.setup === "none" ? "one-tap" : "setup",
      ...(p.setup === "token" ? { setup: "token" } : p.setup === "app" ? { setup: "app" } : {}),
      ...(conn ? { connection: conn.name, shares: shares[conn.name] || [] } : { shares: [] }),
    });
  }
  return out;
}

/** What the box's `mcp.catalog` knows that the curated list does not: a vendor-published row a probe found registers a client by itself, with the preset made for it. Rows already in `apps` are skipped. @param {any[]} entries @param {{ id: string }[]} apps */
export function extraApps(entries, apps) {
  const have = new Set(apps.map((a) => a.id));
  return entries.filter((e) => e && e.oneClick === true && typeof e.preset === "string" && !have.has(e.preset) && !e.connected)
    .map((e) => ({ id: String(e.preset), name: String(e.name || e.id), vendor: String(e.vendor || ""), blurb: String(e.description || ""), category: String(e.category || "other"), state: "one-tap", shares: [] }));
}

/**
 * One connect attempt as the screen holds it. `step` is what the box last answered (the model.ts Step shapes). The sheet to draw follows from it: a token to paste, the vendor's own app, or the sign-in page
 * to approve; a connected, via or empty step has no sheet.
 * @param {{ step: any, values?: Record<string, string>, paste?: string } | null} flow
 * @returns {null | { kind: "token" | "client" | "signin", title: string, help: string, fields: { name: string, label: string, secret: boolean, required: boolean }[], guide: any, url?: string | null, redirect?: string }}
 */
export function sheetOf(flow) {
  const s = flow && flow.step;
  if (!s) return null;
  if (s.step === "token") return { kind: "token", title: s.label || "Token", help: s.help || "", guide: s.guide || null,
    fields: [{ name: "token", label: s.label || "Token", secret: true, required: true }, ...(s.extra || []).map((/** @type {any} */ x) => ({ name: `extra.${x.name}`, label: x.label, secret: false, required: x.required !== false }))] };
  if (s.step === "client") return { kind: "client", title: "The vendor's own app", help: s.help || "", guide: s.guide || null, redirect: s.redirect || "",
    fields: (s.fields || []).map((/** @type {any} */ f) => ({ name: f.name, label: f.label, secret: f.secret === true, required: f.required !== false })) };
  if (s.step === "open") return { kind: "signin", title: "Sign in", help: "Approve it on the vendor's page, then come back. This finishes by itself.", guide: null, url: s.url || null, fields: [] };
  return null;
}

/** The first required field left empty, as a sentence, or "". @param {ReturnType<typeof sheetOf>} sheet @param {Record<string, string>} values */
export function missing(sheet, values) {
  if (!sheet) return "";
  const f = sheet.fields.find((x) => x.required && !String(values[x.name] ?? "").trim());
  return f ? `${f.label} is needed.` : "";
}

/**
 * What the next `connectors.connect` call carries for the values typed into a sheet: a token (and the preset's own extra fields), or the vendor's own app (client id and secret). Nothing else is sent.
 * @param {NonNullable<ReturnType<typeof sheetOf>>} sheet @param {Record<string, string>} values
 */
export function inputOf(sheet, values) {
  const v = (/** @type {string} */ k) => String(values[k] ?? "").trim();
  if (sheet.kind === "token") {
    const extra = Object.fromEntries(sheet.fields.filter((f) => f.name.startsWith("extra.") && v(f.name)).map((f) => [f.name.slice(6), v(f.name)]));
    return { token: v("token"), ...(Object.keys(extra).length ? { extra } : {}) };
  }
  if (sheet.kind === "client") return { app: { client_id: v("client_id"), ...(v("client_secret") ? { client_secret: v("client_secret") } : {}) } };
  return {};
}

/**
 * What a share sheet needs from vault.access.get: the people and agents already shared with, at the library's levels. Teams are not offered in this sheet yet.
 * @param {any} got the answer of vault.access.get @param {{ uid?: string, name: string }[]} [agents] @returns {{ who: string, kind: "person" | "agent", level: string }[]}
 */
export function sharesOf(got, agents = []) {
  const agentName = new Map(agents.filter((a) => a && a.uid).map((a) => [String(a.uid), String(a.name)]));
  const names = new Map((Array.isArray(got && got.people) ? got.people : []).map((/** @type {any} */ p) => [String(p.id), String(p.name || p.id)]));
  return (Array.isArray(got && got.access) ? got.access : []).filter((/** @type {any} */ a) => a && (a.kind === "person" || a.kind === "agent"))
    .map((/** @type {any} */ a) => ({ who: a.kind === "person" ? names.get(String(a.subject)) || String(a.subject) : agentName.get(String(a.subject)) || String(a.subject), subject: String(a.subject), kind: a.kind, level: levelFromKernel(String(a.level)) }));
}

/** Who a share sheet may pick: the Space's people and its agents. @param {any} got @param {any[]} agents */
export function granteesOf(got, agents) {
  return [
    ...(Array.isArray(got && got.people) ? got.people : []).map((/** @type {any} */ p) => ({ who: String(p.name || p.id), subject: String(p.id), kind: "person" })),
    ...agents.map((a) => ({ who: String(a.name), subject: String(a.name), kind: "agent" })),
  ];
}

/** The `vault.access.set` input for one share change: the level in the kernel's words, an agent held at Fill in, `null` to stop. @param {string} item @param {{ kind: "person" | "agent", subject: string }} who @param {string | null} level */
export function shareInput(item, who, level) {
  return { name: item, kind: who.kind, subject: who.subject, level: level === null ? null : who.kind === "agent" ? "use" : levelToKernel(level) };
}
