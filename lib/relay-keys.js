// @ts-check
// The relay's public keys, pinned in the release the way the release-signing key is pinned (core/vyre-core/release.js). A space needs nothing configured per space.
// RELAY_ASSERT_KEY is the Ed25519 public key (base64url, 32 bytes) whose private half is the relay's secret GITHUB_ASSERT_KEY, held only in the relay's Worker secrets. It is empty until the owner
// generates the pair at deploy and commits the public half in a release; while it is empty no GitHub assertion verifies, so GitHub sign-in to a space is refused, never trusted.
// `github.assertKey` in a box's config replaces it, for a development relay and for tests.

/** @type {string} */
export const RELAY_ASSERT_KEY = "";
