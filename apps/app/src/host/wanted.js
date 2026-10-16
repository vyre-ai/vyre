// @ts-check
// Which pages answer the first-run tools themselves (host-core.js) instead of a daemon: a page with no daemon of its own. That is the hosted web app, a build made for it, and the Mac or Windows app's
// window when it runs with no vyred (the shell says `boxless`; the Windows app's window always does). A page whose daemon answers never comes here. Pure, so Node tests it.

const HOSTED = /^web\.vyre\.run$/i;

/** @param {{ web: boolean, flag?: string, hostname?: string, shell?: { kind?: string, boxless?: boolean } | null }} p */
export function hostWantedFor(p) {
  if (!p.web) return false;
  if (p.flag === "1") return true;
  if (p.hostname && HOSTED.test(p.hostname)) return true;
  const s = p.shell;
  return Boolean(s && (s.kind === "mac" || s.kind === "windows") && s.boxless === true);
}
