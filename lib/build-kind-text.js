// build-kind-text: the one place that says what lib/build-kind.js reads in each kind of build. kernel/devbuild.js (the text path of isPackaged) and
// scripts/stamp-build-kind.mjs (what build-site.sh runs) both use these, so the stamp and the check cannot drift apart (DP-1).
export const DEV_LINE = 'export const BUILD_KIND = "development";';
export const RELEASE_LINE = 'export const BUILD_KIND = "release";';
