// @ts-check
// The pure half of the live screen cards: the one word for a run's state, the step track, and the sign-in card's words. Node tests it; OperatorCard.tsx and SigninCard.tsx draw them.

/** @param {string} state */
export const runWord = (state) => ({ working: "Working", done: "Done", stuck: "Needs you", paused: "Paused" }[state] ?? "Working");

/** The step track: at most seven dots, the newest last; the current one is the run's state when that is still going. @param {{ line: string, state: string }[]} steps */
export const dots = (steps) => steps.slice(-7).map((s) => ({ line: s.line, state: ["working", "done", "stuck", "paused"].includes(s.state) ? s.state : "done" }));

/** The sign-in card's words by state. @param {{ site: string, state: string }} b */
export function signinWords(b) {
  if (b.state === "done") return { title: `Signed in to ${b.site}`, detail: "The assistant carries on from here. It never saw the page or your password." };
  if (b.state === "cancelled") return { title: `Sign in to ${b.site}`, detail: "You put this away." };
  if (b.state === "expired") return { title: `Sign in to ${b.site}`, detail: "This waited too long. Ask the assistant again." };
  return { title: `Sign in to ${b.site}`, detail: "Open the screen and sign in yourself. While you do, the assistant cannot see the page and gets no password. Hand back when you are done." };
}

/** The host of an address or a bare host, lower case. @param {string} h */
const hostOf = (h) => { const s = String(h || "").trim().toLowerCase(); try { return new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname; } catch { return s; } };

/**
 * The vault logins that go with a site, from vault.items.names rows ({ name, kind, hosts }): a login whose bound host IS the site or a parent of it (app.example.test fits example.test). Each with the exact host it is bound to,
 * which is what a grant must name. Logins first, then by how close the host is.
 * @param {{ name: string, kind: string, hosts?: string[] }[]} items @param {string} site
 */
export function loginsFor(items, site) {
  const want = hostOf(site);
  /** @type {{ name: string, origin: string, exact: boolean }[]} */ const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.kind !== "login") continue;
    for (const h of it.hosts || []) {
      const hh = hostOf(h);
      if (hh === want || want.endsWith("." + hh)) { out.push({ name: it.name, origin: /^[a-z]+:\/\//.test(h) ? h : `https://${h}`, exact: hh === want }); break; }
    }
  }
  return out.sort((a, b) => Number(b.exact) - Number(a.exact) || a.name.localeCompare(b.name));
}

/** What the picture area says when there is no still: by why the box gave none. @param {string | undefined} why */
export const stillWord = (why) => (why === "mac" ? "The picture stays on your Mac." : why === "none" ? "No picture yet." : "Waiting for a picture.");

/** Does a stuck run's question ask for a one-time code? @param {string} ask */
export const asksForCode = (ask) => /\b(code|otp|2fa|two[- ]factor|authenticator|verification)\b/i.test(String(ask || ""));

/**
 * The vault logins that hold a one-time-code seed, for a run that asked for a code: those whose host shows up in what the run has been doing come first. Rows are vault.list's ({ name, kind, fields, hosts }); a seed is
 * never in them, only that there is one.
 * @param {{ name: string, kind: string, fields?: string[], hosts?: string[] }[]} rows @param {string[]} lines what the run has said it was doing
 */
export function totpLogins(rows, lines) {
  const said = lines.join(" ").toLowerCase();
  const near = (/** @type {{ hosts?: string[] }} */ r) => (r.hosts || []).some((h) => { const x = hostOf(h); return x && said.includes(x.replace(/^www\./, "")); });
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.kind === "login" && Array.isArray(r.fields) && r.fields.includes("totp"))
    .sort((a, b) => Number(near(b)) - Number(near(a)) || a.name.localeCompare(b.name)).map((r) => ({ name: r.name, near: near(r) }));
}
