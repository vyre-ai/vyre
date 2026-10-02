#!/usr/bin/env node
// Make the prebuilt android/app/build.gradle ready for the sideload build:
//   node scripts/native/android-prepare.mjs <build.gradle> <x.y.z>
// - the release buildType loses prebuild's debug signingConfig (the APK comes out unsigned; the release job signs it),
// - versionName is the release version and versionCode only goes up with it (major * 1000000 + minor * 10000 + patch * 100),
// - the application id must still be sh.vyre.app (the box-signed channel in app.yml is sh.vyre.app.box).
import fs from "node:fs";

export function versionCode(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`not a release version: ${version}`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (min > 99 || pat > 99 || maj > 999) throw new Error(`version out of range for a versionCode: ${version}`);
  return maj * 1000000 + min * 10000 + pat * 100;
}

/** @param {string} gradle @param {string} version @returns {string} */
export function prepare(gradle, version) {
  let s = gradle;
  const bt = s.indexOf("buildTypes"), rel = s.indexOf("release {", bt), line = "signingConfig signingConfigs.debug", at = s.indexOf(line, rel);
  if (bt < 0 || rel < 0 || at < 0) throw new Error("no release signingConfig to drop");
  s = s.slice(0, at) + "// unsigned: scripts/native/android-sign.sh signs it in the release job" + s.slice(at + line.length);
  if (!/versionCode\s+\d+/.test(s)) throw new Error("no versionCode");
  if (!/versionName\s+["'][^"']*["']/.test(s)) throw new Error("no versionName");
  s = s.replace(/versionCode\s+\d+/, `versionCode ${versionCode(version)}`).replace(/versionName\s+["'][^"']*["']/, `versionName "${version}"`);
  if (!/applicationId\s+["']sh\.vyre\.app["']/.test(s)) throw new Error("applicationId is not sh.vyre.app");
  return s;
}

if (process.argv[1] && process.argv[1].endsWith("android-prepare.mjs")) {
  const [file, version] = process.argv.slice(2);
  if (!file || !version) { console.error("usage: android-prepare.mjs <build.gradle> <x.y.z>"); process.exit(2); }
  try { fs.writeFileSync(file, prepare(fs.readFileSync(file, "utf8"), version)); } catch (e) { console.error(`android-prepare: ${e.message} in ${file}`); process.exit(1); }
  console.log(`${file}: version ${version}, versionCode ${versionCode(version)}, unsigned release`);
}
