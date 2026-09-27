// @ts-check
// Loaded with `node --import` into every vyred and vyre that scripts/docs-shots starts, so the
// screenshots show the sample world's machine (alex-box, run by alex) and never the name of the
// server or the account they were taken on. With VYRE_SHOTS_TLS_PORT set, a box's HTTPS listener
// asked for port 443 (which only root may bind) binds that port instead and still reports 443, so
// the onboarding shows the address a real box gets. Nothing else changes.

import https from "node:https";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const host = process.env.VYRE_SHOTS_HOST || "alex-box";
const user = process.env.VYRE_SHOTS_USER || "alex";
const real = os.userInfo;
os.hostname = () => host;
os.userInfo = (/** @type {any} */ o) => ({ ...real(o), username: user });
syncBuiltinESMExports();

const tls = Number(process.env.VYRE_SHOTS_TLS_PORT || 0);
if (tls) {
  const listen = https.Server.prototype.listen;
  https.Server.prototype.listen = /** @type {any} */ (function (/** @type {any[]} */ ...args) {
    const o = args[0];
    if (o && typeof o === "object" && Number(o.port) === 443) {
      args[0] = { ...o, port: tls };
      const address = this.address.bind(this);
      this.address = () => { const a = address(); return a && typeof a === "object" ? { ...a, port: 443 } : a; };
    }
    return listen.apply(this, args);
  });
}
