// @ts-check
// buildkind: moved to lib/release-build.js so a part that is not Wink can ask "is this a release build?" without importing Wink. Kept as the name Wink's own files import.
export { isReleaseBuild, devKindSwitch } from "../../lib/release-build.js";
