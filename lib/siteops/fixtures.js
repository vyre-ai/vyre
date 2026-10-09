// @ts-check
// fixtures: a fake website's traffic, for the tests of lib/siteops. Each `page*` function is what the site's own frontend sends and receives when it is triggered with one input, in the
// Exchange shape learn.js reads. Nothing here touches a network; the secrets are made-up strings that the tests then search for in every artifact.

export const SECRET_COOKIE = "sess-Zx81QpLm20vNcR7tYbWk3Hd5";
export const CSRF = "csrf-Ab12Cd34Ef56Gh78Ij90Kl12Mn34";
export const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

/** @param {number} id @param {any} req @param {any} body @param {number} [status] */
const ex = (id, req, body, status = 200) => ({
  id, resourceType: "fetch",
  request: { method: "GET", headers: { accept: "application/json", cookie: `sid=${SECRET_COOKIE}; theme=dark` }, ...req },
  response: { status, headers: { "content-type": "application/json" }, contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) },
});

const noise = [
  { id: 900, resourceType: "script", request: { method: "GET", url: "https://app.example.com/static/app.js", headers: {} }, response: { status: 200, headers: { "cache-control": "public, immutable" }, contentType: "text/javascript", body: "/* bundle */" } },
  { id: 901, resourceType: "fetch", request: { method: "POST", url: "https://app.example.com/collect", headers: {}, body: "{}" }, response: { status: 200, headers: {}, contentType: "application/json", body: "{}" } },
];

/** @param {string} term */
const people = term => ({ total: 3, results: [
  { id: "p-1001", name: `${term} one`, profileUrl: `https://app.example.com/in/${term}-one`, headline: "Engineer", meta: { score: 0.9, tags: ["a", "b"] } },
  { id: "p-1002", name: `${term} two`, profileUrl: `https://app.example.com/in/${term}-two`, headline: "Designer", meta: { score: 0.7, tags: ["c"] } },
  { id: "p-1003", name: `${term} three`, profileUrl: `https://app.example.com/in/${term}-three`, headline: "Lawyer", meta: { score: 0.5, tags: [] } },
] });

/** A REST search with a csrf header kept in the page's storage and a cookie, and a constant page size. @param {string} term @param {string} [nonce] */
export function pageRest(term, nonce) {
  return [...noise, ex(1, {
    url: `https://app.example.com/api/v2/search?q=${encodeURIComponent(term)}&limit=20&_=1700000000${nonce ? "123" : "000"}`,
    headers: { accept: "application/json", "x-csrf-token": CSRF, cookie: `sid=${SECRET_COOKIE}; theme=dark`, ...(nonce ? { "x-sig": nonce } : {}) },
  }, people(term))];
}
export const restStorage = { csrf: CSRF };

/** GraphQL with a persisted-query hash that a deploy rotates. @param {string} term @param {string} [hash] */
export function pageGraphql(term, hash = "a".repeat(8) + "9f3c1d7b2e4a6c8d0f1e3b5a7c9d2e4f6a8b0c1d3e5f7a9b2c4d6e8f0a1b3") {
  return [...noise, ex(1, {
    method: "POST", url: "https://app.example.com/graphql",
    headers: { "content-type": "application/json", cookie: `sid=${SECRET_COOKIE}` },
    body: JSON.stringify({ operationName: "SearchPeople", variables: { query: term, first: 10 }, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
  }, { data: { searchPeople: { edges: people(term).results.map(r => ({ node: r })) } } })];
}

/** A Google-style batch call: the input sits inside JSON inside a JSON string inside a form field. @param {string} term */
export function pageBatch(term) {
  const inner = JSON.stringify([term, null, 10]);
  const outer = JSON.stringify([[["wXbhsf", inner, null, "generic"]]]);
  return [...noise, ex(1, {
    method: "POST", url: "https://app.example.com/_/batchexecute?rpcids=wXbhsf&hl=en",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", cookie: `sid=${SECRET_COOKIE}` },
    body: `f.req=${encodeURIComponent(outer)}&at=${encodeURIComponent("AT-" + CSRF)}&`,
  }, `)]}'\n\n${JSON.stringify([["wrb.fr", "wXbhsf", JSON.stringify([people(term).results.map(r => [r.id, r.name])])]])}`)];
}

/** A write: the page's Send button posts a message. The request was ABORTED before it left (write learning). @param {string} to @param {string} text */
export function pageSend(to, text) {
  return [{ id: 1, resourceType: "fetch", aborted: true, request: {
    method: "POST", url: "https://app.example.com/api/v2/messages", headers: { "content-type": "application/json", "x-csrf-token": CSRF, cookie: `sid=${SECRET_COOKIE}` },
    body: JSON.stringify({ recipient: to, body: text, channel: "direct" }) } }];
}
