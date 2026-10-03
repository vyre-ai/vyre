// What the built Android app asks the phone for, against what the app uses. Reads the merged
// manifest of an APK through aapt2 and fails on any permission that is not on the list.
//   node scripts/check-android-permissions.mjs --apk path.apk [--debug] [--allowed android-permissions.json]
//   node scripts/check-android-permissions.mjs --text <file with aapt2 dump permissions output>
// A debug build also gets `debugOnly` (React Native's debug manifest adds the dev overlay permission). The list is `allowed`, with {package} standing for the app's own id. The vault team's
// scripts/native/check-permissions.mjs and docs/native/permissions.json do the same for the signed
// release; keep the two lists the same.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The package and the permissions in `aapt2 dump permissions` output. */
export function parse(text) {
  const pkg = /^package:\s*(\S+)/m.exec(text)?.[1] ?? null;
  const perms = [...text.matchAll(/^uses-permission(?:-sdk-23)?:\s*name='([^']+)'/gm)].map((m) => m[1]);
  return { pkg, perms: [...new Set(perms)].sort() };
}

/** The permissions not on the list; `{package}` in the list is the app's id. */
export function unexpected(perms, allowed, pkg) {
  const ok = new Set(allowed.map((a) => a.replaceAll("{package}", pkg ?? "")));
  return perms.filter((p) => !ok.has(p));
}

function aapt2() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error("ANDROID_HOME is not set");
  const bt = fs.readdirSync(path.join(sdk, "build-tools")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  return path.join(sdk, "build-tools", bt, "aapt2");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const allowedFile = arg("--allowed") ?? path.join(here, "..", "android-permissions.json");
  const text = arg("--text") ? fs.readFileSync(arg("--text"), "utf8") : arg("--apk") ? execFileSync(aapt2(), ["dump", "permissions", arg("--apk")], { encoding: "utf8" }) : null;
  if (text === null) { console.error("give --apk or --text"); process.exit(2); }
  const { pkg, perms } = parse(text);
  const list = JSON.parse(fs.readFileSync(allowedFile, "utf8"));
  const allowed = [...list.allowed, ...(process.argv.includes("--debug") ? list.debugOnly ?? [] : [])];
  const bad = unexpected(perms, allowed, pkg);
  console.log(`package ${pkg}\npermissions:\n${perms.map((p) => "  " + p).join("\n")}`);
  if (bad.length) { console.error(`not on the list (${allowedFile}):\n${bad.map((p) => "  " + p).join("\n")}`); process.exit(1); }
  console.log("every permission is on the list");
}
