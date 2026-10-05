// The app's version, from the one place a release moves it: the repo's package.json (scripts/bump-version.mjs). app.json carries a placeholder; app.config.js applies this.
// iOS wants a dotted number for the short version (no "-rc.1"), Android keeps the full name and needs an integer versionCode that rises with the release.
/** @param {string} version "0.2.9" or "0.3.0-rc.2" @returns {{ name: string, short: string, code: number }} */
function appVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(version));
  if (!m) throw new Error(`${version} is not a release version (1.2.3 or 1.2.3-rc.1)`);
  const [major, minor, patch] = [m[1], m[2], m[3]].map(Number);
  if (minor > 99 || patch > 99) throw new Error("the version code allows a minor and a patch up to 99");
  // A release candidate of 0.3.0 must sort below 0.3.0 itself: the code ends in 0 for a candidate and in 1 for the release, so its ordinal never reaches the next patch.
  const rc = /-rc\.(\d+)$/.exec(String(version));
  const tail = String(version).includes("-") ? Math.min(Number(rc ? rc[1] : 0), 8) : 9;
  return { name: String(version), short: `${major}.${minor}.${patch}`, code: major * 1_000_000 + minor * 10_000 + patch * 100 + tail * 10 };
}
module.exports = { appVersion };
