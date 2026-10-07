// Nothing central in the Android app: no Firebase messaging service, no Google Play services.
// expo-notifications is not a dependency (local notices come from modules/vyre-notify), but a
// library added later can bring Firebase or Play services in through its own manifest or Gradle
// dependency. This plugin removes them at the two places they arrive, and
// scripts/check-apk-nothing-central.mjs fails the build if anything is left in the APK.
//   1. the merged manifest: tools:node="remove" for every Firebase / Play services component
//   2. Gradle: `configurations.all { exclude group: ... }` for com.google.firebase and com.google.android.gms
const { withAndroidManifest, withProjectBuildGradle } = require("expo/config-plugins");

const GROUPS = ["com.google.firebase", "com.google.android.gms"];
const MARK = "// vyre: nothing central";

// What libraries add to a manifest for Firebase and Play services (names, not prefixes, where the
// library names them; the remove entries are harmless when nothing carries that name).
const REMOVE = {
  service: [
    "expo.modules.notifications.service.ExpoFirebaseMessagingService",
    "com.google.firebase.messaging.FirebaseMessagingService",
    "com.google.firebase.components.ComponentDiscoveryService",
    "com.google.android.gms.measurement.AppMeasurementService",
    "com.google.android.gms.measurement.AppMeasurementJobService",
  ],
  receiver: [
    "com.google.firebase.iid.FirebaseInstanceIdReceiver",
    "com.google.android.gms.measurement.AppMeasurementReceiver",
  ],
  provider: ["com.google.firebase.provider.FirebaseInitProvider"],
  "meta-data": [
    "com.google.android.gms.version",
    "firebase_messaging_auto_init_enabled",
    "firebase_analytics_collection_enabled",
    "com.google.firebase.messaging.default_notification_icon",
    "com.google.firebase.messaging.default_notification_color",
    "com.google.firebase.messaging.default_notification_channel_id",
    "expo.modules.notifications.default_notification_icon",
    "expo.modules.notifications.default_notification_color",
  ],
};

function withManifest(config) {
  return withAndroidManifest(config, (c) => {
    const m = c.modResults.manifest;
    m.$ = { ...m.$, "xmlns:tools": "http://schemas.android.com/tools" };
    const app = m.application[0];
    for (const [tag, names] of Object.entries(REMOVE)) {
      const have = (app[tag] ??= []);
      for (const name of names) {
        if (!have.some((e) => e.$["android:name"] === name)) have.push({ $: { "android:name": name, "tools:node": "remove" } });
      }
    }
    return c;
  });
}

function withGradle(config) {
  return withProjectBuildGradle(config, (c) => {
    if (c.modResults.language !== "groovy" || c.modResults.contents.includes(MARK)) return c;
    const ex = GROUPS.map((g) => `    exclude group: '${g}'`).join("\n");
    c.modResults.contents += `\n${MARK}\nallprojects {\n  configurations.configureEach {\n${ex}\n  }\n}\n`;
    return c;
  });
}

module.exports = (config) => withGradle(withManifest(config));
module.exports.REMOVE = REMOVE;
module.exports.GROUPS = GROUPS;
