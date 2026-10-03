// kernel/storage/devices.js: how a paired storage device (core/wink/storage, tailnet) becomes a pool backend. `backendFor(credentials, offer)` is the
// `makeBackend` the Wink adapter (attachPool) is given: a bucket or a cloud volume with an S3 door is an S3 backend, a plugged-in disk is a folder, and a
// network drive is a folder only when this machine has it mounted. A network drive that only another device on its network can reach is not served here
// (null, so the adapter reports it as skipped): that is a device-to-device backend over Wink, not built yet.
import fs from "node:fs";
import { dirBackend, s3Backend } from "./backends.js";

/** @param {{ kind: string, location: any, accessKey?: string, secretKey?: string }} c @param {{ id: string }} offer */
export function backendFor(c, offer) {
  const loc = c.location || {};
  if (c.kind === "s3" || c.kind === "volume") {
    if (!loc.endpoint || !loc.bucket || !c.accessKey || !c.secretKey) return null;
    return s3Backend({ endpoint: loc.endpoint, bucket: loc.bucket, key: c.accessKey, secret: c.secretKey, region: loc.region || "us-east-1", prefix: `vyre/${offer.id}/` });
  }
  const dir = c.kind === "usb-disk" ? loc.path : loc.mount;
  if (typeof dir === "string" && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dirBackend(`${dir}/vyre-${offer.id}`);
  return null;
}
