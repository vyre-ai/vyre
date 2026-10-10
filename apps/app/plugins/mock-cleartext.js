// A sample-world (mock) build lets the app open plain ws:// and http:// sockets, so the hosted Android emulator proofs can reach a fake server on the runner (10.0.2.2, or adb reverse).
// A real build (EXPO_PUBLIC_VYRE_MOCK unset) leaves the manifest alone: it keeps Android's default, no cleartext.
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = (config) => withAndroidManifest(config, (c) => {
  if (process.env.EXPO_PUBLIC_VYRE_MOCK !== "1") return c;
  c.modResults.manifest.application[0].$["android:usesCleartextTraffic"] = "true";
  return c;
});
