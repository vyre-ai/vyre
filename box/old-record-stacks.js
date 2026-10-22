// @ts-check
// Names of an older record-store stack that `vyre update` removes. Records now live in the kernel's own SQLite store, so those containers and volumes are deleted, not migrated. Only this server's Spaces are named: a shared Docker host may hold another server's stacks, and those are left alone.
import fs from "node:fs";
import path from "node:path";

/** `vyre-spc-<id>-twenty-...` (containers) and `vyre-spc-<id>-twenty_...` (volumes). The id is the Space id with underscores written as hyphens. */
const STACK = /^vyre-(spc-[a-z0-9]+)-twenty[-_].+$/;

/**
 * The old record-store containers and volumes that belong to this server's Spaces.
 * @param {{ containers?: string[], volumes?: string[], spaces?: string[] }} o space ids as stored (`spc_...`) or as compose names (`spc-...`)
 * @returns {{ containers: string[], volumes: string[] }}
 */
export function oldRecordStackNames(o) {
  const mine = new Set((o.spaces || []).map(s => String(s).replace(/_/g, "-")).filter(s => /^spc-[a-z0-9]+$/.test(s)));
  const take = (/** @type {string[] | undefined} */ names) => (names || []).filter(n => {
    const m = STACK.exec(String(n));
    return Boolean(m && mine.has(m[1]));
  });
  return { containers: take(o.containers), volumes: take(o.volumes) };
}

/** Space ids this home hosts: the home Space in kernel/space.json, and each directory under kernel/spaces. @param {string} home */
export function spacesOnHome(home) {
  /** @type {string[]} */ const ids = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, "kernel", "space.json"), "utf8"));
    if (j && typeof j.space === "string") ids.push(j.space);
  } catch { /* no home space */ }
  try {
    for (const name of fs.readdirSync(path.join(home, "kernel", "spaces"))) {
      try { if (fs.statSync(path.join(home, "kernel", "spaces", name)).isDirectory()) ids.push(name); } catch { /* skip */ }
    }
  } catch { /* no hosted spaces */ }
  return ids;
}

/**
 * Read `container <name>` and `volume <name>` lines on stdin, print the ones this server should remove.
 * The home is VYRE_HOME, or /home/vyre/.vyre.
 */
export function reportOldRecordStacks(stdin, home) {
  /** @type {string[]} */ const containers = [];
  /** @type {string[]} */ const volumes = [];
  for (const line of String(stdin).split("\n")) {
    const c = /^container (.+)$/.exec(line);
    const v = /^volume (.+)$/.exec(line);
    if (c) containers.push(c[1]);
    else if (v) volumes.push(v[1]);
  }
  const named = oldRecordStackNames({ containers, volumes, spaces: spacesOnHome(home) });
  return [...named.containers.map(n => `container ${n}`), ...named.volumes.map(n => `volume ${n}`)].join("\n") + (named.containers.length || named.volumes.length ? "\n" : "");
}

if (process.argv[1] && process.argv[1].endsWith("old-record-stacks.js")) {
  const home = process.env.VYRE_HOME || "/home/vyre/.vyre";
  process.stdout.write(reportOldRecordStacks(fs.readFileSync(0, "utf8"), home));
}
