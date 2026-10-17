// @ts-check
// The spaces module entry. The body stays in index.js. This file registers the Create step's install name after that body starts, so index.js does not grow.

import spaces from "./index.js";
import { registerPairInstall } from "./pair-install.js";

export default {
  async start(/** @type {any} */ ctx) {
    const handle = await spaces.start(ctx);
    registerPairInstall(ctx);
    return handle;
  },
};
