// @ts-check
// The pure half of the preview card: the words for each state, who may be shown what, and which verbs the card offers when. Node tests it; PreviewCard.tsx draws it.

/** @typedef {{ block: "preview", id: string, title: string, state: "starting"|"live"|"stopped"|"crashed", source: string, mode: "session"|"supervised", access: "me"|"project"|"team", thumb: number }} PreviewBlock */

/** The one word a card shows for its state. @param {string} state */
export const previewWord = (state) => ({ starting: "Starting", live: "Live", stopped: "Stopped", crashed: "Needs attention" }[state] ?? "Starting");

/** Who can open it, in a line. @param {string} access */
export const shareWord = (access) => ({ me: "Only you can open this", project: "People in this project can open this", team: "Everyone in this space can open this" }[access] ?? "Only you can open this");

/** @type {["me" | "project" | "team", string][]} */
export const SHARE_CHOICES = [["me", "Only me"], ["project", "Project"], ["team", "Everyone"]];

/**
 * The verbs a card offers. Open only when it is up; Restart for what Vyre runs (or any that is down, offered primary); Keep it running for an agent's own server that is up (it would end with the session);
 * the log for what is not working; Stop for what Vyre runs or what is up.
 * @param {{ state: string, mode: string }} p
 */
export function previewActions(p) {
  const live = p.state === "live", down = p.state === "stopped" || p.state === "crashed";
  const supervised = p.mode === "supervised";
  return {
    open: live,
    keep: !supervised && live,
    restart: supervised && (live || down || p.state === "starting") ? true : false,
    log: p.state === "crashed" || (supervised && down),
    stop: live || p.state === "starting",
  };
}

/** What the card says about how long the preview lives: the agent's own server ends with the chat; one Vyre looks after keeps running. @param {string} mode @param {string} state */
export const lifeWord = (mode, state) => (state === "live" || state === "starting") ? (mode === "session" ? "Ends with this chat" : "Keeps running") : "";

/** Whether the card offers Publish: a preview of a folder of files (the folder is the site), not a server an agent runs, and not while it is still starting. @param {{ source?: string, state?: string }} b */
export const canPublish = (b) => b.source === "files" && b.state !== "starting";

/** The site's name from the card's title: lower case letters, digits and dashes, at most 40, never empty. @param {string} title */
export const siteNameOf = (title) => String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "site";

/** The address a published site answers at: its first domain, else its own address. @param {{ url?: string | null, domains?: { host: string }[] } | null | undefined} d */
export const addressOf = (d) => (d ? (d.domains && d.domains[0] ? d.domains[0].host : d.url || "") : "");

/** What publish.quick tells the person beyond the plan: until the public door is on, the address works on their own devices only (the box says the same words). @param {{ public?: boolean }} r */
export const publishWords = (r) => ({ later: r && r.public === false ? "Public once the public door is on. Until then the address works on your own devices only." : "" });
