// app.json is the app's config. This file reads it and changes two things for a SIDELOADED iPhone build (scripts/ios-sideload.sh sets VYRE_SIDELOAD=1): the bundle id, and the
// entitlements a free personal team cannot hold (associated domains, and App Attest). Without VYRE_SIDELOAD nothing changes, so CI and release builds read app.json as it is.
// A build with no App Attest entitlement still works: the presence key stays a Secure Enclave key, unattested (modules/vyre-signer enrolAttestation returns null).
const { appVersion } = require("./scripts/app-version.cjs");

// The version is the repo's (package.json, moved by scripts/bump-version.mjs): one source, so a release bump reaches the iOS short version and the Android name and code.
function withVersion(config) {
  const v = appVersion(require("../../package.json").version);
  return { ...config, version: v.short, ios: { ...config.ios, buildNumber: String(v.code) }, android: { ...config.android, versionCode: v.code } };
}

module.exports = ({ config: base }) => {
  const versioned = withVersion(base);
  // VYRE_APP_BASE=root builds the web export for serving at / (config app.root, core/daemon/app.js); otherwise it is /app (app.json).
  const config = process.env.VYRE_APP_BASE === "root" ? { ...versioned, experiments: { ...versioned.experiments, baseUrl: "" } } : versioned;
  if (process.env.VYRE_SIDELOAD !== "1") return config;
  const id = process.env.VYRE_IOS_BUNDLE_ID;
  if (!id || !/^[A-Za-z0-9.-]+$/.test(id)) throw new Error("VYRE_IOS_BUNDLE_ID must be set to a bundle id of your own (letters, digits, dots, hyphens)");
  const ios = { ...config.ios, bundleIdentifier: id };
  delete ios.associatedDomains;
  delete ios.entitlements;
  return { ...config, ios };
};
