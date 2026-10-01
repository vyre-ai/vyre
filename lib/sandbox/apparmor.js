// @ts-check
// apparmor: Ubuntu 23.10 and later restrict unprivileged user namespaces (kernel.apparmor_restrict_
// unprivileged_userns=1), and bubblewrap, which watchers run inside, needs one. The fix that does not
// loosen the whole machine is a profile that lets bwrap, and only bwrap, create them: the same one the
// bubblewrap and apparmor packages ship from Ubuntu 25.04. `vyre up --system` (as root) writes it and loads
// it; `vyre uninstall --system` removes it. Nothing else changes.

import fs from "node:fs";

export const PROFILE_PATH = "/etc/apparmor.d/vyre-bwrap";
export const PROFILE = `abi <abi/4.0>,
include <tunables/global>

# Vyre: let bubblewrap create user namespaces, so watchers can run with no network and no view of
# your home. Written by vyre up --system, removed by vyre uninstall --system.
profile vyre-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/vyre-bwrap>
}
`;

const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };

/**
 * The install steps for the wall on a Linux box, in system.js's step shape. Nothing to do when there
 * is no AppArmor restriction; a note when bubblewrap itself is missing and cannot be installed here.
 * @param {{ has?: (p: string) => boolean, readFile?: (p: string) => string, platform?: string }} [o]
 * @returns {({ do: "write", path: string, content: string, mode: number } | { do: "run", argv: string[], why: string, optional?: boolean } | { do: "note", text: string })[]}
 */
export function wallSteps({ has = exists, readFile = p => fs.readFileSync(p, "utf8"), platform = process.platform } = {}) {
  if (platform !== "linux") return [];
  const steps = [];
  const haveBwrap = has("/usr/bin/bwrap") || has("/bin/bwrap");
  if (!haveBwrap) {
    if (has("/usr/bin/apt-get")) steps.push({ do: "run", argv: ["apt-get", "install", "-y", "bubblewrap"], why: "watchers run inside bubblewrap, which keeps them off the network and out of your home", optional: true });
    else steps.push({ do: "note", text: "install bubblewrap with your package manager: watchers will not run without it." });
  }
  let restricted = false;
  try { restricted = readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").trim() === "1"; } catch {}
  const shipped = ["/etc/apparmor.d/bwrap", "/etc/apparmor.d/bwrap-userns-restrict"].some(has);
  if (restricted && !shipped && has("/usr/sbin/apparmor_parser")) {
    steps.push({ do: "write", path: PROFILE_PATH, content: PROFILE, mode: 0o644 });
    steps.push({ do: "run", argv: ["apparmor_parser", "-r", PROFILE_PATH], why: "let bubblewrap use user namespaces for watchers (only bwrap, nothing else)" });
  }
  return steps;
}

/** The removal steps, for vyre uninstall --system. */
export function wallUninstallSteps() {
  return [
    { do: "run", argv: ["apparmor_parser", "-R", PROFILE_PATH], why: "unload the bubblewrap profile Vyre added", optional: true },
    { do: "remove", path: PROFILE_PATH },
  ];
}
