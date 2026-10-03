// Nothing central in the APK: no Firebase and no Google Play services, in the merged manifest or in
// any dex file. Fails (exit 1) and prints each match.
//   node scripts/check-apk-nothing-central.mjs --apk path.apk
//   node scripts/check-apk-nothing-central.mjs --strings <file with one string per line>
// The check is the pure function `central(strings)`; the APK path feeds it the manifest (aapt2 dump
// xmltree) and the printable strings of every classes*.dex.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RULES = [
  { name: "firebase", re: /firebase/i },
  { name: "google play services", re: /com[./]google[./]android[./]gms/i },
  { name: "google play services (c2dm)", re: /com\.google\.android\.c2dm/i },
];

// Two intent names inside androidx.activity's photo picker (PickVisualMedia). They are text, not a
// dependency: no Play services class is loaded and nothing calls out. Anything else with gms in it fails.
const TEXT_ONLY = new Set(["com.google.android.gms.provider.action.PICK_IMAGES", "com.google.android.gms.provider.extra.PICK_IMAGES_MAX"]);
// A string in a dex or a manifest dump is the name with a length byte or a few characters of syntax around it.
const isTextOnly = (s) => [...TEXT_ONLY].some((t) => s.endsWith(t) && s.length - t.length <= 2);

/** Each string that names Firebase or Google Play services, once, with the rule that caught it. */
export function central(strings) {
  const seen = new Set();
  const out = [];
  for (const s of strings) {
    if (isTextOnly(s)) continue;
    for (const r of RULES) {
      if (r.re.test(s) && !seen.has(s)) {
        seen.add(s);
        out.push({ rule: r.name, text: s.length > 160 ? s.slice(0, 157) + "..." : s });
      }
    }
  }
  return out;
}

/** Printable runs of at least `min` characters, the way `strings` reads a binary. */
export function printable(buf, min = 6) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const c = i < buf.length ? buf[i] : 0;
    if (c >= 0x20 && c < 0x7f) { if (start < 0) start = i; }
    else { if (start >= 0 && i - start >= min) out.push(buf.toString("latin1", start, i)); start = -1; }
  }
  return out;
}

function aapt2() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error("ANDROID_HOME is not set");
  const bt = fs.readdirSync(path.join(sdk, "build-tools")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  return path.join(sdk, "build-tools", bt, "aapt2");
}

function fromApk(apk) {
  const big = { encoding: "buffer", maxBuffer: 1 << 30 };
  const manifest = execFileSync(aapt2(), ["dump", "xmltree", "--file", "AndroidManifest.xml", apk], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n");
  const names = execFileSync("unzip", ["-Z1", apk], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(Boolean);
  const dexes = names.filter((n) => /^classes\d*\.dex$/.test(n));
  const strings = [...manifest];
  for (const d of dexes) strings.push(...printable(execFileSync("unzip", ["-p", apk, d], big)));
  // Libraries and files that name Firebase or Play services are as central as their classes.
  strings.push(...names);
  return { strings, dexes: dexes.length, manifestLines: manifest.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };
  let strings, note;
  if (arg("--strings")) { strings = fs.readFileSync(arg("--strings"), "utf8").split("\n"); note = "strings file"; }
  else if (arg("--apk")) { const r = fromApk(arg("--apk")); strings = r.strings; note = `${r.dexes} dex files, manifest of ${r.manifestLines} lines`; }
  else { console.error("give --apk or --strings"); process.exit(2); }
  const bad = central(strings);
  if (bad.length) {
    console.error(`found ${bad.length} string(s) that name Firebase or Google Play services (${note}):`);
    for (const b of bad.slice(0, 60)) console.error(`  [${b.rule}] ${b.text}`);
    process.exit(1);
  }
  console.log(`nothing central: no Firebase and no Google Play services (${note})`);
}
