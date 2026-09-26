// @ts-check
// mattermost — the few Mattermost v4 REST calls Chat needs, over fetch.
//
// The client takes `getToken`, an async function, never a token. The prototype learned this the
// hard way (channels.cjs): a token passed in an options object rides beside `channel` and
// `message`, which are exactly what a caller logs when a post fails, so the object is shaped to
// be logged with a credential inside it. With a thunk the value exists only inside `req`'s own
// frame, is fetched from the Vault per call, and never reaches an error message or a log line.
//
// Errors name the method, the path and Mattermost's own message. They never carry a header.

/**
 * @typedef {{ id: string, channel_id: string, user_id: string, root_id: string, message: string, type: string,
 *   create_at: number, update_at: number, props?: any }} Post
 */

/**
 * @param {{ base: string, getToken: () => Promise<string>, fetch?: typeof fetch, timeoutMs?: number }} o
 */
export function client({ base, getToken, fetch: f = globalThis.fetch, timeoutMs = 15000 }) {
  if (typeof getToken !== "function") throw new Error("the Mattermost client needs getToken, not a token");
  const root = String(base || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(root)) throw new Error("chat.url must be an http or https address");

  /**
   * @param {string} method @param {string} path @param {any} [body]
   * @param {{ missingOk?: boolean }} [o]
   */
  async function req(method, path, body, { missingOk = false } = {}) {
    const token = await getToken();
    if (typeof token !== "string" || !token) throw new Error("no Mattermost bot token: put it in the vault as chat-bot-token and grant it to chat");
    let res;
    try {
      res = await f(root + "/api/v4" + path, {
        method,
        headers: { authorization: "Bearer " + token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const why = /** @type {any} */ (e)?.name === "TimeoutError" ? `no answer within ${timeoutMs} ms` : (/** @type {any} */ (e)?.cause?.code || /** @type {Error} */ (e).message);
      throw new Error(`Mattermost did not answer ${method} ${path} (${why})`);
    }
    const text = await res.text();
    if (res.status === 404 && missingOk) return null;
    if (res.status >= 400) {
      let msg = text.slice(0, 200);
      try { msg = JSON.parse(text).message || msg; } catch {}
      throw new Error(`Mattermost ${res.status} on ${method} ${path}: ${msg}`);
    }
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  }

  const enc = encodeURIComponent;
  return {
    /** The bot itself. */
    me: () => req("GET", "/users/me"),
    /** @param {string} name */
    team: name => req("GET", `/teams/name/${enc(name)}`),
    /** @param {string} username */
    user: username => req("GET", `/users/username/${enc(username)}`),
    /** A channel by name, or null. @param {string} teamId @param {string} name */
    channelByName: (teamId, name) => req("GET", `/teams/${enc(teamId)}/channels/name/${enc(name)}`, undefined, { missingOk: true }),
    /** @param {{ team_id: string, name: string, display_name: string, type?: "O"|"P", purpose?: string }} c */
    createChannel: c => req("POST", "/channels", { type: "O", ...c }),
    /** @param {string} channelId @param {string} userId */
    addMember: (channelId, userId) => req("POST", `/channels/${enc(channelId)}/members`, { user_id: userId }),
    /** @param {{ channel_id: string, message: string, root_id?: string, props?: any }} p @returns {Promise<Post>} */
    post: p => req("POST", "/posts", p),
    /** @param {string} id @param {{ message?: string, props?: any }} patch */
    patch: (id, patch) => req("PUT", `/posts/${enc(id)}/patch`, patch),
    /**
     * Posts created or changed in a channel since a time (ms), oldest first.
     * @param {string} channelId @param {number} since @returns {Promise<Post[]>}
     */
    postsSince: async (channelId, since) => {
      const r = await req("GET", `/channels/${enc(channelId)}/posts?since=${Math.max(0, Math.trunc(since))}`);
      const posts = r && r.posts ? Object.values(r.posts) : [];
      return /** @type {Post[]} */ (posts).sort((a, b) => a.create_at - b.create_at);
    },
  };
}
