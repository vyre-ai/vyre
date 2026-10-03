// @ts-check
// A throwaway self-signed certificate for tests and for the integration run: ECDSA P-256, short
// lived, with the given IPs and names as SANs. Uses the openssl CLI (node has no X.509 creation
// without a dependency). The key and certificate come back in memory; the temp dir is removed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** @param {{ ips?: string[], names?: string[], days?: number }} [o] */
export function selfSigned(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-"));
  try {
    const san = [...(o.ips || ["127.0.0.1"]).map(i => `IP:${i}`), ...(o.names || ["localhost"]).map(n => `DNS:${n}`)].join(",");
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-subj", "/CN=wink-gate", "-days", String(o.days || 1), "-addext", `subjectAltName=${san}`],
      { stdio: "ignore" });
    return { cert: fs.readFileSync(path.join(dir, "c.pem"), "utf8"), key: fs.readFileSync(path.join(dir, "k.pem"), "utf8") };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
