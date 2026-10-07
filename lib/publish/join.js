// @ts-check
// lib/publish/join.js: the page behind a join link, https://<space>.vyre.run/join/<token>. One static page, the same for every space, served by the edge's own Caddy (no server behind it,
// nothing to deploy). It shows nothing the link does not already say: the space is the host, and what the invite offers (role, what you will see) is shown by the Vyre app after it
// checks the link, never by this page. The token stays in the address bar: the page sends it nowhere (no request, no referrer, no storage) and only hands the whole link to the app
// through the `vyre://join` link the app registers.

/** The page. No external script, style, font or image: a strict Content-Security-Policy (see JOIN_CSP) allows only this page's own inline code. */
export function joinPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>Join on Vyre</title>
<style>
:root { color-scheme: light dark; --bg: #f6f5f1; --fg: #1c1b19; --mute: #67645c; --line: #d9d6cc; --ink: #1c1b19; --on-ink: #f6f5f1; }
@media (prefers-color-scheme: dark) { :root { --bg: #151513; --fg: #efede6; --mute: #a4a096; --line: #34322e; --ink: #efede6; --on-ink: #151513; } }
html, body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 30rem; margin: 0 auto; padding: 4rem 1rem 3rem; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 .75rem; overflow-wrap: anywhere; }
p { margin: 0 0 1rem; color: var(--mute); }
a.go { display: inline-block; background: var(--ink); color: var(--on-ink); padding: .8rem 1.25rem; border-radius: .6rem; text-decoration: none; font-weight: 600; }
button { font: inherit; background: none; color: var(--fg); border: 1px solid var(--line); padding: .6rem 1rem; border-radius: .6rem; cursor: pointer; }
.row { display: flex; gap: .75rem; flex-wrap: wrap; align-items: center; margin: 1.25rem 0 2rem; }
small { color: var(--mute); }
a { color: inherit; }
</style>
</head>
<body>
<main>
<h1 id="title">You have been invited</h1>
<p>Open this invitation in the Vyre app. The app checks it and shows what you will be able to see before you join.</p>
<div class="row">
<a class="go" id="open" href="#">Open in Vyre</a>
<button id="copy" type="button">Copy link</button>
</div>
<p><small>Do not have Vyre yet? Get it at <a href="https://vyre.run">vyre.run</a>, then open this link again.</small></p>
</main>
<script>
(function () {
  var link = location.href.split("#")[0];
  document.getElementById("title").textContent = "Join " + location.hostname;
  document.title = "Join " + location.hostname;
  document.getElementById("open").href = "vyre://join?link=" + encodeURIComponent(link);
  var b = document.getElementById("copy");
  b.addEventListener("click", function () {
    var done = function () { b.textContent = "Copied"; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, function () {});
  });
})();
</script>
</body>
</html>
`;
}

/** The Content-Security-Policy for the page: its own inline style and script, nothing fetched, nothing framed, no form. */
export const JOIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** Where the page sits inside the edge's Caddy container (a compose config, read-only). */
export const JOIN_FILE = "/srv/join/index.html";
