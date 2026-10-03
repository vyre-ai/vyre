// The debug APK carries its own JavaScript bundle. By default React Native leaves the bundle out of a
// debug build and asks a Metro server on the developer's computer for it, so a debug APK that is
// downloaded from CI opens on a red "unable to load script" screen. With the bundle embedded the
// same APK opens on its own on a phone or an emulator, and building it proves the app's JavaScript
// compiles for the native runtime.
const { withAppBuildGradle } = require("expo/config-plugins");

const MARK = "// vyre: embed the bundle in debug";

module.exports = (config) =>
  withAppBuildGradle(config, (c) => {
    if (c.modResults.language !== "groovy" || c.modResults.contents.includes(MARK)) return c;
    c.modResults.contents = c.modResults.contents.replace(/^react \{\n/m, `react {\n    ${MARK}\n    debuggableVariants = []\n`);
    return c;
  });
