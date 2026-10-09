# What the kernel may import

The kernel is code every other part of Vyre trusts for hashes, macs, ids and the audit chain, and the same files run on a server, a phone and a browser. So it imports almost nothing.

Allowed:

- Node's own modules (`node:...`), in files that only ever run on a server (the sealing process, the sqlite store).
- `lib/databox.js` (the one place the data boxes, HKDF, HMAC and hashes are made).
- The pinned noble packages, at these exact versions and no others: `@noble/hashes` 1.8.0, `@noble/ciphers` 1.3.0, `@noble/curves` 1.9.7. They are the audited pure-JS crypto that `lib/databox.js` and `lib/keywrap.js` use. There is one resolved copy: the root `package.json`, `apps/app/package.json` and `apps/app/package-lock.json` all carry these exact versions, with the lockfile's integrity hashes.

Outside the kernel, one more package is allowed in the shipped build: `yaml` 2.9.1, for reading an API description given as YAML (`records/connectors/import-spec.js`, loaded lazily, with the core schema and no custom tags). The kernel never imports it, and `kernel/dependencies.test.js` still fails on any bare import under `kernel/`.

One more is allowed in the shipped build, also outside the kernel: `esbuild-wasm` 0.28.2, for turning a preview's `.jsx`, `.tsx` or `.ts` file into JavaScript a browser runs (`core/previews/jsx.js`, loaded lazily, transform only: it bundles nothing, resolves no packages and reads no files). It is the WebAssembly build, so there is one portable package and no native binary per platform. The kernel never imports it, and `kernel/dependencies.test.js` still fails on any bare import under `kernel/`.

Everything else outside the repo is refused. `kernel/dependencies.test.js` fails on any other bare import under `kernel/` (outside tests) and on a version that is not exact or that differs between the root and the app.

Ruled by team-lead, 5 Oct 2026, from the one-crypto ruling (36e4dfd). Changing this list is a ruling, not an edit.
