// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare, versionCode } from "./android-prepare.mjs";

const gradle = `android {
    defaultConfig {
        applicationId "sh.vyre.app"
        versionCode 1
        versionName "1.0.0"
    }
    buildTypes {
        debug { signingConfig signingConfigs.debug }
        release {
            // Caution!
            signingConfig signingConfigs.debug
            minifyEnabled true
        }
    }
}`;

test("android-prepare: unsigned release, the release version, a versionCode that goes up", () => {
  const out = prepare(gradle, "0.2.2");
  assert.match(out, /versionCode 20200/);
  assert.match(out, /versionName "0\.2\.2"/);
  assert.match(out, /debug \{ signingConfig signingConfigs\.debug \}/, "the debug build type keeps its debug key");
  assert.ok(!/release \{[^}]*signingConfig signingConfigs\.debug/.test(out), "the release build type loses it");
  assert.ok(versionCode("0.2.3") > versionCode("0.2.2") && versionCode("0.3.0") > versionCode("0.2.99") && versionCode("1.0.0") > versionCode("0.99.99"));
});

test("android-prepare: refuses another application id, a prerelease and a file without a release signing line", () => {
  assert.throws(() => prepare(gradle.replace('"sh.vyre.app"', '"sh.vyre.app.box"'), "0.2.2"), /applicationId/);
  assert.throws(() => prepare(gradle, "0.2.2-rc.1"), /not a release version/);
  assert.throws(() => prepare(gradle.replace("signingConfig signingConfigs.debug\n            minify", "minify"), "0.2.2"), /signingConfig/);
});
