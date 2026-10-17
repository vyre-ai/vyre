// @ts-check
// The relay's public keys, pinned in the release the way the release-signing key is pinned (core/vyre-core/release.js). A space needs nothing configured per space.
// RELAY_ASSERT_KEY is the Ed25519 public key (base64url, 32 bytes) whose private half is the relay's secret GITHUB_ASSERT_KEY, held only in the relay's Worker secrets. It is set: the owner generated
// the pair for 0.5.3 and the private half lives only in the deploy environment secret GH_ASSERT_KEY, which relay-deploy.yml sets on the relay as GITHUB_ASSERT_KEY.
// `github.assertKey` in a box's config replaces it, for a development relay and for tests.

/** @type {string} */
export const RELAY_ASSERT_KEY = "jWJtrkCW2MFtb-Hcp5O_ij31JMvBt1VTJI9lZ9AcoKc";
