// @ts-check
// What a site's page in Files says, from the deployments publish.list returns: where it lives, what the preview frame shows, and whether the draft is ahead of what visitors see.

/** @typedef {{ id: string, version: number, url: string | null, domains: { host: string, status: string }[] }} Dep */
/** @typedef {{ name: string, live: Dep | null, current: Dep }} SiteLike */

/** The public address (a connected domain first, else the live deployment's url) and the frame's source (the live site, or else the private preview). @param {SiteLike} site @returns {{ url: string | null, preview: string | null }} */
export function siteAddress(site) {
  const live = site.live;
  const domain = live ? live.domains.find((d) => d.status === "verified" || d.status === "active") : undefined;
  const url = domain ? `https://${domain.host}` : live && live.url ? live.url : null;
  return { url, preview: url || site.current.url || null };
}

/** True when the newest version is not the one visitors see: changes wait to be published. @param {SiteLike} site */
export const unpublished = (site) => Boolean(site.live) && site.current.id !== /** @type {Dep} */ (site.live).id;
