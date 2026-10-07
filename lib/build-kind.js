// build-kind: what kind of build this tree is. A checkout says "development"; scripts/build-site.sh stamps "release" into the copy it packs, so it is part of the signed
// package (SHA256SUMS covers vyre.tgz). Anything other than the exact word "development", a missing file included, means a packaged build (kernel/devbuild.js).
export const BUILD_KIND = "development";
