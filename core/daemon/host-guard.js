// @ts-check
// A test never boots a vyred on the person's own Mac. The rule was written down and broken again and
// again (a dev Mac is the one place a stray daemon matters: sockets, listeners, sessions, keychain), so
// it is enforced where every boot passes: start(). A vyred that starts on darwin under a test (node:test,
// the test helpers' marker, or a home under the temp folder) is refused unless the machine is a CI
// runner (CI is set, or the host is a hosted runner) or the test box (VYRE_TEST_HOST=testbox). A person's own
// vyred, on ~/.vyre or any home outside the temp folder, is never touched by this.
// Unit tests that boot nothing never reach start(), so they are unaffected.

import os from "node:os";
import path from "node:path";

// The machine's own platform, read once at import: a test that fakes `process.platform` to exercise a darwin code path (relay's Mac refusals) must not make the guard think
// it runs on a Mac. That made "a Mac box never mints" pass where VYRE_TEST_HOST=testbox is set and fail on any other Linux box (4 Oct).
const HOST_PLATFORM = process.platform;

export const REFUSAL = "daemon tests run on a runner or the test box, not on this Mac";

/**
 * @param {{ root: string, real?: boolean, env?: Record<string, string | undefined>, platform?: string, hostname?: string, tmpdir?: string }} o
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function daemonHost({ root, real = false, env = process.env, platform = HOST_PLATFORM, hostname = os.hostname(), tmpdir = os.tmpdir() }) {
  if (platform !== "darwin" || real) return { ok: true };
  const r = path.resolve(root);
  const tmp = [path.resolve(tmpdir), "/tmp", "/private/tmp", "/private/var/folders"].some(t => r === t || r.startsWith(t + path.sep));
  const underTest = Boolean(env.NODE_TEST_CONTEXT || env.VYRE_TEST_HOSTED) || tmp;
  if (!underTest) return { ok: true };
  if (env.CI || env.VYRE_TEST_HOST === "testbox" || /^(runner|fv-az)/i.test(hostname)) return { ok: true };
  return { ok: false, why: REFUSAL };
}

/** Throw the refusal when this start is a test daemon on the person's Mac. @param {Parameters<typeof daemonHost>[0]} o */
export function assertDaemonHost(o) {
  const r = daemonHost(o);
  if (!r.ok) throw Object.assign(new Error(r.why), { code: "test_host" });
}

export const WINDOWS_HOME_REFUSAL = "A Vyre home can't run on Windows yet. Use the Vyre app here, and run your home on a Mac, Linux or a server.";

/**
 * A home on Windows needs its own sealing service (separate identity, DPAPI or TPM key, pipe ACL): 0.3.0. Until then vyred refuses to start there with one plain line.
 * A development build with VYRE_KERNEL_FILE_KEY=1 (the CI socket-ACL job) and a daemon given its own sealer are let through; a packaged build never is.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, packaged?: boolean, sealer?: unknown }} o
 */
export function windowsHome({ platform = HOST_PLATFORM, env = process.env, packaged = true, sealer = null } = {}) {
  if (platform !== "win32" || sealer) return { ok: true };
  if (!packaged && env.VYRE_KERNEL_FILE_KEY === "1") return { ok: true };
  return { ok: false, why: WINDOWS_HOME_REFUSAL };
}

/** Throw the refusal when a home would start on Windows. @param {Parameters<typeof windowsHome>[0]} o */
export function assertNotWindowsHome(o) {
  const r = windowsHome(o);
  if (!r.ok) throw Object.assign(new Error(r.why), { code: "windows_home" });
}
