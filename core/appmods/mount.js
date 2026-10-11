// @ts-check
// mount: the signing app's pages under a path of the Space's own address (<space>.vyre.run/sign/_/...), for a signer. The app was made to own a host, so its pages ask for files and send forms to root-relative
// paths (/packs/..., /s/<slug>, /disk/...). Under the mount every such path is put under the mount on the way out, and taken off again on the way in (proxy.js), so a signer's browser never asks the Space's
// root for anything. The rewrites are exact and few, because the app's own script is rewritten too: DocuSeal's signing page builds its requests from one `baseUrl` prop and one webpack public path, and a
// change to either (a new app version) makes `rewriteJs` say so (`null`) instead of serving a page whose requests would escape; the live journey (core/appmods/outside-signer.live.test.js) proves the whole walk.

/** Where the app's pages live on the Space's address. */
export const MOUNT = "/sign/_";
const TOP = "(?:s|packs|disk|fonts|file|api|rails|blobs_proxy|__vyre|signed|assets|images|icons)";

/** The app's path for a public one under the mount, or null when it is not under it. @param {string} pathname */
export function toApp(pathname) {
  return pathname.startsWith(MOUNT + "/") ? pathname.slice(MOUNT.length) : null;
}

/** A root-relative address a redirect names, put under the mount. @param {string} loc */
export function mountLocation(loc) {
  return /^\/(?!\/)/.test(loc) && !loc.startsWith(MOUNT + "/") ? MOUNT + loc : loc;
}

/** Root-relative URLs in an HTML page: attributes, and the app's JSON inside data attributes and scripts. @param {string} html */
export function rewriteHtml(html, host = "") {
  const own = host ? new RegExp(`https?:\\/\\/${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/(?!sign\\/)`, "gi") : null;
  const out = html
    .replace(/\b(href|src|action|poster|data-src|formaction)=(["'])\/(?!\/|sign\/_\/)/gi, (_m, a, q) => `${a}=${q}${MOUNT}/`)
    .replace(new RegExp(`(&quot;|")\\/(?!sign\\/_\\/)(${TOP})\\/`, "g"), (_m, q, top) => `${q}${MOUNT}/${top}/`)
    .replace(/url\((["']?)\/(?!\/|sign\/_\/)/g, (_m, q) => `url(${q}${MOUNT}/`);
  // the app builds some addresses from the host it was asked on: its files, with that host in front
  return own ? out.replace(own, m => `${m}sign/_/`) : out;
}

/** Root-relative url() in a stylesheet. @param {string} css */
export function rewriteCss(css) {
  return css.replace(/url\((["']?)\/(?!\/|sign\/_\/)/g, (_m, q) => `url(${q}${MOUNT}/`);
}

/** The app's JSON answers carry file paths as strings. @param {string} json */
export function rewriteJson(json, host = "") {
  const out = json.replace(new RegExp(`"\\/(?!sign\\/_\\/)(${TOP})\\/`, "g"), (_m, top) => `"${MOUNT}/${top}/`);
  return host ? out.replace(new RegExp(`https?:\\/\\/${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/(?!sign\\/)`, "gi"), m => `${m}sign/_/`) : out;
}

/**
 * The app's script: its webpack public path (where it loads its own chunks from) and the `baseUrl` prop every request of the signing form is built from. A script that does neither is left as it is;
 * one that has the form's prop in a shape not known here returns null (the proxy then refuses the page rather than serve requests that would escape the mount).
 * @param {string} js @returns {string | null}
 */
export function rewriteJs(js) {
  let out = js.replace(/\.p="\/packs\/"/g, `.p="${MOUNT}/packs/"`);
  if (/\bbaseUrl:\{type:String/.test(out)) {
    const had = out;
    out = out.replace(/baseUrl:\{type:String,required:!1,default:""\}/g, `baseUrl:{type:String,required:!1,default:"${MOUNT}"}`);
    if (out === had && !out.includes(`default:"${MOUNT}"`)) return null;
  }
  return out;
}

/** A `Link:` header (preloads) names root-relative files too. @param {string} value */
export function mountLinkHeader(value) {
  return value.replace(/<\/(?!\/|sign\/_\/)/g, `<${MOUNT}/`);
}
