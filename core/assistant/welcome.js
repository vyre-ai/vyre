// @ts-check
// assistant.welcome: the first message the person sees when setup lands them in the chat.
// Built from onboard.status alone, no model call. A card appears only when its action would work
// now, so nothing on the screen is a dead end. Cards carry {id, title, body} and, for a link, href. The id is the
// contract: the Deck maps it to its own handler, so a card never names a tool to run.

/** The sign-in link only when it is https on tailscale.com or a subdomain of it; anything else is dropped. */
export function vetted(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" && !x.username && !x.password && (x.hostname === "tailscale.com" || x.hostname.endsWith(".tailscale.com")) ? x.href : null;
  } catch { return null; }
}

/** @param {any} st onboard.status data, or null when it could not be read */
export function welcomeOf(st) {
  const d = (st && st.detail) || {};
  const name = (st && (st.assistant || st.name)) || null;
  const person = (st && st.person) || null;
  const cards = [];
  const c = d.claude;
  if (c && !c.signedIn && c.installed) {
    cards.push({ id: "claude", title: "Sign in to Claude", body: "The assistant and your sessions run on your Claude account." });
  }
  const ts = d.tailscale;
  if (ts && ts.state === "working" && ts.loginUrl) {
    const href = vetted(ts.loginUrl);
    cards.push({ id: "tailscale", title: "Finish Tailscale sign-in", body: "One step left to reach this server from your phone.", ...(href ? { href } : {}) });
  }
  const h = d.history;
  if (h && h.state === "todo" && !h.running) {
    cards.push({ id: "history", title: "Bring in your past sessions", body: "Import them so the assistant can remember what you have done." });
  } else if (h && h.running) {
    cards.push({ id: "import", title: "Reading your past sessions", body: `${h.indexed ?? 0} indexed so far.` });
  }
  const dv = d.devices;
  if (dv && dv.state === "todo") {
    cards.push({ id: "phone", title: "Add your phone", body: "Pair it once and the assistant can reach you anywhere." });
  }
  const hello = `${person ? `Hi ${person}. ` : "Hi. "}${name ? `I'm ${name}, your assistant.` : "I'm your assistant."} I can see every project and work across all of them.`;
  const text = cards.length ? `${hello} ${cards.length === 1 ? "One thing is left" : `${cards.length} things are left`} to set up, below. Or just tell me what you want to do.` : `${hello} Everything is set up. Tell me what you want to do.`;
  return { text, cards };
}
