// @ts-check
// The one install line every surface shows (ADR 0055): stable releases use vyre.run/i for Linux and for a Mac that stays on; the code rides in sh's environment, never as an argument.

const RC_RE = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;

/** @param {string | null | undefined} version */
export function releaseCandidateBase(version) {
  const v = String(version ?? "").trim();
  return RC_RE.test(v) ? `https://github.com/vyre-ai/vyre/releases/download/v${v}/` : null;
}

/**
 * @param {{ version?: string | null, code?: string, store?: string, os?: string }} [vars]
 * `store` is ignored: Records is always on (VYRE_STORE=auto when a code is present).
 */
export function buildInstallLine(vars = {}) {
  const base = releaseCandidateBase(vars.version);
  const code = vars.code;
  const env = [base ? `VYRE_BOX_URL=${base}` : "", code ? `VYRE_CODE=${code}` : "", code ? "VYRE_STORE=auto" : ""].filter(Boolean).join(" ");
  let url = "vyre.run/i";
  if (base) url = vars.os === "mac" ? `${base}install-mac-server.sh` : `${base}install-box.sh`;
  return `curl -fsSL ${url} | ${env ? `${env} ` : ""}sh`;
}

/** Minted install line with a one-time code (wink.install.issue, spaces.pair.install). @param {string} code */
export function installCommandWithCode(code) {
  return buildInstallLine({ code });
}

/** Plain installer URL when no signed code is available yet (legacy create flow, mocks). */
export const PLAIN_INSTALL_URL = "curl -fsSL vyre.run/i | sh";
