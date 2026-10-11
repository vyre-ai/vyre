// @ts-check
// Does a launch carry a credential PICKED for it (a vault token or key in the launch's environment, or a fallback key)? Which variables hold a provider's token is the provider's own knowledge, so it lives
// here in the adapters' folder and the Switchboard asks (core/sessions/providers.js re-exports it).

/** @param {any} env */
const holds = (env) => Boolean(env && typeof env === "object" && (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY));

/** @param {{ env?: any, fallback?: any }} launch @returns {boolean} */
export function carriesPickedCredential(launch) {
  return holds(launch && launch.env) || holds(launch && launch.fallback && launch.fallback.env);
}
