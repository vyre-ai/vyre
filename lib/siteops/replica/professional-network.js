// @ts-check
// A replica of a professional network's web app, for the tests of the LinkedIn site kit: NOT the real site and nothing of its data, but the same awkward SHAPES the real one has, so that
// learning from two examples and reading twenty profiles nobody showed it is a fair trial:
//   - the page's own data calls are GraphQL-style GETs with RestLi parentheses in the query (variables=(vanityName:ada-lovelace-3)) and a queryId whose hash a deploy rotates;
//   - a CSRF token that is the page's JSESSIONID cookie, quoted, sent back as a header;
//   - a page-instance header that is different on every page load (a nonce the server never checks);
//   - answers that vary: a profile with no current position, one with three, a different order of the sections included, an empty summary;
//   - search results nested in clusters, an inbox, a message that is sent by POST, an invitation, a profile that does not exist, and a checkpoint (a security check) that can be switched on.
// It is a real HTTP server on 127.0.0.1, so the operation is replayed over a real socket.

import http from "node:http";
import crypto from "node:crypto";

const FIRST = ["Ada", "Grace", "Alan", "Edsger", "Barbara", "Donald", "Margaret", "Tim", "Radia", "Linus", "Katherine", "Dennis", "Frances", "Ken", "Hedy", "John", "Sophie", "Claude", "Mary", "Niklaus"];
const LAST = ["Lovelace", "Hopper", "Turing", "Dijkstra", "Liskov", "Knuth", "Hamilton", "Berners", "Perlman", "Torvalds", "Johnson", "Ritchie", "Allen", "Kay", "Lamarr", "McCarthy", "Wilson", "Shannon", "Jackson", "Wirth"];
const TITLES = ["Estate planning attorney", "Probate paralegal", "Managing partner", "Legal operations lead", "Associate attorney", "Intake specialist", "Of counsel", "Marketing director"];
const FIRMS = ["Harlow Legal", "Fairview Law Group", "Summit Estate Counsel", "Lakeside Family Law", "Cedar & Pine LLP", "Northgate Probate"];
const PLACES = ["Sacramento, California", "Austin, Texas", "Raleigh, North Carolina", "Phoenix, Arizona", "Denver, Colorado", "Atlanta, Georgia"];

/** Deterministic members: slug, names, headline, place, and a varying number of positions. */
export function members(n = 40) {
  return Array.from({ length: n }, (_, i) => {
    const first = FIRST[i % FIRST.length], last = LAST[(i * 7 + 3) % LAST.length];
    const slug = `${first}-${last}-${(1000 + i * 37).toString(36)}`.toLowerCase();
    const positions = i % 5 === 0 ? [] : Array.from({ length: 1 + (i % 3) }, (_, k) => ({ title: TITLES[(i + k) % TITLES.length], companyName: FIRMS[(i + k * 2) % FIRMS.length], current: k === 0 }));
    return { id: `ACoAA${crypto.createHash("sha256").update(slug).digest("base64url").slice(0, 28)}`, slug, firstName: first, lastName: last, headline: `${TITLES[i % TITLES.length]} at ${FIRMS[i % FIRMS.length]}`,
      locationName: PLACES[i % PLACES.length], summary: i % 4 === 0 ? "" : `${first} helps families plan ahead. Based in ${PLACES[i % PLACES.length]}.`, positions };
  });
}

/**
 * @param {{ csrf?: string, hash?: string }} [o]
 * @returns {Promise<{ url: string, origin: string, members: ReturnType<typeof members>, state: { sent: any[], invited: any[], hash: string, checkpoint: boolean, requests: number }, session: { cookie: string, csrf: string }, close: () => Promise<void> }>}
 */
export async function startReplica(o = {}) {
  const all = members();
  const csrf = o.csrf || `ajax:${crypto.randomInt(1e12, 9e12)}`;
  const state = { sent: /** @type {any[]} */ ([]), invited: /** @type {any[]} */ ([]), hash: o.hash || "9c1e5a77d0b3f2e8a4c6d1b07e3f5a92", checkpoint: false, requests: 0 };
  const inbox = [{ entityUrn: "urn:li:fs_conversation:2-aaa", lastActivityAt: 1760000000000, participants: [all[3].id], preview: "Thanks for connecting" }, { entityUrn: "urn:li:fs_conversation:2-bbb", lastActivityAt: 1760100000000, participants: [all[5].id], preview: "Can we talk Tuesday?" }];
  const json = (/** @type {http.ServerResponse} */ res, /** @type {number} */ status, /** @type {any} */ body) => { res.writeHead(status, { "content-type": "application/vnd.linkedin.normalized+json+2.1" }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    state.requests++;
    const u = new URL(req.url || "/", "http://x");
    const cookieCsrf = /JSESSIONID="?([^";]+)"?/.exec(String(req.headers.cookie || ""))?.[1];
    if (state.checkpoint && u.pathname !== "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return void res.end(`<html><head><title>Security Verification | Network</title></head><body><a href="/checkpoint/challenge/AgE1c2VyIn0">Let's do a quick security check</a></body></html>`);
    }
    if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html", "set-cookie": `JSESSIONID="${csrf}"; Path=/` }); return void res.end("<html>feed</html>"); }
    let m;
    if ((m = /^\/in\/([^/]+)\/?$/.exec(u.pathname))) { res.writeHead(200, { "content-type": "text/html" }); return void res.end(`<html><title>${m[1]}</title><div id="app"></div></html>`); }
    // every API call needs the csrf header to equal the cookie
    if (u.pathname.startsWith("/voyager/")) {
      if (req.headers["csrf-token"] !== csrf || cookieCsrf !== csrf) return json(res, 403, { status: 403, message: "CSRF check failed." });
    }
    if (u.pathname === "/voyager/api/graphql" && req.method === "GET") {
      const q = u.searchParams.get("queryId") || "", vars = u.searchParams.get("variables") || "";
      if (!q.endsWith(state.hash)) return json(res, 400, { errors: [{ message: "PersistedQueryNotFound" }], data: null });
      if (q.startsWith("voyagerIdentityDashProfiles.")) {
        const slug = /vanityName:([^,)]+)/.exec(vars)?.[1];
        const p = all.find(x => x.slug === slug);
        if (!p) return json(res, 404, { status: 404, message: "Profile not found" });
        return json(res, 200, { data: { identityDashProfilesByMemberIdentity: { elements: [{ entityUrn: `urn:li:fsd_profile:${p.id}`, publicIdentifier: p.slug, firstName: p.firstName, lastName: p.lastName, headline: p.headline, locationName: p.locationName,
          ...(p.summary ? { summary: p.summary } : {}), connectionDegree: "DISTANCE_2", positionCount: p.positions.length }] } },
          included: p.positions.map((x, k) => ({ $type: "com.linkedin.voyager.dash.identity.profile.Position", entityUrn: `urn:li:fsd_position:${p.id}-${k}`, title: x.title, companyName: x.companyName, current: x.current })).reverse() });
      }
      if (q.startsWith("voyagerSearchDashClusters.")) {
        const kw = /keywords:([^,)]+)/.exec(vars)?.[1] || "";
        const hits = all.filter(p => `${p.firstName} ${p.lastName} ${p.headline}`.toLowerCase().includes(decodeURIComponent(kw).toLowerCase().replace(/\+/g, " "))).slice(0, 10);
        return json(res, 200, { data: { searchDashClustersByAll: { elements: [{ items: hits.map(p => ({ item: { entityResult: { title: { text: `${p.firstName} ${p.lastName}` }, primarySubtitle: { text: p.headline }, navigationUrl: `https://www.example-network.test/in/${p.slug}` } } })) }] } } });
      }
      return json(res, 404, { status: 404 });
    }
    if (u.pathname === "/voyager/api/messaging/conversations" && req.method === "GET") return json(res, 200, { elements: inbox, paging: { count: inbox.length, start: 0 } });
    if (u.pathname === "/voyager/api/voyagerMessagingDashMessengerMessages" && req.method === "POST") {
      let raw = ""; for await (const c of req) raw += c;
      const b = JSON.parse(raw || "{}");
      state.sent.push(b);
      return json(res, 201, { value: { messageUrn: `urn:li:msg_message:${state.sent.length}`, sent: true } });
    }
    if (u.pathname === "/voyager/api/growth/normInvitations" && req.method === "POST") {
      let raw = ""; for await (const c of req) raw += c;
      state.invited.push(JSON.parse(raw || "{}"));
      return json(res, 201, { value: { invitationUrn: `urn:li:fsd_invitation:${state.invited.length}` } });
    }
    json(res, 404, { status: 404, message: "no such route" });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const origin = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  return { url: origin, origin, members: all, state, session: { cookie: `JSESSIONID="${csrf}"; lang=v=2&lang=en-us; bcookie="v=2&abc"`, csrf }, close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); }) };
}

/** The request the replica's own page makes to read a profile, as the page builds it (a fresh page-instance every load). @param {string} origin @param {string} slug @param {string} csrf @param {string} hash */
export const profileCall = (origin, slug, csrf, hash) => ({
  method: "GET",
  url: `${origin}/voyager/api/graphql?includeWebMetadata=true&variables=(vanityName:${slug})&queryId=voyagerIdentityDashProfiles.${hash}`,
  headers: { accept: "application/vnd.linkedin.normalized+json+2.1", "csrf-token": csrf, "x-li-lang": "en_US", "x-li-page-instance": `urn:li:page:d_flagship3_profile_view_base;${crypto.randomBytes(12).toString("base64")}`, "x-restli-protocol-version": "2.0.0" },
});
/** The search call. @param {string} origin @param {string} keywords @param {string} csrf @param {string} hash */
export const searchCall = (origin, keywords, csrf, hash) => ({
  method: "GET",
  url: `${origin}/voyager/api/graphql?includeWebMetadata=true&variables=(start:0,origin:GLOBAL_SEARCH_HEADER,query:(keywords:${encodeURIComponent(keywords)},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE)))))&queryId=voyagerSearchDashClusters.${hash}`,
  headers: { accept: "application/vnd.linkedin.normalized+json+2.1", "csrf-token": csrf, "x-li-lang": "en_US", "x-li-page-instance": `urn:li:page:d_flagship3_search_srp_people;${crypto.randomBytes(12).toString("base64")}`, "x-restli-protocol-version": "2.0.0" },
});
