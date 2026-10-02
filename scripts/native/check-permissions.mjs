#!/usr/bin/env node
// What the built app asks the phone for, checked against docs/native/permissions.json so the privacy page stays true.
//   node scripts/native/check-permissions.mjs android --apk <file>            (aapt2 from ANDROID_HOME, or AAPT2=<path>)
//   node scripts/native/check-permissions.mjs android --text <file>           (the output of `aapt2 dump permissions`, for tests)
//   node scripts/native/check-permissions.mjs ios <Info.plist> [more plists]  (plutil on a Mac, or a JSON file)
// Android: the merged manifest of the built APK may hold only the listed permissions ("{package}" stands for the application id). Anything else
// fails, and one of the sensitive ones (camera, microphone, location, contacts, photos and media, storage) says so by name.
// iOS: any usage-description key for camera, microphone, location, contacts, photos, Bluetooth, motion, Face ID or tracking fails unless it is listed.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const ANDROID_SENSITIVE = [
  [/\.CAMERA$/, "camera"],
  [/\.RECORD_AUDIO$|\.CAPTURE_AUDIO_OUTPUT$/, "microphone"],
  [/\.ACCESS_(FINE|COARSE|BACKGROUND)_LOCATION$|\.ACCESS_MEDIA_LOCATION$/, "location"],
  [/\.(READ|WRITE|GET)_CONTACTS$|\.GET_ACCOUNTS$/, "contacts"],
  [/\.READ_MEDIA_(IMAGES|VIDEO|AUDIO|VISUAL_USER_SELECTED)$/, "photos and media"],
  [/\.(READ|WRITE|MANAGE)_EXTERNAL_STORAGE$/, "storage"],
  [/\.READ_PHONE_STATE$|\.READ_PHONE_NUMBERS$|\.READ_SMS$|\.SEND_SMS$|\.READ_CALL_LOG$/, "phone and messages"],
];
export const IOS_SENSITIVE = [
  [/^NSCameraUsageDescription$/, "camera"],
  [/^NSMicrophoneUsageDescription$/, "microphone"],
  [/^NSLocation\w*UsageDescription$/, "location"],
  [/^NSContactsUsageDescription$/, "contacts"],
  [/^NSPhotoLibrary\w*UsageDescription$/, "photos"],
  [/^NSBluetooth\w*UsageDescription$/, "bluetooth"],
  [/^NSMotionUsageDescription$/, "motion"],
  [/^NSUserTrackingUsageDescription$/, "tracking"],
  [/^NSSpeechRecognitionUsageDescription$/, "speech recognition"],
  [/^NSCalendars\w*UsageDescription$|^NSRemindersUsageDescription$/, "calendar and reminders"],
  [/^NSHealth\w*UsageDescription$/, "health"],
];

/** @param {string} text the output of `aapt2 dump permissions` @returns {{ pkg: string, perms: string[] }} */
export function parseAndroid(text) {
  const pkg = (/^package: (\S+)/m.exec(text) || [])[1] || "";
  const perms = [...text.matchAll(/^uses-permission(?:-sdk-\d+|-sdk-m)?: name='([^']+)'/gm)].map(m => m[1]);
  return { pkg, perms: [...new Set(perms)].sort() };
}

/** @param {{ pkg: string, perms: string[] }} got @param {any} policy the parsed docs/native/permissions.json @returns {string[]} the problems */
export function checkAndroid(got, policy) {
  const problems = [];
  if (!got.pkg) problems.push("could not read the package name from the permission dump");
  const allowed = new Set(((policy.android || {}).allowed || []).map(p => p.replace("{package}", got.pkg)));
  for (const p of got.perms) {
    if (allowed.has(p)) continue;
    const kind = ANDROID_SENSITIVE.find(([re]) => re.test(p));
    problems.push(kind ? `${p} (${kind[1]}) is in the built app and not listed in docs/native/permissions.json` : `${p} is in the built app and not listed in docs/native/permissions.json`);
  }
  return problems;
}

/** @param {Record<string, any>[]} plists @param {any} policy @returns {string[]} the problems */
export function checkIos(plists, policy) {
  const problems = [];
  const allowed = new Set((policy.ios || {}).allowedKeys || []);
  for (const pl of plists) for (const k of Object.keys(pl)) {
    if (allowed.has(k)) continue;
    const kind = IOS_SENSITIVE.find(([re]) => re.test(k));
    if (kind) problems.push(`${k} (${kind[1]}) is in the built app and not listed in docs/native/permissions.json`);
  }
  return problems;
}

function aapt2() {
  if (process.env.AAPT2) return process.env.AAPT2;
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!home) throw new Error("set ANDROID_HOME or AAPT2");
  const dirs = fs.readdirSync(path.join(home, "build-tools")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!dirs.length) throw new Error("no build-tools in " + home);
  return path.join(home, "build-tools", dirs[dirs.length - 1], "aapt2");
}

function readPlist(file) {
  const raw = fs.readFileSync(file, "utf8");
  if (raw.trimStart().startsWith("{")) return JSON.parse(raw);
  return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
}

if (process.argv[1] && process.argv[1].endsWith("check-permissions.mjs")) {
  const [kind, ...rest] = process.argv.slice(2);
  const pf = process.env.PERMISSIONS_FILE || path.join(REPO, "docs/native/permissions.json");
  const policy = JSON.parse(fs.readFileSync(pf, "utf8"));
  let problems = [];
  if (kind === "android") {
    const i = rest.indexOf("--apk"), t = rest.indexOf("--text");
    const text = i >= 0 ? execFileSync(aapt2(), ["dump", "permissions", rest[i + 1]], { encoding: "utf8" }) : t >= 0 ? fs.readFileSync(rest[t + 1], "utf8") : null;
    if (text === null) { console.error("usage: check-permissions.mjs android --apk <file> | --text <file>"); process.exit(2); }
    const got = parseAndroid(text);
    console.log(`Android permissions of ${got.pkg}:\n${got.perms.map(p => "  " + p).join("\n") || "  (none)"}`);
    problems = checkAndroid(got, policy);
  } else if (kind === "ios" && rest.length) {
    const plists = rest.map(readPlist);
    const keys = [...new Set(plists.flatMap(p => Object.keys(p).filter(k => /UsageDescription$/.test(k))))].sort();
    console.log(`iOS usage descriptions in ${rest.length} Info.plist file(s):\n${keys.map(k => "  " + k).join("\n") || "  (none)"}`);
    problems = checkIos(plists, policy);
  } else { console.error("usage: check-permissions.mjs android --apk <file> | ios <Info.plist>..."); process.exit(2); }
  for (const p of problems) console.error(`permissions: ${p}`);
  if (problems.length) process.exit(1);
  console.log("permissions: nothing beyond docs/native/permissions.json");
}
