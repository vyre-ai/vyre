# What the kernel may import

The kernel is code every other part of Vyre trusts for hashes, macs, ids and the audit chain, and the same files run on a server, a phone and a browser. So it imports almost nothing.

Allowed:

- Node's own modules (`node:...`), in files that only ever run on a server (the sealing process, the sqlite store).
- `lib/databox.js` (the one place the data boxes, HKDF, HMAC and hashes are made).
- The pinned noble packages, at these exact versions and no others: `@noble/hashes` 1.8.0, `@noble/ciphers` 1.3.0, `@noble/curves` 1.9.7. They are the audited pure-JS crypto that `lib/databox.js` and `lib/keywrap.js` use. There is one resolved copy: the root `package.json`, `apps/app/package.json` and `apps/app/package-lock.json` all carry these exact versions, with the lockfile's integrity hashes.

Outside the kernel, one more package is allowed in the shipped build: `yaml` 2.9.1, for reading an API description given as YAML (`records/connectors/import-spec.js`, loaded lazily, with the core schema and no custom tags). The kernel never imports it, and `kernel/dependencies.test.js` still fails on any bare import under `kernel/`.

One more is allowed in the shipped build, also outside the kernel: `esbuild-wasm` 0.28.2, for turning a preview's `.jsx`, `.tsx` or `.ts` file into JavaScript a browser runs (`core/previews/jsx.js`, loaded lazily, transform only: it bundles nothing, resolves no packages and reads no files). It is the WebAssembly build, so there is one portable package and no native binary per platform. The kernel never imports it, and `kernel/dependencies.test.js` still fails on any bare import under `kernel/`.

The libraries a React preview may import are not dependencies of the server. They are browser code, built once by `core/previews/vendor-src/build.mjs` from exact versions in its own `package.json` and lockfile (react and react-dom 18.3.1, recharts 2.15.0, lucide-react 0.263.1, d3 7.9.0, lodash 4.17.21, papaparse 5.4.1, mathjs 12.4.2, three 0.160.0, chart.js 4.4.3, date-fns 3.6.0, xlsx 0.18.5, and Tailwind's in-browser build, `@tailwindcss/browser` 4.1.11). The built files are committed under `core/previews/vendor/` with the sha256 of each in `manifest.json`; the box serves them from `/__vyre/lib/` and checks a file against its hash before serving it, so a browser never fetches code from a third party, a box with no internet runs the same page, and nothing a CDN changes can change what runs. An import outside this set gets a plain message on the page. Adding or bumping one is a rebuild and a reviewed diff of the manifest, not a runtime fetch.

Everything else outside the repo is refused. `kernel/dependencies.test.js` fails on any other bare import under `kernel/` (outside tests) and on a version that is not exact or that differs between the root and the app.

Ruled by team-lead, 5 Oct 2026, from the one-crypto ruling (36e4dfd). Changing this list is a ruling, not an edit.
