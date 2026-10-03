#!/usr/bin/env node
// strip-wrapper: the release build of box/vyre, with every test override cut out.
//   node scripts/strip-wrapper.mjs box/vyre > site/box/vyre
// box/vyre keeps one block between "# >>> seams" and "# <<< seams" that reads every VYRE_* override the tests use (the release key, the
// cosign image, where a release comes from, where root's folders are, the clock). The release wrapper has that block replaced by
// CONSTANTS: the pinned values copied out of the block's own defaults, so they are written once. An installed wrapper then reads none of
// those names, whatever a unit drop-in, an EnvironmentFile, `sudo -E` or a person's shell puts in its environment, and a root run
// additionally refuses to start when any other VYRE_* is set (root_guard) and takes the stack folder from a file only root writes.
// Tests run against the unstripped source; test/box-build-clean.test.js checks the built file.
import fs from "node:fs";

const START = "# >>> seams";
const END = "# <<< seams";

/** @param {string} src the text of box/vyre @returns {string} the release text */
export function strip(src) {
  const a = src.indexOf(START), b = src.indexOf(END);
  if (a < 0 || b < a) throw new Error("box/vyre has no seams block");
  const block = src.slice(a, b);
  const pin = name => {
    const m = new RegExp(`^[A-Z_]+=\\$\\{${name}:-([^}]+)\\}$`, "m").exec(block);
    if (!m) throw new Error(`the seams block has no default for ${name}`);
    return m[1];
  };
  const key = pin("VYRE_RELEASE_KEY"), cosign = pin("VYRE_COSIGN_IMAGE");
  const constants = `# >>> release constants: the test overrides of the source are cut out of this build (scripts/strip-wrapper.mjs)
# A fixed PATH, so a docker (or sed, or id) a person's PATH names first is never the one this wrapper runs; a root run gets nothing else: the
# environment variables that point docker at another daemon, another config or another context, every compose setting, and the shell's startup
# hooks are unset. A person's run keeps their own PATH after the system folders.
ORIG_PATH=$PATH
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if [ "$(id -u)" = 0 ]; then
  unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION DOCKER_DEFAULT_PLATFORM DOCKER_BUILDKIT BASH_ENV ENV CDPATH
  for v in $(env | sed -n 's/^\\(COMPOSE_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$v"; done
else
  PATH="$PATH:$ORIG_PATH"
fi
export PATH
UPD_ROOT=/var/lib/vyre-update
RELEASE_KEY=${key}
COSIGN_IMAGE=${cosign}
SITE=https://vyre.run/box/
API=https://api.github.com
REPO=vyre-ai/vyre
USE_API=1
WRAPPER=/usr/local/bin/vyre
ROOT_UID=0
CHAIN_TOP=/
UPDATE_WAIT=60
MIN_GAP=600
SYSTEMD_DIR=/etc/systemd/system
SYSTEMD_SEAM=
UPDATER_NAME=vyre-update
CHOME_SEAM=
SPACES_ROOT=/var/lib/vyre-spaces
SPACES_UNIT=vyre-spaces
CTR_NAME=vyre-vyre-1
DAEMON_UID=1000
SPACES_CAP=16
SPACES_UP_PER_MIN=6
SPACES_SPOOL_CAP=64
ADMIN_NOTTY=0
# The stack folder: a person's or a model's run takes it from VYRE_DIR (their own choice, no trust in it). A root run never does: it
# reads the folder root recorded when it installed the updater (only \`vyre updater\`, which the installer runs, takes it from the
# environment, once, to record it).
if [ "$(id -u)" = 0 ]; then
  case "\${1:-}" in
    updater) DIR=\${VYRE_DIR:-/srv/vyre} ;;
    *) DIR=$(sed -n 1p "$UPD_ROOT/stack" 2>/dev/null || true); DIR=\${DIR:-/srv/vyre} ;;
  esac
else
  DIR=\${VYRE_DIR:-/srv/vyre}
fi
# A root run reads no override: any VYRE_* in its environment other than the one the installer passes to \`updater\` is refused.
root_guard() {
  [ "$(id -u)" = 0 ] || return 0
  case "\${1:-}" in update|update-from-request|publish-release|updater|space-helper-run|space-helper|admin) ;; *) return 0 ;; esac
  extra=$(env | sed -n 's/^\\(VYRE_[A-Za-z0-9_]*\\)=.*/\\1/p' | grep -vx 'VYRE_DIR' | head -n 1 || true)
  if [ -n "$extra" ]; then echo "vyre: $extra is set in the environment of a root run, and a root run reads no override; nothing was changed" >&2; exit 1; fi
}
`;
  const out = src.slice(0, a) + constants + src.slice(b);
  const left = SEAMS.filter(n => out.includes(n));
  if (left.length) throw new Error(`the release wrapper still names ${left.join(", ")}`);
  return out;
}

/** The overrides that must not survive into the release build (the build-clean test uses the same list). */
export const SEAMS = ["VYRE_RELEASE_KEY", "VYRE_COSIGN_IMAGE", "VYRE_BOX_URL", "VYRE_RELEASES_API", "VYRE_RELEASES_REPO", "VYRE_UPDATE_ROOT", "VYRE_ROOT_UID",
  "VYRE_CHAIN_TOP", "VYRE_WRAPPER", "VYRE_UPDATE_WAIT", "VYRE_UPDATE_MIN_GAP", "VYRE_SYSTEMD_DIR", "VYRE_UPDATER_NAME", "VYRE_CONTAINER_HOME",
  "VYRE_SPACES_ROOT", "VYRE_SPACES_UNIT", "VYRE_CTR_NAME", "VYRE_DAEMON_UID", "VYRE_SPACES_CAP", "VYRE_SPACES_UP_PER_MIN", "VYRE_SPACES_SPOOL_CAP", "VYRE_ADMIN_NO_TTY"];

if (process.argv[1] && process.argv[1].endsWith("strip-wrapper.mjs")) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node scripts/strip-wrapper.mjs box/vyre > site/box/vyre"); process.exit(2); }
  process.stdout.write(strip(fs.readFileSync(file, "utf8")));
}
