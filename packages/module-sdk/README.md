# @vyre/module-sdk

Everything an outside author needs to write a Vyre module against module API 1
([ADR 0033](../../docs/adr/0033-hackable-vyre.md)):

- `index.d.ts`: the manifest and the `ctx` a module's `start(ctx)` receives. Members tagged
  `@internal` are for Vyre's own modules and may change in any release. Members tagged `@planned`
  are part of module API 1 but not built yet; test for them with `ctx.api.has()`.
- `manifest.schema.json`: the one definition of `module.json`. Point your manifest's `$schema` at
  it for editor help.
- `manifest.js`: `checkManifest(manifest)` returns a list of problems, empty when the manifest is
  valid. It has no dependencies.

```js
// @ts-check
/** @type {import("@vyre/module-sdk").Module} */
export default {
  async start(ctx) {
    ctx.tool("bakery.orders", {
      description: "Today's Northwind Bakery orders",
      input: { type: "object", properties: {} },
      run: async () => ({ count: 12 }),
    });
    return { async stop() {} };
  },
};
```

The package isn't on npm yet: it publishes with Vyre's first npm release. Until then, reference it
from a checkout of the Vyre repo. `vyre module check` runs `checkManifest()` from the CLI, and
`vyre module new` scaffolds a module that passes it. A test harness (`@vyre/module-sdk/testing`)
comes in phase 3 of the ADR.
