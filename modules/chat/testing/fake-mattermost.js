// @ts-check
// A fake Mattermost for tests: the v4 endpoints Chat uses, in memory, over real HTTP.
//
// It records every call (method, path, whether the bearer matched) so a test can assert on what
// Chat did, and it can act as a person: post as a user, press a button on a post (posting the
// button's integration context to its url, as the real server does), submit a dialog Chat opened
// and run a slash command. Nothing here talks to a real server; the users are the fictional world.

import http from "node:http";
import crypto from "node:crypto";

const rid = () => crypto.randomBytes(13).toString("hex").slice(0, 26);

/**
 * @param {{ token: string, team?: string, users?: string[] }} o
 */
export async function fakeMattermost({ token, team = "vyre", users = ["alex", "sam"] }) {
  let clock = Date.now();
  const tick = () => (clock = Math.max(clock + 1, Date.now()));
  const bot = { id: rid(), username: "vyre-bot" };
  /** @type {Map<string, { id: string, username: string }>} */
  const people = new Map(users.map(u => [u, { id: rid(), username: u }]));
  const teamRec = { id: rid(), name: team };
  /** @type {Map<string, any>} */ const channels = new Map();
  /** @type {Map<string, any>} */ const posts = new Map();
  /** @type {{ channel: string, user: string }[]} */ const members = [];
  /** @type {{ trigger_id: string, url: string, dialog: any }[]} */ const dialogs = [];
  /** Trigger ids handed out with presses and not yet used: the real server opens a dialog only for one. */
  const triggers = new Set();
  /** @type {{ method: string, path: string, authed: boolean, body: any }[]} */ const calls = [];

  const makePost = (user_id, p) => {
    const at = tick();
    const post = { id: rid(), channel_id: p.channel_id, user_id, root_id: p.root_id || "", message: p.message || "", type: "",
      props: p.props || {}, create_at: at, update_at: at };
    posts.set(post.id, post);
    return post;
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch {}
    const url = new URL(req.url || "/", "http://mm");
    const authed = req.headers.authorization === "Bearer " + token;
    calls.push({ method: String(req.method), path: url.pathname + url.search, authed, body });
    const send = (status, b) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (!authed) return send(401, { message: "Invalid or expired session" });
    const p = url.pathname.replace(/^\/api\/v4/, "");
    let m;
    if (req.method === "GET" && p === "/users/me") return send(200, bot);
    if (req.method === "GET" && (m = /^\/teams\/name\/([^/]+)$/.exec(p))) return decodeURIComponent(m[1]) === teamRec.name ? send(200, teamRec) : send(404, { message: "team not found" });
    if (req.method === "GET" && (m = /^\/users\/username\/([^/]+)$/.exec(p))) {
      const u = people.get(decodeURIComponent(m[1]));
      return u ? send(200, u) : send(404, { message: "user not found" });
    }
    if (req.method === "GET" && (m = /^\/teams\/([^/]+)\/channels\/name\/([^/]+)$/.exec(p))) {
      const c = [...channels.values()].find(x => x.team_id === m[1] && x.name === decodeURIComponent(m[2]));
      return c ? send(200, c) : send(404, { message: "channel not found" });
    }
    if (req.method === "POST" && p === "/channels") {
      if ([...channels.values()].some(x => x.name === body.name)) return send(400, { message: "a channel with that name already exists" });
      const c = { id: rid(), team_id: body.team_id, name: body.name, display_name: body.display_name, type: body.type, purpose: body.purpose || "" };
      channels.set(c.id, c);
      return send(201, c);
    }
    if (req.method === "POST" && (m = /^\/channels\/([^/]+)\/members$/.exec(p))) {
      members.push({ channel: m[1], user: body.user_id });
      return send(201, { channel_id: m[1], user_id: body.user_id });
    }
    if (req.method === "POST" && p === "/posts") {
      if (!channels.has(body.channel_id)) return send(400, { message: "no such channel" });
      if (String(body.message || "").length > 16383) return send(400, { message: "message too long" });
      return send(201, makePost(bot.id, body));
    }
    if (req.method === "PUT" && (m = /^\/posts\/([^/]+)\/patch$/.exec(p))) {
      const post = posts.get(m[1]);
      if (!post) return send(404, { message: "post not found" });
      if (body.message !== undefined) post.message = body.message;
      if (body.props !== undefined) post.props = body.props;
      post.update_at = tick();
      return send(200, post);
    }
    if (req.method === "GET" && (m = /^\/channels\/([^/]+)\/posts$/.exec(p))) {
      const since = Number(url.searchParams.get("since") || 0);
      const list = [...posts.values()].filter(x => x.channel_id === m[1] && x.update_at > since);
      return send(200, { order: list.map(x => x.id), posts: Object.fromEntries(list.map(x => [x.id, x])) });
    }
    if (req.method === "POST" && p === "/actions/dialogs/open") {
      if (!body || !triggers.delete(body.trigger_id)) return send(400, { message: "trigger_id is missing, used or expired" });
      if (!body.url || !body.dialog || !Array.isArray(body.dialog.elements)) return send(400, { message: "a dialog needs a url and elements" });
      dialogs.push(body);
      return send(200, { status: "OK" });
    }
    send(404, { message: `no route ${req.method} ${p}` });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const a = /** @type {import("node:net").AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${a.port}`;

  const userId = name => { const u = people.get(name); if (!u) throw new Error(`no fake user ${name}`); return u.id; };
  const postJson = async (url, payload) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    let b = null; try { b = await r.json(); } catch {}
    return { status: r.status, body: b };
  };

  return {
    base, bot, team: teamRec, calls, posts, channels, members, dialogs,
    userId,
    /** @param {string} name */
    channel: name => [...channels.values()].find(c => c.name === name) || null,
    /** Posts in a channel, oldest first. @param {string} channelId */
    postsIn: channelId => [...posts.values()].filter(p => p.channel_id === channelId).sort((x, y) => x.create_at - y.create_at),
    /** Post as a person. @param {string} user @param {{ channel_id: string, message: string, root_id?: string }} p */
    say: (user, p) => makePost(userId(user), p),
    /**
     * Press a button on a post as a person, the way Mattermost does: POST its integration url
     * with the context, the user and a fresh trigger id.
     * @param {string} postId @param {string} actionId @param {string} user
     */
    press: async (postId, actionId, user) => {
      const post = posts.get(postId);
      const action = post && (post.props.attachments || []).flatMap(x => x.actions || []).find(x => x.id === actionId);
      if (!action) throw new Error(`post ${postId} has no button ${actionId}`);
      const trigger_id = rid();
      triggers.add(trigger_id);
      return postJson(action.integration.url, { user_id: userId(user), post_id: postId, channel_id: post.channel_id, trigger_id, context: action.integration.context });
    },
    /**
     * Submit an opened dialog as a person, the way Mattermost does: POST its url with the state it
     * was opened with and what was typed. Fields left out of `submission` keep their defaults.
     * @param {{ url: string, dialog: any }} d @param {Record<string, string>} submission @param {string} user
     * @param {{ state?: string, cancelled?: boolean }} [o] a different state, to forge one
     */
    submit: (d, submission, user, o = {}) => {
      const filled = Object.fromEntries(d.dialog.elements.map(e => [e.name, e.default ?? ""]));
      return postJson(d.url, { type: "dialog_submission", callback_id: d.dialog.callback_id, state: o.state ?? d.dialog.state, user_id: userId(user),
        submission: { ...filled, ...submission }, cancelled: Boolean(o.cancelled) });
    },
    /** Run a slash command as a person. @param {string} url @param {{ token: string, user: string, text: string, channel_id?: string }} o */
    slash: async (url, o) => {
      const form = new URLSearchParams({ token: o.token, user_id: userId(o.user), text: o.text, channel_id: o.channel_id || "", command: "/vyre" });
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
      let b = null; try { b = await r.json(); } catch {}
      return { status: r.status, body: b };
    },
    close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); }),
  };
}
