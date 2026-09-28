// @ts-check
// Who is on the other end of vyre-core's socket: the kernel's word for the peer's uid and pid.
//
// vyre-core runs as its own account (_vyre on a Mac) and answers only the owner's uid (ADR 0040
// section 3). A socket file's mode can't say that on a Mac: the owner's group (staff) is every
// user's, and _vyre can't hand the file to another uid. So the check is the kernel's, per
// connection, before any route: SO_PEERCRED on Linux, LOCAL_PEERCRED and LOCAL_PEERPID on macOS.
//
// Node has no getsockopt, so /usr/bin/perl reads it off the connection handed over as fd 3, the
// same way core/daemon/peer.js reads a pid for vyred. By absolute path and with an empty
// environment: core never runs anything the person's uid could have put first in a PATH, and
// PERL5OPT or PERL5LIB would hand fd 3 to someone else's code (ADR 0040 section 1).

import { spawn } from "node:child_process";

// The child shares the connection's file, and O_NONBLOCK with it: set it back before anything.
const NONBLOCK = 'use Fcntl; open(my $s, "+<&=", 3) or exit 2; fcntl($s, F_SETFL, fcntl($s, F_GETFL, 0) | O_NONBLOCK) or exit 4;';
const PERL = {
  // struct ucred { pid_t pid; uid_t uid; gid_t gid; }
  linux: `use Socket; ${NONBLOCK} my $v = getsockopt($s, SOL_SOCKET, SO_PEERCRED) or exit 3; my ($p, $u) = unpack("iI", $v); print "$p $u";`,
  // SOL_LOCAL 0: LOCAL_PEERPID 2 is a pid_t; LOCAL_PEERCRED 1 is struct xucred { u_int cr_version; uid_t cr_uid; ... }.
  darwin: `${NONBLOCK} my $p = getsockopt($s, 0, 2) or exit 3; my $c = getsockopt($s, 0, 1) or exit 3; my ($ver, $u) = unpack("II", $c); print unpack("i", $p), " $u";`,
};
const PERL_BIN = "/usr/bin/perl";
const TIMEOUT = 4000, ATTEMPTS = 2;

/** Whether this platform can say who is on a socket at all. */
export const canReadPeers = Boolean(PERL[/** @type {"darwin"|"linux"} */ (process.platform)]);

/** @param {any} socket */
function nonBlocking(socket) {
  try { if (socket && socket._handle && typeof socket._handle.setBlocking === "function") socket._handle.setBlocking(false); } catch {}
}

/**
 * The peer's { pid, uid }, or null when the kernel's answer can't be read. Two tries on the same
 * connection, never a guess: a null is a refusal.
 * @param {import("node:net").Socket} socket
 * @returns {Promise<{ pid: number, uid: number } | null>}
 */
export function readPeerCred(socket) {
  const script = PERL[/** @type {"darwin"|"linux"} */ (process.platform)];
  if (!script) return Promise.resolve(null);
  // The fd number, not the Socket: given a Socket, Node closes it when the child exits.
  const fd = /** @type {any} */ (socket)._handle && /** @type {any} */ (socket)._handle.fd;
  if (!Number.isInteger(fd) || fd < 0) return Promise.resolve(null);
  const once = () => new Promise(resolve => {
    let out = "";
    const child = spawn(PERL_BIN, ["-e", script], { stdio: ["ignore", "pipe", "ignore", fd], env: {} });
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT);
    child.stdout.on("data", d => { out += d; });
    child.on("error", () => { clearTimeout(timer); nonBlocking(socket); resolve(null); });
    child.on("close", code => {
      clearTimeout(timer);
      nonBlocking(socket);
      const m = /^(\d+) (\d+)$/.exec(out.trim());
      const pid = m ? Number(m[1]) : 0, uid = m ? Number(m[2]) : -1;
      resolve(code === 0 && m && pid > 0 && uid >= 0 ? { pid, uid } : null);
    });
  });
  return (async () => {
    for (let n = 0; n < ATTEMPTS; n++) {
      const c = await once();
      if (c) return c;
    }
    return null;
  })();
}
